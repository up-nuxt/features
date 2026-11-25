import { resolve } from 'node:path'
import { addNitroPlugin, addServerTemplate, findPath, resolveAlias, useLogger } from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'
import type { FeatureRegistry } from '../core/types.js'
import type { DeclarationAvailability } from '../runtime/server/policy.js'
import { compileFlagBindings, readFlagBindings, type FlagsOptions } from './flag-bindings.js'
import { getRouteMembership } from './page-membership.js'

export async function registerFeatureFlags(
  registry: FeatureRegistry,
  options: FlagsOptions | undefined,
  nuxt: Nuxt,
  runtimeDirectory: string,
) {
  if (options?.enabled !== true) return
  const bindings = readFlagBindings(options.bindings)
  const extensions = ['.ts', '.mts', '.js', '.mjs', '.cts', '.cjs']
  let client: string | null = null
  if (options.serverClient !== undefined) {
    if (typeof options.serverClient !== 'string' || !options.serverClient.trim())
      throw new Error('[FEATURE_FLAGS_CONFIG] feature.flags.serverClient must be a nonempty path.')
    const path = resolveAlias(options.serverClient, nuxt.options.alias)
    client = await findPath(resolve(nuxt.options.rootDir, path), { extensions, alias: {} })
    if (!client)
      useLogger('@up-nuxt/features').warn(
        '[FEATURE_FLAGS_CLIENT] Server client module was not found. Using binding defaults.',
      )
  }

  const runtime = await findPath(resolve(runtimeDirectory, 'server/plugin'), { extensions, alias: {} })
  if (!runtime) throw new Error('[FEATURE_FLAGS_RUNTIME] Nitro availability plugin was not found.')

  let table: readonly DeclarationAvailability[] | undefined
  // Nuxt generates the app templates and publishes finalized Pages membership
  // before build:before. Keep the projection fixed for this boot.
  const getTable = () => (table ??= compileFlagBindings(registry, bindings, getRouteMembership(nuxt)))
  nuxt.hook('build:before', () => {
    getTable()
  })

  // Nitro 2 resolves relative plugin names against serverDir and emits the result
  // in a single-quoted import. A fixed absolute virtual path avoids both rewrites.
  const plugin = '/__up-nuxt-features__/availability.mjs'
  addServerTemplate({
    filename: plugin,
    getContents: () => {
      const args = [JSON.stringify(getTable())]
      if (client) args.push(`() => import(${JSON.stringify(client)})`)
      return `import { installAvailability } from ${JSON.stringify(runtime)};
export default (app) => installAvailability(app, ${args.join(', ')});`
    },
  })
  addNitroPlugin(plugin)
}
