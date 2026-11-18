# @up-nuxt/features

Feature organization for Nuxt. Repository: [up-nuxt/features](https://github.com/up-nuxt/features).

The module supports explicit application/server resource scopes, Nuxt component auto-imports, opt-in feature composable imports, and opt-in Feature Pages. Nitro registration and OpenFeature are future work.

## Directory conventions

```text
app/features/shop/components/ProductCard.vue
server/features/shop/api/                 # discovered, not registered yet
features/shop/app/components/CartSummary.vue
features/shop/server/api/                 # discovered, not registered yet
(shop)/app/components/GroupNotice.vue
(shop)/server/api/                        # discovered, not registered yet
```

App-only and server-only declarations use direct resources. Full-stack declarations require explicit app/ or server/ boundaries. Direct resources under a full-stack declaration are invalid; the previous unpublished convention is replaced. Shared feature scopes are unsupported; Nuxt's native project-level shared directory is unaffected.

Nested declarations sit at declaration level:

```text
features/shop/(checkout)/app/components/Badge.vue
features/shop/features/inventory/app/components/Stock.vue
app/features/shop/(checkout)/components/CheckoutForm.vue
server/features/shop/(checkout)/api/
```

Do not nest declarations inside full-stack app/server scopes. Ordinary directories and Nuxt page resource contents are not interpreted as nested features. App, server and full-stack sources can merge into one logical entry when IDs, kinds and structural parents agree. Features and groups remain different kinds: `(shop)` is not an alias for the feature `features/shop`.

## Components and configuration

```ts
export default defineNuxtConfig({
  modules: ['@up-nuxt/features'],
  feature: {
    roots: {
      general: 'features', // full-stack layout
      // app/server default to resolved srcDir/serverDir + /features
      // set a configured root to false to disable it
    },
    components: {
      autoImport: true, // false skips feature component registration
      prefix: true, // false removes feature prefixes, retaining native internal paths
    },
  },
})
```

Direct parenthesized project-root directories are also discovered as full-stack groups; unrelated project directories are not recursively scanned.

Use components in templates without imports:

```text
features/shop/app/components/ProductCard.vue                  -> ShopProductCard
app/features/shop/components/CartSummary.vue                  -> ShopCartSummary
features/shop/(checkout)/app/components/CheckoutForm.vue       -> ShopCheckoutForm
features/shop/(checkout)/(payment)/app/components/Badge.vue    -> ShopBadge
features/shop/features/inventory/app/components/Stock.vue     -> ShopInventoryStock
features/shop/app/components/forms/AddressInput.vue           -> ShopFormsAddressInput
(shop)/app/components/ProductCard.vue                         -> ProductCard
```

Prefixes follow actual Feature ancestry and omit all Group ancestors. Nuxt controls internal paths, filename deduplication, index names and render-mode behavior. Existing native app components continue to work. Only App scopes contribute components; Server scopes never do. Group names imply no URL prefixes or flag keys.

All contributing directories survive without source precedence. Cross-directory collisions involving feature components fail with both paths in FEATURE_COMPONENT_COLLISION. Complementary client/server variants may share a name. Same-directory duplicates retain Nuxt's own NUXT_B3011 warning; integration tests compare native warning counts with and without the module.

Eligible feature component directories reject both file and directory symlinks with FEATURE_COMPONENT_SYMLINK, including links into Server-only services. A normal component alongside a link does not bypass the fail-closed policy. Later candidates are rechecked before registration. Nuxt may enumerate a late-created link before its public callback runs; this protection is not an OS sandbox. See [architecture](docs/architecture.md) for exact boundaries, scan lifecycle and diagnostics.

## Composables

Enable App-scope composable imports with `feature.composables.autoImport: true`. They are disabled by default.

```ts
export default defineNuxtConfig({
  modules: ['@up-nuxt/features'],
  feature: { composables: { autoImport: true } },
})
```

For example, export `useCart` from `app/features/shop/composables/useCart.ts` or `features/shop/app/composables/useCart.ts`. Nuxt uses the exported name for named exports and the filename for default exports. Use an index barrel to expose nested files. Apps, Groups, and nested Features use the same naming rules. Feature imports have no automatic prefix, and ambiguous names produce a diagnostic. See the [architecture](docs/architecture.md#composable-auto-imports) for priority, symlink, and development refresh behavior.

## Pages

Enable App-scope Pages with `feature.pages.enabled: true`. Nuxt's explicit routing disablement still applies.

```ts
export default defineNuxtConfig({
  modules: ['@up-nuxt/features'],
  feature: { pages: { enabled: true } },
})
```

Place Pages in `app/features/shop/pages/` or `features/shop/app/pages/`. Nested declarations and structural Groups follow the same App-scope rule. For example, `features/shop/(checkout)/app/pages/orders/[id].vue` generates `/orders/:id()` with the default name `orders-id`. Add a directory within `pages/` to introduce a URL segment. Page names, parent and default child routes, layouts and `definePageMeta` follow Nuxt.

A structural Group such as `features/(dashboard)` contributes ownership. A directory such as `app/pages/(dashboard)` or `features/shop/app/pages/(dashboard)` contributes a distinct native Route Group. Feature routes with ambiguous names, paths or static aliases fail with a diagnostic. Restart Nuxt when adding, renaming or removing Pages or Groups to guarantee topology updates. See the [architecture](docs/architecture.md#pages-and-native-route-groups) for metadata, development recovery and filesystem limits.

## Development

Use Node 24 or 26 and pnpm. TypeScript is pinned to 6.0.3. Nuxt/Kit/Schema are pinned and locally verified at 4.6.4; module compatibility is ^4.6.4. Nuxt 4.5.2 support is not claimed. The playground uses the root dependencies and built module.

```sh
pnpm install
pnpm test
pnpm test:types
pnpm prepack
pnpm check:playground
pnpm dev
```
