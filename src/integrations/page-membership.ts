import { basename, join, relative, sep } from 'node:path'
import type { Nuxt, NuxtPage } from '@nuxt/schema'
import { buildRegistry } from '../core/registry.js'
import type { FeatureDeclaration, FeatureRegistry } from '../core/types.js'
import type { loadNuxtRouting } from './nuxt-routing.js'

export interface PageOrigin {
  readonly kind: 'feature' | 'native' | 'layer'
  readonly directory: string
  readonly layer?: string
  readonly ownerId?: string
  readonly declaration?: string
}

interface NativeGroup {
  readonly id: string
  readonly path: string
}

interface RouteSource {
  readonly file: string
  readonly relativePath: string
  readonly view: string
  readonly origin: PageOrigin
  readonly ancestors: readonly string[]
  readonly nativeGroups: readonly NativeGroup[]
}

interface RouteOccurrence {
  readonly id: string
  readonly parentId?: string
  readonly path: string
  readonly name?: string
  readonly sources: readonly RouteSource[]
}

export interface RouteMembershipSnapshot {
  readonly registry: FeatureRegistry
  readonly routes: readonly RouteOccurrence[]
}

const membership = Symbol.for('@up-nuxt/features:route-membership')
type NuxtWithMembership = Nuxt & { [membership]?: RouteMembershipSnapshot }

export function getRouteMembership(nuxt: Nuxt) {
  return (nuxt as NuxtWithMembership)[membership]
}

export function setRouteMembership(nuxt: Nuxt, snapshot?: RouteMembershipSnapshot) {
  if (snapshot) (nuxt as NuxtWithMembership)[membership] = snapshot
  else delete (nuxt as NuxtWithMembership)[membership]
}

export const pagePath = (parent: string, child: string) =>
  child.startsWith('/') ? child : child ? parent.replace(/\/$/, '') + '/' + child : parent

export function routeFiles(page: NuxtPage): [string, string][] {
  const views = Object.entries(page.components ?? {})
  if (page.file && !views.some(([view]) => view === 'default'))
    views.unshift(['default', page.file])
  return views.sort(([a], [b]) => (a < b ? -1 : a === b ? 0 : 1))
}

export function buildRouteMembership(
  registry: FeatureRegistry,
  pages: NuxtPage[],
  findOrigin: (file: string) => PageOrigin | undefined,
  parser: Pick<Awaited<ReturnType<typeof loadNuxtRouting>>, 'parseSegment'>,
  warn: (message: string) => void,
): RouteMembershipSnapshot {
  const definitions = new Map(registry.features.map((entry) => [entry.id, entry]))
  const declarations = new Map<string, FeatureDeclaration>()
  const routes: RouteOccurrence[] = []

  function sourceFor(file: string, view: string): RouteSource | undefined {
    const origin = findOrigin(file)
    if (!origin) return
    const parts = relative(origin.directory, file).split(sep)
    const ancestors: string[] = []
    let ancestor = origin.ownerId && definitions.get(origin.ownerId)?.parentId
    while (ancestor) {
      ancestors.unshift(ancestor)
      ancestor = definitions.get(ancestor)?.parentId
    }
    const nativeGroups: NativeGroup[] = []
    const namespace = origin.ownerId
      ? `@pages:feature/${encodeURIComponent(origin.ownerId)}/`
      : '@pages/'
    for (const [index, segment] of parts.slice(0, -1).entries()) {
      if (!segment.startsWith('(') || !segment.endsWith(')')) continue
      const tokens = parser.parseSegment(segment)
      if (tokens.length !== 1 || tokens[0]?.type !== 'group' || !/^\([^()]+\)$/.test(segment)) {
        const message = `[FEATURE_PAGE_GROUP] Unsupported route group directory ${join(origin.directory, ...parts.slice(0, index + 1))}. Use one parenthesized group per directory.`
        if (origin.kind === 'feature') throw new Error(message)
        warn(message)
        continue
      }
      const groupPath = parts.slice(0, index + 1)
      const id = namespace + groupPath.join('/')
      const path = join(origin.directory, ...groupPath)
      const parentId = nativeGroups.at(-1)?.id
      nativeGroups.push(Object.freeze({ id, path }))
      declarations.set(JSON.stringify([id, path]), {
        id,
        parentId,
        name: basename(path).slice(1, -1),
        kind: 'group',
        origin: 'native-pages',
        source: {
          featureId: id,
          path,
          root: {
            path: origin.directory,
            kind: 'app',
            discovery: 'native-pages',
            layer: origin.layer,
          },
          scopes: [],
          layout: 'app',
        },
      })
    }
    return Object.freeze({
      file,
      view,
      relativePath: parts.join('/'),
      origin: Object.freeze({ ...origin }),
      ancestors: Object.freeze(ancestors),
      nativeGroups: Object.freeze(nativeGroups),
    })
  }

  function occurrenceKey(page: NuxtPage, path: string, files = routeFiles(page)) {
    const aliases = Array.isArray(page.alias) ? page.alias : page.alias ? [page.alias] : []
    return JSON.stringify([files, path, page.name, page.mode, [...aliases].sort()])
  }

  // Distinguish otherwise equal siblings with different children without tying
  // the identity of ordinary routes to edits in their subtrees.
  type ChildIdentity = [key: string, children: ChildIdentity[]]
  function childrenKey(page: NuxtPage, path: string): ChildIdentity[] {
    return (page.children ?? [])
      .map((child): ChildIdentity => {
        const childPath = pagePath(path, child.path)
        return [occurrenceKey(child, childPath), childrenKey(child, childPath)]
      })
      .sort((a, b) => {
        const left = JSON.stringify(a)
        const right = JSON.stringify(b)
        return left < right ? -1 : left === right ? 0 : 1
      })
  }

  function visit(pages: NuxtPage[], parentPath = '/', parentId?: string) {
    const keys = new Set<string>()
    const repeated = new Set<string>()
    const siblings = pages.map((page) => {
      const path = pagePath(parentPath, page.path)
      const files = routeFiles(page)
      const key = occurrenceKey(page, path, files)
      if (keys.has(key)) repeated.add(key)
      keys.add(key)
      return { page, path, files, key }
    })
    const occurrences = new Map<string, number>()
    for (const { page, path, files, key } of siblings) {
      const identity = repeated.has(key) ? JSON.stringify([key, childrenKey(page, path)]) : key
      const count = occurrences.get(identity) ?? 0
      occurrences.set(identity, count + 1)
      const id = (parentId ? parentId + '/' : '') + encodeURIComponent(identity) + ':' + count
      const sources = files.flatMap(([view, file]) => sourceFor(file, view) ?? [])
      routes.push(
        Object.freeze({ id, parentId, path, name: page.name, sources: Object.freeze(sources) }),
      )
      if (page.children?.length) visit(page.children, path, id)
    }
  }

  visit(pages)
  const combined = declarations.size
    ? buildRegistry([
        ...registry.features.flatMap(({ sources, children: _children, ...entry }) =>
          sources.map((source) => ({ ...entry, source })),
        ),
        ...declarations.values(),
      ])
    : { success: true as const, registry }
  if (!combined.success)
    throw new Error(
      combined.diagnostics
        .map((item) => `[${item.code}] ${item.message} ${item.paths.join(', ')}`)
        .join('\n'),
    )
  return Object.freeze({ registry: combined.registry, routes: Object.freeze(routes) })
}
