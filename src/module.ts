import type { NuxtModule } from '@nuxt/schema'
import { createResolver, defineNuxtModule, useLogger } from '@nuxt/kit'
import { scanProject } from './core/index.js'
import { createRoutingPolicy, type RoutingOptions } from './core/routing.js'
import { registerFeatureComponents } from './integrations/components.js'
import type { ComponentsOptions } from './integrations/components.js'
import { registerFeatureComposables } from './integrations/composables.js'
import type { ComposablesOptions } from './integrations/composables.js'
import { registerFeaturePages, type PagesOptions } from './integrations/pages.js'
import { registerFeatureServer, type ServerOptions } from './integrations/server.js'
import { registerFeatureFlags } from './integrations/flags.js'
import type { FlagsOptions } from './integrations/flag-bindings.js'
import type { RootOptions } from './core/types.js'
export type { FlagBindingOptions, FlagsOptions } from './integrations/flag-bindings.js'
export type { FeaturePrefix, RoutingOptions } from './core/routing.js'

export interface ModuleOptions {
  roots?: RootOptions
  components?: ComponentsOptions
  composables?: ComposablesOptions
  pages?: PagesOptions
  routing?: RoutingOptions
  server?: ServerOptions
  flags?: FlagsOptions
}
const module: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({
  meta: { name: '@up-nuxt/features', configKey: 'feature', compatibility: { nuxt: '^4.6.4' } },
  defaults: {
    components: { autoImport: true, prefix: true },
    composables: { autoImport: false },
    pages: { enabled: false },
    server: { enabled: false },
    flags: { enabled: false },
  },
  async setup(options, nuxt) {
    const result = await scanProject(
      {
        rootDir: nuxt.options.rootDir,
        srcDir: nuxt.options.srcDir,
        serverDir: nuxt.options.serverDir,
      },
      options.roots,
    )
    if (!result.success)
      throw new Error(
        result.diagnostics
          .map(
            (diagnostic) =>
              `[${diagnostic.code}] ${diagnostic.message} ${diagnostic.paths.join(', ')}`,
          )
          .join('\n'),
      )
    const prefixFor = createRoutingPolicy(result.registry, options.routing)
    const logger = useLogger('@up-nuxt/features')
    for (const diagnostic of result.diagnostics)
      logger.warn(`[${diagnostic.code}] ${diagnostic.message}`)
    await registerFeatureComponents(result.registry, options.components ?? {}, nuxt)
    await registerFeatureComposables(result.registry, options.composables ?? {}, nuxt)
    await registerFeaturePages(result.registry, options.pages ?? {}, nuxt, prefixFor)
    registerFeatureServer(result.registry, options.server ?? {}, nuxt, prefixFor)
    await registerFeatureFlags(
      result.registry,
      options.flags,
      nuxt,
      createResolver(import.meta.url).resolve('./runtime'),
    )
    logger.debug(`Discovered ${result.registry.features.length} features`)
  },
})

export default module
