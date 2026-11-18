import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Nuxt, NuxtPage } from '@nuxt/schema'

interface PageParserOptions {
  roots: string[]
  modes: string[]
  warn: (message: string) => void
  duplicateStrategy?: 'error'
}

interface RoutingParser {
  buildTree(files: string[], options: PageParserOptions): unknown
  toVueRouter4(tree: unknown, options: { attrs: { mode: string[] } }): NuxtPage[]
  parseSegment(segment: string): { type: string; value: string }[]
}

export async function loadNuxtRouting(nuxt: Nuxt) {
  const manifest = createRequire(join(nuxt.options.rootDir, 'package.json')).resolve(
    'nuxt/package.json',
    { paths: [nuxt.options.rootDir, ...nuxt.options.modulesDir.map((dir) => join(dir, '..'))] },
  )
  const path = createRequire(manifest).resolve('unrouting')
  const parser: RoutingParser = await import(pathToFileURL(path).href)
  return parser
}

export function parseFeaturePages(
  parser: RoutingParser,
  root: string,
  files: string[],
  modes: string[],
  warn: PageParserOptions['warn'],
): NuxtPage[] {
  try {
    return parser.toVueRouter4(
      parser.buildTree(files, { roots: [root], modes, warn, duplicateStrategy: 'error' }),
      { attrs: { mode: modes } },
    )
  } catch (cause) {
    throw new Error(`[FEATURE_PAGE_PARSE] ${root}: ${String(cause)}`, { cause })
  }
}

/** Mount generated routes before Nuxt merges definePageMeta. Child paths stay relative. */
export function mountFeaturePages(routes: NuxtPage[], segments: readonly string[]): NuxtPage[] {
  if (!segments.length) return routes
  const pathPrefix = '/' + segments.join('/')
  const namePrefix = segments.join('-')

  function mount(pages: NuxtPage[], root: boolean) {
    for (const page of pages) {
      if (page.name)
        page.name =
          root && page.path === '/' && page.name === 'index'
            ? namePrefix
            : `${namePrefix}-${page.name}`
      if (root) page.path = page.path === '/' ? pathPrefix : pathPrefix + page.path
      if (page.children) mount(page.children, false)
    }
  }

  mount(routes, true)
  return routes
}
