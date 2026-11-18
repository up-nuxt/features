import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { addNitroPlugin, addServerHandler, addVitePlugin } from '@nuxt/kit'
import type { Nuxt, NuxtHooks } from '@nuxt/schema'
import type { FeatureDefinition, FeatureRegistry } from '../core/types.js'
import { loadNitroScannerTools, nitroFilePattern, nitroRouteFromFile } from './nitro-routing.js'
import { assertSafeResourceTree, containsPath, symlinkError } from './resource-safety.js'
import {
  installNitroResourceGuard,
  validateDevHandlerCollisions,
  validateServerCollisions,
} from './server-safety.js'

export interface ServerOptions {
  enabled?: boolean
}

type ResourceKind = 'api' | 'routes' | 'middleware' | 'plugins'
type HandlerRoute = ReturnType<typeof nitroRouteFromFile>
export type RegisteredServerResource = Readonly<
  {
    file: string
    directory: string
    kind: ResourceKind
    owner: string
    ancestors: readonly string[]
    declaration: string
    scope: string
    layer?: string
    registration: 'feature'
  } & Partial<HandlerRoute>
>

type NuxtNitroInstance = Parameters<NuxtHooks['nitro:init']>[0]
// Nuxt's builder-neutral fallback omits these Nitro 2 scanner options.
export type NitroInstance = NuxtNitroInstance & {
  options: { scanDirs: string[]; apiDir?: string; routesDir?: string }
}
const serverSnapshot = Symbol.for('@up-nuxt/features:server-resources')
type NitroWithResources = NitroInstance & { [serverSnapshot]?: readonly RegisteredServerResource[] }

export function getServerResources(nitro: NuxtNitroInstance) {
  return (nitro as NitroWithResources)[serverSnapshot]
}

const slash = (path: string) => path.split(sep).join('/')

function isSupportedResource(name: string): name is ResourceKind {
  return name === 'api' || name === 'routes' || name === 'middleware' || name === 'plugins'
}

export function registerFeatureServer(
  registry: FeatureRegistry,
  options: ServerOptions,
  nuxt: Nuxt,
  prefixFor: (ownerId: string) => readonly string[],
) {
  const entries = registry.features.filter((entry) => entry.origin === 'feature-root')
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  function ancestorsOf(entry: FeatureDefinition) {
    const ancestors: string[] = []
    let current = entry.parentId
    while (current) {
      ancestors.unshift(current)
      current = byId.get(current)?.parentId
    }
    return Object.freeze(ancestors)
  }
  const scopes = entries.flatMap((owner) =>
    owner.sources.flatMap((source) =>
      source.scopes
        .filter((scope) => scope.kind === 'server')
        .map((scope) => ({ scope, source, owner })),
    ),
  )
  if (!scopes.length) return
  // Native Nuxt import protection knows the conventional server directory.
  // Vite load sees the final absolute path after alias/relative resolution.
  addVitePlugin({
    name: 'up-nuxt:feature-server-import-boundary',
    enforce: 'pre',
    load(id) {
      const file = id.split('?', 1)[0]!
      if (isAbsolute(file) && scopes.some(({ scope }) => containsPath(scope.path, file)))
        this.error(
          `[FEATURE_SERVER_APP_IMPORT] Importing Feature Server source into the Nuxt app is not allowed: ${file}. Use an HTTP request or a shared utility.`,
        )
    },
  })
  if (options.enabled !== true) return
  const directories = scopes.flatMap(({ owner, source, scope }) =>
    scope.resources
      .filter((resource) => isSupportedResource(resource.name))
      .map(({ path, name }) => ({
        directory: path,
        kind: name as ResourceKind,
        owner,
        source,
        scope,
      })),
  )

  if (!directories.length) return
  let resources: readonly RegisteredServerResource[] = []

  const registerResources: NuxtHooks['nitro:config'] = async (config) => {
    const { ignore, apiBaseURL } = config as typeof config & {
      ignore?: string[]
      apiBaseURL?: string
    }
    const { globby, paths } = await loadNitroScannerTools(nuxt)
    const registrations: RegisteredServerResource[] = []
    for (const { directory, kind, owner, source, scope } of directories) {
      if (relative(directory, await realpath(directory))) throw symlinkError(directory, 'server')
      await assertSafeResourceTree(directory, 'server')
      // Nitro runs e.g. api/**/*.ts from its scan root and passes ignores verbatim.
      const files = await globby(`${kind}/${nitroFilePattern}`, {
        cwd: scope.path,
        absolute: true,
        dot: true,
        followSymbolicLinks: false,
        ignore,
      })
      const ancestors = ancestorsOf(owner)
      const segments = prefixFor(owner.id)
      for (const file of files.sort((a, b) => a.localeCompare(b))) {
        if (!containsPath(directory, file))
          throw new Error(`[FEATURE_SERVER_BOUNDARY] Resource ${file} is outside ${directory}.`)
        if (!(await lstat(file)).isFile() || relative(file, await realpath(file)))
          throw symlinkError(file, 'server')
        const route: Partial<HandlerRoute> =
          kind === 'api' || kind === 'routes'
            ? nitroRouteFromFile(
                slash(relative(directory, file)),
                kind === 'api' ? apiBaseURL || '/api' : '/',
                segments,
                paths,
              )
            : {}
        // Nitro 2 interpolates paths into both single- and double-quoted imports.
        const filename = slash(file)
        if ((route.route && /['\r\n\\]/.test(route.route)) || /['"\r\n\\]/.test(filename))
          throw new Error(
            `[FEATURE_SERVER_PATH] Nitro 2 cannot safely emit the route or file path for ${file}.`,
          )
        registrations.push(
          Object.freeze({
            file: filename,
            directory,
            kind,
            owner: owner.id,
            ancestors,
            declaration: source.path,
            scope: scope.path,
            layer: source.root.layer,
            registration: 'feature',
            ...route,
          }),
        )
      }
    }
    resources = Object.freeze(registrations)
    await nuxt.runWithContext(() => {
      for (const resource of resources) {
        if (resource.kind === 'plugins') addNitroPlugin(resource.file)
        else if (resource.kind === 'middleware')
          addServerHandler({ handler: resource.file, middleware: true })
        else
          addServerHandler({
            handler: resource.file,
            route: resource.route,
            method: resource.method,
            env: resource.env,
            lazy: true,
          })
      }
    })
  }
  // Allow modules that register nitro:config during setup to contribute their scan options first.
  nuxt.hook('modules:done', () => {
    nuxt.hook('nitro:config', registerResources)
  })
  // Nuxt collects Kit dev handlers after nitro:init, before it mounts the dev app.
  nuxt.hook('nitro:build:before', (nitro) => {
    validateDevHandlerCollisions(nitro as NitroInstance, resources)
  })
  nuxt.hook('nitro:init', async (instance) => {
    const nitro = instance as NitroInstance
    // The resolved scan directories also include paths registered by other modules.
    const scanRoots = nitro.options.scanDirs.flatMap((dir) =>
      [
        nitro.options.apiDir || 'api',
        nitro.options.routesDir || 'routes',
        'middleware',
        'plugins',
        'utils',
      ].map((kind) => resolve(dir, kind)),
    )
    for (const root of scanRoots) {
      const canonical = await realpath(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return root
        throw error
      })
      for (const { directory } of directories)
        if (
          [root, canonical].some(
            (path) => containsPath(path, directory) || containsPath(directory, path),
          )
        )
          throw new Error(
            `[FEATURE_SERVER_BOUNDARY] Feature Server resource ${directory} overlaps Nitro scan resource ${root}.`,
          )
    }
    validateServerCollisions(nitro, resources)
    installNitroResourceGuard(nitro, resources)
    ;(nitro as NitroWithResources)[serverSnapshot] = resources
  })
}
