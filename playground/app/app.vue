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
    <nav aria-label="Example routes">
      <NuxtLink to="/shop">Home</NuxtLink>
      <NuxtLink to="/shop/products/42">Product 42</NuxtLink>
      <NuxtLink to="/shop/inventory/inventory">Inventory</NuxtLink>
      <NuxtLink to="/shop/checkout">Checkout</NuxtLink>
      <NuxtLink to="/showcase">Showcase</NuxtLink>
      <NuxtLink to="/help">Help</NuxtLink>
    </nav>
    <NuxtPage />
  </main>
</template>
