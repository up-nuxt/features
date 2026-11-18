import { expect, it } from 'vitest'
import { getComposableDirectories } from '../src/integrations/composables.js'
import type { FeatureDefinition, FeatureSource } from '../src/core/types.js'

it('selects unique composable directories from App scopes regardless of source layout', () => {
  const fullStack: FeatureSource = {
    featureId: 'shop',
    root: { kind: 'general', discovery: 'feature-container', path: '/project/features' },
    path: '/project/features/shop',
    layout: 'full-stack',
    scopes: [
      {
        kind: 'server',
        path: '/project/features/shop/server',
        resources: [{ name: 'api', path: '/project/features/shop/server/api' }],
      },
      {
        kind: 'app',
        path: '/project/features/shop/app',
        resources: [
          { name: 'components', path: '/project/features/shop/app/components' },
          { name: 'composables', path: '/project/features/shop/app/composables' },
        ],
      },
    ],
  }
  const app: FeatureSource = {
    featureId: 'shop',
    root: { kind: 'app', discovery: 'feature-container', path: '/project/app/features' },
    path: '/project/app/features/shop',
    layout: 'app',
    scopes: [
      {
        kind: 'app',
        path: '/project/app/features/shop',
        resources: [{ name: 'composables', path: '/project/app/features/shop/composables' }],
      },
    ],
  }
  const entry: FeatureDefinition = {
    id: 'shop',
    name: 'shop',
    kind: 'feature',
    origin: 'feature-root',
    sources: [fullStack, app, fullStack],
    children: [],
  }
  expect(getComposableDirectories({ features: [entry] })).toEqual([
    '/project/app/features/shop/composables',
    '/project/features/shop/app/composables',
  ])
})
