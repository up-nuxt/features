export const appResources = [
  'pages',
  'components',
  'composables',
  'utils',
  'middleware',
  'plugins',
  'types',
] as const
export const serverResources = ['api', 'routes', 'middleware', 'utils', 'plugins', 'types'] as const
export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
export function declarationName(
  directory: string,
): { name: string; kind: 'feature' | 'group' } | undefined {
  const group = /^\(([^()]+)\)$/.exec(directory)
  const name = group?.[1] ?? directory
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[\\/():]/.test(name) ||
    name.startsWith('@') ||
    name.startsWith('.')
  )
    return
  return { name, kind: group ? 'group' : 'feature' }
}
