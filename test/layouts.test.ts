import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRegistry, discoverFeatures, resolveRoots, scanProject } from '../src/core/index.js'
import { getComponentDirectories } from '../src/integrations/components.js'
import type { RegistryBuildResult } from '../src/core/types.js'
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'feature-layouts-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const dirs = () => ({ rootDir: root, srcDir: join(root, 'app'), serverDir: join(root, 'server') })
const directory = async (path: string) => {
  await mkdir(join(root, path), { recursive: true })
}
function registry(result: RegistryBuildResult) {
  expect(result.success, JSON.stringify(result.diagnostics)).toBe(true)
  if (!result.success) throw new Error('Unexpected registry failure')
  return result.registry
}

it('preserves all four declaration locations with explicit layouts, scopes and discovery provenance', async () => {
  for (const path of [
    'features/shop/app/components',
    'features/shop/server/api',
    'app/features/shop/pages',
    'server/features/shop/routes',
    '(dashboard)/app/components',
    '(dashboard)/server/api',
  ])
    await directory(path)
  const snapshot = registry(await scanProject(dirs()))
  const shop = snapshot.features.find((f) => f.id === 'shop')!
  expect(shop.sources.map((source) => source.layout)).toEqual(['app', 'full-stack', 'server'])
  expect(
    shop.sources.flatMap((source) =>
      source.scopes.map((scope) => [scope.kind, scope.resources.map((resource) => resource.name)]),
    ),
  ).toEqual([
    ['app', ['pages']],
    ['app', ['components']],
    ['server', ['api']],
    ['server', ['routes']],
  ])
  const group = snapshot.features.find((f) => f.id === 'dashboard')!
  expect(group.kind).toBe('group')
  expect(group.sources[0]!.root.discovery).toBe('project-group')
  expect(group.sources[0]!.layout).toBe('full-stack')
  expect(getComponentDirectories(snapshot).map((dir) => dir.prefix)).toEqual(['', 'shop'])
})
it('merges compatible groups across root-level, full-stack, app and server declarations', async () => {
  for (const path of [
    '(shop)/app/components',
    'features/(shop)/server/api',
    'app/features/(shop)/components',
    'server/features/(shop)/api',
  ])
    await directory(path)
  const snapshot = registry(await scanProject(dirs()))
  expect(snapshot.features).toHaveLength(1)
  expect(snapshot.features[0]!.sources).toHaveLength(4)
  expect(getComponentDirectories(snapshot).map((dir) => dir.prefix)).toEqual(['', ''])
})
it('preserves nested identities and layouts while excluding every group from prefixes', async () => {
  for (const path of [
    'features/shop/(checkout)/app/components',
    'features/shop/(checkout)/server/api',
    'features/shop/features/payment/app/components',
    'app/features/shop/(checkout)/components',
    'server/features/shop/(checkout)/api',
    '(shell)/(dialog)/features/inventory/app/components',
  ])
    await directory(path)
  const snapshot = registry(await scanProject(dirs()))
  const checkout = snapshot.features.find((f) => f.id === 'shop/checkout')!
  expect(checkout.kind).toBe('group')
  expect(checkout.parentId).toBe('shop')
  expect(checkout.sources).toHaveLength(3)
  expect(snapshot.features.find((f) => f.id === 'shop/payment')!.kind).toBe('feature')
  const prefixes = getComponentDirectories(snapshot).map((dir) => dir.prefix)
  expect(prefixes).toEqual(['inventory', 'shop', 'shop', 'shop-payment'])
})
it.each([
  'components',
  'api',
  'pages',
  'routes',
  'composables',
  'utils',
  'middleware',
  'plugins',
  'types',
])('rejects direct full-stack resource %s', async (name) => {
  await directory(`features/shop/${name}`)
  const result = await scanProject(dirs())
  expect(result.success).toBe(false)
  expect(result).not.toHaveProperty('registry')
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'INVALID_RESOURCE_LOCATION' }),
  )
})
it.each([
  'features/shop/app/features/checkout',
  'features/shop/server/(checkout)',
  '(shop)/app/(checkout)',
])('rejects misplaced nested declaration %s', async (path) => {
  await directory(path)
  const result = await scanProject(dirs())
  expect(result.success).toBe(false)
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'MISPLACED_DECLARATION' }),
  )
  const physical = await discoverFeatures((await resolveRoots(dirs())).roots)
  expect(physical.declarations.some((item) => item.id.endsWith('/checkout'))).toBe(false)
})
it.each([
  'app/features/shop/server/api',
  'server/features/shop/server/api',
  'server/features/shop/app/components',
])('rejects inappropriate runtime wrappers at %s', async (path) => {
  await directory(path)
  expect((await scanProject(dirs())).diagnostics).toContainEqual(
    expect.objectContaining({ code: 'INVALID_SCOPE' }),
  )
})
it.each(['features/shop/shared', '(shop)/shared'])(
  'rejects unsupported shared feature scope at %s',
  async (path) => {
    await directory(path)
    expect((await scanProject(dirs())).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'UNSUPPORTED_SCOPE' }),
    )
  },
)
it('does not touch native shared, native page groups, or unrelated project directories', async () => {
  for (const path of [
    'shared/utils',
    'app/pages/(dashboard)',
    'ordinary/(hidden)/app/components',
    'features/shop/app/pages/(dashboard)/features/not-a-feature',
    'server/features/shop/services/(opaque)',
  ])
    await directory(path)
  const snapshot = registry(await scanProject(dirs()))
  expect(snapshot.features.map((f) => f.id)).toEqual(['shop'])
  expect(
    snapshot.features[0]!.sources.flatMap((source) =>
      source.scopes.flatMap((scope) => scope.resources.map((resource) => resource.name)),
    ),
  ).toEqual(['pages'])
})
it('rejects group/feature kind conflicts rather than making root-level groups feature aliases', async () => {
  await directory('(shop)/app/components')
  await directory('features/shop/server/api')
  expect((await scanProject(dirs())).diagnostics).toContainEqual(
    expect.objectContaining({ code: 'INCOMPATIBLE_DECLARATION' }),
  )
})
it('detects root configuration overlap with a selected root-level group, including symlink aliases', async () => {
  await directory('(shop)/app/components')
  await symlink(root, join(root, 'alias'), 'dir')
  for (const general of ['(shop)', 'alias/(shop)/nested']) {
    const result = await scanProject(dirs(), { general, app: false, server: false })
    expect(result.success).toBe(false)
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'OVERLAPPING_ROOTS' }),
    )
  }
})
it('never follows root-level group symlinks', async () => {
  await directory('outside/app/components')
  await symlink(join(root, 'outside'), join(root, '(shop)'), 'dir')
  expect((await scanProject(dirs())).diagnostics).toContainEqual(
    expect.objectContaining({ code: 'INVALID_ROOT' }),
  )
})
it('keeps nested scope records immutable and rejects forged cross-boundary or shared scopes', async () => {
  await directory('features/shop/app/components')
  await directory('features/shop/server/api')
  const declarations = (await discoverFeatures((await resolveRoots(dirs())).roots)).declarations
  const declaration = declarations[0]!
  const snapshot = registry(buildRegistry(declarations))
  const source = snapshot.features[0]!.sources[0]!
  for (const value of [
    source.scopes,
    ...source.scopes,
    ...source.scopes.map((scope) => scope.resources),
  ])
    expect(Object.isFrozen(value)).toBe(true)
  const app = declaration.source.scopes.find((scope) => scope.kind === 'app')!
  const forged = {
    ...declaration,
    source: {
      ...declaration.source,
      scopes: [
        { ...app, resources: [{ name: 'components', path: join(root, 'server/components') }] },
      ],
    },
  }
  expect(buildRegistry([forged]).success).toBe(false)
  const shared = {
    ...declaration,
    source: {
      ...declaration.source,
      scopes: [
        { kind: 'shared' as const, path: join(declaration.source.path, 'shared'), resources: [] },
      ],
    },
  }
  expect(buildRegistry([shared]).diagnostics).toContainEqual(
    expect.objectContaining({ code: 'UNSUPPORTED_SCOPE' }),
  )
  expect(buildRegistry(declarations)).toEqual(buildRegistry([...declarations].reverse()))
})

it('rejects malformed root-level group names without interpreting ordinary project directories', async () => {
  await directory('(BadName)/app/components')
  await directory('ordinary/app/components')
  const result = await scanProject(dirs())
  expect(result.success).toBe(false)
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'INVALID_DECLARATION' }),
  )
  const discovered = await discoverFeatures((await resolveRoots(dirs())).roots)
  expect(discovered.declarations.some((item) => item.id === 'ordinary')).toBe(false)
})

it.each([
  'app/features/shop/components',
  'features/shop/app',
  'features/shop/server',
  'features/shop/app/components',
  '(shop)/server',
  'features/shop/shared',
])('diagnoses a linked resource or scope at %s without following it', async (path) => {
  await directory('outside/(trap)')
  const link = join(root, path)
  await mkdir(join(link, '..'), { recursive: true })
  await symlink(join(root, 'outside'), link, 'dir')
  const result = await scanProject(dirs())
  expect(result.success).toBe(false)
  expect(result).not.toHaveProperty('registry')
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'SYMLINK_RESOURCE', paths: [expect.stringContaining(path)] }),
  )
})

it('keeps project-group declarations and descendants within their selected subtree', async () => {
  await directory('(shop)/(checkout)/app/components')
  await directory('app/features/(shop)/(checkout)/components')
  const declarations = (await discoverFeatures((await resolveRoots(dirs())).roots)).declarations
  const projectGroup = declarations.find(
    (item) => item.id === 'shop' && item.source.root.discovery === 'project-group',
  )!
  const nestedGroup = declarations.find(
    (item) => item.id === 'shop/checkout' && item.source.root.discovery === 'project-group',
  )!
  expect(
    registry(buildRegistry(declarations)).features.find((item) => item.id === 'shop/checkout')!
      .sources,
  ).toHaveLength(2)
  for (const [item, path] of [
    [projectGroup, join(projectGroup.source.root.path, '(other)')],
    [nestedGroup, projectGroup.source.root.path],
    [nestedGroup, join(root, '(shop-other)', '(checkout)')],
  ] as const) {
    const forged = { ...item, source: { ...item.source, path, scopes: [] } }
    const result = buildRegistry(declarations.map((entry) => (entry === item ? forged : entry)))
    expect(result.success).toBe(false)
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'INVALID_SOURCE_OWNERSHIP' }),
    )
  }
})
