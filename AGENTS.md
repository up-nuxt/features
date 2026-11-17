# Engineering rules

This is the independent `up-nuxt/features` repository, published as `@up-nuxt/features`.

- Read `docs/architecture.md` before changing discovery, identities, root resolution, or registry merging.
- Keep `src/core` independent of Nuxt, Nitro, Vue, and OpenFeature. Integrations consume its registry.
- Preserve the application/server boundary on every resource source record.
- Treat ambiguous declarations as structured errors; preserve deterministic output.
- Follow directory symlinks only after an explicit design change and traversal safety tests.
- Discuss changes to public configuration and identity conventions before implementing them.
- Keep work within the requested milestone. Milestone 1 discovers resources only.
- Validate changes with the relevant package scripts and report only checks actually executed.
- The sibling `nuxt-state` repository is a read-only tooling reference.
