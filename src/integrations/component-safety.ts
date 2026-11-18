import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

function symlinkError(path: string): Error {
  return new Error(
    `[FEATURE_COMPONENT_SYMLINK] Refusing to scan or register a symlink in a feature component directory: ${path}. Remove the link or copy the intended application components into the directory. No symlink targets are allowed, including file links and internal links.`,
  )
}
async function rejectLink(path: string): Promise<void> {
  if ((await lstat(path)).isSymbolicLink()) throw symlinkError(path)
}

/** Safety inspection only: no component filename parsing or registration. Never follows links. */
export async function assertSafeComponentTree(directory: string): Promise<void> {
  const pending = [directory]
  while (pending.length) {
    const current = pending.pop()!
    await rejectLink(current)
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) throw symlinkError(path)
      if (entry.isDirectory()) pending.push(path)
    }
  }
}

/** Recheck candidates during subsequent native rescans, without trusting glob traversal. */
export async function assertSafeComponentFile(directory: string, file: string): Promise<void> {
  const path = relative(directory, file)
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`))
    throw new Error(`[FEATURE_COMPONENT_BOUNDARY] Component ${file} is outside ${directory}.`)
  let current = directory
  await rejectLink(current)
  for (const segment of path.split(sep).filter(Boolean)) {
    current = join(current, segment)
    await rejectLink(current)
  }
  const physical = relative(directory, await realpath(file))
  if (isAbsolute(physical) || physical === '..' || physical.startsWith(`..${sep}`))
    throw symlinkError(file)
}
