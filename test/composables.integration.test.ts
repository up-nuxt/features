import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, loadNuxt } from 'nuxt'
import type { NuxtHooks } from '@nuxt/schema'
import { expect, it, vi } from 'vitest'

const project = fileURLToPath(new URL('..', import.meta.url))
const named = (name: string) => `export function ${name}() { return '${name}' }`
const enabled = 'feature: { composables: { autoImport: true } },'
const options = { timeout: 60_000 }

function generatedImports(nuxt: Awaited<ReturnType<typeof loadNuxt>>) {
  const runtime = nuxt.vfs[join(nuxt.options.buildDir, 'imports.mjs')]
  if (!runtime) throw new Error('Missing generated Nuxt imports.mjs in VFS')
  return runtime
}

async function fixture(
  files: Record<string, string>,
  run: (app: { root: string; load: () => ReturnType<typeof loadNuxt> }) => Promise<void>,
  config = enabled,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'features-imports-')))
  try {
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir')
    for (const [path, content] of Object.entries({
      'app/app.vue': '<template><main/></template>',
      ...files,
    })) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), content)
    }
    await writeFile(
      join(root, 'nuxt.config.ts'),
      `export default defineNuxtConfig({ modules: [${JSON.stringify(join(project, 'src/module.ts'))}], buildDir: '.nuxt', devtools: false, compatibilityDate: '2026-11-17', ${config} })`,
    )
    await run({ root, load: () => loadNuxt({ cwd: root, dev: false }) })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it(
  'uses native export semantics across App scopes and generates runtime imports and types',
  options,
  async () => {
    await fixture(
      {
        'app/features/shop/composables/useCart.ts': named('useCart') + '\n' + named('useProducts'),
        'features/shop/app/composables/use-stock.ts': 'export default () => "stock"',
        'features/shop/features/inventory/app/composables/useInventory.ts': named('useInventory'),
        'features/shop/(checkout)/app/composables/useCheckout.ts': named('useCheckout'),
        'app/features/shop/(delivery)/composables/useDelivery.ts': named('useDelivery'),
        '(catalog)/app/composables/useCatalog.ts': named('useCatalog'),
        '(catalog)/(search)/app/composables/useSearch.ts': named('useSearch'),
        'catalog/app/composables/useDecoy.ts': named('useDecoy'),
        'app/features/shop/composables/index.ts':
          "export { useNested } from './nested/useNested'\nexport type CartItem = { id: string }",
        'app/features/shop/composables/nested/useNested.ts':
          named('useNested') + '\n' + named('useHidden'),
        'app/composables/useNative.ts': named('useNative'),
        'app/composables/useFromFeature.ts':
          'export function useFromFeature() { return useCart() }',
        'server/features/shop/services/usePrivate.ts': named('usePrivate'),
        'features/shop/server/services/useServerOnly.ts': named('useServerOnly'),
        'app/pages/index.vue':
          '<script setup lang="ts">const value = useFromFeature()</script><template><p>{{ value }}</p></template>',
        'app/app.vue':
          '<script setup lang="ts">const cart = useCart()</script><template><main>{{ cart }}<NuxtPage /></main></template>',
      },
      async ({ load }) => {
        const nuxt = await load()
        try {
          await build(nuxt)
          const runtime = generatedImports(nuxt)
          const types = await readFile(join(nuxt.options.buildDir, 'imports.d.ts'), 'utf8')
          for (const name of [
            'useCart',
            'useProducts',
            'useStock',
            'useInventory',
            'useCheckout',
            'useDelivery',
            'useCatalog',
            'useSearch',
            'useNested',
            'useNative',
            'useFromFeature',
          ]) {
            expect(runtime).toContain(name)
            expect(types).toContain(name)
          }
          expect(runtime).toContain('default as useStock')
          expect(runtime).toContain('(catalog)/(search)/app/composables/useSearch')
          expect(runtime).toMatch(/useNested.*composables\/index/)
          expect(types).toContain('CartItem')
          expect(runtime).not.toContain('CartItem')
          for (const name of ['useDecoy', 'useHidden', 'usePrivate', 'useServerOnly'])
            expect(runtime + types).not.toContain(name)
        } finally {
          await nuxt.close()
        }
      },
    )
  },
)

it.each([
  '',
  'feature: { composables: { autoImport: false } },',
  enabled + 'imports: { scan: false },',
])('does not register feature imports when disabled (%s)', options, async (config) => {
  await fixture(
    {
      'app/features/shop/composables/useCart.ts': named('useCart'),
      'features/cart/app/composables/useCart.ts': named('useCart'),
      'app/composables/useNative.ts': named('useNative'),
      'app/app.vue':
        '<script setup lang="ts">import { useCart } from "./features/shop/composables/useCart"; const cart = useCart()</script><template><main>{{ cart }}</main></template>',
    },
    async ({ load }) => {
      const nuxt = await load()
      try {
        await build(nuxt)
        const runtime = generatedImports(nuxt)
        const types = await readFile(join(nuxt.options.buildDir, 'imports.d.ts'), 'utf8')
        expect(runtime + types).not.toContain('useCart')
        if (!config.includes('scan: false')) expect(runtime).toContain('useNative')
      } finally {
        await nuxt.close()
      }
    },
    config,
  )
})

it.each([
  ['app/features/shop/composables/useCart.ts', 'features/shop/app/composables/useCart.ts'],
  [
    'features/shop/(checkout)/app/composables/useCart.ts',
    'features/shop/features/payment/app/composables/useCart.ts',
  ],
  ['(one)/app/composables/useCart.ts', '(two)/app/composables/useCart.ts'],
  ['app/features/shop/composables/useCart.ts', 'app/composables/useCart.ts'],
])('rejects ambiguous imports between %s and %s', options, async (first, second) => {
  await fixture({ [first]: named('useCart'), [second]: named('useCart') }, async ({ load }) => {
    await expect(load()).rejects.toThrow(/FEATURE_COMPOSABLE_COLLISION.*useCart/)
  })
})

it.each([undefined, 0, -10, 100])(
  'honors third-party aliases and explicit priority %s',
  options,
  async (priority) => {
    await fixture(
      {
        'features/shop/app/composables/useCart.ts': named('useCart'),
        'external.ts': named('useExternal'),
        'modules/external.ts': `import { addImports, defineNuxtModule } from '@nuxt/kit'
      export default defineNuxtModule({setup(_, nuxt) {
        addImports({ name: 'useExternal', as: 'useCart', from: nuxt.options.rootDir + '/external.ts', priority: ${priority} })
      }})`,
      },
      async ({ load }) => {
        if (priority === undefined) {
          await expect(load()).rejects.toThrow(/FEATURE_COMPOSABLE_COLLISION.*useCart/)
          return
        }
        const nuxt = await load()
        try {
          await build(nuxt)
          const runtime = generatedImports(nuxt)
          if (priority > 1) expect(runtime).toMatch(/useExternal as useCart.*external/)
          else expect(runtime).toMatch(/useCart.*composables\/useCart/)
        } finally {
          await nuxt.close()
        }
      },
    )
  },
)

it('rejects an equally ranked feature import that clashes with a Nuxt API', options, async () => {
  await fixture(
    { 'features/shop/app/composables/useState.ts': named('useState') },
    async ({ load }) => {
      await expect(load()).rejects.toThrow(/FEATURE_COMPOSABLE_COLLISION.*useState/)
    },
  )
})

it(
  'keeps Server-scope composables out of the application by rejecting the invalid layout',
  options,
  async () => {
    await fixture(
      { 'features/shop/server/composables/usePrivate.ts': named('usePrivate') },
      async ({ load }) => {
        await expect(load()).rejects.toThrow(/INVALID_RESOURCE_LOCATION.*server scope/)
      },
    )
  },
)

it.each(['dir', 'file'] as const)(
  'rejects a %s symlink into server code before publishing imports',
  options,
  async (kind) => {
    await fixture(
      {
        'features/shop/app/composables/useNormal.ts': named('useNormal'),
        'server/features/shop/services/usePrivate.ts': named('usePrivate'),
      },
      async ({ root, load }) => {
        await symlink(
          join(root, 'server/features/shop/services', kind === 'file' ? 'usePrivate.ts' : ''),
          join(root, 'features/shop/app/composables', kind === 'file' ? 'usePrivate.ts' : 'linked'),
          kind,
        )
        await expect(load()).rejects.toThrow(/FEATURE_COMPOSABLE_SYMLINK/)
        await expect(readFile(join(root, '.nuxt/imports.mjs'), 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        })
      },
    )
  },
)

it(
  'refreshes imports through the real Nuxt watch hook and rejects a late symlink',
  options,
  async () => {
    await fixture(
      {
        'app/features/shop/composables/useOld.ts': named('useOld'),
        'server/features/shop/services/usePrivate.ts': named('usePrivate'),
        'app/composables/useNative.ts': named('useNative'),
      },
      async ({ root }) => {
        const target = join(root, 'server/features/shop/services/usePrivate.ts')
        // Nuxt 4.7 stats the link target and may skip a scan for an older mtime.
        await utimes(target, 1, 1)
        const nuxt = await loadNuxt({ cwd: root, dev: true, overrides: { dev: true }, ready: false })
        let context: Parameters<NuxtHooks['imports:context']>[0] | undefined
        nuxt.hook('imports:context', (value) => {
          context = value
        })
        await nuxt.ready()
        try {
          const dir = join(root, 'app/features/shop/composables')
          if (!context) throw new Error('Missing Nuxt import context')
          const imports = context
          const getNames = async () =>
            (await imports.getImports()).map((item) => item.as ?? item.name)
          expect(await getNames()).toContain('useOld')
          await rm(join(dir, 'useOld.ts'))
          await writeFile(join(dir, 'useNew.ts'), named('useNew'))
          await nuxt.callHook('builder:watch', 'add', 'features/shop/composables/useNew.ts')
          expect(await getNames()).toContain('useNew')
          expect(await getNames()).not.toContain('useOld')
          await rm(join(dir, 'useNew.ts'))
          await symlink(target, join(dir, 'useNew.ts'))
          await expect(
            nuxt.callHook('builder:watch', 'add', 'features/shop/composables/useNew.ts'),
          ).rejects.toThrow('FEATURE_COMPOSABLE_SYMLINK')
          expect(await getNames()).not.toContain('usePrivate')
          expect(await getNames()).not.toContain('useNew')
          expect(await getNames()).toContain('useNative')
          await rm(join(dir, 'useNew.ts'))
          await writeFile(join(dir, 'useNew.ts'), named('useNew'))
          await nuxt.callHook('builder:watch', 'add', 'features/shop/composables/useNew.ts')
          expect(await getNames()).toContain('useNew')
        } finally {
          await nuxt.close()
        }
      },
    )
  },
)

it(
  'rejects collisions between star barrels whose helpers are outside composables directories',
  options,
  async () => {
    await fixture(
      {
        'features/shop/app/composables/index.ts': "export * from '../helpers/cart'",
        'features/shop/app/helpers/cart.ts': named('useCart'),
        'features/orders/app/composables/index.ts': "export * from '../helpers/cart'",
        'features/orders/app/helpers/cart.ts': named('useCart'),
      },
      async ({ load }) => {
        await expect(load()).rejects.toThrow(/FEATURE_COMPOSABLE_COLLISION.*useCart/)
      },
    )
  },
)

it.skipIf(process.platform === 'win32')(
  'scans configured literal roots with spaces and glob characters',
  options,
  async () => {
    const directory = 'build|backup [team] {a,b}/(shop)/app/composables'
    await fixture(
      { [directory + '/useCart.ts']: named('useCart') },
      async ({ load }) => {
        const nuxt = await load()
        try {
          await build(nuxt)
          expect(generatedImports(nuxt)).toContain(directory + '/useCart')
          expect(await readFile(join(nuxt.options.buildDir, 'imports.d.ts'), 'utf8')).toContain(
            directory + '/useCart',
          )
        } finally {
          await nuxt.close()
        }
      },
      "feature: { roots: { general: 'build|backup [team] {a,b}' }, composables: { autoImport: true } },",
    )
  },
)

it(
  'revokes replaced composables in a running Nuxt/Vite server and recovers on restart',
  options,
  async () => {
    await fixture(
      {
        'modules/capture-imports.ts': `import { defineNuxtModule } from '@nuxt/kit'
        import { writeFile } from 'node:fs/promises'
        import { join } from 'node:path'
        export default defineNuxtModule({ setup(_, nuxt) {
          nuxt.hook('app:templatesGenerated', () => {
            const source = nuxt.vfs['#build/imports.mjs']
            if (source) return writeFile(join(nuxt.options.buildDir, 'observed-imports.txt'), source)
          })
        } })`,
        'app/app.vue': '<template><NuxtPage /></template>',
        'app/pages/index.vue':
          '<script setup lang="ts">const cart = useCart()</script><template><main>{{ cart }}</main></template>',
        'app/pages/independent.vue': '<template><main>UNRELATED_SSR</main></template>',
        'app/lib/independent.ts': 'export const value = "UNRELATED_MODULE"',
        'app/composables/useNative.ts': named('useNative'),
        'app/features/shop/composables/useCart.ts': 'export const useCart = () => "VALID_CART"',
        'server/features/shop/services/private.ts':
          'export const useCart = () => "SERVER_ONLY_SENTINEL"',
      },
      async ({ root }) => {
        const reserve = createServer().listen(0, '127.0.0.1')
        await once(reserve, 'listening')
        const address = reserve.address()
        if (!address || typeof address === 'string') throw new Error('No development port')
        await new Promise<void>((resolve, reject) =>
          reserve.close((error) => (error ? reject(error) : resolve())),
        )
        const origin = 'http://127.0.0.1:' + address.port
        const relativeFile = 'app/features/shop/composables/useCart.ts'
        const file = join(root, relativeFile)
        const viteUrl = '/_nuxt/@fs/' + file
        const independentUrl = '/_nuxt/@fs/' + join(root, 'app/lib/independent.ts')
        let output = ''
        const start = () => {
          const child = spawn(
            process.execPath,
            [
              join(project, 'node_modules/nuxt/bin/nuxt.mjs'),
              'dev',
              root,
              '--host',
              '127.0.0.1',
              '--port',
              String(address.port),
              '--no-fork',
            ],
            { env: { ...process.env, NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] },
          )
          child.stdout.on('data', (data) => {
            output += data
          })
          child.stderr.on('data', (data) => {
            output += data
          })
          return child
        }
        async function stop(child: ReturnType<typeof start>) {
          if (child.exitCode !== null || child.signalCode !== null) return
          const closed = once(child, 'exit')
          child.kill('SIGTERM')
          await closed
        }
        async function waitFor(check: () => Promise<boolean>) {
          for (let attempt = 0; attempt < 100; attempt++) {
            if (await check()) return
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          throw new Error(output)
        }
        const request = (path: string) =>
          fetch(origin + path, { signal: AbortSignal.timeout(4000) })
        const ready = (marker: string) =>
          waitFor(async () => {
            const response = await request('/').catch(() => undefined)
            return !!response?.ok && (await response.text()).includes(marker)
          })
        let child = start()
        try {
          await ready('VALID_CART')
          const typesFile = join(root, '.nuxt/imports.d.ts')
          expect(await readFile(typesFile, 'utf8')).toContain('useCart')
          const runtimeFile = join(root, '.nuxt/observed-imports.txt')
          expect(await readFile(runtimeFile, 'utf8')).toContain('useCart')
          const original = await request(viteUrl)
          expect(original.status).toBe(200)
          expect(await original.text()).toContain('VALID_CART')
          expect(await (await request(independentUrl)).text()).toContain('UNRELATED_MODULE')
          await rm(file)
          await symlink(join(root, 'server/features/shop/services/private.ts'), file)
          await waitFor(async () => output.includes('FEATURE_COMPOSABLE_SYMLINK'))
          const unsafe = await request(viteUrl)
          expect(unsafe.status).toBe(503)
          const independent = await request(independentUrl)
          expect(independent.status).toBe(200)
          expect(await independent.text()).toContain('UNRELATED_MODULE')
          expect(await unsafe.text()).not.toContain('SERVER_ONLY_SENTINEL')
          const affectedPage = await request('/')
          const affectedHtml = await affectedPage.text()
          expect(affectedPage.status).toBe(500)
          // SSR can retransform the page against the revoked import list, or
          // hit the source guard while loading a previously transformed page.
          expect(affectedHtml).toMatch(/This feature composable failed validation|useCart is not defined/)
          expect(affectedHtml).not.toContain('SERVER_ONLY_SENTINEL')
          const independentPage = await request('/independent')
          expect(independentPage.status).toBe(200)
          expect(await independentPage.text()).toContain('UNRELATED_SSR')
          const types = await readFile(typesFile, 'utf8')
          expect(types).not.toContain('useCart')
          expect(types).toContain('useNative')
          const runtime = await readFile(runtimeFile, 'utf8')
          expect(runtime).not.toContain('useCart')
          expect(runtime).toContain('useNative')
          await stop(child)
          await rm(file)
          await writeFile(file, 'export const useCart = () => "RECOVERED_CART"')
          child = start()
          await ready('RECOVERED_CART')
          const recovered = await request(viteUrl)
          expect(recovered.ok).toBe(true)
          expect(await recovered.text()).toContain('RECOVERED_CART')
        } finally {
          await stop(child)
        }
      },
    )
  },
)

it(
  'keeps valid star barrels and the native winner for unequal directory priorities',
  options,
  async () => {
    await fixture(
      {
        'features/shop/app/composables/index.ts': "export * from '../helpers/cart'",
        'features/shop/app/helpers/cart.ts': named('useCart'),
        'app/composables/useCart.ts': named('useCart'),
      },
      async ({ load }) => {
        const nuxt = await load()
        try {
          await build(nuxt)
          expect(generatedImports(nuxt)).toMatch(/useCart.*features\/shop\/app\/helpers\/cart/)
          expect(generatedImports(nuxt)).not.toContain('app/composables/useCart')
        } finally {
          await nuxt.close()
        }
      },
    )
  },
)

it(
  'invalidates each active Vite graph once after restart within the same Nuxt instance',
  options,
  async () => {
    await fixture(
      {
        'app/features/shop/composables/useCart.ts': named('useCart'),
        'server/features/shop/services/private.ts': named('usePrivate'),
      },
      async ({ root }) => {
        const nuxt = await loadNuxt({ cwd: root, dev: true, overrides: { dev: true } })
        type ViteConfig = Parameters<NuxtHooks['vite:extend']>[0]['config']
        type ViteServer = Parameters<NuxtHooks['vite:serverCreated']>[0]
        const fromProject = createRequire(import.meta.url)
        const fromNuxt = createRequire(fromProject.resolve('nuxt/package.json'))
        const fromBuilder = createRequire(fromNuxt.resolve('@nuxt/vite-builder'))
        const vite: { createServer(config: ViteConfig): Promise<ViteServer> } = await import(
          pathToFileURL(fromBuilder.resolve('vite')).href
        )
        const config: ViteConfig & { configFile: false } = {
          root,
          configFile: false,
          server: { middlewareMode: true, ws: false, watch: null },
        }
        let server: ViteServer | undefined
        try {
          await nuxt.callHook('vite:extend', { nuxt, config })
          server = await vite.createServer(config)
          const oldGraph = server.environments.client.moduleGraph
          await server.restart()
          const graph = server.environments.client.moduleGraph
          expect(graph).not.toBe(oldGraph)
          const obsolete = vi.spyOn(oldGraph, 'getModulesByFile')
          const active = vi.spyOn(graph, 'getModulesByFile')
          const file = 'features/shop/composables/useCart.ts'
          await rm(join(root, 'app', file))
          await symlink(
            join(root, 'server/features/shop/services/private.ts'),
            join(root, 'app', file),
          )
          await expect(nuxt.callHook('builder:watch', 'add', file)).rejects.toThrow(
            'FEATURE_COMPOSABLE_SYMLINK',
          )
          expect(obsolete).not.toHaveBeenCalled()
          expect(active.mock.calls.filter(([path]) => path.endsWith('/useCart.ts'))).toHaveLength(1)
        } finally {
          await server?.close()
          await nuxt.close()
        }
      },
    )
  },
)
