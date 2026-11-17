export type RootKind = 'general' | 'app' | 'server'
export type DeclarationKind = 'feature' | 'group'
export interface RootDirectories {
  rootDir: string
  srcDir: string
  serverDir: string
}
export type RootOptions = Partial<Record<RootKind, string | false>>
export interface FeatureRoot {
  kind: RootKind
  path: string
  layer?: string
}
export interface Diagnostic {
  code:
    | 'INVALID_ROOT'
    | 'OVERLAPPING_ROOTS'
    | 'IO_ERROR'
    | 'INVALID_DECLARATION'
    | 'DUPLICATE_DECLARATION'
    | 'INCOMPATIBLE_DECLARATION'
  severity: 'error'
  message: string
  paths: string[]
  featureId?: string
}
export interface ResourceDirectory {
  name: string
  path: string
  boundary: 'app' | 'server' | 'shared'
}
export interface FeatureSource {
  root: FeatureRoot
  path: string
  resources: ResourceDirectory[]
}
export interface FeatureDeclaration {
  id: string
  name: string
  parentId?: string
  kind: DeclarationKind
  source: FeatureSource
}
export interface FeatureDefinition {
  id: string
  name: string
  parentId?: string
  kind: DeclarationKind
  origin: 'feature-root' | 'native-pages'
  sources: FeatureSource[]
  children: string[]
}
export interface FeatureRegistry {
  features: FeatureDefinition[]
  diagnostics: Diagnostic[]
}
