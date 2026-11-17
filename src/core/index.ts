import { resolveRoots } from './roots.js'
import { discoverFeatures } from './scanner.js'
import { buildRegistry } from './registry.js'
import type { FeatureRegistry, RootDirectories, RootOptions } from './types.js'
export type * from './types.js'
export { resolveRoots, discoverFeatures, buildRegistry }
export async function scanProject(
  dirs: RootDirectories,
  options: RootOptions = {},
): Promise<FeatureRegistry> {
  const resolved = await resolveRoots(dirs, options)
  const discovered = await discoverFeatures(resolved.roots)
  const registry = buildRegistry(discovered.declarations)
  return {
    features: registry.features,
    diagnostics: [...resolved.diagnostics, ...discovered.diagnostics, ...registry.diagnostics],
  }
}
