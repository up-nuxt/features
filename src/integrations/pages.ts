import { relative, resolve, sep } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { extendPages, getLayerDirectories, resolveFiles, useLogger } from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'
import type { FeatureRegistry } from '../core/types.js'
import { loadNuxtRouting, mountFeaturePages, parseFeaturePages } from './nuxt-routing.js'
import { validatePageCollisions } from './page-collisions.js'
import {
  buildRouteMembership,
  routeFiles,
  setRouteMembership,
  type PageOrigin,
} from './page-membership.js'
import { installPageDevGuard } from './page-dev-guard.js'
import { assertSafeResourceTree, containsPath, symlinkError } from './resource-safety.js'

export interface PagesOptions {
  enabled?: boolean
}

const slash = (path: string) => path.split(sep).join('/')

export async function registerFeaturePages(
  registry: FeatureRegistry,
  options: PagesOptions,
  nuxt: Nuxt,
  prefixFor: (ownerId: string) => readonly string[],
) {
  const pagesOption = nuxt.options.pages
  if (pagesOption === false || (typeof pagesOption === 'object' && pagesOption.enabled === false))
    return
  const roots = registry.features
    .filter((entry) => entry.origin === 'feature-root')
    .flatMap((entry) =>
      entry.sources.flatMap((source) =>
        source.scopes.flatMap((scope) =>
          scope.kind === 'app'
            ? scope.resources
                .filter((resource) => resource.name === 'pages')
                .map((resource) => ({
                  directory: resource.path,
                  owner: entry,
                  segments: prefixFor(entry.id),
                  source,
                }))
            : [],
        ),
      ),
    )
  const featureRoots = options.enabled === true ? roots : []
  const layers = getLayerDirectories(nuxt)
  const nativeRoots = layers.map((layer) => layer.appPages)
  const serverRoots = [
    nuxt.options.serverDir,
    ...layers.map((layer) => layer.server),
    ...registry.features.flatMap((entry) =>
      entry.sources.flatMap((source) =>
        source.scopes.filter((scope) => scope.kind === 'server').map((scope) => scope.path),
      ),
    ),
  ]
  const canonicalRoot = async (root: string) =>
    realpath(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return root
      throw error
    })
  const canonicalServerRoots = featureRoots.length
    ? await Promise.all(serverRoots.map(canonicalRoot))
    : []
  const protectedRoots = featureRoots.length
    ? new Set([
        ...nativeRoots,
        ...serverRoots,
        ...canonicalServerRoots,
        ...(await Promise.all(nativeRoots.map(canonicalRoot))),
      ])
    : []
  for (const { directory } of featureRoots) {
    for (const other of protectedRoots) {
      if (containsPath(directory, other) || containsPath(other, directory))
        throw new Error(`[FEATURE_PAGE_BOUNDARY] Pages root ${directory} overlaps ${other}.`)
    }
    if (relative(directory, await realpath(directory))) throw symlinkError(directory, 'page')
    await assertSafeResourceTree(directory, 'page')
  }
  const logger = useLogger('@up-nuxt/features')
  let devGuard: ReturnType<typeof installPageDevGuard> | undefined
  let parser: ReturnType<typeof loadNuxtRouting> | undefined
  const getParser = () => (parser ??= loadNuxtRouting(nuxt))
  let featureFiles = new Map<string, PageOrigin>()
  const nativeOrigins = layers
    .map<PageOrigin>((layer) => ({
      kind: relative(layer.root, nuxt.options.rootDir) ? 'layer' : 'native',
      directory: resolve(layer.appPages),
      layer: resolve(layer.root),
    }))
    .sort((a, b) => b.directory.length - a.directory.length)
  const findOrigin = (file: string) =>
    featureFiles.get(resolve(file)) ??
    nativeOrigins.find((origin) => containsPath(origin.directory, file))
  nuxt.hook('close', () => {
    setRouteMembership(nuxt)
  })
  // Register after Nuxt has attached its initial page resolver to app:templates.
  // This hook also runs when scanPageMeta and typedPages both disable pages:resolved.
  nuxt.hook('modules:done', () => {
    nuxt.hook('app:templates', async (app) => {
      setRouteMembership(nuxt)
      if (!app.pages) return
      const guard = devGuard
      if (guard) {
        const check = async (pages: NonNullable<typeof app.pages>) => {
          for (const page of pages) {
            for (const [, file] of routeFiles(page))
              if (await guard.blocked(resolve(file))) throw symlinkError(file, 'page')
            if (page.children) await check(page.children)
          }
        }
        await check(app.pages)
      }
      validatePageCollisions(app.pages, (file) => findOrigin(file)?.kind === 'feature')
      if (devGuard?.topologyChanged()) return
      const snapshot = buildRouteMembership(
        registry,
        app.pages,
        findOrigin,
        await getParser(),
        (message) => logger.warn(message),
      )
      setRouteMembership(nuxt, snapshot)
    })
  })
  if (!featureRoots.length) return
  if (nuxt.options.dev && nuxt.options.builder !== '@nuxt/vite-builder')
    throw new Error(
      '[FEATURE_PAGE_DEV_BUILDER] Feature Pages require the Vite builder in development for safe file replacement.',
    )
  if (nuxt.options.dev)
    devGuard = installPageDevGuard(
      nuxt,
      featureRoots.map((root) => root.directory),
      canonicalServerRoots,
      () => featureFiles,
    )
  const pattern =
    (typeof pagesOption === 'object' && pagesOption.pattern) ||
    `**/*{${nuxt.options.extensions.join(',')}}`
  const modes = nuxt.options.experimental.componentIslands ? ['server', 'client'] : ['client']
  extendPages(async (pages) => {
    setRouteMembership(nuxt)
    const additions = []
    const origins = new Map<string, PageOrigin>()
    for (const { directory, owner, source, segments } of featureRoots) {
      if (relative(directory, await realpath(directory))) throw symlinkError(directory, 'page')
      await assertSafeResourceTree(directory, 'page')
      const files = await resolveFiles(directory, pattern, { followSymbolicLinks: false })
      for (const file of files) {
        if (!containsPath(directory, file))
          throw new Error(`[FEATURE_PAGE_BOUNDARY] Page ${file} is outside ${directory}.`)
        if (!(await lstat(file)).isFile() || relative(file, await realpath(file)))
          throw symlinkError(file, 'page')
        origins.set(resolve(file), {
          kind: 'feature',
          directory,
          ownerId: owner.id,
          declaration: source.path,
          layer: source.root.layer,
        })
      }
      const routes = parseFeaturePages(
        await getParser(),
        slash(directory),
        files.map(slash),
        modes,
        (message) => logger.warn(message),
      )
      additions.push(...mountFeaturePages(routes, segments))
    }
    // Publish provenance only after all roots have passed preflight.
    featureFiles = origins
    devGuard?.scanned()
    pages.push(...additions)
  })
}
