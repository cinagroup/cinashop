<template>
  <view class="express-page">
    <view v-if="result && displayResult" class="body">
      <scroll-view v-if="result.packages.length > 1" class="package-list" scroll-x>
        <view class="package-row">
          <view
            v-for="item in result.packages"
            :key="item.orderId"
            class="package-chip"
            :class="{ active: selectedPackageId === item.orderId }"
            @tap="selectedPackageId = item.orderId"
          >
            {{ item.expressName || '快递包裹' }} {{ item.expressNo }}
          </view>
        </view>
      </scroll-view>

      <!-- 快递信息 -->
      <view class="info-card">
        <view class="info-row">
          <text class="label">订单号</text>
          <text class="value">{{ displayResult.orderId }}</text>
        </view>
        <view class="info-row">
          <text class="label">物流状态</text>
          <text
            class="status-tag"
            :class="{ done: displayResult.trackingState === 'delivered', exception: displayResult.trackingState === 'exception' }"
          >
            {{ displayResult.deliveryStatus }}
          </text>
        </view>
        <view class="info-row" v-if="displayResult.expressNo">
          <text class="label">快递</text>
          <text class="value">{{ displayResult.expressName }} {{ displayResult.expressNo }}</text>
        </view>
      </view>

      <view v-if="displayResult.message" class="tracking-notice">{{ displayResult.message }}</view>

      <!-- 物流轨迹 -->
      <view class="traces-card" v-if="displayResult.traces.length">
        <view class="card-title">物流轨迹</view>
        <view class="trace-list">
          <view
            v-for="(t, i) in displayResult.traces"
            :key="`${t.time}-${i}`"
            class="trace-item"
            :class="{ first: i === 0, last: i === displayResult.traces.length - 1 }"
          >
            <view class="trace-dot" :class="{ active: i === 0 }" />
            <view class="trace-line" v-if="i < displayResult.traces.length - 1" />
            <view class="trace-content">
              <text class="trace-status">{{ t.status }}</text>
              <text class="trace-text">{{ t.content }}</text>
              <text class="trace-time">{{ t.time }}</text>
            </view>
          </view>
        </view>
      </view>
      <view v-else-if="!displayResult.message" class="empty">承运商尚未返回物流轨迹</view>
    </view>
    <view v-else class="empty">{{ loading ? '查询中...' : '未找到物流信息' }}</view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import { apiOrderExpress } from "@/api/order";

const result = ref<Awaited<ReturnType<typeof apiOrderExpress>> | null>(null);
const loading = ref(true);
const selectedPackageId = ref("");
const displayResult = computed(() => {
  if (!result.value) return null;
  return (
    result.value.packages.find((item) => item.orderId === selectedPackageId.value) ??
    result.value
  );
});

onLoad(async (query) => {
  const orderId = (query?.orderId as string) ?? "";
  if (!orderId) {
    loading.value = false;
    return;
  }
  try {
    result.value = await apiOrderExpress(orderId);
    selectedPackageId.value = result.value.packages[0]?.orderId ?? "";
  } catch {
    result.value = null;
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.express-page {
  padding: 20rpx;
}

.info-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.package-list {
  width: 100%;
  margin-bottom: 20rpx;
  white-space: nowrap;
}

.package-row {
  display: inline-flex;
  gap: 16rpx;
}

.package-chip {
  display: inline-flex;
  align-items: center;
  min-height: 64rpx;
  padding: 0 24rpx;
  border: 2rpx solid #e5e7eb;
  border-radius: 32rpx;
  background: #fff;
  color: #666;
  font-size: 24rpx;
}

.package-chip.active {
  border-color: #e93323;
  color: #e93323;
  background: #fff5f4;
}

.tracking-notice {
  margin-bottom: 20rpx;
  padding: 20rpx 24rpx;
  border-radius: 12rpx;
  color: #805b24;
  background: #fff8e8;
  font-size: 24rpx;
  line-height: 1.5;
}

.info-row {
  display: flex;
  align-items: center;
  padding: 12rpx 0;
}

.label {
  font-size: 26rpx;
  color: #999;
  width: 140rpx;
}

.value {
  font-size: 26rpx;
  color: #333;
  flex: 1;
}

.status-tag {
  font-size: 24rpx;
  color: #ff9900;
  background: #fff7e6;
  padding: 6rpx 18rpx;
  border-radius: 8rpx;
}

.status-tag.done {
  color: #52c41a;
  background: #f6ffed;
}

.status-tag.exception {
  color: #e93323;
  background: #fff2f0;
}

.traces-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
}

.card-title {
  font-size: 28rpx;
  font-weight: 600;
  margin-bottom: 20rpx;
}

.trace-list {
  position: relative;
}

.trace-item {
  position: relative;
  padding-left: 40rpx;
  padding-bottom: 36rpx;
}

.trace-dot {
  position: absolute;
  left: 8rpx;
  top: 8rpx;
  width: 16rpx;
  height: 16rpx;
  border-radius: 50%;
  background: #ddd;
  z-index: 1;
}

.trace-dot.active {
  background: #e93323;
}

.trace-line {
  position: absolute;
  left: 15rpx;
  top: 24rpx;
  width: 2rpx;
  bottom: 0;
  background: #eee;
}

.trace-content {
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.trace-status {
  font-size: 26rpx;
  font-weight: 600;
  color: #e93323;
}

.trace-text {
  font-size: 24rpx;
  color: #666;
}

.trace-time {
  font-size: 22rpx;
  color: #bbb;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 80rpx 0;
}
</style>
