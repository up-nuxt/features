import { resolve } from 'node:path'
import type { NuxtPage } from '@nuxt/schema'
import { expect, it } from 'vitest'
import { buildRouteMembership, type PageOrigin } from '../src/integrations/page-membership.js'

it('keeps route IDs and provenance associated across equivalent rebuilds with reordered records', () => {
  const featureRoot = resolve('fixture/features/shop/app/pages')
  const nativeRoot = resolve('fixture/app/pages')
  const layerRoot = resolve('fixture/layers/store/app/pages')
  const detail = resolve(featureRoot, 'detail.vue')
  const child = resolve(featureRoot, 'summary.vue')
  const sidebar = resolve(layerRoot, 'sidebar.vue')
  const nativeFile = resolve(nativeRoot, 'detail.vue')
  const origins = new Map<string, PageOrigin>([
    [detail, { kind: 'feature', directory: featureRoot, ownerId: 'shop' }],
    [child, { kind: 'feature', directory: featureRoot, ownerId: 'shop' }],
    [nativeFile, { kind: 'native', directory: nativeRoot }],
    [sidebar, { kind: 'layer', directory: layerRoot }],
  ])
  const tree = (reverse: boolean): NuxtPage[] => {
    const children: NuxtPage[] = [
      { path: 'summary', name: 'summary', file: child },
      { path: 'compact', name: 'compact', file: child },
    ]
    const pages: NuxtPage[] = [
      {
        path: '/detail',
        name: 'renamed-detail',
        file: detail,
        children: reverse ? children.reverse() : children,
        components: reverse ? { sidebar, default: detail } : { default: detail, sidebar },
      },
      {
        path: '/alternative',
        name: 'alternative',
        file: detail,
        components: { default: detail, sidebar },
      },
      { path: '/native', name: 'native', file: nativeFile },
      { path: '/detail-view', name: 'detail-view', file: detail, components: { detail } },
    ]
    return reverse ? pages.reverse() : pages
  }
  const project = (pages: NuxtPage[]) =>
    buildRouteMembership(
      { features: [] },
      pages,
      (file) => origins.get(file),
      { parseSegment: () => [] },
      () => {},
    )
  const first = project(tree(false))
  const reversed = project(tree(true))
  expect(Object.fromEntries(reversed.routes.map((route) => [route.path, route]))).toEqual(
    Object.fromEntries(first.routes.map((route) => [route.path, route])),
  )
  expect(new Set(first.routes.map((route) => route.id)).size).toBe(first.routes.length)
  const main = first.routes.find((route) => route.path === '/detail')!
  expect(main).toMatchObject({
    name: 'renamed-detail',
    sources: [
      { file: detail, view: 'default', origin: { kind: 'feature', ownerId: 'shop' } },
      { file: sidebar, view: 'sidebar', origin: { kind: 'layer' } },
    ],
  })
  expect(
    first.routes.filter((route) => route.parentId === main.id).map((route) => route.path),
  ).toEqual(['/detail/summary', '/detail/compact'])
  expect(first.routes.find((route) => route.path === '/native')?.sources[0]?.origin.kind).toBe(
    'native',
  )
  expect(
    first.routes
      .find((route) => route.path === '/detail-view')
      ?.sources.map((source) => source.view),
  ).toEqual(['default', 'detail'])
  expect(Object.isFrozen(first)).toBe(true)
  expect(Object.isFrozen(first.routes)).toBe(true)
  expect(Object.isFrozen(main.sources[0]?.origin)).toBe(true)
})

it('correlates same-source parent occurrences with their distinct subtrees', () => {
  const same = '/fixture/pages/same.vue'
  const tree: NuxtPage[] = [
    { path: '/same', file: same, children: [{ path: 'first', name: 'first' }] },
    { path: '/same', file: same, children: [{ path: 'second', name: 'second' }] },
  ]
  const parentsByChild = (pages: NuxtPage[]) => {
    const snapshot = buildRouteMembership(
      { features: [] },
      pages,
      () => undefined,
      { parseSegment: () => [] },
      () => {},
    )
    return Object.fromEntries(
      snapshot.routes.flatMap((route) => (route.name ? [[route.name, route.parentId]] : [])),
    )
  }
  const first = parentsByChild(tree)
  expect(first.first).toBeDefined()
  expect(first.second).toBeDefined()
  expect(first.first).not.toBe(first.second)
  expect(parentsByChild([...tree].reverse())).toEqual(first)
})
