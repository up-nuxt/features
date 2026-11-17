# Foundation architecture

Repository: `up-nuxt/features`. Package: `@up-nuxt/features`. Nuxt config key: `feature`.

## Scope

Milestone 1 discovers resources and builds an in-memory registry during module setup. It does not register resources, generate runtime manifests, evaluate flags, or implement HMR. Core functions use Node filesystem APIs and have no framework dependencies. Nuxt 4.6.4 is the initial validated baseline; Node 24 or 26 and TypeScript 6 are used for development.

## Roots

`feature.roots` accepts `general`, `app`, and `server`, each a path or `false` to disable. Defaults use Nuxt's resolved `rootDir`, `srcDir`, and `serverDir`, with `features` appended. Custom relative paths resolve from `rootDir`. Missing directories are valid, while empty paths, files, symlink roots, equal roots, and ancestor/descendant roots produce structured errors. Conflicting root pairs are excluded from discovery; the Nuxt adapter rejects any diagnostic before proceeding. Projects where `srcDir === rootDir` must explicitly disable or relocate one overlapping root.

Directory symlinks are never followed during discovery, including resource and nested-feature boundaries. Existing root paths are canonicalized to detect aliases through symlinked ancestors. This is startup discovery of a trusted local tree, not a sandbox against concurrent filesystem mutation.

## Declarations and identities

Each visible immediate child directory of a root declares a feature, or a group when parenthesized. Within a feature, only immediate `(name)` directories and immediate children of `features/` declare nested entries. Traversal stops at all ordinary directories, including resource directories and arbitrary services/repositories/tests. Hidden directories are ignored. Empty or malformed parenthesized names, separators, colon and reserved `@` names are invalid.

`shop/features/checkout` declares a feature `shop/checkout`; `shop/(checkout)` declares a group with that same ID. IDs use `/` independently of the host OS. They are case-sensitive; directory case portability follows the host filesystem. IDs never determine URL paths.

Future native page group identities retain relative directory syntax: `@pages/(dashboard)`, `@pages/admin/(dashboard)`, and `@pages/(admin)/(dashboard)`. The registry's origin field reserves `native-pages`; discovery of these groups and Nuxt's `route.meta.groups` are outside this milestone and remain untouched.

## Resources and boundaries

- General/app roots discover `pages`, `components`, `composables`, `utils`, `middleware`, `plugins`, and `types` as application resources.
- General roots additionally discover `shared` as a shared resource and recognized children of `server/` as server resources.
- Server roots discover `api`, `routes`, `middleware`, `utils`, `plugins`, and `types` directly as server resources.
- Thus the server API convention is `features/shop/server/api` or `server/features/shop/api`. App roots never discover server resources. Other directories remain available for explicit imports without special processing.

Resources describe physical directories, not individual files, imports or registration. Directories such as `stores` are ordinary directories with no special processing. `types` records carry their boundary but do not alter TypeScript resolution.

## Registry and diagnostics

Sources retain root kind, root path, physical declaration path, resource boundary, and an optional future layer origin. Compatible declarations from distinct roots merge into one logical entry. Competing declarations in the same root or incompatible kinds produce structured diagnostics; no source overwrites another. Core may return partial data alongside errors for inspection; consumers must reject errors before using the registry. The Nuxt adapter does so.

Sorting uses explicit lexical comparisons, not locale-dependent collation. Feature entries and child IDs are sorted by ID; sources and diagnostics follow deterministic discovery and declaration order. The registry is a build-time structure: future browser manifests must explicitly select safe fields rather than serialize it wholesale.

Layers, resource naming collisions, route record generation, runtime flag bindings, OpenFeature providers and inheritance are subsequent work. Feature availability will remain separate from authorization. Runtime flags will not imply code exclusion.

## Verification

Unit tests exercise discovery, resource boundaries, merges, conflicts, traversal safety, custom/resolved/missing/overlapping roots and repeatability. Package typechecking and declaration generation verify the TypeScript contract. The playground build verifies module setup against installed Nuxt. Real Windows and Linux CI remain necessary for platform coverage.
