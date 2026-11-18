export default defineNuxtConfig({
  modules: ['../dist/module.mjs'],
  compatibilityDate: '2026-11-17',
  feature: {
    composables: { autoImport: true },
    pages: { enabled: true },
    server: { enabled: true },
    routing: { overrides: { groups: { 'shop/checkout': true } } },
  },
  devtools: { enabled: false },
})
