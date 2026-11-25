import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, loadNuxt } from 'nuxt'
import { expect, it } from 'vitest'

const project = fileURLToPath(new URL('..', import.meta.url))
const helpers = '@up-nuxt/features/server'

const files = {
  'app/pages/(dashboard)/index.vue': `<script setup lang="ts">
const enabled = useState('feature-decision', () => false)
if (import.meta.server) {
  const event = useRequestEvent()!
  const { isFeatureEnabled } = await import('${helpers}')
  enabled.value = await isFeatureEnabled(event, 'shop')
}
</script>
<template><p id="availability">{{ enabled ? 'AVAILABLE' : 'UNAVAILABLE' }}</p></template>`,
  'features/shop/app/pages/(dashboard)/(inner)/index.vue': '<template><p>Shop</p></template>',
  'features/shop/(checkout)/server/api/availability.get.ts': `
import { isGroupEnabled } from '${helpers}'
export default defineEventHandler(event => isGroupEnabled(event, 'shop/checkout'))`,
  'features/shop/features/unbound/server/utils/placeholder.ts': 'export {}',
  'features/support/app/components/Notice.vue': '<template><p>support</p></template>',
  'server/api/availability.get.ts': `
import { isFeatureEnabled, isGroupEnabled } from '${helpers}'

export default defineEventHandler(async (event) => {
  const [first, second] = await Promise.all([
    isFeatureEnabled(event, 'shop'),
    isFeatureEnabled(event, 'shop'),
  ])
  return {
    first, second,
    native: await isGroupEnabled(event, '@pages/(dashboard)'),
    qualified: await isGroupEnabled(event, '@pages:feature/shop/(dashboard)/(inner)'),
    group: await isGroupEnabled(event, 'shop/checkout'),
    inherited: await isFeatureEnabled(event, 'shop/unbound'),
    unbound: await isFeatureEnabled(event, 'support'),
    override: await isFeatureEnabled(event, 'shop', { context: { targetingKey: 'trusted-on' } }),
  }
})`,
  'server/api/defaults.get.ts': `
import { isFeatureEnabled } from '${helpers}'
export default defineEventHandler(async (event) => ({
  shop: await isFeatureEnabled(event, 'shop'),
  support: await isFeatureEnabled(event, 'support'),
}))`,
  'server/api/errors.get.ts': `
import { isFeatureEnabled, isGroupEnabled } from '${helpers}'
export default defineEventHandler(async (event) => {
  const results = await Promise.allSettled([
    isFeatureEnabled(event, 'unknown'),
    isGroupEnabled(event, 'shop'),
    isFeatureEnabled(event, '@pages/(dashboard)'),
  ])
  return results.map(result => result.reason?.message)
})`,
  'server/middleware/01-context.ts': `
export default defineEventHandler((event) => {
  event.context.syntheticIdentity = getHeader(event, 'x-fixture-identity')
})`,
  'server/feature-client.ts': `
import { OpenFeature, TypedInMemoryProvider } from '@openfeature/server-sdk'

const on = { variants: { on: true }, defaultVariant: 'on', disabled: false }
class LocalProvider extends TypedInMemoryProvider {
  async initialize() {
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  async resolveBooleanEvaluation(key, fallback, context) {
    const { targetingKey } = context
    if (key === 'enable-feature-dashboard' && targetingKey === 'native-parent-off') return { value: false }
    if (key !== 'PRIVATE_FLAG_7216') return super.resolveBooleanEvaluation(key, fallback, context)
    if (targetingKey === 'private-error-7216') throw new Error('PRIVATE_RESOLVER_7216')
    if (targetingKey === 'private-on-7216') await new Promise(resolve => setTimeout(resolve, 45))
    return { value: targetingKey === 'private-on-7216' || targetingKey === 'trusted-on' || targetingKey === 'native-parent-off' }
  }
}

export default async function () {
  await OpenFeature.setProviderAndWait('PRIVATE_DOMAIN_7216', new LocalProvider({
    'enable-checkout': on,
    'enable-dashboard': on,
    'enable-feature-dashboard': on,
  }))
  return OpenFeature.getClient('PRIVATE_DOMAIN_7216')
}

export function getEvaluationContext(event) {
  return {
    targetingKey: event.context.syntheticIdentity,
    marker: 'PRIVATE_CONTEXT_7216',
  }
}`,
}

const flags = {
  enabled: true,
  serverClient: './server/feature-client.ts',
  bindings: {
    shop: { key: 'PRIVATE_FLAG_7216' },
    'shop/checkout': { key: 'enable-checkout' },
    '@pages/(dashboard)': { key: 'enable-dashboard' },
    '@pages:feature/shop/(dashboard)': { key: 'enable-feature-dashboard' },
    '@pages:feature/shop/(dashboard)/(inner)': { key: 'missing-inner', defaultValue: true },
  },
}

async function fixture(
  options: unknown,
  run: (root: string) => Promise<void>,
  overrides: Record<string, string> = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'feature-availability-')))
  try {
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir')
    const config = `export default defineNuxtConfig({
      modules: [${JSON.stringify(join(project, 'src/module.ts'))}],
      alias: { ${JSON.stringify(helpers)}: ${JSON.stringify(join(project, 'src/runtime/server/index.ts'))} },
      srcDir: 'app', devtools: false, compatibilityDate: '2026-11-17',
      feature: { pages: { enabled: true }, server: { enabled: true }, flags: ${JSON.stringify(options) ?? 'undefined'} },
    })`
    for (const [name, value] of Object.entries({ ...files, 'nuxt.config.ts': config, ...overrides })) {
      await mkdir(dirname(join(root, name)), { recursive: true })
      await writeFile(join(root, name), value)
    }
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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

async function withServer(
  root: string,
  dev: boolean,
  run: (request: (path: string, identity?: string) => Promise<Response>) => Promise<void>,
) {
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  await new Promise<void>((done, fail) => reservation.close((error) => error ? fail(error) : done()))
  if (!address || typeof address === 'string') throw new Error('No test port')
  const port = String(address.port)
  const args = dev
    ? [join(project, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', root, '--host', '127.0.0.1', '--port', port, '--no-fork']
    : [join(root, '.output/server/index.mjs')]
  const child = spawn(process.execPath, args, {
    env: { ...process.env, NODE_ENV: dev ? 'development' : 'production', PORT: port, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const request = (path: string, identity = 'private-off-7216') =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'x-fixture-identity': identity },
      signal: AbortSignal.timeout(5_000),
    })
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await request('/shop').then((response) => response.ok, () => false)) return await run(request)
      if (child.exitCode !== null) break
      await new Promise((done) => setTimeout(done, 100))
    }
    throw new Error(output)
  } catch (error) {
    throw new Error(output, { cause: error })
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit')
      child.kill('SIGTERM')
      await exit
    }
  }
}

it('evaluates inherited flags with isolated request contexts through production HTTP and SSR', { timeout: 45_000 }, async () => {
  await fixture(flags, async (root) => {
    await buildFixture(root)
    await withServer(root, false, async (request) => {
      const [on, off, providerError] = await Promise.all([
        request('/api/availability', 'private-on-7216').then((r) => r.json()),
        request('/api/availability', 'private-off-7216').then((r) => r.json()),
        request('/api/defaults', 'private-error-7216').then((r) => r.json()),
      ])
      expect(on).toEqual({
        first: true, second: true, native: true, qualified: true,
        group: true, inherited: true, unbound: true, override: true,
      })
      expect(off).toEqual({
        first: false, second: false, native: true, qualified: false,
        group: false, inherited: false, unbound: true, override: true,
      })
      expect(providerError).toEqual({ shop: false, support: true })
      const disabledNativeParent = await request('/api/availability', 'native-parent-off').then((r) => r.json())
      expect(disabledNativeParent).toMatchObject({ first: true, native: true, qualified: false })
      expect(await request('/api/shop/availability', 'trusted-on').then((r) => r.json())).toBe(true)
      expect(await request('/api/shop/availability').then((r) => r.json())).toBe(false)
      expect(await request('/api/errors').then((r) => r.json())).toEqual([
        expect.stringContaining('FEATURE_FLAGS_ID'),
        expect.stringContaining('FEATURE_FLAGS_KIND'),
        expect.stringContaining('FEATURE_FLAGS_KIND'),
      ])
      const [yes, no] = await Promise.all([
        request('/', 'trusted-on').then((r) => r.text()),
        request('/').then((r) => r.text()),
      ])
      expect(yes).toContain('<p id="availability">AVAILABLE</p>')
      expect(no).toContain('<p id="availability">UNAVAILABLE</p>')
      expect(yes + no).not.toMatch(/PRIVATE_|private-on-7216|trusted-on/)
    })

    const publicDir = join(root, '.output/public')
    const assets = (await readdir(publicDir, { recursive: true }))
      .filter((name) => /\.(?:js|json|map|html)$/.test(name))
    expect(assets.length).toBeGreaterThan(0)
    for (const asset of assets) {
      expect(await readFile(join(publicDir, asset), 'utf8')).not.toMatch(
        /PRIVATE_|private-(?:on|off|error)-7216|trusted-on|openfeature\/server-sdk|PROVIDER_CONFIGURATION_CHANGED|feature-client\.ts|FEATURE_FLAGS_UNAVAILABLE|@pages:feature/,
      )
    }
  })
})

it('runs the opt-in integration in the Nitro development worker', { timeout: 45_000 }, async () => {
  await fixture(flags, (root) => withServer(root, true, async (request) => {
    expect(await request('/api/shop/availability', 'trusted-on').then((r) => r.json())).toBe(true)
    expect(await request('/api/shop/availability').then((r) => r.json())).toBe(false)
  }))
})

it.each([
  ['missing file', { serverClient: './server/missing.ts' }, {}],
  ['failed initialization', {}, { 'server/feature-client.ts': "export default async () => { throw new Error('PRIVATE_STARTUP_7216') }" }],
  ['unbound provider', {}, { 'server/feature-client.ts': "import { OpenFeature } from '@openfeature/server-sdk'; export default OpenFeature.getClient()" }],
])('uses binding defaults for %s', { timeout: 45_000 }, async (_name, options, overrides) => {
  await fixture({ ...flags, ...options, bindings: { shop: { key: 'unavailable', defaultValue: true } } }, async (root) => {
    await buildFixture(root)
    await withServer(root, false, async (request) => {
      expect(await request('/api/defaults').then((r) => r.json())).toEqual({ shop: true, support: true })
    })
  }, overrides as Record<string, string>)
})

it.each([
  ['shop/missing', /unknown declaration/],
  ['@pages/(missing)', /unknown native Group/],
  ['@pages:feature/shop/(dashboard)/(missing)', /unknown native Group/],
])('rejects unresolved canonical binding %s', { timeout: 45_000 }, async (id, error) => {
  await fixture({ ...flags, bindings: { [id]: { key: 'example' } } }, async (root) => {
    await expect(buildFixture(root)).rejects.toThrow(error)
  })
})
