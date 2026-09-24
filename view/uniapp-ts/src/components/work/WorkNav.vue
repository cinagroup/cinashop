<template>
  <view class="work-nav">
    <button class="nav-item" :class="{ active: active === 'client' }" :disabled="!ready" @tap="go('/pages/work/userInfo/index')">客户</button>
    <button class="nav-item" :class="{ active: active === 'orders' }" :disabled="!ready" @tap="go('/pages/work/orderList/index')">订单</button>
    <button class="nav-item" :class="{ active: active === 'record' }" :disabled="!ready" @tap="go('/pages/work/record/index')">足迹</button>
  </view>
</template>

<script setup lang="ts">
const props = defineProps<{ active: "client" | "orders" | "record"; ready: boolean; targetHint?: string }>();
function go(url: string) {
  if (!props.ready) return;
  const target = props.targetHint ? `?userid=${encodeURIComponent(props.targetHint)}` : "";
  uni.redirectTo({ url: `${url}${target}` });
}
</script>

<style scoped>
.work-nav { display: flex; position: fixed; bottom: 0; left: 0; right: 0; z-index: 5; background: #fff; border-top: 1rpx solid #e5e8ed; padding-bottom: env(safe-area-inset-bottom); }
.nav-item { flex: 1; margin: 0; border: 0; border-radius: 0; background: #fff; color: #526071; font-size: 28rpx; }
.nav-item::after { border: 0; }.nav-item.active { color: #1b69c9; font-weight: 700; }
</style>
