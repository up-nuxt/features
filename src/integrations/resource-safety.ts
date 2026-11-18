import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export function symlinkError(
  path: string,
  resource: 'component' | 'composable' = 'component',
): Error {
  return new Error(
    `[FEATURE_${resource.toUpperCase()}_SYMLINK] Refusing to scan or register a symlink in a feature ${resource} directory: ${path}. Remove the link or copy the intended application files into the directory. No symlink targets are allowed, including file links and internal links.`,
  )
}
/** Safety inspection only: no component filename parsing or registration. Never follows links. */
export async function assertSafeResourceTree(
  directory: string,
  resource: 'component' | 'composable',
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
