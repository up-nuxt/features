import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

export function symlinkError(
  path: string,
  resource: 'component' | 'composable' | 'page' = 'component',
): Error {
  return new Error(
    `[FEATURE_${resource.toUpperCase()}_SYMLINK] Refusing to scan or register a symlink in a feature ${resource} directory: ${path}. Remove the link or copy the intended application files into the directory. No symlink targets are allowed, including file links and internal links.`,
  )
}
/** Safety inspection only. Never follows links. */
export async function assertSafeResourceTree(
  directory: string,
  resource: 'component' | 'composable' | 'page',
): Promise<void> {
  const pending = [directory]
  while (pending.length) {
    const current = pending.pop()!
    if ((await lstat(current)).isSymbolicLink()) throw symlinkError(current, resource)
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) throw symlinkError(path, resource)
      if (entry.isDirectory()) pending.push(path)
    }
  }
}

/** Filesystem containment on path segments, including cross-volume paths on Windows. */
export function containsPath(root: string, file: string): boolean {
  const path = relative(root, file)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}
