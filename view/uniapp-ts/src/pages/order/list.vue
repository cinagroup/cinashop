<template>
  <view class="order-list">
    <!-- 状态 tab -->
    <view class="tabs">
      <view
        v-for="t in tabs"
        :key="t.type"
        class="tab"
        :class="{ active: activeType === t.type }"
        @tap="switchTab(t.type)"
      >
        {{ t.name }}
      </view>
    </view>

    <view v-if="orders.length" class="order-cards">
      <view class="order-card" v-for="order in orders" :key="order.order_id">
        <view class="order-header">
          <text class="order-id">订单号: {{ order.order_id }}</text>
          <text class="order-status">{{ statusText(order) }}</text>
        </view>
        <view class="order-body" @tap="goDetail(order.order_id)">
          <view class="cart-line" v-for="ci in order.cart_info" :key="ci.id">
            <image
              v-if="ci.cart_info?.product"
              class="cart-image"
              :src="ci.cart_info.product.image"
              mode="aspectFill"
            />
            <text class="cart-name">{{ ci.cart_info?.product?.storeName }}</text>
            <text class="cart-num">x{{ ci.cart_num }}</text>
          </view>
        </view>
        <view class="order-footer">
          <text class="order-price">¥{{ order.pay_price }}</text>
          <view v-if="order.paid === 0" class="pay-btn" @tap="pay(order)">去支付</view>
          <view v-if="order.paid === 1 && order.status === 0" class="pay-btn" @tap="cancel(order)">取消订单</view>
        </view>
      </view>
      <view v-if="hasMore" class="load-more" @tap="loadMore">加载更多</view>
      <view v-else-if="orders.length" class="no-more">没有更多了</view>
    </view>
    <view v-else class="empty">暂无订单</view>
  </view>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";
import { apiOrderList, apiOrderPay, apiOrderCancel } from "@/api/order";
import type { OrderInfo } from "@/types/order";

const orders = ref<OrderInfo[]>([]);
const activeType = ref<number | undefined>();
const page = ref(1);
const hasMore = ref(true);

const tabs = [
  { type: undefined as number | undefined, name: "全部" },
  { type: 0, name: "待付款" },
  { type: 1, name: "待发货" },
  { type: 2, name: "待收货" },
  { type: 3, name: "已完成" },
];

function statusText(order: OrderInfo): string {
  if (order.paid === 0) return "待支付";
  switch (order.status) {
    case 0: return "待发货";
    case 1: return "待收货";
    case 2: return "已收货";
    case 3: return "已完成";
    default: return "未知";
  }
}

function switchTab(type: number | undefined) {
  activeType.value = type;
  load(true);
}

async function load(reset = false) {
  if (reset) {
    page.value = 1;
    orders.value = [];
  }
  try {
    const rows = await apiOrderList({ type: activeType.value, page: page.value, limit: 10 });
    orders.value = [...orders.value, ...rows];
    hasMore.value = rows.length >= 10;
  } catch (e) {
    console.error("订单列表加载失败", e);
  }
}

async function loadMore() {
  page.value += 1;
  await load();
}

async function pay(order: OrderInfo) {
  try {
    await apiOrderPay(order.order_id);
    uni.showToast({ title: "支付成功", icon: "success" });
    load();
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : "支付失败", icon: "none" });
  }
}

async function cancel(order: OrderInfo) {
  try {
    await apiOrderCancel(order.order_id);
    uni.showToast({ title: "已取消", icon: "success" });
    load();
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : "取消失败", icon: "none" });
  }
}

function goDetail(orderId: string) {
  uni.navigateTo({ url: `/pages/order/detail?orderId=${orderId}` });
}

onLoad((options) => {
  activeType.value = options?.type !== undefined ? Number(options.type) : undefined;
  load();
});

onShow(() => {
  load();
});
</script>

<style scoped>
.order-list {
  padding: 20rpx;
}

.tabs {
  display: flex;
  background: #fff;
  border-radius: 12rpx;
  padding: 6rpx;
  margin-bottom: 20rpx;
  overflow-x: auto;
}

.tab {
  flex: 1;
  text-align: center;
  padding: 14rpx 0;
  font-size: 26rpx;
  color: #666;
  border-radius: 10rpx;
  white-space: nowrap;
}

.tab.active {
  background: #e93323;
  color: #fff;
  font-weight: 600;
}

.load-more,
.no-more {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 24rpx;
}

.order-card {
  background: #fff;
  border-radius: 12rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.order-header {
  display: flex;
  justify-content: space-between;
  padding-bottom: 16rpx;
  border-bottom: 1rpx solid #f5f5f5;
}

.order-id {
  color: #999;
  font-size: 24rpx;
}

.order-status {
  color: #e93323;
  font-size: 26rpx;
}

.order-body {
  padding: 16rpx 0;
}

.cart-line {
  display: flex;
  align-items: center;
  padding: 8rpx 0;
}

.cart-image {
  width: 80rpx;
  height: 80rpx;
  border-radius: 6rpx;
  margin-right: 16rpx;
}

.cart-name {
  flex: 1;
  font-size: 26rpx;
}

.cart-num {
  color: #999;
}

.order-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding-top: 16rpx;
  border-top: 1rpx solid #f5f5f5;
  gap: 24rpx;
}

.order-price {
  color: #e93323;
  font-size: 30rpx;
  font-weight: 600;
}

.pay-btn {
  background: #e93323;
  color: #fff;
  border-radius: 32rpx;
  padding: 10rpx 36rpx;
  font-size: 26rpx;
}
</style>
