# Changelog

## 0.1.1

- Support Nuxt 4.7.0 and Nitro 2.14.0 alongside Nuxt 4.6.4 and Nitro 2.13.6.
- Revoke feature composable imports when a development watch event detects a symlink replacement,
  even if Nuxt skips its import rescan.

## 0.1.0

- Organize Nuxt apps into app-only, server-only, and full-stack features with nested groups.
- Auto-import feature components with names that reflect their feature hierarchy. Enable
  composable auto-imports and feature pages through configuration.
- Configure URL and route-name prefixes for features and groups.
- Enable feature-scoped Nitro API handlers, server routes, middleware, and plugins through
  configuration.
- Try experimental, opt-in OpenFeature support for server-side feature availability, with
  request-specific targeting and per-binding fallback values.
