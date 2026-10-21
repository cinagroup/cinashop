<template>
  <view v-if="closed || checking || message" class="community-availability" role="status">
    <text>{{ checking ? '正在检查社区状态…' : message || '社区暂未开放' }}</text>
    <button class="community-availability-retry" :disabled="checking" @tap="$emit('retry')">重新检查社区</button>
  </view>
</template>
<script setup lang="ts">
defineProps<{ closed: boolean; checking: boolean; message: string }>();
defineEmits<{ retry: [] }>();
</script>
<style scoped>
.community-availability { padding: 28rpx; margin: 16rpx 0; color: #8c321f; background: #fff2ee; border-radius: 14rpx; overflow-wrap: anywhere; }
.community-availability-retry { margin: 20rpx 0 0; font-size: 26rpx; }
</style>
