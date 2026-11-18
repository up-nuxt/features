# Feature architecture and Components Integration

Repository: `up-nuxt/features`. Package: `@up-nuxt/features`. Configuration key: `feature`. This contract replaces the previous unpublished convention.

## Scope and verified versions

Milestones 2.1 and 2.2 integrate component directories and opt-in composable imports. Pages/routing, native page-group discovery, Nitro registration, OpenFeature, layers/precedence and complete feature-discovery HMR are future work. Core remains independently testable without Nuxt.

Nuxt, Kit and Schema are pinned to 4.6.4 in package.json and the lockfile. Module compatibility is `^4.6.4`; local source inspection and integration tests verify 4.6.4. The playground consumes root dependencies and the built module, with no separate dependency manifest. Nuxt 4.5.2 compatibility is not claimed and would require independent verification. Node 24 or 26 and TypeScript 6 are configured; local checks use Node 24.

## Declaration locations and runtime layouts

| Declaration location | Discovery | Layout | Runtime scope paths |
| --- | --- | --- | --- |
| `<srcDir>/features/shop` | feature-container | app | declaration itself |
| `<serverDir>/features/shop` | feature-container | server | declaration itself |
| `<rootDir>/features/shop` | feature-container | full-stack | `app/`, `server/` beneath declaration |
| `<rootDir>/(shop)` | project-group | full-stack | `app/`, `server/` beneath declaration |

Root options remain `feature.roots.general`, `app`, and `server` (path or `false`). Defaults append `features` to Nuxt's resolved rootDir/srcDir/serverDir. Relative overrides resolve from rootDir. The role `general` now means full-stack layout, not implicit application resources. Literal `app/` and `server/` within full-stack declarations are scope boundaries, independent of the project's customized srcDir/serverDir names.

Missing roots are valid. Canonicalization resolves the deepest existing ancestor and appends unresolved suffixes, retaining alias-overlap detection for missing targets. Equal or nested configured roots produce diagnostics using filesystem-relative boundaries, not textual prefixes.

Root-level group discovery selects only immediate project children starting with `(`, validates their names, and scans each selected group subtree with the full-stack grammar. It never turns the entire project root into an ordinary feature container. Symlink group roots are rejected. Overlap checks compare selected group subtrees against configured roots, including canonical aliases, to avoid scanning one physical subtree twice. Ordinary project directories, native project `shared/`, and `app/pages/(group)` are untouched.

## Discovery grammar

Visible immediate children of feature containers declare `name/` features or `(name)/` groups. Names use lowercase ASCII kebab-case, starting with a letter. Invalid names are diagnosed without lowercasing, renaming or Unicode normalization. Native Nuxt group names are not subject to that policy.

Only declaration-level `features/<declaration>/` or `(name)/` introduces nesting. Child declarations inherit the source's layout:

```text
app/features/shop/(checkout)/components
server/features/shop/(checkout)/api
features/shop/(checkout)/app/pages
features/shop/(checkout)/server/api
features/shop/features/payment/app/components
(shop)/(checkout)/app/components
(shop)/features/inventory/server/api
```

Full-stack children sit beside `app/` and `server/`, and define their own explicit scopes. App/server-only children retain their existing direct-resource layout. Structural names `app`, `server` and `features` never become logical identity segments.

The scanner stops at resources and arbitrary ordinary directories. `pages/(dashboard)` is opaque to core discovery and belongs to eventual native routing integration. It does not create a feature entry. Services/repositories/tests/stores and other arbitrary directories are not automatically registered or recursively interpreted as declarations; place runtime helpers inside their intended app/server scope. Arbitrary opaque declaration-level directories do not receive an inferred runtime owner.

## Resource scopes and diagnostics

A source explicitly records:

```ts
interface FeatureSource {
  readonly featureId: string
  readonly root: FeatureRoot // role, discovery origin, canonical path, optional layer origin
  readonly path: string // physical declaration
  readonly layout: 'app' | 'server' | 'full-stack'
  readonly scopes: readonly ResourceScope[]
}
interface ResourceScope {
  readonly kind: 'app' | 'server' | 'shared'
  readonly path: string
  readonly resources: readonly ResourceDirectory[] // name + path; no duplicated boundary field
}
```

`shared` is reserved in the type model for future extension; discovery and registry validation reject it today. No shared resource registration is implemented. Both `features/shop/shared` and `(shop)/shared` produce `UNSUPPORTED_SCOPE`; Nuxt's native project-level shared directory is unrelated.

App scopes recognize components, composables, pages, utils, middleware, plugins and types. Server scopes recognize api, routes, middleware, utils, plugins and types. Resource records describe directories only. Helper directories such as server services remain ordinary explicitly imported code, not new auto-import conventions.

Invalid examples:

| Path | Diagnostic |
| --- | --- |
| `features/shop/components`, `features/shop/api` | INVALID_RESOURCE_LOCATION: explicit scope required |
| `features/shop/app/features/checkout` | MISPLACED_DECLARATION: nest beside scopes |
| `features/shop/server/(checkout)` | MISPLACED_DECLARATION |
| `app/features/shop/server/api` | INVALID_SCOPE: server boundary inside app declaration |
| `server/features/shop/server/api` | INVALID_SCOPE: redundant runtime boundary |
| `server/features/shop/components` | INVALID_RESOURCE_LOCATION: app resource in server scope |
| full-stack `shared/` | UNSUPPORTED_SCOPE |

Symlinks at recognized resource paths or runtime boundaries are rejected with `SYMLINK_RESOURCE` without traversing the target. Symlinks at unrelated opaque paths remain ignored.

Physical discovery records provenance and location diagnostics; logical validation remains the registry's responsibility. No resolver independently discovers features.

## Logical identities and cross-root merges

Identity is independent of physical layout and eventual URL paths:

```text
features/shop/(checkout)/app/components
app/features/shop/(checkout)/components
server/features/shop/(checkout)/api
    -> shop/checkout (group; parent shop)
```

Compatible ID, kind, origin and structural parent merge across distinct roots. A full-stack source can contribute both app and server scopes to the same entry. All compatible sources/scopes/resources survive; no root takes precedence. Project groups and groups inside feature containers share the module-defined namespace, so `(shop)` and `app/features/(shop)` can merge. `(shop)` and `features/shop` conflict because group and feature kinds differ.

Registry validation enforces names/IDs, logical source ownership (`featureId`) and physical ownership relative to the canonical discovery root, source layout, scope kind/location, unique scope kinds, resource location, same-root duplicate detection, consistent declaration kinds/parents, required parent existence, structural compatibility and cycles. Case-only module identity collisions are diagnosed. Conflicting declarations contribute diagnostics; none becomes a winning fallback entry.

Source ordering is deterministic presentation: root role, physical discovery mode, optional layer origin and relative declaration path, with physical paths only breaking otherwise identical keys. Resolver priority must never be inferred from array position. Component naming conflicts remain an explicit integration error.

A feature-container source must be a strict descendant of its root. A top-level project group owns its root directory, and its nested declarations must be descendants. Reserved native-page sources must match the relative directory hierarchy encoded by their `@pages/` identity. These ownership checks are lexical against the canonical paths supplied by discovery, with no additional filesystem access.

## Structural parents, membership and native groups

For module identities, `parentId` is the immediate registered feature/group ancestor. `shop/checkout/payment` requires structural parent `shop/checkout`, regardless of app/server/full-stack layout. Children are computed deterministically from validated relationships.

Resource membership is separate and potentially many-to-many. `ResourceMembership` reserves physical path plus logical scope IDs, but no membership resolver exists yet. One future page may belong to a feature and a native route group without acquiring two structural parents.

Native identities remain separate: `@pages/(dashboard)`, `@pages/admin/(dashboard)` and `@pages/(admin)/(dashboard)`. Their full relative syntax is retained; their parent is the nearest registered native group, without synthetic ordinary-directory entries. Core does not scan page resources for these entries, reproduce Nuxt route parsing, restrict native names to module kebab-case, or modify `route.meta.groups`.

Future explicit OpenFeature bindings attach to logical IDs independently of runtime layout. Features and groups may both be bound. Structural ancestry can supply inheritance and future resource membership can supply applicable gates. Groups generate neither implicit flag keys nor URL segments. Feature flags are not authorization and runtime evaluation does not imply code exclusion.

## Immutable registry results

`RegistryBuildResult` is a discriminated success/failure union. Errors from roots, discovery or logical validation deny a registry property; warnings remain compatible with success. Integrations narrow on success before using the snapshot.

Known shapes are copied explicitly and frozen: registry, entries, sources, roots, scope records/arrays, resource records/arrays, children and diagnostics. Read-only types and runtime freezing protect against scanner-input mutation and downstream corruption without generic cloning machinery. Physical paths belong to build-time metadata, not future wholesale browser serialization.

## Components Integration

`src/integrations/components.ts` projects only app scopes and their components resources. Root role does not substitute for scope ownership. The scanner and registry are the only feature-discovery foundation. `addComponentsDir` delegates actual component scanning/naming to Nuxt.

`feature.components.autoImport` and `prefix` default to true. Disabling auto-import skips registrations, collision hooks and component safety inspection. Disabling prefix removes feature prefixes while preserving Nuxt's native internal path-prefix behavior.

Prefixes follow actual structural ancestors of kind feature. Every group ancestor is omitted:

```text
features/shop/app/components/ProductCard.vue -> ShopProductCard
app/features/shop/components/CartSummary.vue -> ShopCartSummary
features/shop/(checkout)/app/components/Badge.vue -> ShopBadge
features/shop/(checkout)/features/inventory/app/components/Stock.vue -> ShopInventoryStock
(shop)/app/components/ProductCard.vue -> ProductCard
(shop)/features/inventory/app/components/Stock.vue -> InventoryStock
features/shop/app/components/forms/Input.vue -> ShopFormsInput
```

Nuxt 4.6.4 performs PascalCase conversion, duplicate-segment/index handling and render-mode naming. Public extendComponent callbacks expose names before native empty-name validation and cross-directory deduplication. The collision guard skips candidates whose original Nuxt name was empty, leaving `NUXT_B3010` to Nuxt; components:extend alone sees an already deduplicated result. Cross-directory names with overlapping modes fail with FEATURE_COMPONENT_COLLISION when a feature candidate participates. Client/server pairs and repeated observations of one file are allowed; native-only collisions retain Nuxt behavior. Same-directory duplicates precede our callback and preserve native NUXT_B3011 diagnostics. Programmatic replacement outside directory scanning is not exhaustively audited.

Nuxt's default application scan gives `components/global/` and `components/islands/` dedicated directory entries. Feature component directories are registered as a single scan entry each, so their `global/` and `islands/` children are ordinary path-prefix directories. Nuxt's filename suffix handling (such as `.global.vue` and `.island.vue`) still applies under its normal configuration. Directory-level parity should be considered separately because it changes naming, registration and collision semantics.

## Component safety and scan lifecycle

Nuxt 4.6.4 passes pattern/cwd/ignore to tinyglobby, whose default follows symlinks; public directory options expose no no-follow switch. Static ignore globs are not used as a durable safety policy.

The selected policy is fail-closed. An iterative lstat/readdir inspection rejects all file/directory symlinks in eligible app component directories before registration and on directory resolution. FEATURE_COMPONENT_SYMLINK names the link. A normal file beside a link does not make the directory partially usable; remove the link or copy the intended app component.

On subsequent native scans, the first protected candidate triggers a fresh tree inspection; each candidate path and physical boundary is checked as well. Registered-directory ownership prevents escaped glob results bypassing validation. A callback-modified path is rechecked; escapes produce FEATURE_COMPONENT_BOUNDARY. This is filesystem safety inspection, not a second Vue component scanner.

Nuxt exposes no before-every-glob hook. A late-created link may be enumerated before candidate validation rejects registration. No successful updated component registry is published by that failed scan. This is not an OS sandbox against concurrent adversarial replacement; explicit imports and independently configured native directories remain outside the feature-directory policy.

Collision and safety caches are instance-local and reset after success, collision or wrapped-callback failure. Existing callbacks receive the original argument and native directory receiver. Original exceptions are rethrown unchanged. A retry after a wrapped callback failure can reuse the same descriptors without retaining removed-file collisions. An error inside Nuxt's scanner before it reaches a wrapped callback or the completion hook (for example, a glob compilation error in a later directory) can leave partial state until directory resolution runs again. Nuxt 4.6.4 exposes no public start/failure hook for its direct development rescans. Fix the original scan error and restart Nuxt if a direct retry reports a stale collision. Creating new logical features or previously absent component directories still requires restart in this milestone.

## Verification

Core suites cover the four declaration locations, explicit boundaries, invalid old layouts, nested placement, selected root-group overlaps/aliases, shared rejection, cross-layout merging, identity/parent invariants, provenance, scope isolation, mutation protection and determinism. Real Nuxt fixtures cover naming, merged app resources, root groups, features inside groups, collisions with both prefix settings, disabled auto-import, native components and warning-count parity. Symlink tests inspect actual registration before/after link removal and on later scans. Lifecycle tests invoke Nuxt's real scan hooks across callback failure/retry and genuine collision. The playground consumes the built module and demonstrates auto-imports through actual SSR. Node 26 and cross-platform CI outcomes are distinct from local Node 24 verification.


## Composable auto-imports

Set `feature.composables.autoImport: true` to register App-scope composable directories. The default is false. Nuxt's own `imports.scan: false` disables directory scanning, including feature imports. Explicit imports remain available.

The integration consumes existing registry scopes and calls Nuxt Kit's `addImportsDir`. In Nuxt 4.6.4 this feeds `imports:dirs`, and Nuxt passes those paths to Unimport 7.0.3. Unimport scans direct children by default. Named exports keep their exported names, default exports use Unimport's filename convention, and an index barrel can expose selected nested exports. Type-only exports appear in declarations and stay out of runtime exports. Nuxt produces its virtual `imports.mjs`, declaration files and application transforms.

Directory strings use character classes to represent literal glob characters, including pipes. The glob library's backslash escapes are unsuitable here because Nuxt normalizes paths before Unimport scans them. Otherwise a parenthesized feature path can scan an ordinary sibling. Nuxt's native watch refresh checks literal path prefixes against its scan entries. File updates in unescaped registered directories use that refresh path. For escaped paths such as Groups, restart Nuxt if file changes do not refresh the import list. Discovering entirely new feature directories also requires a restart.

Before Unimport deduplicates the native scan, `imports:extend` validates its candidates. The integration resolves the public scanner from project Nuxt's Unimport installation and converts its entry path to a file URL before importing it. It scans each feature directory separately to identify the bindings contributed by that directory, including star re-exports whose `from` points at a helper outside `composables/`. Nuxt's combined scan remains the source of registered imports and their priorities. Different feature bindings with the same name fail regardless of root. A feature and an external binding collide only at equal Unimport priority. Zero, negative and positive priorities retain their native meaning. Identical source/export pairs are allowed. Built-in and configured imports are included from the initial `imports:context` snapshot. Custom registrations added after validation are outside this check.

`addImports` can set an alias explicitly. An optional feature prefix could use Unimport's discovered export records and Registry ancestry, but requires separate decisions for filename-based default aliases, barrel provenance and source spellings. Milestone 2.2 keeps native names and has no prefix option.

Registered directories are inspected without following symlinks before registration and checked again before scan results are published. The integration also checks the canonical source paths returned by star barrels. A link raises `FEATURE_COMPOSABLE_SYMLINK`. Unimport follows links during globbing, so a rescan can enumerate or read a newly linked file before the validation hook rejects the result. Explicit imports and named re-exports remain authored dependencies. Independently registered directories retain their own behavior.

When validation rejects a rescan, the integration restores the last validated external dynamic imports through Unimport's context API and regenerates Nuxt's runtime and declaration templates. Nuxt's static imports remain available. On Vite development servers the integration invalidates graph entries for revoked feature sources. Closing a Vite environment removes its graph from invalidation, including during a Vite restart. While a scan is rejected, middleware checks requests for revoked sources and files inside registered composable directories before Vite can serve cached transforms. Requests for linked or missing revoked sources in that scope return 503. Vite resolve and load hooks also reject affected source paths and linked targets. In the tested Nuxt development SSR setup, a page that uses the revoked source returns 500 with the validation error. Unrelated pages and Vite modules continue to be served. Production builds do not install this middleware. Fix the source and let Nuxt rescan, or restart the development server if the CLI or watcher does not recover. The automated development-server test verifies restart recovery. This protection applies once a scan detects an unsafe path. A request can race with filesystem changes or validation, and files already delivered to a client cannot be recalled. Verification covers the Vite builder.
