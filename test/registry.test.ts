import { describe, expect, it } from 'vitest'
import { buildRegistry } from '../src/core/registry.js'
import type {
  FeatureDeclaration,
  RegistryBuildResult,
  RootKind,
  RuntimeLayout,
} from '../src/core/types.js'

function declaration(id: string, rootKind: RootKind = 'general', root = `/project/${rootKind}`) {
  const segments = id.split('/')
  return {
    id,
    name: segments.at(-1)!,
    parentId: segments.length > 1 ? segments.slice(0, -1).join('/') : undefined,
    kind: 'feature' as const,
    origin: 'feature-root' as const,
    source: {
      featureId: id,
      root: { kind: rootKind, path: root, discovery: 'feature-container' as const },
      path: `${root}/${id}`,
      layout: (rootKind === 'general' ? 'full-stack' : rootKind) as RuntimeLayout,
      scopes: [
        {
          kind: rootKind === 'server' ? ('server' as const) : ('app' as const),
          path: `${root}/${id}${rootKind === 'general' ? '/app' : ''}`,
          resources: [
            {
              name: rootKind === 'server' ? 'api' : 'components',
              path: `${root}/${id}${rootKind === 'general' ? '/app' : ''}/${rootKind === 'server' ? 'api' : 'components'}`,
            },
          ],
        },
      ],
    },
  }
}
function registry(result: RegistryBuildResult) {
  expect(result.success, JSON.stringify(result.diagnostics)).toBe(true)
  if (!result.success) throw new Error('Expected successful registry')
  return result.registry
}
function failure(items: readonly FeatureDeclaration[], code: string) {
  const result = buildRegistry(items)
  expect(result.success).toBe(false)
  expect(result).not.toHaveProperty('registry')
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code)
  return result
}
const native = (id: string, parentId?: string): FeatureDeclaration => ({
  id,
  name: id.split('/').at(-1)!.slice(1, -1),
  kind: 'group',
  origin: 'native-pages',
  parentId,
  source: {
    featureId: id,
    root: { kind: 'app', path: '/project/app/pages', discovery: 'native-pages' },
    path: `/project/app/pages/${id.slice(7)}`,
    layout: 'app',
    scopes: [],
  },
})

describe('validated registry results', () => {
  it('returns explicit success for an empty registry', () => {
    expect(buildRegistry([])).toEqual({
      success: true,
      registry: { features: [] },
      diagnostics: [],
    })
  })
  it('merges all compatible sources and resources without precedence', () => {
    const input = [declaration('shop', 'server'), declaration('shop'), declaration('shop', 'app')]
    const entry = registry(buildRegistry(input)).features[0]!
    expect(entry.sources.map((source) => source.root.kind)).toEqual(['app', 'general', 'server'])
    expect(entry.sources.flatMap((source) => source.scopes[0]!.resources)).toHaveLength(3)
    expect(buildRegistry(input)).toEqual(buildRegistry([...input].reverse()))
  })
  it('retains both conflict paths when kinds conflict', () => {
    const a = declaration('shop'),
      b = { ...declaration('shop', 'app'), kind: 'group' as const }
    expect(failure([a, b], 'INCOMPATIBLE_DECLARATION').diagnostics[0]!.paths).toEqual(
      [a.source.path, b.source.path].sort(),
    )
  })
  it('reports duplicates even when kinds also conflict', () => {
    const a = declaration('shop')
    const result = failure([a, { ...a, kind: 'group' }], 'DUPLICATE_DECLARATION')
    expect(result.diagnostics.map((d) => d.code)).toContain('INCOMPATIBLE_DECLARATION')
  })
  it('rejects conflicting parent declarations across roots', () => {
    failure(
      [
        declaration('shop'),
        declaration('shop/checkout'),
        { ...declaration('shop/checkout', 'app'), parentId: 'other' },
      ],
      'CONFLICTING_PARENT',
    )
  })
  it('requires a registered parent for nested feature identities', () => {
    failure([declaration('shop/checkout')], 'MISSING_PARENT')
    failure([{ ...declaration('shop/checkout'), parentId: undefined }], 'INVALID_PARENT')
  })
  it('rejects skipped ancestors, unrelated parents, and parents on top-level identities', () => {
    failure(
      [declaration('shop'), { ...declaration('shop/checkout/payment'), parentId: 'shop' }],
      'INVALID_PARENT',
    )
    failure(
      [declaration('other'), { ...declaration('shop/checkout'), parentId: 'other' }],
      'INVALID_PARENT',
    )
    failure([{ ...declaration('shop'), parentId: 'other' }, declaration('other')], 'INVALID_PARENT')
  })
  it('rejects self-cycles and multi-node cycles', () => {
    failure([{ ...declaration('shop'), parentId: 'shop' }], 'CYCLIC_PARENT')
    failure(
      [
        { ...declaration('shop'), parentId: 'other' },
        { ...declaration('other'), parentId: 'shop' },
      ],
      'CYCLIC_PARENT',
    )
  })
  it('detects cycles even when another declaration gives the same ID a different parent', () => {
    failure(
      [
        declaration('shop'),
        { ...declaration('shop', 'app'), parentId: 'other' },
        { ...declaration('other'), parentId: 'shop' },
      ],
      'CYCLIC_PARENT',
    )
  })
  it('keeps sorted structural children without duplicates across roots', () => {
    const input = [
      declaration('shop'),
      declaration('shop', 'app'),
      declaration('shop/z'),
      declaration('shop/a'),
      declaration('shop/a', 'app'),
    ]
    expect(registry(buildRegistry(input)).features[0]!.children).toEqual(['shop/a', 'shop/z'])
  })
  it.each([
    'Shop',
    'shop_name',
    'shop name',
    ' shop',
    'shop-',
    'shop--name',
    '123',
    'shop//checkout',
    'shop/../checkout',
    '@pages/(shop)',
    'فروشگاه',
  ])('rejects invalid module ID %s without normalization', (id) => {
    failure([declaration(id)], 'INVALID_ID')
  })
  it('reports case-related identity collisions', () => {
    failure([declaration('shop'), declaration('Shop', 'app')], 'CASE_COLLISION')
  })
  it('requires the declaration name to match its identity', () => {
    failure([{ ...declaration('shop'), name: 'other' }], 'INVALID_ID')
  })
  it('does not share mutable source, root, resource or array references with input', () => {
    const input = declaration('shop')
    const snapshot = registry(buildRegistry([input]))
    input.source.root.path = '/changed'
    input.source.scopes[0]!.resources[0]!.path = '/changed'
    input.source.scopes[0]!.resources.push({ name: 'pages', path: '/new' })
    expect(snapshot.features[0]!.sources[0]!.root.path).toBe('/project/general')
    expect(snapshot.features[0]!.sources[0]!.scopes[0]!.resources).toHaveLength(1)
    expect(snapshot.features[0]!.sources[0]!.scopes[0]!.resources[0]!.path).toBe(
      '/project/general/shop/app/components',
    )
  })
  it('freezes every exposed snapshot container and record at runtime', () => {
    const result = buildRegistry([declaration('shop'), declaration('shop/checkout')])
    const snapshot = registry(result),
      feature = snapshot.features[0]!,
      source = feature.sources[0]!
    for (const value of [
      result,
      result.diagnostics,
      snapshot,
      snapshot.features,
      feature,
      feature.sources,
      feature.children,
      source,
      source.root,
      source.scopes,
      source.scopes[0]!,
      source.scopes[0]!.resources,
      source.scopes[0]!.resources[0]!,
    ])
      expect(Object.isFrozen(value)).toBe(true)
    expect(Reflect.set(source.root, 'path', '/corrupted')).toBe(false)
    expect(Reflect.set(source.scopes[0]!.resources, '0', {})).toBe(false)
  })
  it('warnings allow success, errors deny a registry; diagnostics are detached and frozen', () => {
    const warning = {
      code: 'IO_ERROR' as const,
      severity: 'warning' as const,
      message: 'Upstream warning',
      paths: ['/source'],
    }
    const result = buildRegistry([], [warning])
    expect(result.success).toBe(true)
    warning.paths.push('/later')
    expect(result.diagnostics[0]!.paths).toEqual(['/source'])
    expect(Object.isFrozen(result.diagnostics[0]!.paths)).toBe(true)
    expect(buildRegistry([], [{ ...warning, severity: 'error' }])).not.toHaveProperty('registry')
  })
  it('does not derive source order from absolute project location', () => {
    for (const [generalRoot, appRoot] of [
      ['/a/general', '/z/app'],
      ['/z/general', '/a/app'],
    ]) {
      const entries = [
        declaration('shop', 'general', generalRoot),
        declaration('shop', 'app', appRoot),
      ]
      expect(
        registry(buildRegistry(entries)).features[0]!.sources.map((source) => source.root.kind),
      ).toEqual(['app', 'general'])
    }
  })
})

describe('native group identity contract (no page discovery)', () => {
  it('preserves regular directory segments without requiring synthetic parents', () => {
    const items = [
      native('@pages/admin/(dashboard)'),
      native('@pages/(admin)'),
      native('@pages/(admin)/(dashboard)', '@pages/(admin)'),
    ]
    const snapshot = registry(buildRegistry(items))
    expect(
      snapshot.features.find((f) => f.id === '@pages/admin/(dashboard)')!.parentId,
    ).toBeUndefined()
    expect(snapshot.features.find((f) => f.id === '@pages/(admin)')!.children).toEqual([
      '@pages/(admin)/(dashboard)',
    ])
  })
  it('requires the nearest registered native ancestor group', () => {
    const a = native('@pages/(admin)'),
      b = native('@pages/(admin)/regular/(nested)', a.id)
    registry(buildRegistry([a, b]))
    failure([a, { ...b, parentId: undefined }], 'INVALID_PARENT')
    failure([a, b, native('@pages/(admin)/regular/(nested)/(child)', a.id)], 'INVALID_PARENT')
  })
  it('does not impose kebab-case or fold native group case', () => {
    registry(
      buildRegistry([
        native('@pages/(Dashboard)'),
        native('@pages/(dashboard)'),
        native('@pages/[tenant]/(گروه)'),
      ]),
    )
  })
  it('keeps feature and native group identities separate', () => {
    const snapshot = registry(
      buildRegistry([{ ...declaration('dashboard'), kind: 'group' }, native('@pages/(dashboard)')]),
    )
    expect(snapshot.features).toHaveLength(2)
    expect(snapshot.features.every((feature) => feature.parentId === undefined)).toBe(true)
  })
})

it('produces the same failed result for reversed conflicting input', () => {
  const items = [
    declaration('shop'),
    { ...declaration('shop', 'app'), kind: 'group' as const },
    { ...declaration('shop', 'server'), parentId: 'shop' },
  ]
  expect(buildRegistry(items)).toEqual(buildRegistry([...items].reverse()))
})
it('has deterministic ordering even when sources have the same logical root role', () => {
  const items = [
    declaration('shop', 'general', '/project/z'),
    declaration('shop', 'general', '/project/a'),
  ]
  expect(buildRegistry(items)).toEqual(buildRegistry([...items].reverse()))
})
it('exposes read-only snapshot types', () => {
  const snapshot = registry(buildRegistry([declaration('shop')]))
  // Checked by tsc; keep mutation attempts unreachable at runtime.
  if (false) {
    // @ts-expect-error Registry arrays are read-only.
    snapshot.features.push(snapshot.features[0]!)
    // @ts-expect-error Source root fields are read-only.
    snapshot.features[0]!.sources[0]!.root.path = '/changed'
    // @ts-expect-error Nested resource arrays are read-only.
    snapshot.features[0]!.sources[0]!.scopes[0]!.resources.pop()
  }
})

it('validates source ownership and runtime scope layout independently from logical merge identity', () => {
  const item = declaration('shop')
  failure([{ ...item, source: { ...item.source, featureId: 'other' } }], 'INVALID_ID')
  failure([{ ...item, source: { ...item.source, layout: 'app' } }], 'INVALID_SCOPE')
  const app = declaration('shop', 'app')
  failure(
    [
      {
        ...app,
        source: {
          ...app.source,
          scopes: [{ kind: 'server', path: app.source.path, resources: [] }],
        },
      },
    ],
    'INVALID_SCOPE',
  )
})
it('copies scope paths, kinds and resource lists without retaining mutable input records', () => {
  const input = declaration('shop')
  const snapshot = registry(buildRegistry([input]))
  input.source.scopes[0]!.path = '/changed'
  input.source.scopes[0]!.kind = 'server'
  input.source.scopes.length = 0
  const source = snapshot.features[0]!.sources[0]!
  expect(source.featureId).toBe('shop')
  expect(source.scopes).toHaveLength(1)
  expect(source.scopes[0]!.kind).toBe('app')
  expect(source.scopes[0]!.path).toBe('/project/general/shop/app')
  expect(Reflect.set(source.scopes[0]!, 'kind', 'server')).toBe(false)
})

it('rejects declarations outside their claimed root even when scopes match the source', () => {
  const item = declaration('shop', 'app', '/repo/app/features')
  for (const path of [
    '/repo/server/features/shop',
    '/repo/app/features-other/shop',
    item.source.root.path,
  ]) {
    failure(
      [
        {
          ...item,
          source: {
            ...item.source,
            path,
            scopes: [
              {
                kind: 'app',
                path,
                resources: [{ name: 'components', path: path + '/components' }],
              },
            ],
          },
        },
      ],
      'INVALID_SOURCE_OWNERSHIP',
    )
  }
})

it('validates native page-group ownership against the relative page hierarchy', () => {
  const item = native('@pages/admin/(dashboard)')
  registry(buildRegistry([item]))
  for (const path of ['/project/other/admin/(dashboard)', '/project/app/pages/(dashboard)'])
    failure([{ ...item, source: { ...item.source, path } }], 'INVALID_SOURCE_OWNERSHIP')
  failure(
    [
      {
        ...item,
        source: { ...item.source, root: { ...item.source.root, discovery: 'feature-container' } },
      },
    ],
    'INVALID_SOURCE_OWNERSHIP',
  )
})
