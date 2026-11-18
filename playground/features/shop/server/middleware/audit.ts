export default defineEventHandler((event) => {
  setResponseHeader(event, 'x-feature-middleware', 'shop-audit')
})
