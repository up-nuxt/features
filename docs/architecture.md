# Feature architecture and integrations

Repository: `up-nuxt/features`. Package: `@up-nuxt/features`. Configuration key: `feature`. This contract replaces the previous unpublished convention.

## Scope and verified versions

Milestones 2.1–2.4 integrate component directories, opt-in composable imports, opt-in Feature Pages, native Route Group membership, and opt-in Nitro resources. Milestone 3.1 adds opt-in OpenFeature bindings and server-side availability. Feature discovery across Layers and complete feature-discovery HMR are future work. Core remains independently testable without Nuxt.

Nuxt, Kit and Schema are pinned to 4.7.0 in package.json and the lockfile. Module compatibility is `^4.6.4`. The current integration suite runs on Nuxt 4.7.0 with Nitro 2.14.0. The playground consumes root dependencies and the built module, with no separate dependency manifest. Nuxt 4.5.2 compatibility is not claimed and would require independent verification. Node 24 or 26 and TypeScript 6 are configured; local checks use Node 24.

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

The scanner stops at resources and arbitrary ordinary directories. `pages/(dashboard)` is opaque to core discovery and belongs to Pages Integration. It does not create a feature entry. Services/repositories/tests/stores and other arbitrary directories are not automatically registered or recursively interpreted as declarations; place runtime helpers inside their intended app/server scope. Arbitrary opaque declaration-level directories do not receive an inferred runtime owner.

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

Resource membership is separate and potentially many-to-many. `ResourceMembership` reserves physical path plus logical scope IDs, but no membership resolver exists yet. A page can belong to a feature and a native route group without acquiring two structural parents.

Native identities remain separate: `@pages/(dashboard)`, `@pages/admin/(dashboard)` and `@pages/(admin)/(dashboard)`. Their full relative syntax is retained; their parent is the nearest registered native group, without synthetic ordinary-directory entries. Core does not scan page resources for these entries, reproduce Nuxt route parsing, restrict native names to module kebab-case, or modify `route.meta.groups`.

Explicit OpenFeature bindings attach to logical IDs independently of runtime layout. Features and Groups can both be bound. Structural ancestry supplies inheritance, and qualified native Groups include the Feature owner chain from Pages membership. Groups generate no implicit flag keys and contribute a URL segment only when enabled by the routing policy. Feature flags are not authorization and runtime evaluation does not imply code exclusion.

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

In development, Feature composable watch events also check filesystem identity. Nuxt 4.7 can skip an import rescan when a replacement resolves to a target with an older modification time. When validation rejects a rescan or a watch event, the integration restores the last validated external dynamic imports through Unimport's context API and regenerates Nuxt's runtime and declaration templates. Nuxt's static imports remain available. On Vite development servers the integration invalidates graph entries for revoked feature sources. Closing a Vite environment removes its graph from invalidation, including during a Vite restart. While a scan is rejected, middleware checks requests for revoked sources and files inside registered composable directories before Vite can serve cached transforms. Requests for linked or missing revoked sources in that scope return 503. Vite resolve and load hooks also reject affected source paths and linked targets. In the tested Nuxt development SSR setup, a page that uses the revoked source returns 500 with the validation error. Unrelated pages and Vite modules continue to be served. Production builds do not install this middleware. Fix the source and let Nuxt rescan, or restart the development server if the CLI or watcher does not recover. The automated development-server test verifies restart recovery. This protection applies once a scan detects an unsafe path. A request can race with filesystem changes or validation, and files already delivered to a client cannot be recalled. Verification covers the Vite builder.


## Pages and Native Route Groups

`feature.pages.enabled` defaults to false. With it enabled, only Registry-owned App scopes contribute Pages. Nuxt's explicit `pages: false` and `pages.enabled: false` still apply. A Feature-only application can activate Nuxt's router through the normal page hook. If Nuxt resolves the legacy source layout and the default Features roots coincide, set the intended `srcDir: 'app'` or configure distinct roots. Native Route Group membership is tracked whenever native routing is active, including when Feature Pages are disabled.

Each eligible `pages/` directory forms its own route tree. Pages Integration resolves `unrouting` from the project's installed Nuxt, uses its file grammar and supported rendering modes, and registers the results through Kit's `extendPages`. Nuxt handles layouts, `definePageMeta`, typed routes and generated router modules. The native file path and name are the base for generated routes. The shared, framework-independent routing policy walks actual Registry parent links and emits enabled declaration names in ancestor-first order. Feature segments default to on with `routing.prefix: 'feature'`. Structural Group segments default to off with `routing.groupPrefix: false`. `routing.overrides.features` and `routing.overrides.groups` switch individual declarations on or off without cascading to descendants. The policy validates IDs, kinds, and values at setup. Native Route Groups never contribute policy segments.

Pages mount only the top-level generated paths and namespace generated names at every depth before Nuxt augments records with `definePageMeta`. A root index uses the mount as its path and name (for example, `/shop` and `shop`). Relative children retain their parsed paths. Independent Pages roots do not acquire Vue Router parent-child relationships. Explicit names and absolute paths and aliases keep their Nuxt behavior. Relative child paths and aliases resolve under the effective parent. Typed routes and build-time membership reflect the statically resolved records. Runtime-only macro values can override those defaults at runtime and remain outside build-time typing and collision detection.

The default Feature prefix changes Feature Page URLs and names from Milestone 2.3. Set `routing.prefix: 'none'`, retaining the default group policy and omitting overrides, to restore the previous behavior. The public options type checks the shape and values. IDs are string keys because Nuxt resolves configuration before the module scans declarations. Filesystem-derived autocomplete would require a separate generation and refresh workflow, so this milestone validates IDs at startup. The policy returns segments for future integrations. The Nitro adapter places those segments after Nitro's own `/api` mount without including it in the Feature namespace.

Native project and Layer groups use the exact root-relative group directory, such as `@pages/admin/(dashboard)`. Feature Pages qualify that identity with the encoded owner, such as `@pages:feature/shop%2Fcheckout/(dashboard)`. The Registry validates that a qualified group refers to a Pages resource of its App owner. Its structural parent is the nearest native Group in the same namespace. Identical identities may retain multiple sources. Native `route.meta.groups` remains under Nuxt's control. For example, the native parser may normalize a label from `(sales-team)`, while the Registry retains the raw directory name. Membership supports one recognized parenthesized group per directory. Compound group directories are diagnosed in Feature Pages and omitted from the build-time membership for native Pages. Nuxt remains responsible for native routing and its diagnostics.

The internal immutable snapshot is published at Nuxt's `app:templates` hook after page resolution. It records route occurrences, parent occurrences, effective build-time names and paths, files and views, source origins, structural ancestry, and native group provenance. It uses the Nuxt instance for storage and sends no private paths or flags to the browser. An occurrence ID uses physical files and view names, the parent occurrence, and the effective build-time path, name, mode and aliases. Equivalent trees preserve the ID-to-route association when sibling or view order changes. Matching siblings with different children use their subtree to distinguish them. Fully indistinguishable repeated records receive separate snapshot-local suffixes. IDs can change when a route or its parent is renamed, moved or otherwise changes identity. It reflects the routes present at that hook, including Layer winners. Runtime-only values or records introduced by router options at runtime are outside that snapshot. If static scanning and typed routes are both disabled, the snapshot reflects Nuxt's available build-time records even when runtime macro evaluation supplies other values.

Parser failures, including competing files for one slot, produce `FEATURE_PAGE_PARSE`. `FEATURE_PAGE_COLLISION` reports conflicts involving Feature Pages by effective path, name, static alias, or equivalent simple Vue Router parameter patterns. Genuine default children and combined views are supported. Vue Router ranks static paths, dynamic parameters and catch-alls. The integration does not try to prove general regex overlap or select winners for Feature Pages. Native Layer precedence and native-only diagnostics remain with Nuxt.

Pages root overlap with native Pages or Server scopes is rejected with `FEATURE_PAGE_BOUNDARY`. Feature Pages use a no-follow scan, with symlink tree and canonical file checks before feeding files to Nuxt's metadata extraction. A link yields `FEATURE_PAGE_SYMLINK`. Feature Pages require the Nuxt Vite builder in development. Scoped module guards and invalidation reject the Feature path after an unsafe replacement. The canonical target is also blocked for that development session when it lies under a configured or discovered Server scope. Native App pages and other App modules retain independent access through their original paths. The snapshot is cleared on rejected updates. Restore the regular file and restart Nuxt to recover. Nuxt's existing page handling delivers edits and static metadata updates for known pages under its default settings. Restart for reliable topology changes such as adding, deleting or renaming Pages, Groups and resource directories.

The checks are filesystem validation, with a race between inspection and reads or requests in flight. They cannot retract content already delivered. Independently authored imports and independently configured native Pages retain their own behavior. This integration is verified with Nuxt 4.7.0, its installed `unrouting` 0.3.2 and the Vite builder. The parser choice, mode handling and hook order need parity checks on Nuxt upgrades. The snapshot remains private build-time provenance. The flags integration consumes its canonical IDs and ancestry.


## Nitro server resources

`feature.server.enabled` defaults to false. The integration consumes existing Server scopes and registers `api/`, `routes/`, `middleware/` and `plugins/`. Explicit `utils/` and `types/` imports use ordinary TypeScript resolution. Nuxt and Nitro continue to auto-import utilities through their native scan roots; enabling Feature Server registration adds no server or client utility scanning.

`addServerScanDir` uses Nitro's unmodified resource discovery and URL mounts, and its native scanner follows links. Instead, the integration uses Nitro's installed globber with no-follow enumeration and explicit `addServerHandler` and `addNitroPlugin` registration. The file-to-record adapter mirrors the Nitro 2.13.6 and 2.14.0 scanners’ extension, grouping, parameter, index, method and environment suffix rules. Nitro still performs route matching and generates its own `InternalApi` declarations. Parenthesized directories inside Nitro route resources are transparent under Nitro's scanner semantics. Structural declaration Groups are governed independently by `feature.routing`. Feature prefixes come after Nitro's API base and before the file-derived route.

A Feature collision reports both physical files, owners when known, route and method. Native Nitro selects its Layer winners before the comparison. A distinct method or the methodless fallback can share a path. Differently named placeholders that occupy the same radix slot can overwrite the entire method table and are rejected. Static and catch-all ranking remains with Nitro. In development, an active literal Feature URL and an identical explicit Nitro dev-handler mount are rejected. H3 installs those mounts before its worker proxy, and the dev registration API has no HTTP method field. Global and broader prefix middleware retain native behavior, as does matching through dynamic route patterns. Production omits this dev-handler check. Overlap with an independent native Server scan root is rejected to prevent double registration. Duplicate Feature middleware is rejected. Nitro and Kit deduplicate identical plugin paths; distinct Feature plugins are registered in deterministic Registry and filename order.

Feature middleware is global and runs after native scanned middleware. Explicitly registered Feature plugins join Nitro's configured plugins and run before its scanned plugins in the verified version. Order relative to other modules follows their registration and Nitro's own startup. The internal immutable registration snapshot records owner, ancestry, declaration, scope, physical file, resource kind, effective route, method, environment and optional Layer origin. It is stored on the Nitro instance and is not serialized to the App.

Feature resource trees and canonical paths are validated before registration. A Nitro Rollup hook keeps lexical entry IDs and validates files before loading the source, including Nitro's separate OpenAPI metadata loader. A changed invalid entry fails production compilation. In development it compiles to a 503 handler, or a no-op for middleware or plugins, while keeping unrelated routes available. Nitro's watcher handles ordinary edits to existing handlers. Topology changes and recovery after an unsafe replacement should be applied with a Nuxt restart. The old compiled worker may briefly continue serving its previously built safe response before reload. The Vite App graph rejects resolved imports from Feature Server scopes independently of the registration option. App and SSR bundles share that restriction. Nitro compilation can import Feature Server files. The boundary applies to registered entry points and recognized scopes. This is not a filesystem sandbox for independently configured native scans or authored dependency imports, and it cannot eliminate races during filesystem changes.

Nitro ignore patterns use the installed globber's native interpretation. Relative patterns such as `api/private/**` are evaluated from each Server scope, including the leading resource directory. Absolute patterns apply to their physical paths. A leading slash does not mean scope-relative. Config hooks registered during module setup can supply patterns before Feature registration. Tree safety checks still inspect ignored directories for symlinks.

Feature Server registration supports Nitro 2.13.6 and 2.14.0. It resolves Nitro's package metadata from Nuxt's installed Nitro builder before loading the v2 adapter. Package metadata is authoritative because the published 2.13.6 build embeds 2.13.5 in its runtime metadata. Unknown or unsupported versions report `FEATURE_SERVER_NITRO_VERSION`. Disabled registration skips this compatibility check. The file syntax, dev-handler lifecycle and Rollup metadata IDs are version-specific. The current tests use Nuxt and Kit 4.7.0, Nitro 2.14.0, H3 1.15.11 and Radix3 1.1.2. Server evaluation is an independent, opt-in integration.


## Server-side feature availability

The opt-in integration compiles a frozen projection of the Registry and finalized Pages membership after app template generation. Each entry contains its ID, kind, and inherited boolean bindings. A qualified native Group receives the structural bindings of its owning Feature and the bindings on its native Group chain. Project native Groups use the native chain alone. A Nitro-only virtual module receives the projection, without physical paths or route occurrence provenance. Restart Nuxt after binding configuration or declaration topology changes.

A Nitro runtime plugin attaches an evaluator to each H3 event. The application supplies an OpenFeature client directly or via a factory and owns provider lifecycle and SDK configuration. The plugin starts one readiness promise per Nitro boot, with a five-second deadline. Missing, failed or timed-out client modules use configured defaults. A late factory result is ignored and only a fresh Nitro boot can retry the handoff. At runtime the plugin releases its hooks and startup wait on close. It holds no process-wide provider instance or request identity. Provider teardown belongs in the application's lifecycle.

The evaluator validates the lookup ID and kind and short-circuits at the first disabled binding. The optional request context callback reads the current event at invocation time, so it can observe data supplied by earlier Nitro middleware. Explicit trusted options override equally named callback fields. A fresh invocation context is passed to the SDK, which retains its own API, transaction, client and before-hook merge semantics. The event holds only the evaluator. Each call evaluates its applicable bindings afresh, including SDK hooks for bindings evaluated while the provider is ready. The module retains no decisions across calls. It uses binding defaults in SDK states `NOT_READY`, `ERROR`, `STALE` and `FATAL`, and on evaluation failures or SDK-reported fallbacks. A successfully handed-off client continues to observe provider recovery and replacement managed by the application. Startup and adapter errors recorded by the module use fixed, context-free log messages. Applications control provider and SDK diagnostic logging.

Native and Feature-owned Nitro handlers and SSR entry points use the same request-backed helper. Availability is a rollout input for application code. Route registration, handler registration and IAM remain independent. The package publishes a server-only helper entry with SDK type imports and an optional SDK peer. Browser bundles and app payloads receive only values an application explicitly chooses to render or serialize.

Provider-managed flag caching follows the provider's own contract. Application-level caching happens outside the evaluator and can bypass it altogether. Avoid sharing personalized availability in Nitro cached handlers or functions, SWR or ISR route rules, or shared CDN and reverse-proxy caches unless cache isolation covers every targeting dimension and the freshness policy accounts for provider updates. This applies to personalized SSR HTML and its Nuxt payload as well as API responses. Static prerendering cannot supply a fresh decision for each user. Applications enforce authorization on sensitive data and server operations independently of client-visible rollout decisions.

The implementation is verified with Nuxt 4.7.0, Nitro 2.14.0 and H3 1.15.11. `pnpm test:package` builds a tarball and verifies isolated pnpm consumers with and without the SDK, including type declarations and production HTTP/SSR behavior. See the [design report](openfeature-design.md) for the remaining phases.
