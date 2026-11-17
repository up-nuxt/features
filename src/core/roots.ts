import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Diagnostic, FeatureRoot, RootDirectories, RootOptions } from './types.js'

/** Resolve aliases even when the final directory does not exist yet. */
async function canonicalPath(path: string): Promise<string> {
  const suffix: string[] = []
  let ancestor = path
  while (true) {
    try {
      return resolve(await realpath(ancestor), ...suffix)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      suffix.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

export async function resolveRoots(
  dirs: RootDirectories,
  options: RootOptions = {},
): Promise<{ roots: FeatureRoot[]; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = []
  const roots: FeatureRoot[] = []
  const defaults = {
    general: resolve(dirs.rootDir, 'features'),
    app: resolve(dirs.srcDir, 'features'),
    server: resolve(dirs.serverDir, 'features'),
  }
  for (const kind of ['general', 'app', 'server'] as const) {
    const value = options[kind] ?? defaults[kind]
    if (value === false) continue
    if (typeof value !== 'string' || !value.trim()) {
      diagnostics.push({
        code: 'INVALID_ROOT',
        severity: 'error',
        message: `Root ${kind} must be a non-empty path or false.`,
        paths: [],
      })
      continue
    }
    let path = resolve(dirs.rootDir, value)
    try {
      // Reject a symlink at the configured root itself; aliases in ancestors are canonicalized.
      try {
        const stat = await lstat(path)
        if (!stat.isDirectory()) {
          diagnostics.push({
            code: 'INVALID_ROOT',
            severity: 'error',
            message: `Root ${kind} must be a directory, not a file or symlink.`,
            paths: [path],
          })
          continue
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      path = await canonicalPath(path)
    } catch (error) {
      diagnostics.push({
        code: 'IO_ERROR',
        severity: 'error',
        message: `Cannot inspect root ${path}: ${String(error)}`,
        paths: [path],
      })
      continue
    }
    roots.push({ kind, path })
  }
  const overlaps = (a: string, b: string) => {
    const rel = relative(a, b)
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  }
  const rejected = new Set<FeatureRoot>()
  for (let i = 0; i < roots.length; i++)
    for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i]!,
        b = roots[j]!
      if (overlaps(a.path, b.path) || overlaps(b.path, a.path)) {
        rejected.add(a)
        rejected.add(b)
        diagnostics.push({
          code: 'OVERLAPPING_ROOTS',
          severity: 'error',
          message: `Feature roots ${a.kind} and ${b.kind} overlap. Configure distinct paths or disable a root.`,
          paths: [a.path, b.path],
        })
      }
    }
  return { roots: roots.filter((root) => !rejected.has(root)), diagnostics }
}
