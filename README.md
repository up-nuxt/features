# @up-nuxt/features

Feature organization for Nuxt 4. Repository: [up-nuxt/features](https://github.com/up-nuxt/features).

Foundation milestone: discovers explicit nested features across general, app, and server roots. Resource registration and OpenFeature integration are planned; this version only discovers and validates the feature tree.

```ts
export default defineNuxtConfig({
  modules: ['@up-nuxt/features'],
  feature: {
    roots: {
      general: 'features',
      // app/server default to Nuxt's resolved srcDir/serverDir + /features.
      // Set a root to false to disable it.
    },
  },
})
```

Development requires Node 24 or 26 and pnpm. TypeScript remains pinned to version 6.

```sh
pnpm install
pnpm test
pnpm test:types
pnpm prepack
pnpm check:playground
pnpm dev
```

See [architecture](docs/architecture.md) for root resolution, nesting, resource boundaries and diagnostics. Core discovery is internal; the published entry is the Nuxt module.
