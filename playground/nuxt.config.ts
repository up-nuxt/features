export default defineNuxtConfig({
  modules: ['../dist/module.mjs'],
  compatibilityDate: '2026-11-17',
  feature: { composables: { autoImport: true } },
  devtools: { enabled: false },
})
