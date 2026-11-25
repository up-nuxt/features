import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const project = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
const lockfile = await readFile(join(project, 'pnpm-lock.yaml'), 'utf8')
const temporary = await mkdtemp(join(tmpdir(), 'up-nuxt-features-package-'))

async function write(root, path, contents) {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents)
}

async function verifyConsumer(tarball, enabled, storeDir) {
  const root = join(temporary, enabled ? 'with-sdk' : 'without-sdk')
  await write(root, 'package.json', JSON.stringify({
    name: enabled ? 'features-with-sdk' : 'features-without-sdk',
    private: true,
    type: 'module',
    packageManager: manifest.packageManager,
    dependencies: {
      [manifest.name]: `file:${tarball}`,
      nuxt: manifest.devDependencies.nuxt,
      ...(enabled ? { '@openfeature/server-sdk': manifest.devDependencies['@openfeature/server-sdk'], h3: '1.15.11' } : {}),
    },
  }))

  // Seed Nuxt's graph with the same versions as the repository. pnpm still installs
  // and resolves the packed module as an independent consumer dependency.
  const importer = lockfile.indexOf('importers:')
  const packages = lockfile.indexOf('\npackages:')
  assert.ok(importer >= 0 && packages > importer)
  const locked = lockfile.slice(importer, packages).split('\n')
  const dependency = (name) => {
    const index = locked.indexOf(`      ${name}:`)
    assert.ok(index >= 0, `Missing ${name} in repository lockfile`)
    return locked.slice(index, index + 3).join('\n')
  }
  const pins = [dependency('nuxt')]
  if (enabled) pins.push(dependency("'@openfeature/server-sdk'"), '      h3:\n        specifier: 1.15.11\n        version: 1.15.11')
  let packageEntries = lockfile.slice(packages)
  if (!enabled) {
    packageEntries = packageEntries.replace(
      /\n  '@openfeature\/(?:core|server-sdk)@[^\n]*:\n(?:    [^\n]*\n|\n)*/g,
      '',
    )
  }
  await write(root, 'pnpm-lock.yaml', [
    lockfile.slice(0, importer),
    'importers:\n\n  .:\n    dependencies:\n',
    pins.join('\n') + '\n',
    packageEntries,
  ].join(''))
  await run('pnpm', [
    'install', '--offline', '--no-frozen-lockfile', '--ignore-scripts', '--fetch-retries=0',
    '--store-dir', storeDir,
    // The registry dependencies come from this checkout's already installed lockfile.
    '--trust-lockfile',
  ], { cwd: root, timeout: 60_000 })
  const consumer = createRequire(join(root, 'package.json'))
  if (enabled) assert.ok(consumer.resolve('@openfeature/server-sdk'))
  else {
    assert.throws(() => consumer.resolve('@openfeature/server-sdk'), { code: 'MODULE_NOT_FOUND' })
    const fromPackage = createRequire(join(await realpath(join(root, 'node_modules', manifest.name)), 'package.json'))
    assert.throws(() => fromPackage.resolve('@openfeature/server-sdk'), { code: 'MODULE_NOT_FOUND' })
    assert.doesNotMatch(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'), /@openfeature\/server-sdk@/)
  }

  await write(root, 'nuxt.config.ts', `export default defineNuxtConfig({
  modules: ['@up-nuxt/features'],
  srcDir: 'app',
  compatibilityDate: '2026-11-17',
  devtools: false,
  nitro: { preset: 'node-listener' },
  feature: { flags: ${enabled
    ? "{ enabled: true, serverClient: './server/client.ts', bindings: { shop: { key: 'PRIVATE_PACKAGE_FLAG' } } }"
    : "{ serverClient: './server/client.ts', bindings: { invalid: { key: 'unused' } } }"} },
})`)
  await write(root, 'app/features/shop/components/Label.vue', '<template><p>shop</p></template>')
  await write(root, 'server/client.ts', `
import { OpenFeature, TypedInMemoryProvider } from '@openfeature/server-sdk'
export default async function () {
  await OpenFeature.setProviderAndWait('package-probe', new TypedInMemoryProvider({
    PRIVATE_PACKAGE_FLAG: { variants: { on: true }, defaultVariant: 'on', disabled: false },
  }))
  return OpenFeature.getClient('package-probe')
}
`)
  await write(root, 'server/api/availability.ts', enabled
    ? "import { isFeatureEnabled } from '@up-nuxt/features/server'; export default defineEventHandler(event => isFeatureEnabled(event, 'shop'))"
    : 'export default defineEventHandler(() => true)')
  await write(root, 'app/pages/index.vue', enabled
    ? `<script setup lang="ts">
const enabled = useState('availability', () => false)
if (import.meta.server) {
  const event = useRequestEvent()!
  const { isFeatureEnabled } = await import('@up-nuxt/features/server')
  enabled.value = await isFeatureEnabled(event, 'shop')
}
</script>
<template><p>{{ enabled ? 'package-ready' : 'package-off' }}</p></template>`
    : '<template><p>package-ready</p></template>')

  await write(root, 'consumer-types.ts', `
import type { ModuleOptions } from '@up-nuxt/features'
const options: ModuleOptions = { flags: { bindings: { shop: { key: 'flag', defaultValue: true } } } }
// @ts-expect-error Binding defaults must be boolean.
const invalid: ModuleOptions = { flags: { bindings: { shop: { key: 'flag', defaultValue: 'true' } } } }
${enabled ? `import { isFeatureEnabled, type FeatureEvaluationContextResolver } from '@up-nuxt/features/server'
import type { H3Event } from 'h3'
declare const event: H3Event
const context: FeatureEvaluationContextResolver<H3Event> = event => ({ targetingKey: event.path })
await isFeatureEnabled(event, 'shop', { context: await context(event) })` : ''}
`)
  await run(process.execPath, [
    join(project, 'node_modules/typescript/lib/tsc.js'),
    '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', 'consumer-types.ts',
  ], { cwd: root })
  await run('pnpm', ['exec', 'nuxt', 'build'], { cwd: root, maxBuffer: 4 * 1024 * 1024 })
  const publicDir = join(root, '.output/public')
  for (const name of await readdir(publicDir, { recursive: true })) {
    if (/\.(?:js|json|map|html)$/.test(name))
      assert.doesNotMatch(await readFile(join(publicDir, name), 'utf8'), /PRIVATE_PACKAGE_FLAG|package-probe|openfeature\/server-sdk|FEATURE_FLAGS_UNAVAILABLE/)
  }

  const { listener } = await import(pathToFileURL(join(root, '.output/server/index.mjs')).href)
  const server = createServer(listener).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const origin = `http://127.0.0.1:${server.address().port}`
    assert.equal(await fetch(origin + '/api/availability').then((response) => response.json()), true)
    assert.match(await fetch(origin).then((response) => response.text()), /<p>package-ready<\/p>/)
  } finally {
    server.closeAllConnections()
    await promisify(server.close.bind(server))()
  }
  console.log(`Packed consumer ${enabled ? 'with' : 'without'} OpenFeature passed types, build and HTTP checks.`)
}

try {
  // A temporary consumer can be on another volume and get a different default store.
  const { stdout: storePath } = await run('pnpm', ['store', 'path'], { cwd: project })
  const storeDir = dirname(storePath.trim())
  await run('pnpm', ['pack', '--pack-destination', temporary], { cwd: project })
  const files = await readdir(temporary)
  const archive = files.find((name) => name.endsWith('.tgz'))
  assert.ok(archive)
  for (const enabled of [false, true]) await verifyConsumer(join(temporary, archive), enabled, storeDir)
} catch (error) {
  if (error.stdout) console.error(error.stdout)
  if (error.stderr) console.error(error.stderr)
  throw error
} finally {
  await rm(temporary, { recursive: true, force: true })
}
