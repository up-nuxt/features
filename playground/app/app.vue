<script setup lang="ts">
const cart = useCartSummary()
const catalog = useCatalogSummary()
const inventory = useInventorySummary()
const showcase = useShowcaseSummary()
</script>

<template>
  <main>
    <h1>@up-nuxt/features</h1>
    <p>Components playground: native auto-imports from the feature registry.</p>
    <ShopProductCard />
    <ShopCartSummary />
    <ShopCheckoutForm />
    <ShopPaymentBadge />
    <ShopInventoryStockLevel />
    <ShopFormsAddressInput />
    <NativeNotice />
    <GroupNotice />
    <ul aria-label="Feature composables">
      <li>{{ cart }}</li>
      <li>{{ catalog }}</li>
      <li>{{ inventory }}</li>
      <li>{{ showcase }}</li>
    </ul>
  </main>
</template>
