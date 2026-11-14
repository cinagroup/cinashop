<template>
  <view class="lifecycle" role="region" aria-label="订单进度记录">
    <view class="toolbar"><text class="heading">订单进度记录</text>
      <button class="refresh" size="mini" :disabled="loading" @click="$emit('refresh')">刷新进度</button></view>
    <text class="hint">仅显示本订单已记录的事件，日期为上海时间。</text>
    <view v-for="row in entries" :key="row.key" class="event">
      <view class="dot" />
      <text class="label">{{ row.label }}</text><text class="time">{{ row.time }}</text>
    </view>
    <text v-if="!entries.length" class="empty">暂无本订单的进度记录</text>
  </view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { lifecycleEntries, type OrderLifecycleLog, type CityOrderLifecycleLog } from '../../../common/orderLifecycle';
const props = defineProps<{ log: OrderLifecycleLog | CityOrderLifecycleLog; loading?: boolean }>();
defineEmits<{ refresh: [] }>();
const entries = computed(() => lifecycleEntries(props.log));
</script>
<style scoped>
.lifecycle { background:#fff; padding:24rpx; border-radius:14rpx; margin-bottom:20rpx; box-sizing:border-box; overflow-wrap:anywhere; }
.heading,.hint,.empty { display:block; }.heading { font-size:30rpx; font-weight:600; }.hint,.empty { font-size:23rpx; color:#6e7785; line-height:1.65; margin:10rpx 0 18rpx; }
.toolbar { display:flex; align-items:center; justify-content:space-between; gap:16rpx; }.refresh { margin:0; font-size:24rpx; color:#1768c8; background:#f2f6fc; flex-shrink:0; }
.event { display:flex; align-items:baseline; gap:14rpx; padding:14rpx 0; font-size:26rpx; border-bottom:1rpx solid #edf0f4; }.event:last-child { border-bottom:0; }
.dot { flex:0 0 12rpx; height:12rpx; border-radius:50%; background:var(--view-theme,#1768c8); align-self:center; }.label { flex:1; min-width:0; }.time { color:#616b78; font-size:24rpx; font-variant-numeric:tabular-nums; }
</style>
