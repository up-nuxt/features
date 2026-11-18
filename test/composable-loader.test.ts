import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { loadNuxtUnimport } from '../src/integrations/nuxt-unimport.js'

const runNode = promisify(execFile)
const requireFromTest = createRequire(import.meta.url)
const nuxtManifest = requireFromTest.resolve('nuxt/package.json')
const unimportPath = createRequire(nuxtManifest).resolve('unimport')

it('loads the scanner from Nuxt’s installed Unimport dependency', async () => {
  const { scanDirExports } = await loadNuxtUnimport(nuxtManifest)
  const installed = await import(pathToFileURL(unimportPath).href)
  expect(scanDirExports).toBe(installed.scanDirExports)
})

const paths = process.platform === 'win32' ? ['plain', 'with #'] : ['plain', 'with #', 'with ?']
it.each(paths)('loads and runs Unimport via a dependency entry in %s', async (name) => {
  const root = await mkdtemp(join(tmpdir(), 'features-unimport-url-'))
  try {
    const dependency = join(root, name, 'node_modules/unimport')
    const manifest = join(root, name, 'node_modules/nuxt/package.json')
    const composables = join(root, 'composables')
    await mkdir(dependency, { recursive: true })
    await mkdir(join(manifest, '..'), { recursive: true })
    await mkdir(composables)
    await writeFile(manifest, '{"name":"nuxt"}')
    await writeFile(join(dependency, 'package.json'), '{"name":"unimport","exports":"./index.mjs"}')
    // Use the real scanner while forcing require.resolve to return a literal special path.
    await writeFile(
      join(dependency, 'index.mjs'),
      `export * from ${JSON.stringify(pathToFileURL(unimportPath).href)}`,
    )
    await writeFile(
      join(composables, 'useFixture.ts'),
      'export function useFixture() { return 42 }',
    )
    // Vitest's module runner decodes file URLs before importing them. Exercise native ESM.
    const loader = new URL('../src/integrations/nuxt-unimport.ts', import.meta.url).href
    const { stdout } = await runNode(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { loadNuxtUnimport } from ${JSON.stringify(loader)}
const [manifest, composables] = process.argv.slice(1)
const { scanDirExports } = await loadNuxtUnimport(manifest)
console.log(JSON.stringify(await scanDirExports([composables], { fileFilter: () => true })))`,
      manifest,
      composables,
    ])
    expect(JSON.parse(stdout)).toContainEqual(expect.objectContaining({ name: 'useFixture' }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('encodes Windows drive and UNC paths using Node’s platform-independent conversion', () => {
  expect(
    pathToFileURL('C:\\Nuxt #1\\node_modules\\unimport\\index.mjs', { windows: true }).href,
  ).toBe('file:///C:/Nuxt%20%231/node_modules/unimport/index.mjs')
  expect(pathToFileURL('\\\\server\\share\\Nuxt #1\\index.mjs', { windows: true }).href).toBe(
    'file://server/share/Nuxt%20%231/index.mjs',
  )
})
