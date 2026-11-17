import type { NuxtModule } from '@nuxt/schema'
import { defineNuxtModule } from '@nuxt/kit'
import { scanProject } from './core/index.js'
import type { RootOptions } from './core/types.js'
export interface ModuleOptions {
  roots?: RootOptions
}
const module: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({
  meta: { name: '@up-nuxt/features', configKey: 'feature', compatibility: { nuxt: '^4.6.4' } },
  defaults: {},
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
    for (const diagnostic of result.diagnostics)
      console.warn(`[${diagnostic.code}] ${diagnostic.message}`)
    // Discovery only: resolvers and runtime manifests will consume this registry in Milestone 2.
    console.info(`@up-nuxt/features: discovered ${result.registry.features.length} features`)
  },
})

export default module
