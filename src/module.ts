import type { NuxtModule } from '@nuxt/schema'
import { defineNuxtModule, useLogger } from '@nuxt/kit'
import { scanProject } from './core/index.js'
import { registerFeatureComponents } from './integrations/components.js'
import type { ComponentsOptions } from './integrations/components.js'
import { registerFeatureComposables } from './integrations/composables.js'
import type { ComposablesOptions } from './integrations/composables.js'
import { registerFeaturePages, type PagesOptions } from './integrations/pages.js'
import type { RootOptions } from './core/types.js'
export interface ModuleOptions {
  roots?: RootOptions
  components?: ComponentsOptions
  composables?: ComposablesOptions
  pages?: PagesOptions
}
const module: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({
  meta: { name: '@up-nuxt/features', configKey: 'feature', compatibility: { nuxt: '^4.6.4' } },
  defaults: {
    components: { autoImport: true, prefix: true },
    composables: { autoImport: false },
    pages: { enabled: false },
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
    const logger = useLogger('@up-nuxt/features')
    for (const diagnostic of result.diagnostics)
      logger.warn(`[${diagnostic.code}] ${diagnostic.message}`)
    await registerFeatureComponents(result.registry, options.components ?? {}, nuxt)
    await registerFeatureComposables(result.registry, options.composables ?? {}, nuxt)
    await registerFeaturePages(result.registry, options.pages ?? {}, nuxt)
    logger.debug(`Discovered ${result.registry.features.length} features`)
  },
})

export default module
