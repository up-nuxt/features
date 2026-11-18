export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('request', (event) => {
    setResponseHeader(event, 'x-feature-plugin', 'shop-startup')
  })
})
