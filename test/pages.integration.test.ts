import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Nuxt, NuxtPage } from '@nuxt/schema'
import { build, loadNuxt } from 'nuxt'
import { expect, it } from 'vitest'
import { getRouteMembership } from '../src/integrations/page-membership.js'

const project = fileURLToPath(new URL('..', import.meta.url))
const page = '<template><p>page</p></template>'
const timeout = 60_000

function runNuxtDev(root: string, port: number) {
  return runServer(
    [
      join(project, 'node_modules/nuxt/bin/nuxt.mjs'),
      'dev',
      root,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--no-fork',
    ],
    { NODE_ENV: 'development' },
  )
}

async function fixture(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
  config = '',
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'feature-pages-')))
  try {
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir')
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), content)
    }
    await writeFile(
      join(root, 'nuxt.config.ts'),
      `export default defineNuxtConfig({
        modules: [${JSON.stringify(join(project, 'src/module.ts'))}],
        srcDir: 'app', buildDir: '.nuxt', devtools: false, compatibilityDate: '2026-11-17',
        ${config}
      })`,
    )
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function withNuxt(root: string, run: (nuxt: Nuxt) => Promise<void>) {
  const nuxt = await loadNuxt({ cwd: root, ready: false })
  try {
    await nuxt.ready()
    await run(nuxt)
  } finally {
    await nuxt.close()
  }
}

async function buildWithMembership(nuxt: Nuxt) {
  let snapshot: ReturnType<typeof getRouteMembership>
  nuxt.hook('build:done', () => {
    snapshot = getRouteMembership(nuxt)
  })
  await build(nuxt)
  return snapshot
}

it(
  'emits equivalent Nuxt page trees for native and Feature-only applications',
  { timeout },
  async () => {
    const files = {
      'index.vue': page,
      'help.vue': page,
      'products.vue':
        '<template><section><NuxtPage /><NuxtPage name="aside"/></section></template>',
      'products/index.vue': page,
      'products/[id].vue': page,
      'products/[id]@aside.vue': page,
      'products/[id]/index.vue': page,
      'search/[[term]].vue': page,
      'docs/[...slug].vue': page,
      'client.client.vue': page,
      'island.server.vue': page,
      '(marketing)/offers.vue':
        '<script setup>definePageMeta({ name: "deals", alias: "/deals", layout: "store" })</script>' +
        page,
    }
    async function scan(prefix: string, enabled: boolean) {
      let tree: unknown
      await fixture(
        Object.fromEntries(Object.entries(files).map(([file, value]) => [prefix + file, value])),
        (root) =>
          withNuxt(root, async (nuxt) => {
            const snapshot = await buildWithMembership(nuxt)
            function summarize(routes: NuxtPage[]): unknown {
              return routes.map(({ file, components, children, ...route }) => ({
                ...route,
                file: file?.slice(file.indexOf(prefix) + prefix.length),
                components:
                  components &&
                  Object.fromEntries(
                    Object.entries(components).map(([name, path]) => [
                      name,
                      path.slice(path.indexOf(prefix) + prefix.length),
                    ]),
                  ),
                children: summarize(children ?? []),
              }))
            }
            expect(nuxt.apps.default?.pages?.length).toBeGreaterThan(0)
            tree = summarize(nuxt.apps.default!.pages!)
            expect(nuxt.vfs[join(nuxt.options.buildDir, 'routes.mjs')]).toContain('deals')
            expect(
              await readFile(join(nuxt.options.buildDir, 'types/typed-router.d.ts'), 'utf8'),
            ).toContain('deals')
            const product = snapshot?.routes.find(
              (route) => route.path === '/products/:id()' && route.sources.length === 2,
            )
            expect(product?.sources.map((source) => source.view)).toEqual(['aside', 'default'])
            expect(
              snapshot?.routes.some(
                (route) => route.parentId === product?.id && route.path === product?.path,
              ),
            ).toBe(true)
          }),
        `feature: { pages: { enabled: ${enabled} } }, experimental: { componentIslands: true, typedPages: true },`,
      )
      return tree
    }
    expect(await scan('features/shop/app/pages/', true)).toEqual(await scan('app/pages/', false))
  },
)

it.each(['pages: false,', 'pages: { enabled: false },'])(
  'respects explicit Nuxt routing disablement (%s)',
  { timeout },
  async (config) => {
    await fixture(
      { 'app/features/shop/pages/index.vue': page, 'app/pages/about.vue': page },
      (root) =>
        withNuxt(root, async (nuxt) => {
          expect(nuxt.options.pages).toMatchObject({ enabled: false })
          expect(getRouteMembership(nuxt)).toBeUndefined()
        }),
      config + 'feature: { pages: { enabled: true } },',
    )
  },
)

it.each(['false', 'true', "'after-resolve'"])(
  'publishes native group membership with scanPageMeta %s and Feature Pages disabled',
  { timeout },
  async (scanPageMeta) => {
    await fixture(
      { 'app/pages/(dashboard)/home.vue': page, 'features/(dashboard)/app/pages/index.vue': page },
      (root) =>
        withNuxt(root, async (nuxt) => {
          const snapshot = (await buildWithMembership(nuxt))!
          expect(Object.isFrozen(snapshot.routes[0]?.sources[0]?.nativeGroups)).toBe(true)
          expect(snapshot.routes).toHaveLength(1)
          expect(snapshot.routes[0]).toMatchObject({
            path: '/home',
            sources: [{ origin: { kind: 'native' }, nativeGroups: [{ id: '@pages/(dashboard)' }] }],
          })
          expect(snapshot.registry.features.map((item) => item.id)).toEqual([
            '@pages/(dashboard)',
            'dashboard',
          ])
        }),
      `experimental: { scanPageMeta: ${scanPageMeta}, typedPages: false },`,
    )
  },
)

it(
  'preserves distinct group identities and per-source provenance across registered layouts',
  { timeout },
  async () => {
    await fixture(
      {
        'app/pages/(dashboard)/native.vue': page,
        'features/(dashboard)/app/pages/(dashboard)/feature.vue': page,
        'features/(dashboard)/features/cart/app/pages/(dashboard)/(second)/cart.vue': page,
        'app/features/shop/pages/(dashboard)/cart-app.vue': page,
        'features/shop/app/pages/(dashboard)/cart-full.vue': page,
        'server/features/shop/services/secret.vue': page,
        '(meeting)/app/pages/meet.vue': page,
      },
      (root) =>
        withNuxt(root, async (nuxt) => {
          const snapshot = (await buildWithMembership(nuxt))!
          expect(
            snapshot.registry.features.find((item) => item.id === '@pages:feature/shop/(dashboard)')
              ?.sources,
          ).toHaveLength(2)
          expect(
            snapshot.routes.find((route) => route.path === '/feature')?.sources[0],
          ).toMatchObject({
            origin: { kind: 'feature', ownerId: 'dashboard' },
            nativeGroups: [{ id: '@pages:feature/dashboard/(dashboard)' }],
          })
          expect(snapshot.routes.find((route) => route.path === '/cart')?.sources[0]).toMatchObject(
            {
              ancestors: ['dashboard'],
              origin: { kind: 'feature', ownerId: 'dashboard/cart' },
              nativeGroups: [
                { id: '@pages:feature/dashboard%2Fcart/(dashboard)' },
                { id: '@pages:feature/dashboard%2Fcart/(dashboard)/(second)' },
              ],
            },
          )
          expect(snapshot.routes.map((route) => route.path).sort()).toEqual([
            '/cart',
            '/cart-app',
            '/cart-full',
            '/feature',
            '/meet',
            '/native',
          ])
          expect(nuxt.vfs[join(nuxt.options.buildDir, 'routes.mjs')]).not.toContain(
            '@pages:feature',
          )
        }),
      'feature: { pages: { enabled: true } },',
    )
  },
)

it.each([
  ['features/cart/app/pages/index.vue', 'app/features/cart/pages/index.vue', '/', page],
  ['features/cart/app/pages/index.vue', 'app/pages/index.vue', '/', page],
  ['features/cart/app/pages/(one)/index.vue', 'features/cart/app/pages/(two)/index.vue', '/', page],
  ['features/cart/app/pages/[id].vue', 'features/shop/app/pages/[slug].vue', 'param', page],
  ['features/cart/app/pages/duplicate.vue', 'app/pages/duplicate/index.vue', 'duplicate', page],
  [
    'features/cart/app/pages/cart.vue',
    'app/pages/shop.vue',
    '/shop',
    '<script setup>definePageMeta({ path: "/shop" })</script>' + page,
  ],
  [
    'features/cart/app/pages/cart.vue',
    'app/pages/shop.vue',
    'shop',
    '<script setup>definePageMeta({ name: "shop" })</script>' + page,
  ],
  [
    'features/cart/app/pages/cart.vue',
    'app/pages/shop.vue',
    '/shop',
    '<script setup>definePageMeta({ alias: "/shop" })</script>' + page,
  ],
])('rejects ambiguous records between %s and %s', { timeout }, async (a, b, identity, content) => {
  await fixture(
    { [a]: content, [b]: page },
    async (root) => {
      const child = spawn(process.execPath, [
        join(project, 'node_modules/nuxt/bin/nuxt.mjs'),
        'build',
        root,
      ])
      let logs = ''
      child.stdout.on('data', (chunk) => {
        logs += chunk
      })
      child.stderr.on('data', (chunk) => {
        logs += chunk
      })
      const [code] = await once(child, 'close')
      expect(code).not.toBe(0)
      expect(logs).toContain('FEATURE_PAGE_COLLISION')
      expect(logs).toContain(identity)
      expect(logs).toContain(a)
      expect(logs).toContain(b)
    },
    'feature: { pages: { enabled: true } },',
  )
})

it.each(['file', 'dir'] as const)(
  'rejects a %s symlink before passing the Page to Nuxt',
  { timeout },
  async (kind) => {
    await fixture(
      {
        'features/shop/app/pages/safe.vue': page,
        'server/features/auth/services/private.vue': '<template><p>SERVER_ONLY_PAGE</p></template>',
      },
      async (root) => {
        await symlink(
          join(root, 'server/features/auth/services', kind === 'file' ? 'private.vue' : ''),
          join(root, 'features/shop/app/pages', kind === 'file' ? 'secret.vue' : 'linked'),
          kind,
        )
        await expect(
          withNuxt(root, async (nuxt) => {
            await build(nuxt)
          }),
        ).rejects.toThrow('FEATURE_PAGE_SYMLINK')
      },
      'feature: { pages: { enabled: true } },',
    )
  },
)

async function portForTest() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  if (!address || typeof address === 'string') throw new Error('No loopback port')
  return address.port
}

async function waitFor(check: () => Promise<boolean>, logs: () => string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(logs())
}

function runServer(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (chunk) => {
    logs += chunk
  })
  child.stderr.on('data', (chunk) => {
    logs += chunk
  })
  return {
    logs: () => logs,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    },
  }
}

it(
  'renders a production Feature-only application with the native router and layout',
  { timeout },
  async () => {
    await fixture(
      {
        'app/app.vue': '<template><NuxtLayout><NuxtPage /></NuxtLayout></template>',
        'app/layouts/store.vue': '<template><main><h1>STORE_LAYOUT</h1><slot /></main></template>',
        'features/shop/app/pages/(offers)/products/[id].vue': `
      <script setup lang="ts">
      definePageMeta({ layout: 'store', name: 'product', alias: '/sku/:id()' })
      const route = useRoute()
      </script>
      <template><p>PRODUCT {{ route.params.id }}</p></template>`,
      },
      (root) =>
        withNuxt(root, async (nuxt) => {
          const snapshot = await buildWithMembership(nuxt)
          const port = await portForTest()
          const server = runServer([join(root, '.output/server/index.mjs')], {
            PORT: String(port),
            HOST: '127.0.0.1',
            NODE_ENV: 'production',
          })
          try {
            let html = ''
            await waitFor(async () => {
              const response = await fetch(`http://127.0.0.1:${port}/sku/42`).catch(() => undefined)
              if (response?.status !== 200) return false
              html = await response.text()
              return true
            }, server.logs)
            expect(html).toContain('STORE_LAYOUT')
            expect(html).toContain('PRODUCT 42')
            expect(snapshot?.routes[0]).toMatchObject({
              name: 'product',
              path: '/products/:id()',
            })
          } finally {
            await server.close()
          }
        }),
      'feature: { pages: { enabled: true } },',
    )
  },
)

it(
  'blocks a symlink replacement from the running Vite server and SSR and recovers after restart',
  { timeout },
  async () => {
    const source = 'app/features/shop/pages/item.vue'
    const sentinel = 'SERVER_ONLY_PAGE_SENTINEL'
    const target = 'server/features/auth/services/private.vue'
    await fixture(
      {
        'app/app.vue': '<template><NuxtPage /></template>',
        [source]: '<template><p>VALID_FEATURE_PAGE</p></template>',
        'app/pages/native.vue': '<template><p>NATIVE_PAGE</p></template>',
        [target]: `<template><p>${sentinel}</p></template>`,
      },
      async (root) => {
        const port = await portForTest()
        const start = () => runNuxtDev(root, port)
        const request = (path: string) =>
          fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4000) })
        const moduleUrl = '/_nuxt/@fs/' + join(root, source)
        let server = start()
        const rendered = (path: string, value: string) =>
          waitFor(async () => {
            const response = await request(path).catch(() => undefined)
            return response?.status === 200 && (await response.text()).includes(value)
          }, server.logs)
        try {
          await rendered('/item', 'VALID_FEATURE_PAGE')
          await writeFile(join(root, source), '<template><p>EDITED_FEATURE_PAGE</p></template>')
          await rendered('/item', 'EDITED_FEATURE_PAGE')
          await writeFile(
            join(root, source),
            '<script setup>definePageMeta({ path: "/changed" })</script><template><p>EDITED_FEATURE_PAGE</p></template>',
          )
          await rendered('/changed', 'EDITED_FEATURE_PAGE')
          expect((await request('/item')).status).toBe(404)
          const before = await request(moduleUrl)
          expect(before.status).toBe(200)
          expect(await before.text()).toContain('EDITED_FEATURE_PAGE')

          await rm(join(root, source))
          await symlink(join(root, target), join(root, source))
          await waitFor(async () => server.logs().includes('FEATURE_PAGE_SYMLINK'), server.logs)
          const blocked = await request(moduleUrl)
          expect(blocked.status).toBe(503)
          expect(await blocked.text()).not.toContain(sentinel)
          const directTarget = await request('/_nuxt/@fs/' + join(root, target))
          expect(directTarget.status).toBe(503)
          expect(await directTarget.text()).not.toContain(sentinel)
          const unsafePage = await request('/changed')
          const unsafeHtml = await unsafePage.text()
          expect(unsafePage.status).toBe(500)
          expect(unsafeHtml).toContain('This Feature Page failed filesystem validation')
          expect(unsafeHtml).not.toContain(sentinel)
          const native = await request('/native')
          expect(native.status).toBe(200)
          expect(await native.text()).toContain('NATIVE_PAGE')

          await server.close()
          await rm(join(root, source))
          await writeFile(join(root, source), '<template><p>RECOVERED_FEATURE_PAGE</p></template>')
          server = start()
          await rendered('/item', 'RECOVERED_FEATURE_PAGE')

          await server.close()
          await rename(join(root, source), join(root, 'app/features/shop/pages/renamed.vue'))
          const newGroup = join(root, 'features/shop/app/pages/(extra)')
          await mkdir(newGroup, { recursive: true })
          await writeFile(join(newGroup, 'new.vue'), '<template><p>NEW_GROUP_PAGE</p></template>')
          server = start()
          await rendered('/renamed', 'RECOVERED_FEATURE_PAGE')
          await rendered('/new', 'NEW_GROUP_PAGE')
          expect((await request('/item')).status).toBe(404)

          await server.close()
          await rm(newGroup, { recursive: true })
          server = start()
          await rendered('/renamed', 'RECOVERED_FEATURE_PAGE')
          expect((await request('/new')).status).toBe(404)
        } finally {
          await server.close()
        }
      },
      'feature: { pages: { enabled: true } },',
    )
  },
)

it(
  'retains native Layer precedence and identifies the effective physical origins',
  { timeout },
  async () => {
    await fixture(
      {
        'layers/base/nuxt.config.ts': 'export default defineNuxtConfig({})',
        'layers/base/app/pages/(catalog)/stock.vue': '<template><p>BASE_STOCK</p></template>',
        'layers/base/app/pages/(catalog)/other.vue': page,
        'app/pages/(catalog)/stock.vue': '<template><p>APP_STOCK</p></template>',
        'app/features/shop/pages/stock/[id].vue': page,
        'features/shop/app/pages/[...rest].vue': page,
      },
      (root) =>
        withNuxt(root, async (nuxt) => {
          const snapshot = (await buildWithMembership(nuxt))!
          expect(
            snapshot.routes.find((route) => route.path === '/stock')?.sources[0],
          ).toMatchObject({
            origin: { kind: 'native' },
            file: join(root, 'app/pages/(catalog)/stock.vue'),
          })
          expect(
            snapshot.routes.find((route) => route.path === '/other')?.sources[0],
          ).toMatchObject({
            origin: { kind: 'layer' },
            nativeGroups: [{ id: '@pages/(catalog)' }],
          })
          expect(
            snapshot.registry.features.find((item) => item.id === '@pages/(catalog)')?.sources,
          ).toHaveLength(2)
        }),
      'feature: { pages: { enabled: true } },',
    )
  },
)

it(
  'applies Nuxt page patterns and ignore rules outside the native pages directory',
  { timeout },
  async () => {
    await fixture(
      {
        'features/shop/app/pages/included.vue': page,
        'features/shop/app/pages/hidden.vue': page,
        'features/shop/app/pages/ignored.ts': 'export default {}',
      },
      (root) =>
        withNuxt(root, async (nuxt) => {
          const snapshot = await buildWithMembership(nuxt)
          expect(snapshot?.routes.map((route) => route.path)).toEqual(['/included'])
        }),
      'pages: { pattern: "**/*.vue" }, ignore: ["**/hidden.vue"], feature: { pages: { enabled: true } },',
    )
  },
)

it(
  'rejects a native Pages configuration overlapping a protected Feature Pages root',
  { timeout },
  async () => {
    await fixture(
      { 'app/features/shop/pages/index.vue': page },
      async (root) => {
        await expect(withNuxt(root, async () => {})).rejects.toThrow('FEATURE_PAGE_BOUNDARY')
      },
      'dir: { pages: "features/shop/pages" }, feature: { pages: { enabled: true } },',
    )
  },
)

it(
  'keeps raw group identity even when Nuxt normalizes the runtime label',
  { timeout },
  async () => {
    await fixture(
      {
        'features/shop/app/pages/(sales-team)/offer.vue': page,
        'features/shop/app/pages/(salesteam)/terms.vue': page,
        'features/shop/app/pages/detail.vue': page,
      },
      (root) =>
        withNuxt(root, async (nuxt) => {
          // A module may intentionally register multiple routes using the same file.
          nuxt.hook('pages:extend', (pages) => {
            const detail = pages.find((route) => route.path === '/detail')
            if (detail) pages.push({ ...detail, path: '/alternative', name: 'alternative' })
          })
          const snapshot = (await buildWithMembership(nuxt))!
          const offer = nuxt.apps.default?.pages?.find((route) => route.path === '/offer')
          const terms = nuxt.apps.default?.pages?.find((route) => route.path === '/terms')
          expect(offer?.meta?.groups).toEqual(['salesteam'])
          expect(terms?.meta?.groups).toEqual(['salesteam'])
          expect(
            snapshot.routes.find((route) => route.path === '/offer')?.sources[0]?.nativeGroups[0]
              ?.id,
          ).toBe('@pages:feature/shop/(sales-team)')
          expect(
            snapshot.routes.find((route) => route.path === '/terms')?.sources[0]?.nativeGroups[0]
              ?.id,
          ).toBe('@pages:feature/shop/(salesteam)')
          const detailRoutes = snapshot.routes.filter((route) =>
            route.sources.some((source) => source.relativePath === 'detail.vue'),
          )
          expect(detailRoutes.map((route) => route.path).sort()).toEqual([
            '/alternative',
            '/detail',
          ])
          expect(new Set(detailRoutes.map((route) => route.id)).size).toBe(2)
        }),
      'feature: { pages: { enabled: true } },',
    )
  },
)

it(
  'fails before Nuxt can silently deduplicate two files occupying one Feature route slot',
  { timeout },
  async () => {
    await fixture(
      {
        'features/shop/app/pages/same.vue': page,
        'features/shop/app/pages/same.ts': 'export default {}',
      },
      async (root) => {
        await expect(withNuxt(root, async () => {})).rejects.toThrow(
          /FEATURE_PAGE_PARSE.*same\.ts.*same\.vue/,
        )
      },
      'feature: { pages: { enabled: true } },',
    )
  },
)

it(
  'treats Pages roots with spaces, brackets, and structural Groups as literal directories',
  { timeout },
  async () => {
    await fixture(
      {
        'feature areas [work]/(store)/app/pages/(marketing)/special.vue': page,
        'feature areas w/store/app/pages/decoy.vue': page,
      },
      (root) =>
        withNuxt(root, async (nuxt) => {
          const snapshot = await buildWithMembership(nuxt)
          expect(snapshot?.routes.map((route) => route.path)).toEqual(['/special'])
          expect(snapshot?.routes[0]?.sources[0]?.nativeGroups[0]?.id).toBe(
            '@pages:feature/store/(marketing)',
          )
        }),
      'feature: { roots: { general: "feature areas [work]" }, pages: { enabled: true } },',
    )
  },
)

it.each(['app/pages/about.vue', 'app/lib/shared.vue'])(
  'rejects a Feature page symlink while preserving independent access to %s',
  { timeout },
  async (target) => {
    const source = 'app/features/shop/pages/info.vue'
    await fixture(
      {
        'app/app.vue': '<template><NuxtPage /></template>',
        [source]: '<template><p>VALID_INFO</p></template>',
        'app/pages/about.vue': '<template><p>NATIVE_ABOUT</p></template>',
        'app/lib/shared.vue': '<template><p>SHARED_APP_COMPONENT</p></template>',
        'app/lib/unrelated.ts': 'export const marker = "UNRELATED_APP_MODULE"',
      },
      async (root) => {
        const port = await portForTest()
        const server = runNuxtDev(root, port)
        const request = (path: string) =>
          fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4000) })
        const moduleUrl = (file: string) => '/_nuxt/@fs/' + join(root, file)
        const marker = target === 'app/pages/about.vue' ? 'NATIVE_ABOUT' : 'SHARED_APP_COMPONENT'
        try {
          await waitFor(async () => {
            const response = await request('/info').catch(() => undefined)
            return response?.status === 200 && (await response.text()).includes('VALID_INFO')
          }, server.logs)
          expect((await request('/about')).status).toBe(200)
          expect((await request(moduleUrl(target))).status).toBe(200)
          expect((await request(moduleUrl(source))).status).toBe(200)

          await rm(join(root, source))
          await symlink(join(root, target), join(root, source))
          await waitFor(async () => server.logs().includes('FEATURE_PAGE_SYMLINK'), server.logs)

          const native = await request('/about')
          expect(native.status).toBe(200)
          expect(await native.text()).toContain('NATIVE_ABOUT')
          const legitimate = await request(moduleUrl(target))
          expect(legitimate.status).toBe(200)
          expect(await legitimate.text()).toContain(marker)
          const unrelated = await request(moduleUrl('app/lib/unrelated.ts'))
          expect(unrelated.status).toBe(200)
          expect(await unrelated.text()).toContain('UNRELATED_APP_MODULE')

          const rejected = await request(moduleUrl(source))
          expect(rejected.status).toBe(503)
          expect(await rejected.text()).not.toContain(marker)
          const ssr = await request('/info')
          expect(ssr.status).toBe(500)
          const html = await ssr.text()
          expect(html).toContain('This Feature Page failed filesystem validation')
          expect(html).not.toContain(marker)
        } finally {
          await server.close()
        }
      },
      'feature: { pages: { enabled: true } },',
    )
  },
)
