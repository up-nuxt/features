import { describe, expect, it } from 'vitest'
import { buildRegistry } from '../src/core/registry.js'
import { createCollisionGuard, getComponentDirectories } from '../src/integrations/components.js'
import type { DeclarationKind, FeatureDeclaration, RootKind } from '../src/core/types.js'
function declaration(
  id: string,
  kind: DeclarationKind = 'feature',
  rootKind: RootKind = 'general',
): FeatureDeclaration {
  return {
    id,
    name: id.split('/').at(-1)!,
    kind,
    origin: 'feature-root',
    parentId: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : undefined,
    source: {
      featureId: id,
      root: { kind: rootKind, path: `/project/${rootKind}`, discovery: 'feature-container' },
      path: `/project/${rootKind}/${id}`,
      layout: rootKind === 'general' ? 'full-stack' : rootKind,
      scopes: [
        {
          kind: rootKind === 'server' ? 'server' : 'app',
          path: `/project/${rootKind}/${id}${rootKind === 'general' ? '/app' : ''}`,
          resources: [
            {
              name: rootKind === 'server' ? 'api' : 'components',
              path: `/project/${rootKind}/${id}${rootKind === 'general' ? '/app' : ''}/${rootKind === 'server' ? 'api' : 'components'}`,
            },
          ],
        },
      ],
    },
  }
}
function directories(items: FeatureDeclaration[], prefix = true) {
  const result = buildRegistry(items)
  if (!result.success) throw new Error(JSON.stringify(result.diagnostics))
  return getComponentDirectories(result.registry, prefix)
}
describe('component directory projection', () => {
  it('preserves general/app sources and excludes server sources', () => {
    const result = directories([
      declaration('shop'),
      declaration('shop', 'feature', 'app'),
      declaration('shop', 'feature', 'server'),
    ])
    expect(result.map((dir) => dir.path)).toEqual([
      '/project/app/shop/components',
      '/project/general/shop/app/components',
    ])
    expect(result.map((dir) => dir.prefix)).toEqual(['shop', 'shop'])
  })
  it('uses only structural feature ancestors, skipping arbitrary nested groups', () => {
    const result = directories([
      declaration('shop'),
      declaration('shop/checkout', 'group'),
      declaration('shop/checkout/payment', 'group'),
      declaration('shop/checkout/payment/inventory'),
    ])
    expect(result.map((dir) => dir.prefix)).toEqual(['shop', 'shop', 'shop', 'shop-inventory'])
  })
  it('does not namespace a top-level group', () => {
    expect(directories([declaration('dashboard', 'group')])[0]!.prefix).toBe('')
  })
  it('allows disabling feature prefixes independently of native path prefixes', () => {
    expect(directories([declaration('shop')], false)[0]!.prefix).toBe('')
  })
  it('ignores absent component resources and server boundaries even in app sources', () => {
    const item = declaration('shop')
    expect(directories([{ ...item, source: { ...item.source, scopes: [] } }])).toEqual([])
    const server = declaration('shop', 'feature', 'server')
    expect(directories([server])).toEqual([])
  })
})
describe('Nuxt-computed name collision validation', () => {
  it('rejects matching names across feature/group directories and preserves both paths', () => {
    const guard = createCollisionGuard([
      '/features/shop/app/components',
      '/features/shop/(checkout)/app/components',
    ])
    guard.observe({
      pascalName: 'ShopButton',
      filePath: '/features/shop/app/components/Button.vue',
      mode: 'all',
    })
    expect(() =>
      guard.observe({
        pascalName: 'ShopButton',
        filePath: '/features/shop/(checkout)/app/components/Button.vue',
        mode: 'all',
      }),
    ).toThrow('FEATURE_COMPONENT_COLLISION')
  })
  it('detects native/feature collisions in either scan order', () => {
    const components = [
      {
        pascalName: 'ShopButton',
        filePath: '/app/components/ShopButton.vue',
        mode: 'all' as const,
      },
      {
        pascalName: 'ShopButton',
        filePath: '/features/shop/app/components/Button.vue',
        mode: 'all' as const,
      },
    ]
    for (const items of [components, [...components].reverse()]) {
      const guard = createCollisionGuard(['/features/shop/app/components'])
      guard.observe(items[0]!)
      expect(() => guard.observe(items[1]!)).toThrow('ShopButton')
    }
  })
  it('preserves complementary native client/server variants', () => {
    const guard = createCollisionGuard(['/features/shop/app/components'])
    guard.observe({
      pascalName: 'ShopButton',
      filePath: '/features/shop/app/components/Button.client.vue',
      mode: 'client',
    })
    expect(() =>
      guard.observe({
        pascalName: 'ShopButton',
        filePath: '/features/shop/app/components/Button.server.vue',
        mode: 'server',
      }),
    ).not.toThrow()
  })
  it('rejects an all-mode file overlapping a client or server variant', () => {
    const guard = createCollisionGuard(['/features/shop/app/components'])
    guard.observe({
      pascalName: 'ShopButton',
      filePath: '/features/shop/app/components/Button.client.vue',
      mode: 'client',
    })
    expect(() =>
      guard.observe({
        pascalName: 'ShopButton',
        filePath: '/features/shop/app/components/Button.vue',
        mode: 'all',
      }),
    ).toThrow('FEATURE_COMPONENT_COLLISION')
  })
  it('ignores repeated files, resets between scans and preserves native-only behavior', () => {
    const guard = createCollisionGuard(['/features/shop/app/components'])
    const item = { pascalName: 'ShopButton', filePath: '/features/shop/app/components/Button.vue' }
    guard.observe(item)
    expect(() => guard.observe(item)).not.toThrow()
    guard.reset()
    expect(() => guard.observe(item)).not.toThrow()
    guard.observe({ pascalName: 'Native', filePath: '/app/components/Native.vue' })
    expect(() =>
      guard.observe({ pascalName: 'Native', filePath: '/layer/components/Native.vue' }),
    ).not.toThrow()
  })
})
