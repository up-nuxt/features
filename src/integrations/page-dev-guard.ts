import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { addVitePlugin, useLogger } from '@nuxt/kit'
import type { Nuxt, NuxtHooks } from '@nuxt/schema'
import { setRouteMembership } from './page-membership.js'
import { containsPath, symlinkError } from './resource-safety.js'

export function installPageDevGuard(
  nuxt: Nuxt,
  directories: string[],
  serverDirectories: string[],
  registeredFiles: () => ReadonlyMap<string, unknown>,
) {
  type Server = Parameters<NuxtHooks['vite:serverCreated']>[0]
  type Graph = Server['environments'][string]['moduleGraph']
  const graphs = new Set<Graph>()
  let topologyChanged = false
  const rejectedLinks = new Map<string, string>()
  const serverTargets = new Set<string>()
  const logger = useLogger('@up-nuxt/features')
  const message =
    'This Feature Page failed filesystem validation. Restore the file and restart Nuxt.'
  const isPagePath = (file: string) => directories.some((dir) => containsPath(dir, file))

  function invalidate(file: string) {
    for (const graph of graphs)
      for (const module of graph.getModulesByFile(file.split(sep).join('/')) ?? [])
        graph.invalidateModule(module)
  }

  async function blocked(file: string) {
    if (serverTargets.has(file)) return true
    if (!isPagePath(file)) return false
    const canonical = await realpath(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP') return
      throw error
    })
    if (!canonical) return registeredFiles().has(file)
    if (!relative(file, canonical)) {
      rejectedLinks.delete(file)
      return false
    }
    if (rejectedLinks.get(file) !== canonical) {
      rejectedLinks.set(file, canonical)
      setRouteMembership(nuxt)
      invalidate(file)
      // A resolver may already have canonicalized a server link. Preserve this
      // fallback without rejecting independent requests for App files.
      if (serverDirectories.some((directory) => containsPath(directory, canonical))) {
        serverTargets.add(canonical)
        invalidate(canonical)
      }
      logger.error(symlinkError(file, 'page').message)
    }
    return true
  }

  addVitePlugin({
    name: 'up-nuxt:feature-page-safety',
    enforce: 'pre',
    async resolveId(id, importer) {
      const path = id.split('?', 1)[0]!
      const from = importer?.split('?', 1)[0]
      const file = isAbsolute(path)
        ? resolve(path)
        : from && isAbsolute(from) && (path.startsWith('./') || path.startsWith('../'))
          ? resolve(dirname(from), path)
          : undefined
      if (file && (await blocked(file))) this.error(message)
    },
    async load(id) {
      const path = id.split('?', 1)[0]!
      if (isAbsolute(path) && (await blocked(resolve(path)))) this.error(message)
    },
    configureServer(server) {
      for (const environment of Object.values(server.environments))
        graphs.add(environment.moduleGraph)
      server.middlewares.use(async (request, response, next) => {
        if (!request.url) return next()
        let path: string
        try {
          path = decodeURIComponent(request.url.split('?', 1)[0]!)
        } catch {
          return next()
        }
        const base = server.config.base
        if (base !== '/' && path.startsWith(base)) path = path.slice(base.length - 1)
        const file = path.startsWith('/@fs/')
          ? resolve(path.slice(4).replace(/^\/+(?=\w:\/)/, ''))
          : resolve(server.config.root, '.' + path)
        try {
          if (!(await blocked(file))) return next()
          response.statusCode = 503
          response.end(message)
        } catch (error) {
          next(error)
        }
      })
    },
    closeBundle() {
      if ('moduleGraph' in this.environment) graphs.delete(this.environment.moduleGraph)
    },
  })

  for (const directory of directories)
    if (!nuxt.options.watch.includes(directory)) nuxt.options.watch.push(directory)
  nuxt.hook('builder:watch', async (event, path) => {
    const file = resolve(nuxt.options.srcDir, path)
    if (!isPagePath(file)) return
    if (event !== 'change') {
      topologyChanged = true
    }
    if (topologyChanged || (nuxt.options.experimental.scanPageMeta && registeredFiles().has(file)))
      setRouteMembership(nuxt)
    if (await blocked(file)) invalidate(file)
    // A directory can be replaced without a separate event for each known child.
    if (event === 'addDir' || event === 'unlinkDir')
      for (const child of registeredFiles().keys())
        if (containsPath(file, child) && (await blocked(child))) invalidate(child)
  })
  nuxt.hook('close', () => {
    rejectedLinks.clear()
    serverTargets.clear()
    graphs.clear()
  })
  return {
    blocked,
    topologyChanged: () => topologyChanged,
    scanned: () => {
      topologyChanged = false
    },
  }
}
