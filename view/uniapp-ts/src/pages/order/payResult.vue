<template>
  <view class="pay-result">
    <view class="result-icon" :class="{ fail: !success }">{{ success ? "✅" : "❌" }}</view>
    <view class="result-title">{{ success ? "支付成功" : "支付失败" }}</view>
    <view class="result-sub">{{ success ? "感谢您的购买, 我们会尽快为您发货" : "请返回订单页重试支付" }}</view>

    <view v-if="orderId" class="order-info">
      <view class="info-line">
        <text class="label">订单号</text>
        <text class="value">{{ orderId }}</text>
      </view>
      <view v-if="amount" class="info-line">
        <text class="label">支付金额</text>
        <text class="value price">¥{{ amount }}</text>
      </view>
    </view>

    <view class="btn-area">
      <view class="btn primary" @tap="goOrder">查看订单</view>
      <view class="btn" @tap="goHome">继续购物</view>
    </view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

const success = ref(true);
const orderId = ref("");
const amount = ref("");

function goOrder() {
  if (orderId.value) {
    uni.redirectTo({ url: `/pages/order/detail?orderId=${orderId.value}` });
  } else {
    uni.switchTab({ url: "/pages/user/index" });
  }
}

function goHome() {
  uni.switchTab({ url: "/pages/index/index" });
}

onLoad((options) => {
  success.value = options?.status !== "fail";
  orderId.value = options?.orderId ?? "";
  amount.value = options?.amount ?? "";
});
</script>

<style scoped>
.pay-result {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 120rpx 40rpx 0;
}

.result-icon {
  font-size: 120rpx;
  margin-bottom: 30rpx;
}

.result-title {
  font-size: 40rpx;
  font-weight: 700;
  color: #333;
}

.result-sub {
  font-size: 26rpx;
  color: #999;
  margin-top: 12rpx;
}

.order-info {
  width: 100%;
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-top: 60rpx;
}

.info-line {
  display: flex;
  justify-content: space-between;
  padding: 14rpx 0;
  font-size: 26rpx;
}

.label {
  color: #999;
}

.value {
  color: #333;
}

.value.price {
  color: #e93323;
  font-weight: 700;
}

.btn-area {
  width: 100%;
  margin-top: 80rpx;
  display: flex;
  flex-direction: column;
  gap: 20rpx;
}

.btn {
  text-align: center;
  padding: 24rpx;
  border-radius: 44rpx;
  font-size: 30rpx;
  border: 2rpx solid #ddd;
  color: #666;
}

.btn.primary {
  background: #e93323;
  color: #fff;
  border-color: #e93323;
}
</style>
