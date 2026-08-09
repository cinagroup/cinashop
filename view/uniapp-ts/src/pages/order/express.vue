<template>
  <view class="express-page">
    <view v-if="result" class="body">
      <!-- 快递信息 -->
      <view class="info-card">
        <view class="info-row">
          <text class="label">订单号</text>
          <text class="value">{{ result.orderId }}</text>
        </view>
        <view class="info-row">
          <text class="label">物流状态</text>
          <text class="status-tag" :class="{ done: result.deliveryStatus === '已签收' }">
            {{ result.deliveryStatus }}
          </text>
        </view>
        <view class="info-row" v-if="result.expressNo">
          <text class="label">快递</text>
          <text class="value">{{ result.expressName }} {{ result.expressNo }}</text>
        </view>
      </view>

      <!-- 物流轨迹 -->
      <view class="traces-card" v-if="result.traces.length">
        <view class="card-title">物流轨迹</view>
        <view class="trace-list">
          <view
            v-for="(t, i) in result.traces"
            :key="i"
            class="trace-item"
            :class="{ first: i === 0, last: i === result.traces.length - 1 }"
          >
            <view class="trace-dot" :class="{ active: i === 0 }" />
            <view class="trace-line" v-if="i < result.traces.length - 1" />
            <view class="trace-content">
              <text class="trace-status">{{ t.status }}</text>
              <text class="trace-text">{{ t.content }}</text>
              <text class="trace-time">{{ t.time }}</text>
            </view>
          </view>
        </view>
      </view>
      <view v-else class="empty">暂无物流轨迹信息</view>
    </view>
    <view v-else class="empty">{{ loading ? '查询中...' : '未找到物流信息' }}</view>
  </view>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import { apiOrderExpress } from "@/api/order";

const result = ref<Awaited<ReturnType<typeof apiOrderExpress>> | null>(null);
const loading = ref(true);

onLoad(async (query) => {
  const orderId = (query?.orderId as string) ?? "";
  if (!orderId) {
    loading.value = false;
    return;
  }
  try {
    result.value = await apiOrderExpress(orderId);
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
