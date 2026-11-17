import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRegistry, discoverFeatures, resolveRoots, scanProject } from '../src/core/index.js'
import type { RegistryBuildResult, RootDirectories, RootOptions } from '../src/core/types.js'

let project: string
let dirs: RootDirectories
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'up-nuxt-features-'))
  dirs = { rootDir: project, srcDir: join(project, 'app'), serverDir: join(project, 'server') }
})
afterEach(async () => {
  await rm(project, { recursive: true, force: true })
})
const directory = async (path: string) => {
  await mkdir(join(project, path), { recursive: true })
}
// Test convenience only: production failures have no registry property.
const inspect = (result: RegistryBuildResult) => ({
  features: result.success ? result.registry.features : [],
  diagnostics: result.diagnostics,
})
const scanWith = async (directories: RootDirectories, options?: RootOptions) =>
  inspect(await scanProject(directories, options))
const scan = () => scanWith(dirs)

describe('discovery and registry', () => {
  it('merges three roots while preserving resource boundaries', async () => {
    for (const path of [
      'features/shop/server/api',
      'features/shop/shared',
      'app/features/shop/components',
      'server/features/shop/api',
      'server/features/shop/server/api',
      'app/features/shop/server/api',
    ])
      await directory(path)
    const result = await scan()
    expect(result.diagnostics).toEqual([])
    expect(result.features).toHaveLength(1)
    const shop = result.features[0]!
    expect(shop.id).toBe('shop')
    expect(shop.sources).toHaveLength(3)
    expect(
      shop.sources
        .flatMap((s) => s.resources)
        .map((r) => [r.name, r.boundary])
        .sort(),
    ).toEqual(
      [
        ['api', 'server'],
        ['api', 'server'],
        ['components', 'app'],
        ['shared', 'shared'],
      ].sort(),
    )
  })
  it('supports both explicit nesting conventions and mixed depth', async () => {
    await directory('features/shop/features/checkout/(payment)/features/card/(verify)/components')
    const result = await scan()
    expect(result.diagnostics).toEqual([])
    expect(result.features.map((f) => [f.id, f.kind])).toEqual([
      ['shop', 'feature'],
      ['shop/checkout', 'feature'],
      ['shop/checkout/payment', 'group'],
      ['shop/checkout/payment/card', 'feature'],
      ['shop/checkout/payment/card/verify', 'group'],
    ])
    expect(result.features[1]!.children).toEqual(['shop/checkout/payment'])
    expect(result.features[2]!.parentId).toBe('shop/checkout')
  })
  it('ignores ordinary directories and declarations inside resources', async () => {
    for (const name of [
      'pages',
      'components',
      'composables',
      'utils',
      'services',
      'repositories',
      'server',
      'shared',
      'tests',
      'checkout',
    ])
      await directory(`features/shop/${name}/(fake)/features/also-fake`)
    expect((await scan()).features.map((f) => f.id)).toEqual(['shop'])
  })
  it('treats stores as an ordinary directory, without discovering resources or nested groups', async () => {
    for (const path of [
      'features/shop/stores/(fake)',
      'app/features/shop/stores/features/fake',
      'server/features/shop/stores/(fake)',
    ])
      await directory(path)
    const result = await scan()
    expect(result.diagnostics).toEqual([])
    expect(result.features.map((feature) => feature.id)).toEqual(['shop'])
    expect(result.features[0]!.sources.flatMap((source) => source.resources)).toEqual([])
  })
  it('reports feature/group conflict in one root', async () => {
    await directory('features/shop/features/checkout')
    await directory('features/shop/(checkout)')
    expect((await scan()).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'INCOMPATIBLE_DECLARATION', featureId: 'shop/checkout' }),
    )
  })
  it('reports incompatible declarations across roots', async () => {
    await directory('features/shop/(checkout)')
    await directory('app/features/shop/features/checkout')
    expect((await scan()).diagnostics[0]!.code).toBe('INCOMPATIBLE_DECLARATION')
  })
  it('merges compatible nested groups across roots', async () => {
    await directory('features/shop/(checkout)')
    await directory('app/features/shop/(checkout)')
    const result = await scan()
    expect(result.diagnostics).toEqual([])
    expect(result.features.find((f) => f.id === 'shop/checkout')!.sources).toHaveLength(2)
    expect(result.features[0]!.children).toEqual(['shop/checkout'])
  })
  it('reports competing same-kind declarations instead of replacing sources', async () => {
    await directory('features/shop')
    const { roots } = await resolveRoots(dirs)
    const { declarations } = await discoverFeatures(roots)
    const result = inspect(buildRegistry([...declarations, ...declarations]))
    expect(result.diagnostics[0]!.code).toBe('DUPLICATE_DECLARATION')
    expect(result.features).toEqual([])
  })
  it('is deterministic regardless of input order', async () => {
    for (const path of [
      'features/z/(child)',
      'app/features/a',
      'server/features/z/(child)',
      'features/z/features/child',
    ])
      await directory(path)
    const { declarations } = await discoverFeatures((await resolveRoots(dirs)).roots)
    expect(buildRegistry(declarations)).toEqual(buildRegistry([...declarations].reverse()))
    expect(await scan()).toEqual(await scan())
  })
  it('uses slash-separated logical identities', async () => {
    await directory('features/shop/(checkout)')
    expect((await scan()).features[1]!.id).toBe('shop/checkout')
  })
  it('diagnoses malformed declaration names and ignores hidden directories', async () => {
    await directory('features/shop/(broken')
    await directory('features/.hidden/(fake)')
    const result = await scan()
    expect(result.diagnostics[0]!.code).toBe('INVALID_DECLARATION')
    expect(result.features).toEqual([])
    const physical = await discoverFeatures((await resolveRoots(dirs)).roots)
    expect(physical.declarations.map((item) => item.id)).toEqual(['shop'])
  })
})

describe('roots and traversal safety', () => {
  it('ignores missing default roots', async () => {
    expect(await scan()).toEqual({ features: [], diagnostics: [] })
  })
  it('resolves custom roots relative to rootDir and supports disabling roots', async () => {
    await directory('custom/shop')
    const result = await scanWith(dirs, { general: 'custom', app: false, server: false })
    expect(result.features[0]!.sources[0]!.root.path).toBe(await realpath(join(project, 'custom')))
    expect(result.diagnostics).toEqual([])
  })
  it('uses resolved srcDir and serverDir', async () => {
    await directory('client/features/shop')
    await directory('backend/features/shop/api')
    const result = await scanWith({
      ...dirs,
      srcDir: join(project, 'client'),
      serverDir: join(project, 'backend'),
    })
    expect(result.features[0]!.sources).toHaveLength(2)
  })
  it('rejects equal and nested roots even when missing', async () => {
    for (const app of ['features', 'features/nested']) {
      const result = await scanWith(dirs, { app })
      expect(result.diagnostics[0]!.code).toBe('OVERLAPPING_ROOTS')
      expect(result.features).toEqual([])
    }
  })
  it('does not mistake sibling prefixes for overlap', async () => {
    expect(
      (await scanWith(dirs, { general: 'features', app: 'features-extra' })).diagnostics,
    ).toEqual([])
  })
  it('rejects files and empty roots', async () => {
    await writeFile(join(project, 'file'), '')
    expect(
      (await scanWith(dirs, { general: 'file', app: '' })).diagnostics.map((d) => d.code),
    ).toEqual(['INVALID_ROOT', 'INVALID_ROOT'])
  })
  it('ignores feature, resource, and cyclic directory symlinks', async () => {
    await directory('features/shop')
    await directory('outside/(secret)')
    await symlink(join(project, 'outside'), join(project, 'features', 'linked'), 'dir')
    await symlink(join(project, 'outside'), join(project, 'features/shop/components'), 'dir')
    await symlink(join(project, 'features'), join(project, 'features/shop/(cycle)'), 'dir')
    const result = await scan()
    expect(result.diagnostics).toEqual([])
    expect(result.features.map((f) => f.id)).toEqual(['shop'])
    expect(result.features[0]!.sources[0]!.resources).toEqual([])
  })
  it('detects overlapping roots through symlinked ancestors', async () => {
    await directory('features/shop')
    await symlink(project, join(project, 'alias'), 'dir')
    const result = await scanWith(dirs, { app: 'alias/features' })
    expect(result.diagnostics[0]!.code).toBe('OVERLAPPING_ROOTS')
  })
  it('rejects symlink roots', async () => {
    await directory('outside')
    await symlink(join(project, 'outside'), join(project, 'linked'), 'dir')
    expect((await scanWith(dirs, { general: 'linked' })).diagnostics[0]!.code).toBe('INVALID_ROOT')
  })
})
