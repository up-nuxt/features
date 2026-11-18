import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { appResources, compare, declarationName, serverResources } from './conventions.js'
import type {
  Diagnostic,
  FeatureDeclaration,
  FeatureRoot,
  ResourceDirectory,
  ResourceScope,
  RuntimeLayout,
} from './types.js'

export async function discoverFeatures(
  roots: readonly FeatureRoot[],
): Promise<{ declarations: FeatureDeclaration[]; diagnostics: Diagnostic[] }> {
  const declarations: FeatureDeclaration[] = []
  const diagnostics: Diagnostic[] = []
  const report = (code: Diagnostic['code'], message: string, path: string) =>
    diagnostics.push({ code, severity: 'error', message, paths: [path] })
  const knownResource = (name: string) =>
    appResources.some((item) => item === name) || serverResources.some((item) => item === name)
  async function directories(path: string, inspectResources = false): Promise<string[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true })
      const names: string[] = []
      for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory()) names.push(entry.name)
        else if (
          inspectResources &&
          entry.isSymbolicLink() &&
          (knownResource(entry.name) || ['app', 'server', 'shared'].includes(entry.name))
        ) {
          report(
            'SYMLINK_RESOURCE',
            'Feature resources and runtime boundaries cannot be symlinks. Use a real directory at this path.',
            join(path, entry.name),
          )
        }
      }
      return names
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        report('IO_ERROR', `Cannot read ${path}: ${String(error)}`, path)
      return []
    }
  }
  function scope(
    kind: 'app' | 'server',
    path: string,
    entries: string[],
    allowNesting: boolean,
  ): ResourceScope {
    const resources: ResourceDirectory[] = []
    const allowed = kind === 'app' ? appResources : serverResources
    for (const name of entries) {
      if (name === 'shared')
        report(
          'UNSUPPORTED_SCOPE',
          'Shared feature scopes are not supported yet.',
          join(path, name),
        )
      else if (name === 'app' || name === 'server')
        report(
          'INVALID_SCOPE',
          `Nested runtime boundary ${name} is invalid in a ${kind} scope.`,
          join(path, name),
        )
      else if (!allowNesting && (name === 'features' || name.startsWith('(')))
        report(
          'MISPLACED_DECLARATION',
          'Nested declarations must be alongside app/server scopes, not inside them.',
          join(path, name),
        )
      else if (allowed.some((item) => item === name))
        resources.push({ name, path: join(path, name) })
      else if (knownResource(name))
        report(
          'INVALID_RESOURCE_LOCATION',
          `Resource ${name} is not valid in a ${kind} scope.`,
          join(path, name),
        )
    }
    return { kind, path, resources }
  }
  async function visit(
    root: FeatureRoot,
    path: string,
    directory: string,
    layout: RuntimeLayout,
    parentId?: string,
  ): Promise<void> {
    const parsed = declarationName(directory)
    if (!parsed) {
      report(
        'INVALID_DECLARATION',
        `Invalid feature directory "${directory}". Expected lowercase kebab-case, for example "checkout-flow" or "(checkout-flow)".`,
        path,
      )
      return
    }
    const id = parentId ? `${parentId}/${parsed.name}` : parsed.name
    const entries = await directories(path, true)
    const scopes: ResourceScope[] = []
    if (layout === 'full-stack') {
      for (const name of entries) {
        if (name === 'app' || name === 'server')
          scopes.push(
            scope(name, join(path, name), await directories(join(path, name), true), false),
          )
        else if (name === 'shared')
          report(
            'UNSUPPORTED_SCOPE',
            'Shared feature scopes are not supported yet.',
            join(path, name),
          )
        else if (knownResource(name))
          report(
            'INVALID_RESOURCE_LOCATION',
            `Full-stack resource ${name} requires an explicit app/ or server/ boundary.`,
            join(path, name),
          )
      }
    } else scopes.push(scope(layout, path, entries, true))
    declarations.push({
      id,
      name: parsed.name,
      kind: parsed.kind,
      origin: 'feature-root',
      parentId,
      source: { featureId: id, root, path, layout, scopes },
    })
    for (const name of entries) {
      if (name === 'features')
        for (const nested of await directories(join(path, name)))
          await visit(root, join(path, name, nested), nested, layout, id)
      else if (name.startsWith('(')) await visit(root, join(path, name), name, layout, id)
    }
  }
  for (const root of [...roots].sort(
    (a, b) =>
      compare(a.discovery, b.discovery) || compare(a.kind, b.kind) || compare(a.path, b.path),
  )) {
    const layout: RuntimeLayout = root.kind === 'general' ? 'full-stack' : root.kind
    if (root.discovery === 'project-group')
      await visit(root, root.path, basename(root.path), layout)
    else
      for (const name of await directories(root.path))
        await visit(root, join(root.path, name), name, layout)
  }
  return { declarations, diagnostics }
}
