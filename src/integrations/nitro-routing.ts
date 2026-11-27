import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getNitroVersion } from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'

type Method = 'connect' | 'delete' | 'get' | 'head' | 'options' | 'patch' | 'post' | 'put' | 'trace'
type Mode = 'dev' | 'prod' | 'prerender'
const suffix =
  /(?:\.(?<method>connect|delete|get|head|options|patch|post|put|trace))?(?:\.(?<env>dev|prod|prerender))?$/

interface NitroPathTools {
  withBase(path: string, base: string): string
  withLeadingSlash(path: string): string
  withoutTrailingSlash(path: string): string
}

export const nitroFilePattern = '**/*.{js,mjs,cjs,ts,mts,cts,tsx,jsx}'

const supportedNitro = ['2.13.6', '2.14.0']

function compatibilityError(details: string, cause?: unknown) {
  return new Error(
    `[FEATURE_SERVER_NITRO_VERSION] ${details}. Supported Nitro versions: ${supportedNitro.join(', ')}. Use a Nuxt installation with a supported Nitro version or disable feature.server.enabled.`,
    { cause },
  )
}

export async function resolveSupportedNitro(dependencyOwner: string | URL) {
  let manifest: string
  try {
    manifest = createRequire(dependencyOwner).resolve('nitropack/package.json')
  } catch (cause) {
    throw compatibilityError('could not resolve Nitro package metadata from Nuxt', cause)
  }
  let version: unknown
  try {
    const metadata = JSON.parse(await readFile(manifest, 'utf8'))
    version = metadata?.version
  } catch (cause) {
    throw compatibilityError('could not read Nitro package metadata', cause)
  }
  // Nitro 2.13.6 ships an embedded meta.version of 2.13.5; trust the package manifest.
  if (typeof version !== 'string' || !version)
    throw compatibilityError('Nitro package metadata is missing a version')
  if (!supportedNitro.includes(version)) throw compatibilityError(`detected Nitro ${version}`)
  return createRequire(manifest)
}

export async function loadNitroScannerTools(nuxt: Nuxt) {
  const major = getNitroVersion(nuxt)
  if (major !== undefined && major !== 2) throw compatibilityError(`detected Nitro major ${major}`)
  let manifest: string
  try {
    manifest = createRequire(join(nuxt.options.rootDir, 'package.json')).resolve(
      'nuxt/package.json',
      { paths: [nuxt.options.rootDir, ...nuxt.options.modulesDir.map((dir) => join(dir, '..'))] },
    )
  } catch (cause) {
    throw compatibilityError('could not resolve Nuxt package metadata', cause)
  }
  let builderManifest: string
  try {
    builderManifest = createRequire(manifest).resolve('@nuxt/nitro-server/package.json')
  } catch (cause) {
    throw compatibilityError('could not resolve the Nuxt Nitro builder package metadata', cause)
  }
  const fromNitro = await resolveSupportedNitro(builderManifest)
  const [{ globby }, paths]: [
    {
      globby(
        pattern: string,
        options: {
          cwd: string
          dot: boolean
          followSymbolicLinks: boolean
          absolute: boolean
          ignore?: string[]
        },
      ): Promise<string[]>
    },
    NitroPathTools,
  ] = await Promise.all([
    import(pathToFileURL(fromNitro.resolve('globby')).href),
    import(pathToFileURL(fromNitro.resolve('ufo')).href),
  ])
  return { globby, paths }
}

/** A file-to-record adapter for the supported Nitro v2 scanners. Nitro still owns matching. */
export function nitroRouteFromFile(
  file: string,
  apiBase: string,
  segments: readonly string[],
  paths: NitroPathTools,
) {
  const relativeRoute = file
    .replace(/\.[A-Za-z]+$/, '')
    .replace(/\(([^(/\\]+)\)[/\\]/g, '')
    .replace(/\[\.{3}]/g, '**')
    .replace(/\[\.{3}(\w+)]/g, '**:$1')
    .replace(/\[([^/\]]+)]/g, ':$1')
  const base = paths.withLeadingSlash(paths.withoutTrailingSlash(apiBase))
  const mounted = paths.withLeadingSlash(
    paths.withoutTrailingSlash(paths.withBase(relativeRoute, base)),
  )
  const match = suffix.exec(mounted)
  const nativeRoute =
    (match?.index ? mounted.slice(0, match.index) : mounted).replace(/\/index$/, '') || '/'
  const method = match?.index ? (match.groups?.method as Method | undefined) : undefined
  const env = match?.index ? (match.groups?.env as Mode | undefined) : undefined
  if (!segments.length) return { route: nativeRoute, method, env }
  const mount = (base === '/' ? '' : base) + '/' + segments.join('/')
  const tail = base === '/' ? nativeRoute : nativeRoute.slice(base.length)
  return { route: mount + (tail === '/' ? '' : tail), method, env }
}
