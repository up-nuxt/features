import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { resolveSupportedNitro } from '../src/integrations/nitro-routing.js'

it('resolves the verified Nitro distribution from the installed Nuxt package', async () => {
  const fromNuxt = createRequire(new URL(import.meta.resolve('nuxt/package.json')))
  const nitro = await resolveSupportedNitro(fromNuxt.resolve('@nuxt/nitro-server/package.json'))
  expect(nitro.resolve('globby')).toContain('globby')
})

it.each([
  ['3.0.0', /detected Nitro 3\.0\.0.*2\.13\.6/],
  ['2.14.0', /detected Nitro 2\.14\.0.*2\.13\.6/],
  [null, /metadata.*missing.*2\.13\.6/],
  [undefined, /could not resolve.*2\.13\.6/],
] as const)('rejects unsupported/missing Nitro metadata (%s)', async (version, diagnostic) => {
  const root = await mkdtemp(join(tmpdir(), 'features-nitro-version-'))
  try {
    const packageDir = join(root, 'node_modules/nitropack')
    await mkdir(packageDir, { recursive: true })
    // An export map with no package.json entry prevents falling back to the
    // real installed Nitro on a globally configured Node resolution path.
    const metadata = version === undefined ? { exports: { '.': './index.mjs' } } : { version }
    await writeFile(join(packageDir, 'package.json'), JSON.stringify(metadata))
    await expect(resolveSupportedNitro(join(root, 'package.json'))).rejects.toThrow(diagnostic)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
