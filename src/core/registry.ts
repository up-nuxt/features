import { relative, sep } from 'node:path'
import { compare, featureName } from './conventions.js'
import type {
  Diagnostic,
  FeatureDeclaration,
  FeatureDefinition,
  FeatureSource,
  RegistryBuildResult,
} from './types.js'

const sourceKey = (source: FeatureSource): string =>
  JSON.stringify([
    source.root.kind,
    source.root.layer ?? '',
    relative(source.root.path, source.path).split(sep).join('/'),
  ])
const rootKey = (source: FeatureSource): string =>
  JSON.stringify([source.root.layer ?? '', source.root.path])

function copySource(source: FeatureSource): FeatureSource {
  return Object.freeze({
    root: Object.freeze({ ...source.root }),
    path: source.path,
    resources: Object.freeze(
      source.resources
        .map((resource) => Object.freeze({ ...resource }))
        .sort(
          (a, b) =>
            compare(a.boundary, b.boundary) || compare(a.name, b.name) || compare(a.path, b.path),
        ),
    ),
  })
}

function validIdentity(item: FeatureDeclaration): boolean {
  if (item.kind !== 'feature' && item.kind !== 'group') return false
  if (item.origin === 'feature-root') {
    const segments = item.id.split('/')
    return segments.every((segment) => featureName.test(segment)) && item.name === segments.at(-1)
  }
  // Reserve the native namespace without imposing feature naming rules on Nuxt groups.
  if (item.origin !== 'native-pages' || item.kind !== 'group' || !item.id.startsWith('@pages/'))
    return false
  const segments = item.id.slice('@pages/'.length).split('/')
  const last = segments.at(-1) ?? ''
  return (
    segments.every(
      (segment) =>
        segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes('\\'),
    ) &&
    /^\([^()]+\)$/.test(last) &&
    item.name === last.slice(1, -1)
  )
}

export function buildRegistry(
  declarations: readonly FeatureDeclaration[],
  upstreamDiagnostics: readonly Diagnostic[] = [],
): RegistryBuildResult {
  const diagnostics: Diagnostic[] = [...upstreamDiagnostics]
  const groups = new Map<string, FeatureDeclaration[]>()
  const ordered = [...declarations].sort(
    (a, b) =>
      compare(a.id, b.id) ||
      compare(sourceKey(a.source), sourceKey(b.source)) ||
      compare(a.source.root.path, b.source.root.path) ||
      compare(a.source.path, b.source.path) ||
      compare(a.kind, b.kind) ||
      compare(a.parentId ?? '', b.parentId ?? ''),
  )
  const report = (
    code: Diagnostic['code'],
    message: string,
    items: readonly FeatureDeclaration[],
  ) => {
    diagnostics.push({
      code,
      severity: 'error',
      featureId: items[0]!.id,
      message,
      paths: items.map((item) => item.source.path).sort(compare),
    })
  }
  for (const item of ordered) {
    if (!validIdentity(item))
      report(
        'INVALID_ID',
        `Invalid identity or name for ${item.id}. Module names must use lowercase kebab-case; native groups use the @pages/ namespace.`,
        [item],
      )
    const items = groups.get(item.id) ?? []
    items.push(item)
    groups.set(item.id, items)
  }
  const folded = new Map<string, string>()
  for (const [id, items] of groups) {
    // Native names remain case-sensitive and are not constrained by feature naming policy.
    if (items.some((item) => item.origin === 'feature-root')) {
      const lower = id.toLowerCase()
      const previous = folded.get(lower)
      if (previous && previous !== id)
        report(
          'CASE_COLLISION',
          `Identities ${previous} and ${id} differ only by case. Rename the invalid declaration explicitly.`,
          [...groups.get(previous)!, ...items],
        )
      else folded.set(lower, id)
    }
    if (new Set(items.map((item) => `${item.origin}:${item.kind}`)).size > 1)
      report(
        'INCOMPATIBLE_DECLARATION',
        `Conflicting declaration kinds or origins for ${id}.`,
        items,
      )
    if (new Set(items.map((item) => item.parentId)).size > 1)
      report('CONFLICTING_PARENT', `Conflicting structural parents for ${id}.`, items)
    const roots = new Map<string, FeatureDeclaration[]>()
    for (const item of items) {
      const key = rootKey(item.source)
      const duplicates = roots.get(key) ?? []
      duplicates.push(item)
      roots.set(key, duplicates)
    }
    for (const duplicates of roots.values())
      if (duplicates.length > 1)
        report(
          'DUPLICATE_DECLARATION',
          `Competing declarations for ${id} in the same root.`,
          duplicates,
        )
    for (const item of items) {
      if (item.parentId !== undefined && !groups.has(item.parentId))
        report(
          'MISSING_PARENT',
          `Structural parent ${item.parentId} for ${id} is not registered.`,
          [item],
        )
      let expected: string | undefined
      if (item.origin === 'feature-root') {
        const end = id.lastIndexOf('/')
        expected = end < 0 ? undefined : id.slice(0, end)
      } else {
        expected = [...groups.entries()]
          .filter(
            ([candidate, entries]) =>
              entries.some((entry) => entry.origin === 'native-pages' && entry.kind === 'group') &&
              id.startsWith(`${candidate}/`),
          )
          .map(([candidate]) => candidate)
          .sort((a, b) => b.length - a.length || compare(a, b))[0]
      }
      if (item.parentId !== expected)
        report('INVALID_PARENT', `Structural parent for ${id} must be ${expected ?? 'absent'}.`, [
          item,
        ])
    }
  }
  // Inspect every declared parent edge, including conflicts, so diagnostics retain cycles.
  const colors = new Map<string, 'active' | 'done'>()
  for (const start of groups.keys()) {
    if (colors.has(start)) continue
    const stack = [{ id: start, exit: false }]
    while (stack.length) {
      const frame = stack.pop()!
      if (frame.exit) {
        colors.set(frame.id, 'done')
        continue
      }
      if (colors.get(frame.id) === 'done') continue
      if (colors.get(frame.id) === 'active') {
        report(
          'CYCLIC_PARENT',
          `Cyclic structural parent relationship involving ${frame.id}.`,
          groups.get(frame.id)!,
        )
        continue
      }
      colors.set(frame.id, 'active')
      stack.push({ id: frame.id, exit: true })
      const parents = [
        ...new Set(
          groups
            .get(frame.id)!
            .map((item) => item.parentId)
            .filter((id): id is string => id !== undefined && groups.has(id)),
        ),
      ].sort(compare)
      for (const parent of parents.reverse()) stack.push({ id: parent, exit: false })
    }
  }
  const frozenDiagnostics = Object.freeze(
    diagnostics
      .map((diagnostic) =>
        Object.freeze({ ...diagnostic, paths: Object.freeze([...diagnostic.paths]) }),
      )
      .sort(
        (a, b) =>
          compare(a.featureId ?? '', b.featureId ?? '') ||
          compare(a.code, b.code) ||
          compare(a.message, b.message) ||
          compare(JSON.stringify(a.paths), JSON.stringify(b.paths)),
      ),
  )
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
    return Object.freeze({ success: false, diagnostics: frozenDiagnostics })
  const children = new Map<string, string[]>()
  for (const id of groups.keys()) children.set(id, [])
  for (const [id, items] of groups)
    if (items[0]!.parentId) children.get(items[0]!.parentId)!.push(id)
  const features: FeatureDefinition[] = [...groups.entries()].map(([id, items]) => {
    const first = items[0]!
    return Object.freeze({
      id,
      name: first.name,
      kind: first.kind,
      origin: first.origin,
      parentId: first.parentId,
      sources: Object.freeze(items.map((item) => copySource(item.source))),
      children: Object.freeze(children.get(id)!.sort(compare)),
    })
  })
  return Object.freeze({
    success: true,
    registry: Object.freeze({ features: Object.freeze(features) }),
    diagnostics: frozenDiagnostics,
  })
}
