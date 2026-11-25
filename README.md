# @up-nuxt/features

Organize a Nuxt app by feature. Keep a feature's components, composables, pages, and server routes together and let Nuxt discover them from that feature's directory.

## Quick start

```sh
pnpm add @up-nuxt/features
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@up-nuxt/features'],
  feature: {
    composables: { autoImport: true },
    pages: { enabled: true },
    server: { enabled: true },
  },
})
```

Feature components are auto-imported by default. The other options in this example enable feature composables, pages, and Nitro resources.

```text
features/shop/
├── app/
│   ├── components/ProductCard.vue    → <ShopProductCard />
│   ├── composables/useCart.ts        → useCart()
│   └── pages/products.vue            → /shop/products
└── server/
    └── api/products.get.ts           → GET /api/shop/products
```

For app-only features, put resources directly under `app/features/<name>/`. For server-only features, use `server/features/<name>/`. Full-stack features use `features/<name>/app/` and `features/<name>/server/`. Nested features and groups sit next to those scopes. Feature names prefix routes by default. Parenthesized groups such as `features/shop/(checkout)/` organize related resources without adding a URL segment by default. Restart Nuxt after adding, moving, or removing feature resources.

Requires Nuxt 4.6.4 or later in the 4.x series and Node 24 or 26. Feature server integration is tested with Nitro 2.13.6. See the [architecture guide](https://github.com/up-nuxt/features/blob/main/docs/architecture.md) for routing options, naming rules, and discovery boundaries.

## Experimental OpenFeature integration

OpenFeature is an experimental, opt-in integration for server-side feature flags. Install `@openfeature/server-sdk@^1.23.0` to use an OpenFeature provider. The base module runs without the SDK.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@up-nuxt/features'],
  feature: {
    flags: {
      enabled: true,
      serverClient: './server/feature-client.ts',
      bindings: {
        shop: { key: 'features.shop.enabled', defaultValue: false },
      },
    },
  },
})
```

The client file default-exports a ready OpenFeature client or a factory that returns one. Your app manages the provider and can export `getEvaluationContext(event)` for request targeting. In a Nitro handler, import `isFeatureEnabled` or `isGroupEnabled` from `@up-nuxt/features/server` and pass the request event and feature or group ID.

```ts
import { isFeatureEnabled } from '@up-nuxt/features/server'

export default defineEventHandler(async (event) => ({
  enabled: await isFeatureEnabled(event, 'shop'),
}))
```

A feature is available when its own flag and all bound ancestor flags pass. Unavailable evaluations use the binding's default. Use these decisions for rollouts, enforce authorization separately, and avoid sharing cached personalized responses across users. See the [server-side availability guide](https://github.com/up-nuxt/features/blob/main/docs/architecture.md#server-side-feature-availability) for context, fallbacks, and caching.

## Development

Run `pnpm install` to set up the repository, `pnpm dev` to start the playground, and `pnpm test` to run the tests.
