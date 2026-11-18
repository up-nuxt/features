# Engineering rules

This is the independent `up-nuxt/features` repository, published as `@up-nuxt/features`.

- Read `docs/architecture.md` before changing discovery, identities, root resolution, or registry merging.
- Keep `src/core` independent of Nuxt, Nitro, Vue, and OpenFeature. Integrations consume its registry.
- Preserve explicit runtime scopes on every source; app integrations consume App scopes only.
- Full-stack resources require app/ or server/ wrappers; keep nested declarations beside those scopes.
- Discover only direct parenthesized project-root declarations, never the entire project tree.
- Shared feature scopes remain unsupported; leave Nuxt native project shared/ untouched.
- Treat ambiguous declarations as structured errors; publish a registry only on explicit build success. Warnings may accompany success.
- Keep structural parent relationships separate from resource membership and future flag bindings.
- Preserve snapshot immutability at type and runtime levels; copy known records without sharing scanner input objects.
- Apply lowercase kebab-case to module-defined names, preserving native Nuxt group identities without that restriction.
- Source order is presentation only; integrations must never infer precedence from it.
- Follow directory symlinks only after an explicit design change and traversal safety tests.
- Discuss changes to public configuration and identity conventions before implementing them.
- Keep work within the requested milestone. Milestone 2.3 adds opt-in Pages from App scopes and tracks native Route Group membership at build time. Keep Nitro registration and flags outside this scope.
- Validate changes with the relevant package scripts and report only checks actually executed.
- The sibling `nuxt-state` repository is a read-only tooling reference.
