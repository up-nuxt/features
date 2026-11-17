# Foundation architecture

Repository: `up-nuxt/features`. Package: `@up-nuxt/features`. Nuxt config key: `feature`.

## Scope and data flow

Milestone 1 discovers physical declarations and constructs an immutable logical registry at module setup. Nuxt 4.6.4 is the validated baseline, using Node 24 or 26 and TypeScript 6. Core uses Node filesystem APIs independently of Nuxt, Vue, Nitro and OpenFeature.

```text
Resolved roots -> Physical declarations -> Registry validation -> Immutable snapshot
                                             |
                                             +-> Diagnostics (no registry on error)
```

Resource registration, native page discovery, routing, runtime manifests, resource membership resolution, flag evaluation, layer precedence and HMR are outside this milestone.

## Root resolution and traversal

`feature.roots` accepts `general`, `app`, and `server`, each a path or `false`. Defaults append `features` to Nuxt's resolved `rootDir`, `srcDir`, and `serverDir`. Relative overrides resolve against `rootDir`.

Missing roots are valid. Root canonicalization resolves the deepest existing ancestor using `realpath`, then appends the unresolved suffix. Consequently, paths through symlinked ancestors have the same canonical identity before and after target creation. Overlap validation uses filesystem-relative path boundaries, not textual prefixes; `features-extra` is not a descendant of `features`.

Equal or nested roots, empty paths, files and symlink roots produce structured errors. Conflicting root pairs are excluded from discovery, and any error prevents a successful project result. Projects with `srcDir === rootDir` must disable or relocate one duplicate root.

The scanner never follows directory symlinks, including feature, resource and explicit nesting boundaries. Configured paths may have symlinked ancestors, which root resolution canonicalizes. Discovery assumes a trusted local tree; it is not a sandbox against concurrent filesystem changes.

## Physical declarations and naming

Visible immediate child directories of a root declare features or parenthesized groups. Within a declaration, only immediate `(name)` directories and immediate children of `features/` introduce nested declarations. Ordinary directories stop feature discovery regardless of their contents; hidden directories are ignored. The scanner records physical provenance and naming errors, not logical parent validity or Nuxt routes.

Module-defined names follow lowercase kebab-case: a lowercase ASCII letter, followed by lowercase letters or digits, with single hyphens separating nonempty segments. Examples: `shop`, `shop-v2`, `(checkout-flow)`. Uppercase, whitespace, underscores, Unicode and malformed separators are rejected explicitly, never renamed or normalized. These module naming rules do not apply to native Nuxt groups.

`shop/features/checkout` declares a feature with ID `shop/checkout`; `shop/(checkout)` declares a group with the same ID. They are incompatible kinds. Feature identity segments always use `/`, independent of the host filesystem.

Every `FeatureDeclaration` retains its ID, local name, kind, origin, structural parent, root role/path, optional future layer origin, physical directory and resource directories. Scanner declarations remain separate from merged logical entries.

## Resource boundaries

- General/app roots discover `pages`, `components`, `composables`, `utils`, `middleware`, `plugins`, and `types` as app resources.
- General roots also discover `shared` and recognized resource directories beneath `server/`.
- Server roots discover `api`, `routes`, `middleware`, `utils`, `plugins`, and `types` directly as server resources.

Server APIs therefore live at `features/shop/server/api` or `server/features/shop/api`. App roots never contribute server resources. Arbitrary folders, including `stores`, services, repositories and tests, receive no special processing. Resource records describe directories with explicit app/server/shared boundaries; they do not imply registration or change TypeScript import behavior.

## Registry invariants and merging

`buildRegistry` validates all physical declarations before constructing a registry:

- IDs and local names agree with their namespace's identity contract.
- Each logical ID has a consistent origin, declaration kind and parent.
- Multiple compatible declarations from different roots merge; all sources and all resource contributions are preserved.
- Competing declarations in the same root produce duplicate diagnostics, including when their kinds also conflict.
- Required parents exist; parent identities are structurally compatible.
- Self-parenting and multi-entry cycles fail, including cycles contributed by conflicting declarations.
- Module IDs differing only by case produce a collision diagnostic in addition to invalid-name diagnostics. No case folding changes an ID.

All conflicting declarations contribute to diagnostics. There is no winning declaration, override or fallback registry. A kind or parent conflict is not resolved by traversal or absolute project location.

Entries and child IDs use explicit lexical ID ordering. Sources sort by root role, optional layer label and declaration-relative path, with physical paths only breaking otherwise identical display keys. This is deterministic presentation, not precedence; every source survives a successful merge. Future resolvers must detect resource collisions explicitly instead of treating array position as priority. Layers can be represented in provenance but discovery and precedence remain future work.

## Structural parents and resource membership

`parentId` is structural hierarchy between registered logical entries. Module-defined nested IDs require their immediate logical parent: `shop/checkout/payment` has parent `shop/checkout`. Top-level IDs have no parent. `children` is computed once from validated relationships.

Resource membership is a separate many-to-many association. The reserved `ResourceMembership` type identifies a physical resource and a set-like list of `scopeIds`; this milestone does not generate these records or resolve membership. A future page may belong to both a feature scope and a native route group without having multiple structural parents.

## Native Nuxt groups

The `native-pages` origin reserves IDs such as:

- `@pages/(dashboard)`
- `@pages/admin/(dashboard)`
- `@pages/(admin)/(dashboard)`

Full relative directory hierarchy, including ordinary path segments and parenthesis syntax, remains in the ID and physical provenance. The parent is the nearest registered ancestor native group. `@pages/admin/(dashboard)` does not require a synthetic `@pages/admin` entry. If a nearer native ancestor exists, omitting or skipping it is invalid.

Native identities are independent of module feature IDs. Matching names never automatically connect them. Registry contract tests exercise native IDs without scanning pages. The registry only checks namespace/relative-path structure and the group leaf; it neither applies module kebab-case restrictions nor claims to reproduce Nuxt's route-group grammar. Native case compatibility is left to Nuxt integration verification. Nuxt's `route.meta.groups` remains untouched.

## Snapshot and result contract

```ts
type RegistryBuildResult =
  | { success: true; registry: FeatureRegistry; diagnostics: readonly Diagnostic[] }
  | { success: false; diagnostics: readonly Diagnostic[] }
```

Errors from root resolution, discovery or registry validation deny a registry property altogether. Warnings are preserved but allow success. The Nuxt adapter narrows on `success` before accessing the registry.

Snapshot records, arrays, roots, resources, structural children and diagnostics expose read-only types and are frozen at runtime. Known record shapes are copied explicitly; no mutable scanner input objects are retained. There is no generic recursive cloning/freezing machinery. Integrations must derive a new projection rather than mutate registry state. Build-time physical paths must not be serialized wholesale into future browser manifests.

## Future flag bindings

Features and groups may both gain explicit flag bindings later. Structural hierarchy can supply ancestor evaluation order, while resource membership can supply multiple applicable scopes. Neither model performs flag evaluation today. Parenthesized names imply no URL prefix, component prefix or flag key. Feature availability remains separate from authorization; runtime evaluation does not imply build-time code removal.

## Verification

Core tests cover discovery boundaries, mixed nesting, compatible and conflicting merges, root aliases before/after creation, missing/invalid parents, cycles, naming and case collisions, native structural identities, deterministic success/failure results, warning handling, input mutation isolation, and runtime/type-level immutability. Typechecking and package declaration generation validate the contract; a playground consuming the built module verifies Nuxt setup. Cross-platform and Node 26 CI results remain distinct from local Node 24 verification.
