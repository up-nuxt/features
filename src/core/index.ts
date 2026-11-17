import { resolveRoots } from './roots.js'
import { discoverFeatures } from './scanner.js'
import { buildRegistry } from './registry.js'
import type { RegistryBuildResult, RootDirectories, RootOptions } from './types.js'
export type * from './types.js'
export { resolveRoots, discoverFeatures, buildRegistry }
export async function scanProject(
  dirs: RootDirectories,
  options: RootOptions = {},
): Promise<RegistryBuildResult> {
  const resolved = await resolveRoots(dirs, options)
  const discovered = await discoverFeatures(resolved.roots)
  return buildRegistry(discovered.declarations, [
    ...resolved.diagnostics,
    ...discovered.diagnostics,
  ])
}
