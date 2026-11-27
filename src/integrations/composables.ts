import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { addImportsDir, addVitePlugin, isIgnored, updateTemplates, useLogger } from '@nuxt/kit'
import type { Nuxt, NuxtHooks, NuxtImport } from '@nuxt/schema'
import type { FeatureRegistry } from '../core/types.js'
import { loadNuxtUnimport } from './nuxt-unimport.js'
import { assertSafeResourceTree, symlinkError } from './resource-safety.js'

export interface ComposablesOptions {
  /** Enable native auto-imports from feature App scopes. Defaults to false. */
  autoImport?: boolean
}

export function getComposableDirectories(registry: FeatureRegistry): string[] {
  return [
    ...new Set(
      registry.features
        .filter((feature) => feature.origin === 'feature-root')
        .flatMap((feature) =>
          feature.sources.flatMap((source) =>
            source.scopes.flatMap((scope) =>
              scope.kind === 'app'
                ? scope.resources
                    .filter((resource) => resource.name === 'composables')
                    .map((resource) => resource.path)
                : [],
            ),
          ),
        ),
    ),
  ].sort()
}

function exportKey(entry: NuxtImport): string {
  return JSON.stringify([entry.from, entry.name, entry.as ?? entry.name, Boolean(entry.type)])
}

function scanPath(path: string): string {
  return path.replace(/[()[\]{}*?|]/g, (character) =>
    character === ']' ? '[]]' : `[${character}]`,
  )
}

function contains(directory: string, file: string): boolean {
  const path = relative(directory, file)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function validateCollisions(
  imports: readonly NuxtImport[],
  featureExports: ReadonlySet<string>,
): void {
  const byName = new Map<string, { entry: NuxtImport; feature: boolean }[]>()
  for (const entry of imports) {
    if (entry.disabled) continue
    const feature = featureExports.has(exportKey(entry))
    const name = entry.as ?? entry.name
    const candidates = byName.get(name) ?? []
    for (const other of candidates) {
      if (!feature && !other.feature) continue
      if (entry.from === other.entry.from && entry.name === other.entry.name) continue
      // Feature sources have no precedence over each other. For other pairs,
      // compare the actual Unimport priorities, including explicit zero.
      if (!(feature && other.feature) && (entry.priority ?? 1) !== (other.entry.priority ?? 1))
        continue
      const sources = [entry, other.entry].map((item) => `${item.from} (${item.name})`).sort()
      throw new Error(
        `[FEATURE_COMPOSABLE_COLLISION] Ambiguous auto-import "${name}":\n${sources.join('\n')}\nRename one export or use an explicit import.`,
      )
    }
    candidates.push({ entry, feature })
    byName.set(name, candidates)
  }
}

export async function registerFeatureComposables(
  registry: FeatureRegistry,
  options: ComposablesOptions,
  nuxt: Nuxt,
): Promise<void> {
  if (options.autoImport !== true || nuxt.options.imports.scan === false) return
  const directories = getComposableDirectories(registry)
  if (!directories.length) return

  async function checkTrees(allowMissing = false) {
    for (const directory of directories) {
      // Registry paths are canonical. A changed ancestor must not redirect a registered directory.
      try {
        if (relative(directory, await realpath(directory)))
          throw symlinkError(directory, 'composable')
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      await assertSafeResourceTree(directory, 'composable')
    }
  }

  await checkTrees()
  // Use the same Unimport implementation as this project's Nuxt installation.
  // Per-directory scanning retains provenance that the combined Nuxt scan drops for star exports.
  const requireFromProject = createRequire(join(nuxt.options.rootDir, 'package.json'))
  const nuxtManifest = requireFromProject.resolve('nuxt/package.json', {
    paths: [
      nuxt.options.rootDir,
      ...nuxt.options.modulesDir.map((directory) => join(directory, '..')),
    ],
  })
  const { scanDirExports } = await loadNuxtUnimport(nuxtManifest)
  const scanDirectories = directories.map(scanPath)
  addImportsDir(scanDirectories)
  let revokedFiles: ReadonlySet<string> | undefined
  const revokedTargets = new Set<string>()
  const invalidSource = 'This feature composable failed validation. Fix the source and retry.'

  async function isRevokedSource(file: string): Promise<boolean> {
    if (!revokedFiles) return false
    if (revokedTargets.has(file)) return true
    if (!revokedFiles.has(file) && !directories.some((dir) => contains(dir, file))) return false
    try {
      return Boolean(relative(file, await realpath(file)))
    } catch {
      // A missing revoked source can still have a cached transform.
      return revokedFiles.has(file)
    }
  }

  type ViteServer = Parameters<NuxtHooks['vite:serverCreated']>[0]
  const moduleGraphs = new Set<ViteServer['environments'][string]['moduleGraph']>()
  function invalidateImports(files: ReadonlySet<string>) {
    for (const graph of moduleGraphs)
      for (const file of files)
        for (const module of graph.getModulesByFile(file.split(sep).join('/')) ?? [])
          graph.invalidateModule(module)
  }
  if (nuxt.options.dev) {
    addVitePlugin({
      name: 'up-nuxt:feature-import-safety',
      enforce: 'pre',
      async resolveId(source, importer) {
        if (!revokedFiles) return
        const path = source.split('?', 1)[0]!
        const file = isAbsolute(path)
          ? resolve(path)
          : importer && path.startsWith('.')
            ? resolve(dirname(importer), path)
            : undefined
        if (!file) return
        if (await isRevokedSource(file)) this.error(invalidSource)
        if (!extname(file)) {
          for (const extension of nuxt.options.extensions) {
            const candidate = file + extension
            if (revokedFiles?.has(candidate) && (await isRevokedSource(candidate)))
              this.error(invalidSource)
          }
        }
      },
      async load(id) {
        if (
          revokedFiles &&
          isAbsolute(id) &&
          (await isRevokedSource(resolve(id.split('?', 1)[0]!)))
        )
          this.error(invalidSource)
      },
      closeBundle() {
        // Vite closes each environment on restart, even in middleware mode.
        if ('moduleGraph' in this.environment) moduleGraphs.delete(this.environment.moduleGraph)
      },
      configureServer(server) {
        for (const environment of Object.values(server.environments))
          moduleGraphs.add(environment.moduleGraph)
        // Check before Vite's cached transform middleware can serve a revoked source.
        server.middlewares.use(async (request, response, next) => {
          if (!revokedFiles || !request.url) return next()
          let url: string
          try {
            url = decodeURIComponent(request.url.split('?', 1)[0]!)
          } catch {
            return next()
          }
          const base = server.config.base
          if (base !== '/' && url.startsWith(base)) url = url.slice(base.length - 1)
          const absolute = resolve(url.replace(/^\/+(?=\w:\/)/, ''))
          const file = url.startsWith('/@fs/')
            ? resolve(url.slice(4).replace(/^\/+(?=\w:\/)/, ''))
            : revokedFiles.has(absolute) ||
                revokedTargets.has(absolute) ||
                directories.some((dir) => contains(dir, absolute))
              ? absolute
              : resolve(server.config.root, '.' + url)
          if (!(await isRevokedSource(file)) || !revokedFiles) return next()
          response.statusCode = 503
          response.end(invalidSource)
        })
      },
    })
    for (const directory of directories)
      if (!nuxt.options.watch.includes(directory)) nuxt.options.watch.push(directory)
    nuxt.hook('close', () => {
      revokedFiles = undefined
      moduleGraphs.clear()
      revokedTargets.clear()
    })
  }

  nuxt.hook('imports:context', async (context) => {
    const initialImports = await context.getImports()
    let lastSafeExternalImports: NuxtImport[] = []
    let lastFeatureFiles = new Set<string>()
    nuxt.hook('close', () => {
      lastSafeExternalImports = []
      lastFeatureFiles.clear()
    })

    async function revokeFeatureImports() {
      // Nuxt can mutate the dynamic list before validation. Publish only the
      // last validated external imports and invalidate previously served files.
      if (nuxt.options.dev) {
        revokedFiles = lastFeatureFiles
        for (const file of revokedFiles) {
          const target = await realpath(file).catch(() => undefined)
          if (target && relative(file, target)) revokedTargets.add(resolve(target))
        }
        invalidateImports(new Set([...revokedFiles, ...revokedTargets]))
      }
      await context.modifyDynamicImports(() => [...lastSafeExternalImports])
      if (nuxt.options.dev && nuxt.apps.default) {
        try {
          await nuxt.runWithContext(() =>
            updateTemplates({
              filter: (template) =>
                /(?:^|\/)(?:shared-)?imports\.(?:d\.ts|mjs)$/.test(template.filename),
            }),
          )
        } catch (templateError) {
          useLogger('@up-nuxt/features').debug('Failed to regenerate revoked imports', templateError)
        }
      }
    }

    if (nuxt.options.dev) {
      nuxt.hook('builder:watch', async (_, path) => {
        const file = resolve(nuxt.options.srcDir, path)
        if (
          !lastFeatureFiles.has(file) &&
          !directories.some((dir) => contains(dir, file) || contains(file, dir))
        ) return
        // Nuxt 4.7 can skip imports:extend when the event's target has an older
        // mtime than the last import scan. Check its filesystem identity anyway.
        try {
          await checkTrees(true)
          if (lastFeatureFiles.has(file)) {
            const actual = await realpath(file).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error
            })
            if (actual && relative(file, actual)) throw symlinkError(file, 'composable')
          }
        } catch (error) {
          await revokeFeatureImports()
          throw error
        }
      })
    }

    nuxt.hook('imports:extend', async (imports) => {
      try {
        await checkTrees(true)
        const featureExports = new Set<string>()
        const featureFiles = new Set<string>()
        for (const directory of scanDirectories) {
          const entries = await scanDirExports([directory], {
            fileFilter: (file) => !isIgnored(file, undefined, nuxt),
          })
          for (const entry of entries) featureExports.add(exportKey(entry))
          for (const path of new Set(entries.map((entry) => entry.from).filter(isAbsolute))) {
            if (relative(path, await realpath(path))) throw symlinkError(path, 'composable')
            featureFiles.add(resolve(path))
          }
        }
        // Star barrels may resolve files outside the scanned directory. Keep
        // their provenance, and reject linked physical export paths as well.
        await checkTrees(true)
        validateCollisions([...initialImports, ...imports], featureExports)
        lastSafeExternalImports = imports.filter((entry) => !featureExports.has(exportKey(entry)))
        if (revokedFiles) {
          invalidateImports(revokedFiles)
          revokedFiles = undefined
          revokedTargets.clear()
        }
        lastFeatureFiles = featureFiles
      } catch (error) {
        await revokeFeatureImports()
        throw error
      }
    })
  })
}
