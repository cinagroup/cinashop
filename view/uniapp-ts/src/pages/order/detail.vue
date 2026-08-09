<template>
  <view class="order-detail" v-if="order">
    <!-- 状态 -->
    <view class="status-card">
      <text class="status-text">{{ statusText }}</text>
      <text class="status-sub">{{ order.paid ? "感谢您的购买" : "请尽快完成支付" }}</text>
    </view>

    <!-- 订单信息 -->
    <view class="section">
      <view class="info-row"><text class="label">订单号</text><text>{{ order.order_id }}</text></view>
      <view class="info-row"><text class="label">下单时间</text><text>{{ formatTime(order.add_time) }}</text></view>
      <view class="info-row"><text class="label">收货人</text><text>{{ order.real_name }} {{ order.user_phone }}</text></view>
      <view class="info-row"><text class="label">收货地址</text><text>{{ order.province }}{{ order.user_address }}</text></view>
    </view>

    <!-- 商品 -->
    <view class="section">
      <view class="cart-line" v-for="ci in order.cart_info" :key="ci.id">
        <image
          v-if="ci.cart_info?.product"
          class="cart-image"
          :src="ci.cart_info.product.image"
          mode="aspectFill"
        />
        <view class="cart-info">
          <view class="cart-name">{{ ci.cart_info?.product?.storeName }}</view>
          <view class="cart-bottom">
            <text class="cart-price">¥{{ ci.cart_info?.sku?.price }}</text>
            <text class="cart-num">x{{ ci.cart_num }}</text>
          </view>
        </view>
      </view>
    </view>

    <!-- 金额 -->
    <view class="section">
      <view class="amount-row"><text>商品金额</text><text>¥{{ order.total_price }}</text></view>
      <view class="amount-row total-row"><text>实付</text><text class="amount-price">¥{{ order.pay_price }}</text></view>
    </view>

    <!-- 支付按钮 -->
    <view v-if="order.paid === 0" class="pay-bar">
      <view class="pay-btn" @tap="pay">余额支付 ¥{{ order.pay_price }}</view>
    </view>

    <!-- 物流入口 (已发货) -->
    <view v-if="order.paid === 1 && order.status >= 1" class="express-link" @tap="goExpress">
      <text>📍 查看物流</text>
      <text class="arrow">›</text>
    </view>

    <!-- 评价入口 (已签收) -->
    <view v-if="order.paid === 1 && order.status >= 2" class="express-link" @tap="goReply">
      <text>✍️ 评价订单</text>
      <text class="arrow">›</text>
    </view>

    <!-- 退款入口 (已支付未收货) -->
    <view v-if="order.paid === 1 && order.status <= 1" class="express-link" @tap="goRefund">
      <text>↩️ 申请退款</text>
      <text class="arrow">›</text>
    </view>
    <view class="express-link" @tap="goRefundList">
      <text>📋 退款记录</text>
      <text class="arrow">›</text>
    </view>
  </view>
  <view v-else class="empty">订单不存在</view>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import { apiOrderDetail, apiOrderPay } from "@/api/order";
import type { OrderInfo } from "@/types/order";

const order = ref<OrderInfo | null>(null);

const statusText = computed(() => {
  if (!order.value) return "";
  if (order.value.paid === 0) return "待支付";
  switch (order.value.status) {
    case 0: return "待发货";
    case 1: return "待收货";
    case 2: return "已收货";
    case 3: return "已完成";
    default: return "未知";
  }
});

function formatTime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function pay() {
  if (!order.value) return;
  try {
    await apiOrderPay(order.value.order_id);
    uni.redirectTo({
      url: `/pages/order/payResult?status=ok&orderId=${order.value.order_id}&amount=${order.value.pay_price}`,
    });
  } catch (e) {
    uni.redirectTo({
      url: `/pages/order/payResult?status=fail&orderId=${order.value.order_id}&amount=${order.value.pay_price}`,
    });
  }
}

function goExpress() {
  if (!order.value) return;
  uni.navigateTo({ url: `/pages/order/express?orderId=${order.value.order_id}` });
}

function goReply() {
  if (!order.value) return;
  uni.navigateTo({ url: `/pages/order/reply?orderId=${order.value.order_id}` });
}

function goRefund() {
  if (!order.value) return;
  uni.navigateTo({ url: `/pages/order/refundApply?orderId=${order.value.order_id}` });
}

function goRefundList() {
  uni.navigateTo({ url: "/pages/order/refundList" });
}

async function load() {
  try {
    order.value = await apiOrderDetail(currentOrderId);
  } catch (e) {
    console.error("订单加载失败", e);
  }
}

let currentOrderId = "";

onLoad((options) => {
  currentOrderId = (options?.orderId as string) ?? "";
  load();
});
</script>

<style scoped>
.order-detail {
  padding: 20rpx;
  padding-bottom: 140rpx;
}

.status-card {
  background: linear-gradient(135deg, #e93323, #ff7a45);
  border-radius: 16rpx;
  padding: 40rpx;
  color: #fff;
  margin-bottom: 20rpx;
}

.status-text {
  display: block;
  font-size: 36rpx;
  font-weight: 700;
}

.status-sub {
  display: block;
  font-size: 24rpx;
  opacity: 0.9;
  margin-top: 8rpx;
}

.section {
  background: #fff;
  border-radius: 12rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.info-row {
  display: flex;
  justify-content: space-between;
  padding: 12rpx 0;
  font-size: 26rpx;
}

.label {
  color: #999;
}

.cart-line {
  display: flex;
  padding: 12rpx 0;
}

.cart-image {
  width: 100rpx;
  height: 100rpx;
  border-radius: 8rpx;
  flex-shrink: 0;
}

.cart-info {
  flex: 1;
  margin-left: 16rpx;
}

.cart-name {
  font-size: 26rpx;
}

.cart-bottom {
  display: flex;
  justify-content: space-between;
  margin-top: 8rpx;
}

.cart-price {
  color: #e93323;
}

.cart-num {
  color: #999;
}

.amount-row {
  display: flex;
  justify-content: space-between;
  padding: 8rpx 0;
  color: #666;
  font-size: 26rpx;
}

.total-row {
  border-top: 1rpx solid #f5f5f5;
  padding-top: 16rpx;
}

.amount-price {
  color: #e93323;
  font-size: 32rpx;
  font-weight: 700;
}

.pay-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #fff;
  padding: 20rpx 30rpx;
  padding-bottom: calc(20rpx + env(safe-area-inset-bottom));
}

.pay-btn {
  background: #e93323;
  color: #fff;
  text-align: center;
  padding: 22rpx;
  border-radius: 40rpx;
  font-size: 30rpx;
}

.express-link {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-top: 20rpx;
  font-size: 28rpx;
  color: #333;
}

.express-link .arrow {
  color: #ccc;
  font-size: 32rpx;
}
</style>
