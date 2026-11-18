<script setup lang="ts">
definePageMeta({ name: 'product-detail' })
const route = useRoute()
</script>

<template>
  <p data-page="product-detail">Product {{ route.params.id }}</p>
</template>
