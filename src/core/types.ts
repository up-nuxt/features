export type RootKind = 'general' | 'app' | 'server'
export type RuntimeLayout = 'app' | 'server' | 'full-stack'
/** Shared is reserved; currently rejected by discovery and registry validation. */
export type ScopeKind = 'app' | 'server' | 'shared'
export type DiscoveryOrigin = 'feature-container' | 'project-group' | 'native-pages'
export type DeclarationKind = 'feature' | 'group'
export type DeclarationOrigin = 'feature-root' | 'native-pages'
export interface RootDirectories {
  readonly rootDir: string
  readonly srcDir: string
  readonly serverDir: string
}
export type RootOptions = Partial<Record<RootKind, string | false>>
export interface FeatureRoot {
  readonly discovery: DiscoveryOrigin
  readonly kind: RootKind
  readonly path: string
  readonly layer?: string
}
export interface Diagnostic {
  readonly code:
    | 'INVALID_ROOT'
    | 'OVERLAPPING_ROOTS'
    | 'IO_ERROR'
    | 'INVALID_DECLARATION'
    | 'DUPLICATE_DECLARATION'
    | 'INCOMPATIBLE_DECLARATION'
    | 'INVALID_ID'
    | 'CASE_COLLISION'
    | 'CONFLICTING_PARENT'
    | 'INVALID_PARENT'
    | 'MISSING_PARENT'
    | 'CYCLIC_PARENT'
    | 'INVALID_RESOURCE_LOCATION'
    | 'MISPLACED_DECLARATION'
    | 'UNSUPPORTED_SCOPE'
    | 'INVALID_SCOPE'
    | 'INVALID_SOURCE_OWNERSHIP'
    | 'SYMLINK_RESOURCE'
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly paths: readonly string[]
  readonly featureId?: string
}
export interface ResourceDirectory {
  readonly name: string
  readonly path: string
}
export interface ResourceScope {
  readonly kind: ScopeKind
  readonly path: string
  readonly resources: readonly ResourceDirectory[]
}
export interface FeatureSource {
  readonly featureId: string
  readonly layout: RuntimeLayout
  readonly root: FeatureRoot
  readonly path: string
  readonly scopes: readonly ResourceScope[]
}
/** A physical declaration. Scanner output is untrusted until registry validation succeeds. */
export interface FeatureDeclaration {
  readonly id: string
  readonly name: string
  readonly parentId?: string
  readonly kind: DeclarationKind
  readonly origin: DeclarationOrigin
  readonly source: FeatureSource
}
/** Structural hierarchy only; parentId does not describe resource membership. */
export interface FeatureDefinition {
  readonly id: string
  readonly name: string
  readonly parentId?: string
  readonly kind: DeclarationKind
  readonly origin: DeclarationOrigin
  readonly sources: readonly FeatureSource[]
  readonly children: readonly string[]
}
/** Future membership projection, independent of a resource's structural owner. No resolver yet. */
export interface ResourceMembership {
  readonly path: string
  readonly scopeIds: readonly string[]
}
export interface FeatureRegistry {
  readonly features: readonly FeatureDefinition[]
}
export type RegistryBuildResult =
  | {
      readonly success: true
      readonly registry: FeatureRegistry
      readonly diagnostics: readonly Diagnostic[]
    }
  | { readonly success: false; readonly diagnostics: readonly Diagnostic[] }
