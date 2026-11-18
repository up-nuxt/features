import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { NuxtImport } from '@nuxt/schema'

export async function loadNuxtUnimport(nuxtManifest: string): Promise<{
  scanDirExports(
    dirs: string[],
    options: { fileFilter: (file: string) => boolean },
  ): Promise<NuxtImport[]>
}> {
  const requireFromNuxt = createRequire(nuxtManifest)
  const unimportPath = requireFromNuxt.resolve('unimport')
  return import(pathToFileURL(unimportPath).href)
}
