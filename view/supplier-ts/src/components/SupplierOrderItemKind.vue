<script setup lang="ts">
defineProps<{ isGift?: 0 | 1 }>();
</script>

<template>
  <span class="order-item-kind" :class="{ 'order-item-kind--gift': isGift === 1 }"
    :aria-label="isGift === undefined ? '商品性质未返回' : `商品性质：${isGift === 1 ? '赠品' : '购买商品'}`">
    {{ isGift === 1 ? '赠品' : isGift === 0 ? '购买商品' : '商品性质未返回' }}
  </span>
</template>

<style scoped>
.order-item-kind { display: inline-flex; max-width: 100%; margin: 4px 6px 4px 0; padding: 1px 6px; border: 1px solid var(--el-border-color); border-radius: 4px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; white-space: normal; overflow-wrap: anywhere; vertical-align: middle; }
.order-item-kind--gift { border-color: var(--el-color-primary-light-7); color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
</style>
