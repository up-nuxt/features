import { expect, it } from 'vitest'
import { createRoutingPolicy } from '../src/core/routing.js'
import type { FeatureDefinition } from '../src/core/types.js'

it('preserves ancestor order and applies independent Feature and structural Group switches', () => {
  const declaration = (
    id: string,
    name: string,
    kind: FeatureDefinition['kind'],
    parentId?: string,
  ): FeatureDefinition => ({
    id,
    name,
    kind,
    parentId,
    origin: 'feature-root',
    children: [],
    sources: [],
  })
  const registry = {
    features: [
      declaration('shop/admin/inventory', 'inventory', 'feature', 'shop/admin'),
      declaration('shop', 'shop', 'feature'),
      declaration('shop/admin', 'admin', 'group', 'shop'),
    ],
  }
  expect(createRoutingPolicy(registry)('shop/admin/inventory')).toEqual(['shop', 'inventory'])
  expect(
    createRoutingPolicy(registry, {
      groupPrefix: true,
      overrides: { features: { shop: 'none' } },
    })('shop/admin/inventory'),
  ).toEqual(['admin', 'inventory'])
  expect(
    createRoutingPolicy(registry, {
      prefix: 'none',
      groupPrefix: true,
      overrides: {
        groups: { 'shop/admin': false },
        features: { 'shop/admin/inventory': 'feature' },
      },
    })('shop/admin/inventory'),
  ).toEqual(['inventory'])
})
