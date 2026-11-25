import type { FeatureRegistry } from '../core/types.js'
import type { DeclarationAvailability, FlagBinding } from '../runtime/server/policy.js'
import type { RouteMembershipSnapshot } from './page-membership.js'

export interface FlagBindingOptions {
  key: string
  defaultValue?: boolean
}

export interface FlagsOptions {
  enabled?: boolean
  serverClient?: string
  bindings?: Record<string, FlagBindingOptions>
}

function reject(message: string): never {
  throw new Error(`[FEATURE_FLAGS_CONFIG] ${message}.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function readFlagBindings(value: unknown): ReadonlyMap<string, FlagBinding> {
  if (value === undefined) return new Map()
  if (!isRecord(value)) reject('feature.flags.bindings must be an object')
  const bindings = new Map<string, FlagBinding>()
  for (const [id, entry] of Object.entries(value)) {
    const label = `feature.flags.bindings[${JSON.stringify(id)}]`
    if (!isRecord(entry)) reject(`${label} must be an object`)
    for (const field of Object.keys(entry)) {
      if (field !== 'key' && field !== 'defaultValue')
        reject(`${label} contains unknown field ${JSON.stringify(field)}`)
    }
    const { key, defaultValue = false } = entry
    if (typeof key !== 'string' || !key || key !== key.trim() || /[\x00-\x1f\x7f]/.test(key))
      reject(`${label}.key must be a nonempty flag key without surrounding whitespace or control characters`)
    if (typeof defaultValue !== 'boolean') reject(`${label}.defaultValue must be a boolean`)
    bindings.set(id, Object.freeze({ key, defaultValue }))
  }
  return bindings
}

export function compileFlagBindings(
  registry: FeatureRegistry,
  bindings: ReadonlyMap<string, FlagBinding>,
  membership?: RouteMembershipSnapshot,
): readonly DeclarationAvailability[] {
  const declarations = (membership?.registry ?? registry).features
  const byId = new Map(declarations.map((entry) => [entry.id, entry]))
  for (const id of bindings.keys()) {
    if (!byId.has(id)) {
      const kind = id.startsWith('@pages') ? 'native Group' : 'declaration'
      reject(`feature.flags.bindings references unknown ${kind} ${JSON.stringify(id)}`)
    }
  }

  // Each qualified native Group already records the App owner through its Page sources.
  const nativeOwners = new Map<string, string>()
  for (const route of membership?.routes ?? []) {
    for (const source of route.sources) {
      const owner = source.origin.ownerId
      if (!owner) continue
      for (const group of source.nativeGroups) nativeOwners.set(group.id, owner)
    }
  }

  function chain(id: string): FlagBinding[] {
    const effective: FlagBinding[] = []
    let declaration = byId.get(id)
    while (declaration) {
      const binding = bindings.get(declaration.id)
      if (binding) effective.push(binding)
      declaration = declaration.parentId ? byId.get(declaration.parentId) : undefined
    }
    return effective.reverse()
  }

  return Object.freeze(
    declarations.map(({ id, kind }) => {
      const owner = nativeOwners.get(id)
      const effective = owner ? chain(owner).concat(chain(id)) : chain(id)
      return Object.freeze({ id, kind, bindings: Object.freeze(effective) })
    }),
  )
}
