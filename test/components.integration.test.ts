import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as buildNuxt, loadNuxt } from 'nuxt'
import { expect, it } from 'vitest'
import { defineNuxtModule } from '@nuxt/kit'
import type { ComponentsDir, Nuxt, NuxtApp, NuxtModule } from '@nuxt/schema'
const project = fileURLToPath(new URL('..', import.meta.url))
async function fixture(
  files: Record<string, string>,
  options = '{}',
  settings: { modules?: NuxtModule[]; featureModule?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'features-components-'))
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir')
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(resolve(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  await writeFile(
    join(root, 'nuxt.config.ts'),
    `export default defineNuxtConfig({ modules: [${settings.featureModule === false ? '' : JSON.stringify(join(project, 'src/module.ts'))}], devtools: false, buildDir: '.nuxt', compatibilityDate: '2026-11-17', feature: {components: ${options}} })`,
  )
  const nuxt = await loadNuxt({
    cwd: root,
    dev: false,
    overrides: { modules: settings.modules ?? [] },
  })
  return {
    nuxt,
    root,
    async cleanup() {
      await nuxt.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
const component = '<template><p>fixture</p></template>'
it('registers actual Nuxt names with nested paths, groups and complementary variants', async () => {
  const app = await fixture({
    'app/app.vue': '<template><main><ShopButton/><ShopVariant/><NativeNotice/></main></template>',
    'features/shop/app/components/Button.vue': component,
    'app/features/shop/(checkout)/(payment)/components/Badge.vue': component,
    'features/shop/features/inventory/app/components/forms/Input.vue': component,
    'features/shop/app/components/Variant.client.vue': component,
    'app/features/shop/components/Variant.server.vue': component,
    'server/features/secret/services/Secret.vue': component,
    'app/components/NativeNotice.vue': component,
  })
  try {
    await buildNuxt(app.nuxt)
    const types = await readFile(join(app.nuxt.options.buildDir, 'components.d.ts'), 'utf8')
    for (const name of [
      'ShopButton',
      'ShopBadge',
      'ShopInventoryFormsInput',
      'ShopVariant',
      'NativeNotice',
    ])
      expect(types).toContain(name)
    expect(types).not.toContain('ShopCheckout')
    expect(types).not.toContain('Secret.vue')
  } finally {
    await app.cleanup()
  }
}, 60000)
it.each(['group', 'native'])(
  'fails an actual %s/feature name collision instead of choosing priority',
  async (target) => {
    const duplicate =
      target === 'group'
        ? 'features/shop/(checkout)/app/components/Button.vue'
        : 'app/components/ShopButton.vue'
    const app = await fixture({
      'app/app.vue': '<template><ShopButton/></template>',
      'features/shop/app/components/Button.vue': component,
      [duplicate]: component,
    })
    try {
      // Exercise failure through the real CLI; Nuxt's debounced generation may reject twice.
      const command = promisify(execFile)(
        process.execPath,
        [join(project, 'node_modules/nuxt/bin/nuxt.mjs'), 'build', app.root],
        { maxBuffer: 4 * 1024 * 1024 },
      )
      await expect(command).rejects.toSatisfy(
        (error: { code: number; stdout: string; stderr: string }) =>
          error.code !== 0 &&
          `${error.stdout}${error.stderr}`.includes('FEATURE_COMPONENT_COLLISION'),
      )
    } finally {
      await app.cleanup()
    }
  },
  60000,
)
it.each(['{autoImport:false}', '{prefix:false}'])(
  'honors config %s without changing native Nuxt components',
  async (options) => {
    const app = await fixture(
      {
        'app/app.vue': '<template><NativeNotice/></template>',
        'features/shop/app/components/Button.vue': component,
        'app/components/NativeNotice.vue': component,
      },
      options,
    )
    try {
      await buildNuxt(app.nuxt)
      const types = await readFile(join(app.nuxt.options.buildDir, 'components.d.ts'), 'utf8')
      expect(types).toContain('NativeNotice')
      expect(types).not.toContain('ShopButton')
      if (options.includes('prefix')) expect(types).toContain('Button:')
      else expect(types).not.toContain('Button.vue')
    } finally {
      await app.cleanup()
    }
  },
  60000,
)

// Nuxt reports same-directory duplicates before public extendComponent callbacks run.
it('preserves the explicit native diagnostic for a same-directory duplicate', async () => {
  const app = await fixture({
    'app/app.vue': '<template><ShopButton/></template>',
    'features/shop/app/components/Button.vue': component,
    'features/shop/app/components/ShopButton.vue': component,
  })
  try {
    const output = await promisify(execFile)(
      process.execPath,
      [join(project, 'node_modules/nuxt/bin/nuxt.mjs'), 'build', app.root],
      { maxBuffer: 4 * 1024 * 1024 },
    )
    expect(`${output.stdout}${output.stderr}`).toContain('NUXT_B3011')
  } finally {
    await app.cleanup()
  }
}, 60000)

it.each(['directory', 'file'])(
  'fails closed on a %s symlink and registers normal components after removal',
  async (kind) => {
    const app = await fixture({
      'app/app.vue': '<template><ShopNormal/></template>',
      'features/shop/app/components/Normal.vue': '<template><p>normal component</p></template>',
      'server/features/auth/services/Secret.vue':
        '<template><p>PRIVATE_SERVER_CONTENT</p></template>',
    })
    const link = join(
      app.root,
      'features/shop/app/components',
      kind === 'directory' ? 'auth' : 'Secret.vue',
    )
    await symlink(
      join(app.root, 'server/features/auth/services', kind === 'file' ? 'Secret.vue' : ''),
      link,
      kind === 'directory' ? 'dir' : 'file',
    )
    try {
      const command = promisify(execFile)(
        process.execPath,
        [join(project, 'node_modules/nuxt/bin/nuxt.mjs'), 'build', app.root],
        { maxBuffer: 4 * 1024 * 1024 },
      )
      await expect(command).rejects.toSatisfy((error: { stdout: string; stderr: string }) =>
        `${error.stdout}${error.stderr}`.includes('FEATURE_COMPONENT_SYMLINK'),
      )
      await expect(
        readFile(join(app.nuxt.options.buildDir, 'components.d.ts'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await rm(link)
      await buildNuxt(app.nuxt)
      const types = await readFile(join(app.nuxt.options.buildDir, 'components.d.ts'), 'utf8')
      expect(types).toContain('ShopNormal')
      expect(types).not.toContain('Secret.vue')
      const server = await readFile(
        join(app.nuxt.options.buildDir, 'dist/server/server.mjs'),
        'utf8',
      )
      expect(server).not.toContain('PRIVATE_SERVER_CONTENT')
    } finally {
      await app.cleanup()
    }
  },
  60000,
)

it('resets after an external callback exception during a real Nuxt scan and still catches genuine collisions', async () => {
  let fail = false
  const sentinel = new Error('original external callback failure')
  const received: string[] = []
  const receivers: string[] = []
  const extension = defineNuxtModule({
    setup(_options, nuxt) {
      nuxt.hook('components:dirs', (dirs) => {
        for (const dir of dirs)
          if (typeof dir !== 'string' && dir.path.endsWith('shop/app/components'))
            dir.extendComponent = (component) => ({
              ...component,
              pascalName: 'ShopButton',
              kebabName: 'shop-button',
            })
        dirs.push({
          path: join(nuxt.options.rootDir, 'external-components'),
          extendComponent(this: ComponentsDir, component) {
            received.push(component.filePath)
            receivers.push(this.path)
            if (fail) throw sentinel
            return component
          },
        })
      })
    },
  })
  const app = await fixture(
    {
      'app/app.vue': '<template><ShopButton/></template>',
      'features/shop/app/components/Old.vue': component,
      'external-components/External.vue': component,
      'app/components/NativeNotice.vue': component,
    },
    '{}',
    { modules: [extension] },
  )
  try {
    // Invoke Nuxt's real scan hooks directly, avoiding build() clearing hooks on close.
    const nuxtApp: NuxtApp = {
      dir: app.nuxt.options.srcDir,
      extensions: app.nuxt.options.extensions,
      plugins: [],
      components: [],
      templates: [],
      layouts: {},
      middleware: [],
      configs: [],
    }
    await app.nuxt.callHook('app:resolve', nuxtApp)
    await app.nuxt.callHook('app:templates', nuxtApp)
    fail = true
    await expect(app.nuxt.callHook('app:templates', nuxtApp)).rejects.toBe(sentinel)
    expect(received.at(-1)).toContain('external-components/External.vue')
    expect(receivers.at(-1)).toContain('external-components')
    await rm(join(app.root, 'features/shop/app/components/Old.vue'))
    await writeFile(join(app.root, 'features/shop/app/components/New.vue'), component)
    fail = false
    await app.nuxt.callHook('app:templates', nuxtApp)
    const registered = nuxtApp.components.filter((item) => item.pascalName === 'ShopButton')
    expect(registered).toHaveLength(1)
    expect(registered[0]!.filePath).toContain('/New.vue')
    await writeFile(join(app.root, 'app/components/ShopButton.vue'), component)
    await expect(app.nuxt.callHook('app:templates', nuxtApp)).rejects.toThrow(
      'FEATURE_COMPONENT_COLLISION',
    )
  } finally {
    await app.cleanup()
  }
}, 60000)

it('matches native NUXT_B3011 warning counts with and without feature integration', async () => {
  const counts: number[] = []
  for (const featureModule of [false, true]) {
    const app = await fixture(
      {
        'app/app.vue': '<template><ShopButton/></template>',
        'app/components/ShopButton.vue': component,
        'app/components/shop/Button.vue': component,
        'features/catalog/app/components/Product.vue': component,
      },
      '{}',
      { featureModule },
    )
    try {
      const output = await promisify(execFile)(
        process.execPath,
        [join(project, 'node_modules/nuxt/bin/nuxt.mjs'), 'build', app.root],
        { maxBuffer: 4 * 1024 * 1024 },
      )
      counts.push((`${output.stdout}${output.stderr}`.match(/NUXT_B3011/g) ?? []).length)
    } finally {
      await app.cleanup()
    }
  }
  expect(counts[0]).toBeGreaterThan(0)
  expect(counts[1]).toBe(counts[0])
}, 60000)

function emptyScanApp(nuxt: Nuxt): NuxtApp {
  return {
    dir: nuxt.options.srcDir,
    extensions: nuxt.options.extensions,
    plugins: [],
    components: [],
    templates: [],
    layouts: {},
    middleware: [],
    configs: [],
  }
}
it.each(['directory', 'file'])(
  'rejects a %s symlink introduced after the initial native scan',
  async (kind) => {
    const app = await fixture({
      'app/app.vue': '<template><ShopNormal/></template>',
      'features/shop/app/components/Normal.vue': component,
      'server/features/auth/services/Secret.vue':
        '<template><p>PRIVATE_SERVER_CONTENT</p></template>',
    })
    try {
      const scanApp = emptyScanApp(app.nuxt)
      await app.nuxt.callHook('app:resolve', scanApp)
      await app.nuxt.callHook('app:templates', scanApp)
      expect(scanApp.components.some((item) => item.pascalName === 'ShopNormal')).toBe(true)
      const link = join(
        app.root,
        'features/shop/app/components',
        kind === 'directory' ? 'auth' : 'Secret.vue',
      )
      await symlink(
        join(app.root, 'server/features/auth/services', kind === 'file' ? 'Secret.vue' : ''),
        link,
        kind === 'directory' ? 'dir' : 'file',
      )
      await expect(app.nuxt.callHook('app:templates', scanApp)).rejects.toThrow(
        /FEATURE_COMPONENT_(SYMLINK|BOUNDARY)/,
      )
      expect(scanApp.components.some((item) => item.filePath.includes('Secret.vue'))).toBe(false)
      await rm(link)
      await app.nuxt.callHook('app:templates', scanApp)
      expect(scanApp.components.some((item) => item.pascalName === 'ShopNormal')).toBe(true)
    } finally {
      await app.cleanup()
    }
  },
  60000,
)

it('skips feature safety checks when auto-import is disabled and never registers linked server content', async () => {
  const app = await fixture(
    {
      'app/app.vue': '<template><NativeNotice/></template>',
      'app/components/NativeNotice.vue': component,
      'features/shop/app/components/Normal.vue': component,
      'server/features/auth/services/Secret.vue': component,
    },
    '{autoImport:false}',
  )
  try {
    await symlink(
      join(app.root, 'server/features/auth/services'),
      join(app.root, 'features/shop/app/components/auth'),
      'dir',
    )
    await buildNuxt(app.nuxt)
    const types = await readFile(join(app.nuxt.options.buildDir, 'components.d.ts'), 'utf8')
    expect(types).toContain('NativeNotice')
    expect(types).not.toContain('Normal.vue')
    expect(types).not.toContain('Secret.vue')
  } finally {
    await app.cleanup()
  }
}, 60000)

it('auto-imports from all app scopes including merged root groups and features nested inside groups', async () => {
  const app = await fixture({
    'app/app.vue':
      '<template><main><ShopGeneral/><ShopApplication/><Notice/><AppNotice/><Badge/><InventoryWidget/><NativeNotice/></main></template>',
    'features/shop/app/components/General.vue': component,
    'app/features/shop/components/Application.vue': component,
    '(shell)/app/components/Notice.vue': component,
    'app/features/(shell)/components/AppNotice.vue': component,
    '(shell)/(dialog)/app/components/Badge.vue': component,
    '(shell)/(dialog)/features/inventory/app/components/Widget.vue': component,
    '(shell)/server/services/Hidden.vue': component,
    'server/features/(shell)/services/Hidden.vue': component,
    'app/components/NativeNotice.vue': component,
  })
  try {
    await buildNuxt(app.nuxt)
    const types = await readFile(join(app.nuxt.options.buildDir, 'components.d.ts'), 'utf8')
    for (const name of [
      'ShopGeneral',
      'ShopApplication',
      'Notice',
      'AppNotice',
      'Badge',
      'InventoryWidget',
      'NativeNotice',
    ])
      expect(types).toContain(`${name}:`)
    expect(types).not.toContain('ShellNotice')
    expect(types).not.toContain('DialogBadge')
    expect(types).not.toContain('Hidden.vue')
  } finally {
    await app.cleanup()
  }
}, 60000)
it.each([
  ['features/shop/app/components/Button.vue', 'app/features/shop/components/Button.vue', '{}'],
  [
    'features/shop/features/inventory/app/components/Button.vue',
    'app/features/shop/features/inventory/components/Button.vue',
    '{}',
  ],
  ['(shell)/app/components/Button.vue', '(shell)/(dialog)/app/components/Button.vue', '{}'],
  [
    'features/shop/app/components/Button.vue',
    'features/cart/app/components/Button.vue',
    '{prefix:false}',
  ],
])(
  'rejects collisions between %s and %s',
  async (first, second, options) => {
    const app = await fixture(
      { 'app/app.vue': '<template><main/></template>', [first]: component, [second]: component },
      options,
    )
    try {
      const command = promisify(execFile)(
        process.execPath,
        [join(project, 'node_modules/nuxt/bin/nuxt.mjs'), 'build', app.root],
        { maxBuffer: 4 * 1024 * 1024 },
      )
      await expect(command).rejects.toSatisfy((error: { stdout: string; stderr: string }) =>
        `${error.stdout}${error.stderr}`.includes('FEATURE_COMPONENT_COLLISION'),
      )
    } finally {
      await app.cleanup()
    }
  },
  60000,
)
it('does not report collisions for full-stack or root-group components when auto-import is disabled', async () => {
  const app = await fixture(
    {
      'app/app.vue': '<template><NativeNotice/></template>',
      'app/components/NativeNotice.vue': component,
      '(one)/app/components/Button.vue': component,
      '(two)/app/components/Button.vue': component,
      'features/shop/app/components/Button.vue': component,
    },
    '{autoImport:false,prefix:false}',
  )
  try {
    await buildNuxt(app.nuxt)
    const types = await readFile(join(app.nuxt.options.buildDir, 'components.d.ts'), 'utf8')
    expect(types).toContain('NativeNotice')
    expect(types).not.toContain('Button.vue')
  } finally {
    await app.cleanup()
  }
}, 60000)

it.each(['{}', '{prefix:false}'])(
  'preserves native empty-name warnings without reporting a collision (%s)',
  async (options) => {
    const app = await fixture(
      {
        'app/app.vue': '<template><main/></template>',
        '(shop)/app/components/index.vue': component,
        '(blog)/app/components/index.vue': component,
        'features/catalog/app/components/index.vue': component,
      },
      options,
    )
    try {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [join(project, 'node_modules/nuxt/bin/nuxt.mjs'), 'build', app.root],
        { maxBuffer: 4 * 1024 * 1024 },
      )
      expect((stdout + stderr).match(/NUXT_B3010/g)).toHaveLength(options === '{}' ? 2 : 3)
      const types = await readFile(join(app.nuxt.options.buildDir, 'components.d.ts'), 'utf8')
      expect(types).not.toContain('(shop)/app/components/index.vue')
      expect(types).not.toContain('(blog)/app/components/index.vue')
      expect(types.includes('Catalog:')).toBe(options === '{}')
    } finally {
      await app.cleanup()
    }
  },
  60000,
)

it('preserves a native glob error and recovers once Nuxt resolves directories again', async () => {
  let badPattern = false
  const pattern = ['**/*.vue']
  const extension = defineNuxtModule({
    setup(_options, nuxt) {
      nuxt.hook('components:dirs', (dirs) => {
        for (const dir of dirs) {
          if (typeof dir === 'string' || !dir.path.endsWith('shop/app/components')) continue
          dir.extendComponent = (item) => {
            pattern[0] = badPattern ? 'x'.repeat(70000) + '*.vue' : '**/*.vue'
            return { ...item, pascalName: 'ShopButton' }
          }
        }
        dirs.push({ path: join(nuxt.options.rootDir, 'external-components'), pattern })
      })
    },
  })
  const app = await fixture(
    {
      'app/app.vue': '<template><ShopButton/></template>',
      'features/shop/app/components/Old.vue': component,
      'external-components/External.vue': component,
    },
    '{}',
    { modules: [extension] },
  )
  try {
    const scanApp = emptyScanApp(app.nuxt)
    await app.nuxt.callHook('app:resolve', scanApp)
    await app.nuxt.callHook('app:templates', scanApp)
    badPattern = true
    await expect(app.nuxt.callHook('app:templates', scanApp)).rejects.toThrow(/input length/i)
    await rm(join(app.root, 'features/shop/app/components/Old.vue'))
    await writeFile(join(app.root, 'features/shop/app/components/New.vue'), component)
    badPattern = false
    // Directory resolution is a supported reset boundary after a native scan failure.
    await app.nuxt.callHook('app:resolve', scanApp)
    await app.nuxt.callHook('app:templates', scanApp)
    expect(
      scanApp.components
        .filter((item) => item.pascalName === 'ShopButton')
        .map((item) => item.filePath),
    ).toEqual([expect.stringContaining('/New.vue')])
  } finally {
    await app.cleanup()
  }
}, 60000)
