import { symlinkError } from './resource-safety.js'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

async function rejectLink(path: string): Promise<void> {
  if ((await lstat(path)).isSymbolicLink()) throw symlinkError(path)
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
