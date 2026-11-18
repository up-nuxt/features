import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { symlinkError } from './resource-safety.js'
import type { NitroInstance, RegisteredServerResource } from './server.js'

function pathKey(path: string) {
  return isAbsolute(path) ? resolve(path).split(sep).join('/') : path
}

function routeKey(route: string) {
  return (route.replace(/\/$/, '') || '/')
    .split('/')
    .map((segment) => (segment.startsWith('**') ? '**' : segment.startsWith(':') ? ':' : segment))
    .join('/')
}

interface Handler {
  handler: string
  route?: string
  method?: string
  middleware?: boolean
  env?: string | string[]
}

function disjointEnvironments(a: Handler['env'], b: Handler['env']) {
  const left = Array.isArray(a) ? a : [a]
  const right = Array.isArray(b) ? b : [b]
  return (
    left.length > 0 &&
    right.length > 0 &&
    left.every((mode) =>
      right.every(
        (other) =>
          (mode === 'dev' && (other === 'prod' || other === 'prerender')) ||
          (other === 'dev' && (mode === 'prod' || mode === 'prerender')),
      ),
    )
  )
}

export function validateServerCollisions(
  nitro: NitroInstance,
  resources: readonly RegisteredServerResource[],
) {
  const feature = new Map(resources.map((resource) => [pathKey(resource.file), resource]))
  const routes = new Map<string, Handler[]>()
  const middleware = new Set<string>()
  function label(file: string) {
    const source = feature.get(pathKey(file))
    return source ? `${file} (owner ${source.owner})` : `${file} (native or module)`
  }
  for (const handler of [...nitro.scannedHandlers, ...nitro.options.handlers] as Handler[]) {
    const file = pathKey(handler.handler)
    if (handler.middleware || !handler.route) {
      if (middleware.has(file) && feature.get(file)?.kind === 'middleware')
        throw new Error(
          `[FEATURE_SERVER_DUPLICATE] Middleware registered more than once: ${label(file)}.`,
        )
      middleware.add(file)
      continue
    }
    const key = routeKey(handler.route)
    const existing = routes.get(key) ?? []
    for (const other of existing) {
      if (!feature.has(file) && !feature.has(pathKey(other.handler))) continue
      if (disjointEnvironments(handler.env, other.env)) continue
      const rawPath = handler.route.replace(/\/$/, '')
      const otherPath = other.route?.replace(/\/$/, '')
      // Different parameter spellings occupy the same radix node and replace
      // the entire method table. On one spelling H3 keeps a separate all slot.
      if (
        rawPath === otherPath &&
        (handler.method || 'all').toLowerCase() !== (other.method || 'all').toLowerCase()
      )
        continue
      const descriptions = [handler, other]
        .map(
          (entry) =>
            `${(entry.method || 'all').toUpperCase()} ${entry.route}: ${label(entry.handler)}`,
        )
        .sort()
      throw new Error(
        `[FEATURE_SERVER_COLLISION] Ambiguous Nitro handlers: ${descriptions.join(' and ')}.`,
      )
    }
    existing.push(handler)
    routes.set(key, existing)
  }
  const plugins = new Set<string>()
  for (const plugin of nitro.options.plugins) {
    const file = pathKey(plugin)
    if (plugins.has(file) && feature.get(file)?.kind === 'plugins')
      throw new Error(
        `[FEATURE_SERVER_DUPLICATE] Nitro plugin registered more than once: ${label(file)}.`,
      )
    plugins.add(file)
  }
}

export function validateDevHandlerCollisions(
  nitro: NitroInstance,
  resources: readonly RegisteredServerResource[],
) {
  if (!nitro.options.dev) return
  const baseURL = nitro.options.runtimeConfig.app?.baseURL ?? '/'
  const mount = (route: string) => route.replace(/\/$/, '') || '/'
  for (const resource of resources) {
    if (
      !resource.route ||
      (resource.env && resource.env !== 'dev' && resource.env !== nitro.options.preset)
    )
      continue
    // H3 dev handlers are literal mounts, rather than radix route patterns.
    if (resource.route.split('/').some((part) => part.startsWith(':') || part.startsWith('*')))
      continue
    const route = mount(baseURL.replace(/\/$/, '') + resource.route)
    const devHandler = nitro.options.devHandlers.find(
      (entry) => entry.route && mount(entry.route) === route,
    )
    if (devHandler) {
      const { handler } = devHandler
      const label =
        typeof handler === 'string'
          ? handler
          : (typeof handler === 'function' && handler.name) || '<anonymous>'
      throw new Error(
        `[FEATURE_SERVER_COLLISION] ${(resource.method || 'all').toUpperCase()} ${route}: ${resource.file} (owner ${resource.owner}) is shadowed in development by ALL ${route}: ${label} (dev handler).`,
      )
    }
  }
}

async function readRegisteredFile(file: string) {
  if (relative(file, await realpath(file))) throw symlinkError(file, 'server')
  const descriptor = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    // Check again after opening in case an ancestor changed during resolution.
    if (relative(file, await realpath(file))) throw symlinkError(file, 'server')
    if (!(await descriptor.stat()).isFile()) throw new Error(`Not a regular file: ${file}`)
    return await descriptor.readFile('utf8')
  } finally {
    await descriptor.close()
  }
}

export function installNitroResourceGuard(
  nitro: NitroInstance,
  resources: readonly RegisteredServerResource[],
) {
  const registered = new Map(resources.map((resource) => [pathKey(resource.file), resource]))
  function attach(instance: NitroInstance) {
    instance.hooks.hook('rollup:before', (_nitro: NitroInstance, config: { plugins?: unknown }) => {
      const plugins = Array.isArray(config.plugins) ? config.plugins : [config.plugins]
      config.plugins = [
        {
          name: 'up-nuxt:feature-server-safety',
          buildStart(this: { addWatchFile(file: string): void }) {
            validateServerCollisions(instance, resources)
            for (const file of registered.keys()) this.addWatchFile(file)
          },
          resolveId: {
            order: 'pre',
            handler(id: string) {
              // Retain the lexical registration ID instead of letting node-resolve
              // replace it with a symlink target before the guarded load.
              const file = pathKey(id)
              if (registered.has(file)) return file
            },
          },
          load: {
            order: 'pre',
            async handler(this: { warn(message: string): void }, id: string) {
              // Nitro's OpenAPI metadata loader uses a separate virtual module ID.
              const metaPrefix = '\0nitro-handler-meta:'
              const file = id.startsWith(metaPrefix) ? id.slice(metaPrefix.length) : id
              const resource = registered.get(pathKey(file))
              if (!resource) return
              try {
                return await readRegisteredFile(resource.file)
              } catch (cause) {
                const error = new Error(
                  `[FEATURE_SERVER_UNSAFE] Feature Server resource unavailable: ${resource.file}. Restore the file and restart Nuxt. ${String(cause)}`,
                  { cause },
                )
                if (!instance.options.dev) throw error
                this.warn(error.message)
                if (resource.kind === 'api' || resource.kind === 'routes')
                  return 'export default (event) => { event.node.res.statusCode = 503; return { error: "FEATURE_SERVER_UNAVAILABLE" }; }'
                return 'export default () => {}'
              }
            },
          },
        },
        ...plugins,
      ]
    })
  }
  attach(nitro)
  nitro.hooks.hook('prerender:init', attach)
}
