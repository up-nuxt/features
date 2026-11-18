import { isAbsolute, relative, sep } from 'node:path'
import { addComponentsDir, resolveAlias } from '@nuxt/kit'
import type { Component, ComponentsDir, Nuxt } from '@nuxt/schema'
import { assertSafeComponentFile, assertSafeComponentTree } from './component-safety.js'
import type { FeatureRegistry } from '../core/types.js'

export interface ComponentsOptions {
  /** Register discovered application component directories. Defaults to true. */
  autoImport?: boolean
  /** Prefix with structural feature names, omitting groups. Defaults to true. */
  prefix?: boolean
}
export interface FeatureComponentsDir {
  path: string
  prefix: string
}

export function getComponentDirectories(
  registry: FeatureRegistry,
  prefix = true,
): FeatureComponentsDir[] {
  const entries = new Map(registry.features.map((feature) => [feature.id, feature]))
  return registry.features.flatMap((feature) => {
    if (feature.origin !== 'feature-root') return []
    const names: string[] = []
    let current = feature
    while (true) {
      if (current.kind === 'feature') names.unshift(current.name)
      if (!current.parentId) break
      current = entries.get(current.parentId)!
    }
    // Nuxt performs PascalCase conversion and native path/filename deduplication.
    const componentPrefix = prefix ? names.join('-') : ''
    return feature.sources.flatMap((source) =>
      source.scopes
        .filter((scope) => scope.kind === 'app')
        .flatMap((scope) =>
          scope.resources
            .filter((resource) => resource.name === 'components')
            .map((resource) => ({ path: resource.path, prefix: componentPrefix })),
        ),
    )
  })
}

type NamedComponent = Pick<Component, 'pascalName' | 'filePath' | 'mode'>
const within = (directory: string, file: string) => {
  const path = relative(directory, file)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

/** Consumes names computed by Nuxt before cross-directory priority/deduplication. */
export function createCollisionGuard(featureDirectories: readonly string[]) {
  const seen = new Map<string, NamedComponent[]>()
  return {
    reset() {
      seen.clear()
    },
    observe(component: NamedComponent) {
      const previous = seen.get(component.pascalName) ?? []
      const collision = previous.find(
        (other) =>
          other.filePath !== component.filePath &&
          ((other.mode ?? 'all') === 'all' ||
            (component.mode ?? 'all') === 'all' ||
            other.mode === component.mode) &&
          featureDirectories.some(
            (path) => within(path, component.filePath) || within(path, other.filePath),
          ),
      )
      if (collision) {
        seen.clear()
        throw new Error(
          `[FEATURE_COMPONENT_COLLISION] Component ${component.pascalName} has overlapping render modes in:\n${[collision.filePath, component.filePath].sort().join('\n')}\nRename a component or use a distinct feature namespace. Groups do not add prefixes.`,
        )
      }
      previous.push({ ...component })
      seen.set(component.pascalName, previous)
    },
  }
}

export async function registerFeatureComponents(
  registry: FeatureRegistry,
  options: ComponentsOptions,
  nuxt: Nuxt,
): Promise<void> {
  if (options.autoImport === false) return
  const directories = getComponentDirectories(registry, options.prefix !== false)
  if (!directories.length) return
  for (const directory of directories) await assertSafeComponentTree(directory.path)
  for (const directory of directories) addComponentsDir({ ...directory, pathPrefix: true })
  const guard = createCollisionGuard(directories.map((directory) => directory.path))
  const checkedDirectories = new Set<string>()
  const resetScan = () => {
    guard.reset()
    checkedDirectories.clear()
  }
  // Install after module setup so existing Nuxt directories and module directories participate.
  nuxt.hook('modules:done', () => {
    nuxt.hook('components:dirs', async (dirs) => {
      resetScan()
      for (const directory of directories) await assertSafeComponentTree(directory.path)
      for (let index = 0; index < dirs.length; index++) {
        const original = dirs[index]!
        const dir: ComponentsDir =
          typeof original === 'string'
            ? { path: resolveAlias(original) }
            : { ...original, path: resolveAlias(original.path) }
        const extend = dir.extendComponent
        const ownedDirectory = directories.find((directory) => within(directory.path, dir.path))
        dir.extendComponent = async function (this: ComponentsDir, component) {
          try {
            const originalFilePath = component.filePath
            const originalName = component.pascalName
            const featureDirectory =
              ownedDirectory ??
              directories.find((directory) => within(directory.path, originalFilePath))
            if (featureDirectory) {
              if (!checkedDirectories.has(featureDirectory.path)) {
                await assertSafeComponentTree(featureDirectory.path)
                checkedDirectories.add(featureDirectory.path)
              }
              await assertSafeComponentFile(featureDirectory.path, component.filePath)
            }
            const resolved = (await extend?.call(this, component)) || component
            if (featureDirectory && resolved.filePath !== originalFilePath)
              await assertSafeComponentFile(featureDirectory.path, resolved.filePath)
            // Nuxt discards empty original names after extendComponent, even if renamed.
            if (originalName) guard.observe(resolved)
            return resolved
          } catch (error) {
            // A failed scan never reaches components:extend. Preserve the original exception.
            resetScan()
            throw error
          }
        }
        dirs[index] = dir
      }
    })
    nuxt.hook('components:extend', () => {
      resetScan()
    })
  })
}
