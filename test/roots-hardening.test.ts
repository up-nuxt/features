import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRoots, scanProject } from '../src/core/index.js'
let project: string
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'features-roots-'))
})
afterEach(async () => {
  await rm(project, { recursive: true, force: true })
})
const dirs = () => ({
  rootDir: project,
  srcDir: join(project, 'app'),
  serverDir: join(project, 'server'),
})
it('detects identical aliased roots both before and after target creation', async () => {
  await symlink(project, join(project, 'alias'), 'dir')
  for (const exists of [false, true]) {
    if (exists) await mkdir(join(project, 'future/deep/features'), { recursive: true })
    const result = await resolveRoots(dirs(), {
      general: 'future/deep/features',
      app: 'alias/future/deep/features',
      server: false,
    })
    expect(result.roots).toEqual([])
    expect(result.diagnostics.map((d) => d.code)).toEqual(['OVERLAPPING_ROOTS'])
    expect(result.diagnostics[0]!.paths[0]).toBe(result.diagnostics[0]!.paths[1])
  }
})
it('detects nested aliased roots with unresolved suffixes and preserves path boundaries', async () => {
  await symlink(project, join(project, 'alias'), 'dir')
  expect(
    (await resolveRoots(dirs(), { general: 'future', app: 'alias/future/nested', server: false }))
      .diagnostics[0]!.code,
  ).toBe('OVERLAPPING_ROOTS')
  const siblings = await resolveRoots(dirs(), {
    general: 'future',
    app: 'alias/future-extra',
    server: false,
  })
  expect(siblings.diagnostics).toEqual([])
  expect(siblings.roots).toHaveLength(2)
})
it('does not expose a registry when root validation fails', async () => {
  const result = await scanProject(dirs(), { general: 'same', app: 'same' })
  expect(result.success).toBe(false)
  expect(result).not.toHaveProperty('registry')
})
it.each(['Shop', '(Checkout)', 'shop_name', 'shop name', '(shop--name)', '123'])(
  'diagnoses invalid physical declaration %s without renaming it',
  async (name) => {
    await mkdir(join(project, 'features', name), { recursive: true })
    const result = await scanProject(dirs())
    expect(result.success).toBe(false)
    expect(result).not.toHaveProperty('registry')
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'INVALID_DECLARATION' }),
    )
  },
)
it('discovers portable nested names without turning group IDs into physical paths', async () => {
  await mkdir(join(project, 'features/shop-v2/(checkout-flow)/features/payment-v2'), {
    recursive: true,
  })
  const result = await scanProject(dirs())
  expect(result.success).toBe(true)
  if (!result.success) throw new Error('Unexpected failure')
  expect(result.registry.features.map((feature) => [feature.id, feature.kind])).toEqual([
    ['shop-v2', 'feature'],
    ['shop-v2/checkout-flow', 'group'],
    ['shop-v2/checkout-flow/payment-v2', 'feature'],
  ])
})
