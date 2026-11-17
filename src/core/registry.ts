import { compare } from './conventions.js'
import type { FeatureDeclaration, FeatureDefinition, FeatureRegistry } from './types.js'

export function buildRegistry(declarations: FeatureDeclaration[]): FeatureRegistry {
  const features = new Map<string, FeatureDefinition>()
  const diagnostics: FeatureRegistry['diagnostics'] = []
  const ordered = [...declarations].sort(
    (a, b) =>
      compare(a.id, b.id) ||
      compare(a.source.root.path, b.source.root.path) ||
      compare(a.source.path, b.source.path) ||
      compare(a.kind, b.kind),
  )
  for (const declaration of ordered) {
    const existing = features.get(declaration.id)
    if (!existing) {
      features.set(declaration.id, {
        id: declaration.id,
        name: declaration.name,
        parentId: declaration.parentId,
        kind: declaration.kind,
        origin: 'feature-root',
        sources: [declaration.source],
        children: [],
      })
      continue
    }
    const duplicate = existing.sources.some(
      (source) =>
        source.root.path === declaration.source.root.path &&
        source.root.layer === declaration.source.root.layer,
    )
    if (existing.kind !== declaration.kind || duplicate) {
      diagnostics.push({
        code:
          existing.kind !== declaration.kind ? 'INCOMPATIBLE_DECLARATION' : 'DUPLICATE_DECLARATION',
        severity: 'error',
        featureId: declaration.id,
        message: `Conflicting declarations for feature ${declaration.id}.`,
        paths: [...existing.sources.map((source) => source.path), declaration.source.path],
      })
      continue
    }
    existing.sources.push(declaration.source)
  }
  for (const feature of features.values())
    if (feature.parentId) features.get(feature.parentId)?.children.push(feature.id)
  return { features: [...features.values()], diagnostics }
}
