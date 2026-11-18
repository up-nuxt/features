import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NuxtHooks } from '@nuxt/schema'
import { build, loadNuxt } from 'nuxt'
import { expect, it } from 'vitest'
import { getServerResources } from '../src/integrations/server.js'

const project = fileURLToPath(new URL('..', import.meta.url))
const timeout = 60_000
const handler = (value: string) =>
  `export default defineEventHandler(() => ${JSON.stringify(value)})`
const enabled = 'feature: { server: { enabled: true } },'

async function fixture(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
  config = enabled,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'feature-nitro-')))
  try {
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir')
    for (const [name, value] of Object.entries({
      'app/app.vue': '<template><main>app</main></template>',
      ...files,
    })) {
      await mkdir(dirname(join(root, name)), { recursive: true })
      await writeFile(join(root, name), value)
    }
    await writeFile(
      join(root, 'nuxt.config.ts'),
      `export default defineNuxtConfig({
      modules: [${JSON.stringify(join(project, 'src/module.ts'))}], srcDir: 'app', buildDir: '.nuxt',
      compatibilityDate: '2026-11-17', devtools: false, ${config}
    })`,
    )
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function withServer(
  root: string,
  dev: boolean,
  run: (
    request: (path: string, method?: string) => Promise<Response>,
    logs: () => string,
  ) => Promise<void>,
) {
  const listener = createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  await new Promise<void>((done, fail) => listener.close((error) => (error ? fail(error) : done())))
  if (!address || typeof address === 'string') throw new Error('No test server port')
  const port = String(address.port)
  const child = spawn(
    process.execPath,
    dev
      ? [
          join(project, 'node_modules/nuxt/bin/nuxt.mjs'),
          'dev',
          root,
          '--host',
          '127.0.0.1',
          '--port',
          port,
          '--no-fork',
        ]
      : [join(root, '.output/server/index.mjs')],
    {
      env: {
        ...process.env,
        PORT: port,
        HOST: '127.0.0.1',
        NODE_ENV: dev ? 'development' : 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  try {
    const request = (path: string, method?: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(4000) })
    await waitFor(
      async () => !!(await request('/').catch(() => undefined)),
      () => output,
    )
    await run(request, () => output)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
  }
}

async function waitFor(check: () => Promise<boolean>, logs: () => string) {
  for (let attempt = 0; attempt < 140; attempt++) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(logs())
}

async function buildFixture(root: string) {
  const nuxt = await loadNuxt({ cwd: root, ready: false })
  try {
    await nuxt.ready()
    await build(nuxt)
  } finally {
    await nuxt.close()
  }
}

it(
  'verifies Nitro scan directories use native mounts and explicit handlers generate method types',
  { timeout },
  async () => {
    await fixture(
      {
        'extra/api/(transparent)/sample.get.ts': handler('scanned'),
        'explicit.ts': handler('explicit'),
        'modules/probe.ts': `import { addServerScanDir, addServerHandler, defineNuxtModule } from '@nuxt/kit'
      export default defineNuxtModule({ setup(_, nuxt) {
        addServerScanDir(nuxt.options.rootDir + '/extra')
        addServerHandler({ route: '/api/custom', method: 'post', handler: nuxt.options.rootDir + '/explicit.ts' })
      } })`,
      },
      async (root) => {
        await buildFixture(root)
        const routes = await readFile(join(root, '.nuxt/types/nitro-routes.d.ts'), 'utf8')
        expect(routes).toContain("'/api/sample'")
        expect(routes).toContain("'/api/custom'")
        expect(routes).toContain("'post'")
        await withServer(root, false, async (request) => {
          expect(await (await request('/api/sample')).text()).toBe('scanned')
          expect(await (await request('/api/custom', 'POST')).text()).toBe('explicit')
          expect(await (await request('/api/transparent/sample')).text()).not.toBe('scanned')
        })
      },
      '',
    )
  },
)

it(
  'registers prefixed Feature API and routes with native method fallback and typed responses',
  { timeout },
  async () => {
    await fixture(
      {
        'server/api/status.get.ts': handler('native'),
        'server/middleware/native.ts':
          'export default defineEventHandler((event) => setResponseHeader(event, "x-middleware-order", "native"))',
        'server/plugins/native.ts':
          'export default defineNitroPlugin((nitro) => nitro.hooks.hook("request", (event) => setResponseHeader(event, "x-plugin-order", (getResponseHeader(event, "x-plugin-order") || "") + "native")))',
        'layers/base/nuxt.config.ts': 'export default defineNuxtConfig({})',
        'layers/base/server/api/status.get.ts': handler('overridden native layer'),
        'layers/base/server/api/layer.get.ts': handler('native layer'),
        'server/features/shop/api/products.get.ts': handler('GET'),
        'features/shop/server/api/products.post.ts': handler('POST'),
        'features/shop/server/api/products.ts': handler('fallback'),
        ...Object.fromEntries(
          ['put', 'patch', 'delete', 'options'].map((method) => [
            `features/shop/server/api/methods.${method}.ts`,
            handler(method),
          ]),
        ),
        'features/shop/server/api/methods.head.ts':
          'export default defineEventHandler((event) => { setResponseHeader(event, "x-method", "head") })',
        'features/shop/server/api/files/pinned.get.ts': handler('static priority'),
        'features/shop/server/api/users/me.get.ts': handler('static user'),
        'modules/duplicate-plugin.ts': `import { addNitroPlugin, defineNuxtModule } from '@nuxt/kit'
          export default defineNuxtModule({ setup(_, nuxt) {
            addNitroPlugin(nuxt.options.rootDir + '/features/shop/server/plugins/start.ts')
          } })`,
        'features/shop/server/routes/health.get.ts': handler('health'),
        'features/shop/features/inventory/server/api/index.get.ts': handler('inventory'),
        'features/shop/(admin)/server/api/(nested)/users/[id].get.ts':
          'export default defineEventHandler((event) => getRouterParam(event, "id"))',
        'features/shop/server/api/files/[...slug].get.ts':
          'export default defineEventHandler((event) => getRouterParam(event, "slug"))',
        'features/shop/server/api/mode.get.prod.ts': handler('prod'),
        'features/shop/server/api/mode.get.dev.ts': handler('dev'),
        'features/shop/server/utils/prefix.ts':
          'export const makeServerMessage = () => "explicit utility"',
        'features/shop/server/api/util.ts':
          'import { makeServerMessage } from "../utils/prefix"; export default defineEventHandler(makeServerMessage)',
        'features/shop/server/middleware/count.ts':
          'export default defineEventHandler((event) => setResponseHeader(event, "x-feature-middleware", String(Number(getResponseHeader(event, "x-feature-middleware") || 0) + 1)))',
        'features/shop/server/middleware/order.ts':
          'export default defineEventHandler((event) => setResponseHeader(event, "x-middleware-order", (getResponseHeader(event, "x-middleware-order") || "") + "-feature"))',
        'features/shop/server/plugins/start.ts':
          'export default defineNitroPlugin((nitro) => { let calls = 0; nitro.hooks.hook("request", (event) => { setResponseHeader(event, "x-plugin-count", String(++calls)); setResponseHeader(event, "x-plugin-order", "feature-") }) })',
      },
      async (root) => {
        await buildFixture(root)
        const types = await readFile(join(root, '.nuxt/types/nitro-routes.d.ts'), 'utf8')
        for (const route of [
          '/api/shop/products',
          '/shop/health',
          '/api/shop/inventory',
          '/api/shop/users/:id',
        ])
          expect(types).toContain(route)
        const products = types.match(/'\/api\/shop\/products': \{([^}]+)}/)?.[1]
        expect(products).toContain("'get':")
        expect(products).toContain("'post':")
        expect(products).toContain("'default':")
        const imports = await readFile(join(root, '.nuxt/types/nitro-imports.d.ts'), 'utf8')
        expect(imports).not.toContain('makeServerMessage')
        await withServer(root, false, async (request) => {
          let calls = 0
          for (const [path, method, expected] of [
            ['/api/shop/products', 'GET', 'GET'],
            ['/api/shop/products', 'POST', 'POST'],
            ['/api/shop/products', 'PUT', 'fallback'],
            ['/shop/health', 'GET', 'health'],
            ['/api/shop/inventory', 'GET', 'inventory'],
            ['/api/shop/users/42', 'GET', '42'],
            ['/api/shop/files/a/b', 'GET', 'a/b'],
            ['/api/shop/files/pinned', 'GET', 'static priority'],
            ['/api/shop/users/me', 'GET', 'static user'],
            ['/api/shop/methods', 'PUT', 'put'],
            ['/api/shop/methods', 'PATCH', 'patch'],
            ['/api/shop/methods', 'DELETE', 'delete'],
            ['/api/shop/methods', 'OPTIONS', 'options'],
            ['/api/shop/util', 'GET', 'explicit utility'],
            ['/api/shop/mode', 'GET', 'prod'],
            ['/api/status', 'GET', 'native'],
            ['/api/layer', 'GET', 'native layer'],
          ]) {
            const response = await request(path!, method)
            expect(response.status, path).toBe(200)
            expect(await response.text()).toBe(expected)
            expect(response.headers.get('x-feature-middleware')).toBe('1')
            const call = Number(response.headers.get('x-plugin-count'))
            if (calls) expect(call).toBe(calls + 1)
            calls = call
            expect(response.headers.get('x-plugin-order')).toBe('feature-native')
            expect(response.headers.get('x-middleware-order')).toBe('native-feature')
          }
          const head = await request('/api/shop/methods', 'HEAD')
          expect(head.status).toBe(204)
          expect(head.headers.get('x-method')).toBe('head')
        })
      },
    )
  },
)

it(
  'uses Nitro reload for edits and quarantines a replaced handler without taking unrelated endpoints offline',
  { timeout },
  async () => {
    const file = 'features/shop/server/api/value.get.ts'
    const sentinel = 'OUTSIDE_SCOPE_SENTINEL'
    const outside = 'app/lib/outside.ts'
    await fixture(
      {
        [file]: handler('initial'),
        [outside]: `defineRouteMeta({ openAPI: { description: "${sentinel}" } }); ${handler(sentinel)}`,
        'server/api/health.get.ts': handler('native healthy'),
        'features/shop/server/api/rest.get.ts': handler('feature healthy'),
        'features/shop/server/api/mode.get.dev.ts': handler('development only'),
      },
      async (root) => {
        await withServer(root, true, async (request, logs) => {
          async function renders(path: string, value: string) {
            await waitFor(async () => {
              const response = await request(path).catch(() => undefined)
              return response?.ok === true && (await response.text()) === value
            }, logs)
          }
          await renders('/api/shop/value', 'initial')
          await renders('/api/shop/mode', 'development only')
          await writeFile(join(root, file), handler('edited'))
          await renders('/api/shop/value', 'edited')

          await rm(join(root, file))
          await symlink(join(root, outside), join(root, file))
          await waitFor(async () => {
            const response = await request('/api/shop/value').catch(() => undefined)
            if (!response) return false
            const body = await response.text()
            expect(body).not.toContain(sentinel)
            return response.status === 503 && body.includes('FEATURE_SERVER_UNAVAILABLE')
          }, logs)
          expect(logs()).toContain('FEATURE_SERVER_UNSAFE')
          await renders('/api/health', 'native healthy')
          await renders('/api/shop/rest', 'feature healthy')
          const openAPI = await request('/_openapi.json')
          expect(openAPI.status).toBe(200)
          expect(await openAPI.text()).not.toContain(sentinel)
        })
        await rm(join(root, file))
        await writeFile(join(root, file), handler('recovered'))
        await mkdir(join(root, 'features/other/server/api'), { recursive: true })
        await writeFile(join(root, 'features/other/server/api/new.get.ts'), handler('new root'))
        await mkdir(join(root, 'features/shop/server/api/nested'), { recursive: true })
        await writeFile(
          join(root, 'features/shop/server/api/nested/new.get.ts'),
          handler('new endpoint'),
        )
        await rename(
          join(root, 'features/shop/server/api/rest.get.ts'),
          join(root, 'features/shop/server/api/renamed.get.ts'),
        )
        await withServer(root, true, async (request, logs) => {
          await waitFor(
            async () => (await (await request('/api/shop/value')).text()) === 'recovered',
            logs,
          )
          expect(await (await request('/api/other/new')).text()).toBe('new root')
          expect(await (await request('/api/shop/nested/new')).text()).toBe('new endpoint')
          expect(await (await request('/api/shop/rest')).text()).not.toBe('feature healthy')
          expect(await (await request('/api/shop/renamed')).text()).toBe('feature healthy')
        })
        const configFile = join(root, 'nuxt.config.ts')
        const config = await readFile(configFile, 'utf8')
        await writeFile(
          configFile,
          config.replace(
            enabled,
            `feature: {
          server: { enabled: true }, routing: { overrides: { features: { shop: 'none' } } },
        },`,
          ),
        )
        await withServer(root, true, async (request, logs) => {
          await waitFor(
            async () => (await (await request('/api/value')).text()) === 'recovered',
            logs,
          )
          expect(await (await request('/api/shop/value')).text()).not.toBe('recovered')
          expect(await (await request('/api/other/new')).text()).toBe('new root')
        })
      },
      enabled + 'nitro: { experimental: { openAPI: true } },',
    )
  },
)

it.each([
  ['features/shop/server/api/value.get.ts', 'server/features/shop/api/value.get.ts', ''],
  ['features/shop/server/api/value.get.ts', 'server/api/shop/value.get.ts', ''],
  ['features/shop/server/api/value.get.ts', 'layers/base/server/api/shop/value.get.ts', ''],
  ['features/shop/server/api/[id].get.ts', 'features/shop/(admin)/server/api/[slug].get.ts', ''],
  [
    'features/shop/server/api/value.get.ts',
    'features/auth/server/api/value.get.ts',
    'routing: { prefix: "none" },',
  ],
])('rejects a route collision between %s and %s', { timeout }, async (a, b, routing) => {
  await fixture(
    {
      'layers/base/nuxt.config.ts': 'export default defineNuxtConfig({})',
      [a]: handler('first'),
      [b]: handler('second'),
    },
    async (root) => {
      await expect(buildFixture(root)).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringMatching(/FEATURE_SERVER_COLLISION[\s\S]*GET/),
        }),
      )
    },
    `feature: { server: { enabled: true }, ${routing} },`,
  )
})

it('does not register any Feature Server resources by default', { timeout }, async () => {
  await fixture(
    {
      'app/app.vue':
        '<script setup>import { greeting } from "./lib/greeting"; const message = ref(greeting)</script><template><main>{{ message }}<NativeDisplay /></main></template>',
      'app/lib/greeting.ts': 'export const greeting = "APP_NORMAL_IMPORT"',
      'app/components/NativeDisplay.vue': '<template><p>NATIVE_NUXT_COMPONENT</p></template>',
      'server/api/native.get.ts': handler('native'),
      'features/shop/server/utils/private.ts':
        'export const marker = "DISABLED_SERVER_PRIVATE_SENTINEL"',
      'features/shop/server/api/feature.get.ts': handler('feature only'),
      'features/shop/server/middleware/probe.ts':
        'export default defineEventHandler((event) => setResponseHeader(event, "x-feature", "present"))',
      'features/shop/server/plugins/probe.ts':
        'export default defineNitroPlugin(() => { throw new Error("must stay disabled") })',
    },
    async (root) => {
      await buildFixture(root)
      expect(await readFile(join(root, '.nuxt/types/nitro-routes.d.ts'), 'utf8')).not.toContain(
        '/api/shop/feature',
      )
      const client = join(root, '.output/public/_nuxt')
      const js = (await readdir(client)).filter((file) => file.endsWith('.js'))
      const bundle = (
        await Promise.all(js.map((file) => readFile(join(client, file), 'utf8')))
      ).join('')
      expect(bundle).toContain('APP_NORMAL_IMPORT')
      expect(bundle).not.toContain('DISABLED_SERVER_PRIVATE_SENTINEL')
      await withServer(root, false, async (request) => {
        const app = await (await request('/')).text()
        expect(app).toContain('APP_NORMAL_IMPORT')
        expect(app).toContain('NATIVE_NUXT_COMPONENT')
        const native = await request('/api/native')
        expect(await native.text()).toBe('native')
        expect(native.headers.has('x-feature')).toBe(false)
        expect(await (await request('/api/shop/feature')).text()).not.toBe('feature only')
      })
    },
    '',
  )
})

it.each(['file', 'directory', 'ancestor'] as const)(
  'rejects a symlinked %s before Feature Server registration',
  { timeout },
  async (kind) => {
    await fixture(
      {
        'features/shop/server/api/valid.get.ts': handler('valid'),
        'features/other/server/utils/outside.ts': handler('another feature'),
        'app/lib/outside.ts': handler('app'),
      },
      async (root) => {
        const api = join(root, 'features/shop/server/api')
        if (kind === 'file') {
          await symlink(join(root, 'app/lib/outside.ts'), join(api, 'linked.ts'))
        } else if (kind === 'directory') {
          await symlink(join(root, 'features/other/server/utils'), join(api, 'linked'), 'dir')
        } else {
          const scope = dirname(api)
          await rename(scope, join(root, 'moved-scope'))
          await symlink(join(root, 'moved-scope'), scope, 'dir')
        }
        await expect(buildFixture(root)).rejects.toThrow(/FEATURE_SERVER_SYMLINK|SYMLINK_RESOURCE/)
      },
    )
  },
)

it(
  'uses shared ancestry overrides and respects a custom Nitro API mount',
  { timeout },
  async () => {
    await fixture(
      {
        'app/features/shop/composables/example.ts': 'export const example = 1',
        'server/features/shop/api/index.get.ts': handler('shop'),
        'features/shop/(admin)/server/api/team.get.ts': handler('admin'),
        'features/shop/(admin)/features/inventory/server/api/index.get.ts': handler('inventory'),
        '(ops)/server/routes/status.get.ts': handler('operations'),
      },
      async (root) => {
        let snapshot: ReturnType<typeof getServerResources>
        const nuxt = await loadNuxt({ cwd: root, ready: false })
        try {
          await nuxt.ready()
          nuxt.hook('nitro:build:before', (nitro) => {
            snapshot = getServerResources(nitro)
          })
          await build(nuxt)
        } finally {
          await nuxt.close()
        }
        const inventory = snapshot?.find((item) => item.owner === 'shop/admin/inventory')
        expect(inventory).toMatchObject({
          kind: 'api',
          route: '/private-api/admin/inventory',
          method: 'get',
          ancestors: ['shop', 'shop/admin'],
          registration: 'feature',
        })
        expect(Object.isFrozen(snapshot)).toBe(true)
        expect(Object.isFrozen(inventory?.ancestors)).toBe(true)
        await withServer(root, false, async (request) => {
          for (const [path, body] of Object.entries({
            '/private-api': 'shop',
            '/private-api/admin/team': 'admin',
            '/private-api/admin/inventory': 'inventory',
            '/status': 'operations',
          }))
            expect(await (await request(path)).text()).toBe(body)
        })
      },
      `nitro: { apiBaseURL: '/private-api' }, feature: {
    server: { enabled: true },
    routing: { prefix: 'none', groupPrefix: true, overrides: {
      features: { 'shop/admin/inventory': 'feature' }, groups: { ops: false }
    } },
  },`,
    )
  },
)

it('rejects the same effective slot registered by another module', { timeout }, async () => {
  await fixture(
    {
      'features/shop/server/api/value.get.ts': handler('feature'),
      'other.get.ts': handler('other'),
      'modules/other.ts': `import { addServerHandler, defineNuxtModule } from '@nuxt/kit'
      export default defineNuxtModule({ setup(_, nuxt) {
        addServerHandler({ route: '/api/shop/value', handler: nuxt.options.rootDir + '/other.get.ts' })
      } })`,
    },
    async (root) => {
      await expect(buildFixture(root)).rejects.toThrow(/FEATURE_SERVER_COLLISION.*other\.get\.ts/)
    },
  )
})

it(
  'rejects duplicated Feature middleware even when registered by a module',
  { timeout },
  async () => {
    await fixture(
      {
        'features/shop/server/middleware/trace.ts': 'export default defineEventHandler(() => {})',
        'modules/other.ts': `import { addServerHandler, defineNuxtModule } from '@nuxt/kit'
      export default defineNuxtModule({ setup(_, nuxt) {
        addServerHandler({ middleware: true, handler: nuxt.options.rootDir + '/features/shop/server/middleware/trace.ts' })
      } })`,
      },
      async (root) => {
        await expect(buildFixture(root)).rejects.toThrow(/FEATURE_SERVER_DUPLICATE.*trace\.ts/)
      },
    )
  },
)

it(
  'rejects Feature resources that overlap configured native scan directories',
  { timeout },
  async () => {
    await fixture(
      {
        'features/shop/server/api/value.get.ts': handler('feature'),
        'modules/other.ts': `import { addServerScanDir, defineNuxtModule } from '@nuxt/kit'
      export default defineNuxtModule({ setup(_, nuxt) {
        addServerScanDir(nuxt.options.rootDir + '/features/shop/server')
      } })`,
      },
      async (root) => {
        await expect(buildFixture(root)).rejects.toThrow(
          /FEATURE_SERVER_BOUNDARY.*overlaps Nitro scan/,
        )
      },
    )
  },
)

it(
  'guards App import graphs against explicit imports from a full-stack Server scope',
  { timeout },
  async () => {
    await fixture(
      {
        'app/app.vue':
          '<script setup lang="ts">import { serverOnly } from "~~/features/shop/server/utils/value"</script><template><main>{{ serverOnly }}</main></template>',
        'features/shop/server/utils/value.ts': 'export const serverOnly = "SERVER_ONLY_IMPORT"',
        'features/shop/server/api/value.get.ts': handler('feature'),
      },
      async (root) => {
        await expect(buildFixture(root)).rejects.toThrow(/FEATURE_SERVER_APP_IMPORT.*value\.ts/)
      },
    )
  },
)

it(
  'fails a production build if a registered handler changes into a symlink before compilation',
  { timeout },
  async () => {
    const handlerPath = 'features/shop/server/api/value.get.ts'
    await fixture(
      {
        [handlerPath]: handler('safe'),
        'app/lib/outside.ts': handler('OUTSIDE_SOURCE'),
      },
      async (root) => {
        const nuxt = await loadNuxt({ cwd: root, ready: false })
        try {
          await nuxt.ready()
          nuxt.hook('nitro:build:before', async () => {
            await rm(join(root, handlerPath))
            await symlink(join(root, 'app/lib/outside.ts'), join(root, handlerPath))
          })
          await expect(build(nuxt)).rejects.toThrow('FEATURE_SERVER_UNSAFE')
        } finally {
          await nuxt.close()
        }
      },
    )
  },
)

it.each([
  [false, '../../features/shop/server/utils/value', 'features/shop/server/utils/value.ts'],
  [false, '~~/server/features/shop/utils/value', 'server/features/shop/utils/value.ts'],
  [true, '~~/features/shop/server/utils/value', 'features/shop/server/utils/value.ts'],
] as const)(
  'blocks browser imports with Server registration %s (%s)',
  { timeout },
  async (serverEnabled, specifier, file) => {
    const marker = 'FEATURE_SERVER_CLIENT_BOUNDARY_SENTINEL'
    await fixture(
      {
        'app/app.vue': '<template><Forbidden /></template>',
        'app/components/Forbidden.vue': `<script setup>import { value } from '${specifier}'</script><template><p>{{ value }}</p></template>`,
        [file]: `export const value = "${marker}"`,
      },
      async (root) => {
        await expect(buildFixture(root)).rejects.toThrow('FEATURE_SERVER_APP_IMPORT')
      },
      `feature: { server: { enabled: ${serverEnabled} } },`,
    )
  },
)

const devModule = `import { addDevServerHandler, defineNuxtModule } from '@nuxt/kit'
export default defineNuxtModule({
  setup(_, nuxt) {
    addDevServerHandler({ route: nuxt.options.runtimeConfig.devHandlerPath, handler: function developmentProbe() { return 'development handler' } })
  }
})`

it('rejects a same-path Kit dev handler only in development', { timeout }, async () => {
  await fixture(
    {
      'features/shop/server/api/products.get.ts': handler('feature GET'),
      'server/api/native.get.ts': handler('native'),
      'modules/dev-probe.ts': devModule,
    },
    async (root) => {
      const nuxt = await loadNuxt({ cwd: root, dev: true, overrides: { dev: true }, ready: false })
      try {
        let instance: Parameters<NuxtHooks['nitro:init']>[0] | undefined
        nuxt.hook('nitro:init', (nitro) => {
          instance = nitro
        })
        await nuxt.ready()
        const nitro = instance!
        expect(
          nitro.options.devHandlers.some((handler) => handler.route === '/api/shop/products'),
        ).toBe(true)
        await expect(nuxt.callHook('nitro:build:before', nitro)).rejects.toThrow(
          /FEATURE_SERVER_COLLISION.*GET \/api\/shop\/products.*ALL.*developmentProbe/,
        )
      } finally {
        await nuxt.close()
      }
      await buildFixture(root)
      await withServer(root, false, async (request) => {
        expect(await (await request('/api/shop/products')).text()).toBe('feature GET')
        expect(await (await request('/api/native')).text()).toBe('native')
      })
    },
    enabled + 'runtimeConfig: { devHandlerPath: "/api/shop/products" },',
  )
})

it(
  'observes Kit dev-handler precedence while distinct Feature methods coexist',
  { timeout },
  async () => {
    await fixture(
      {
        'features/shop/server/api/products.get.ts': handler('feature GET'),
        'features/shop/server/api/products.post.ts': handler('feature POST'),
        'server/api/native.get.ts': handler('native'),
        'modules/dev-probe.ts': devModule,
      },
      async (root) => {
        await withServer(root, true, async (request, logs) => {
          await waitFor(
            async () => (await (await request('/api/shop/products')).text()) === 'feature GET',
            logs,
          )
          expect(await (await request('/api/shop/products', 'POST')).text()).toBe('feature POST')
          expect(await (await request('/api/native')).text()).toBe('native')
          expect(await (await request('/api/development', 'POST')).text()).toBe(
            'development handler',
          )
        })
      },
      enabled + 'runtimeConfig: { devHandlerPath: "/api/development" },',
    )
  },
)

it(
  'matches Nitro ignores relative to each Server scope while honoring absolute patterns',
  { timeout },
  async () => {
    await fixture(
      {
        'server/api/private/value.get.ts': handler('hidden native'),
        'server/routes/internal/value.get.ts': handler('hidden native'),
        'server/api/public/value.get.ts': handler('public native'),
        'server/api/leading/value.get.ts': handler('leading slash native'),
        'features/shop/server/api/private/value.get.ts': handler('hidden feature'),
        'features/shop/server/routes/internal/value.get.ts': handler('hidden feature'),
        'features/shop/server/api/private/deep/nested.get.ts': handler('hidden feature'),
        'features/shop/server/api/absolute/value.get.ts': handler('hidden by absolute pattern'),
        'features/shop/server/api/public/value.get.ts': handler('public feature'),
        'server/features/shop/api/private/other.get.ts': handler('hidden other scope'),
        'server/features/shop/api/leading/value.get.ts': handler('leading slash feature'),
        'server/features/shop/api/absolute/other.get.ts': handler(
          'absolute pattern does not apply here',
        ),
        'modules/ignores.ts': `import { defineNuxtModule } from '@nuxt/kit'
      export default defineNuxtModule({ setup(_, nuxt) {
        nuxt.hook('nitro:config', (config) => {
          config.ignore ||= []
          config.ignore.push(nuxt.options.rootDir + '/features/shop/server/api/absolute/**')
        })
      } })`,
      },
      async (root) => {
        await buildFixture(root)
        const types = await readFile(join(root, '.nuxt/types/nitro-routes.d.ts'), 'utf8')
        for (const path of [
          '/api/private/value',
          '/internal/value',
          '/api/shop/private/value',
          '/shop/internal/value',
          '/api/shop/private/deep/nested',
          '/api/shop/private/other',
          '/api/shop/absolute/value',
        ])
          expect(types).not.toContain(`'${path}'`)
        for (const path of [
          '/api/public/value',
          '/api/shop/public/value',
          '/api/leading/value',
          '/api/shop/leading/value',
          '/api/shop/absolute/other',
        ])
          expect(types).toContain(`'${path}'`)
        await withServer(root, false, async (request) => {
          expect(await (await request('/api/shop/public/value')).text()).toBe('public feature')
          expect(await (await request('/api/shop/private/value')).text()).not.toBe('hidden feature')
        })
      },
      enabled + `nitro: { ignore: ['api/private/**', 'routes/inter[n]al/**', '/api/leading/**'] },`,
    )
  },
)

it(
  'protects development SSR when Feature Server registration is off',
  { timeout },
  async () => {
    const source = 'features/shop/server/utils/private.ts'
    const marker = 'DEV_SERVER_PRIVATE_SENTINEL'
    await fixture(
      {
        'app/app.vue':
          '<script setup>import { value } from "~~/features/shop/server/utils/private"</script><template><main>{{ value }}</main></template>',
        [source]: `export const value = "${marker}"`,
        'server/api/native.get.ts': handler('native remains available'),
      },
      async (root) => {
        await withServer(root, true, async (request, logs) => {
          await waitFor(
            async () =>
              (await (await request('/api/native')).text()) === 'native remains available',
            logs,
          )
          const ssr = await request('/')
          expect(ssr.status).toBe(500)
          const html = await ssr.text()
          expect(html).toContain('Importing Feature Server source into the Nuxt app is not allowed')
          expect(html).not.toContain(marker)
        })
      },
      'feature: { server: { enabled: false } },',
    )
  },
)
