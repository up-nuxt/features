import { basename } from 'node:path'
import type { NuxtPage } from '@nuxt/schema'
import { pagePath, routeFiles } from './page-membership.js'

interface RouteClaim {
  page: NuxtPage
  parent?: NuxtPage
  path: string
  feature: boolean
  kind: 'route name' | 'route path' | 'route alias'
  sources: string[]
}

// The simple parameter grammar emitted by Nuxt for dynamic, optional and catch-all files.
// Leave arbitrary regexes and mixed parameter/static segments to the router.
function patternKey(path: string) {
  return path
    .split('/')
    .map((segment) =>
      segment.replace(
        /^:[\w]+(\(\)|\(\.\*\))?([?*+]?)$/,
        (_match, regex: string | undefined, modifier: string) =>
          ':param' + (regex === '(.*)' ? regex : '') + modifier,
      ),
    )
    .join('/')
}

function defaultChild(a: RouteClaim, b: RouteClaim) {
  const [child, parent] = a.parent === b.page ? [a, b] : [b, a]
  const file = child.page.file
  const parentFile = parent.page.file
  return (
    child.parent === parent.page &&
    child.page.path === '' &&
    file &&
    parentFile &&
    /^index[.@]/.test(basename(file)) &&
    !/^index[.@]/.test(basename(parentFile))
  )
}

export function validatePageCollisions(pages: NuxtPage[], isFeature: (file: string) => boolean) {
  const names = new Map<string, RouteClaim[]>()
  const paths = new Map<string, RouteClaim[]>()

  function record(claims: Map<string, RouteClaim[]>, key: string, claim: RouteClaim) {
    const existing = claims.get(key) ?? []
    for (const other of existing) {
      if (!(claim.feature || other.feature) || other.page === claim.page) continue
      if (
        claim.kind === 'route path' &&
        other.kind === 'route path' &&
        claim.path === other.path &&
        defaultChild(claim, other)
      )
        continue
      if (
        other.path === claim.path &&
        other.page.name === claim.page.name &&
        claim.sources.length > 0 &&
        JSON.stringify(claim.sources) === JSON.stringify(other.sources)
      )
        continue
      throw new Error(
        `[FEATURE_PAGE_COLLISION] Ambiguous ${claim.kind} "${key}": ${other.sources.join(', ') || other.path} and ${claim.sources.join(', ') || claim.path}.`,
      )
    }
    existing.push(claim)
    claims.set(key, existing)
  }

  function visit(records: NuxtPage[], parentPath = '/', parent?: NuxtPage) {
    for (const page of records) {
      const path = pagePath(parentPath, page.path)
      const sources = routeFiles(page).map(([, file]) => file)
      const claim = { page, parent, path, feature: sources.some(isFeature), sources }
      if (page.name) record(names, page.name, { ...claim, kind: 'route name' })
      const key = patternKey(path)
      record(paths, key, { ...claim, kind: 'route path' })
      for (const alias of Array.isArray(page.alias) ? page.alias : [page.alias])
        if (alias)
          record(paths, patternKey(pagePath(parentPath, alias)), { ...claim, kind: 'route alias' })
      if (page.children) visit(page.children, path, page)
    }
  }

  visit(pages)
}
