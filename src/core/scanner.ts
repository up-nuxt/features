import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { appResources, compare, declarationName, serverResources } from './conventions.js'
import type { Diagnostic, FeatureDeclaration, FeatureRoot, ResourceDirectory } from './types.js'

export async function discoverFeatures(
  roots: FeatureRoot[],
): Promise<{ declarations: FeatureDeclaration[]; diagnostics: Diagnostic[] }> {
  const declarations: FeatureDeclaration[] = []
  const diagnostics: Diagnostic[] = []
  async function directories(path: string): Promise<string[]> {
    try {
      return (await readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort(compare)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        diagnostics.push({
          code: 'IO_ERROR',
          severity: 'error',
          message: `Cannot read ${path}: ${String(error)}`,
          paths: [path],
        })
      return []
    }
  }
  async function visit(
    root: FeatureRoot,
    path: string,
    directory: string,
    parentId?: string,
  ): Promise<void> {
    const parsed = declarationName(directory)
    if (!parsed) {
      diagnostics.push({
        code: 'INVALID_DECLARATION',
        severity: 'error',
        message: `Invalid feature directory ${directory}.`,
        paths: [path],
      })
      return
    }
    const id = parentId ? `${parentId}/${parsed.name}` : parsed.name
    const entries = await directories(path)
    const resources: ResourceDirectory[] = []
    for (const name of entries) {
      if (root.kind !== 'server' && appResources.some((resource) => resource === name))
        resources.push({ name, path: join(path, name), boundary: 'app' })
      if (root.kind === 'server' && serverResources.some((resource) => resource === name))
        resources.push({ name, path: join(path, name), boundary: 'server' })
      if (root.kind === 'general' && name === 'shared')
        resources.push({ name, path: join(path, name), boundary: 'shared' })
      if (root.kind === 'general' && name === 'server')
        for (const resource of await directories(join(path, name))) {
          if (serverResources.some((name) => name === resource))
            resources.push({
              name: resource,
              path: join(path, name, resource),
              boundary: 'server',
            })
        }
    }
    declarations.push({
      id,
      name: parsed.name,
      kind: parsed.kind,
      parentId,
      source: { root, path, resources },
    })
    for (const name of entries) {
      if (name === 'features')
        for (const nested of await directories(join(path, name)))
          await visit(root, join(path, name, nested), nested, id)
      else if (name.startsWith('(')) await visit(root, join(path, name), name, id)
    }
  }
  for (const root of [...roots].sort(
    (a, b) => compare(a.path, b.path) || compare(a.kind, b.kind),
  )) {
    for (const name of await directories(root.path)) await visit(root, join(root.path, name), name)
  }
  return { declarations, diagnostics }
}
