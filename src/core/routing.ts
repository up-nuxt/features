import type { FeatureRegistry } from './types.js'

export type FeaturePrefix = 'feature' | 'none'

export interface RoutingOptions {
  prefix?: FeaturePrefix
  groupPrefix?: boolean
  overrides?: {
    features?: Record<string, FeaturePrefix>
    groups?: Record<string, boolean>
  }
}

function reject(option: string, reason: string): never {
  throw new Error(
    `[FEATURE_ROUTING_CONFIG] feature.routing${option ? '.' + option : ''} ${reason}.`,
  )
}

function record(value: unknown, option: string, keys?: readonly string[]) {
  if (value === undefined) return {}
  if (
    value === null ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    reject(option, 'must be an object')
  const entries = Object.entries(value)
  for (const [key] of entries)
    if (keys && !keys.includes(key)) reject(option ? `${option}.${key}` : key, 'is unknown')
  return Object.fromEntries(entries) as Record<string, unknown>
}

/** Resolve ordered declaration segments independently of the router or runtime scope. */
export function createRoutingPolicy(registry: FeatureRegistry, options?: RoutingOptions) {
  const {
    prefix = 'feature',
    groupPrefix = false,
    overrides,
  } = record(options, '', ['prefix', 'groupPrefix', 'overrides'])
  if (prefix !== 'feature' && prefix !== 'none') reject('prefix', 'must be "feature" or "none"')
  if (typeof groupPrefix !== 'boolean') reject('groupPrefix', 'must be a boolean')

  const { features, groups } = record(overrides, 'overrides', ['features', 'groups'])
  const declarations = new Map(
    registry.features
      .filter((entry) => entry.origin === 'feature-root')
      .map((entry) => [entry.id, entry]),
  )
  const overridesById = new Map<string, boolean>()
  for (const [kind, entries] of [
    ['feature', features],
    ['group', groups],
  ] as const) {
    const option = `overrides.${kind}s`
    for (const [id, value] of Object.entries(record(entries, option))) {
      const key = `${option}[${JSON.stringify(id)}]`
      const declaration = declarations.get(id)
      if (!declaration) reject(key, `references unknown declaration ${JSON.stringify(id)}`)
      if (declaration.kind !== kind)
        reject(
          key,
          `requires a structural ${kind}, but ${JSON.stringify(id)} is a ${declaration.kind}`,
        )
      if (kind === 'feature' && value !== 'feature' && value !== 'none')
        reject(key, 'must be "feature" or "none"')
      if (kind === 'group' && typeof value !== 'boolean') reject(key, 'must be a boolean')
      overridesById.set(id, value === 'feature' || value === true)
    }
  }

  return (ownerId: string): readonly string[] => {
    const segments: string[] = []
    let declaration = declarations.get(ownerId)
    if (!declaration) throw new Error(`Unknown routing owner ${JSON.stringify(ownerId)}.`)
    do {
      const enabled =
        overridesById.get(declaration.id) ??
        (declaration.kind === 'feature' ? prefix === 'feature' : groupPrefix)
      if (enabled) segments.push(declaration.name)
      declaration = declaration.parentId ? declarations.get(declaration.parentId) : undefined
    } while (declaration)
    return segments.reverse()
  }
}
