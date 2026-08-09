<template>
  <view class="coupon-center">
    <view v-if="list.length" class="coupon-list">
      <view v-for="c in list" :key="(c as any).id" class="coupon-card">
        <view class="coupon-left">
          <view class="coupon-price">
            <text class="price-symbol">¥</text>
            <text class="price-num">{{ (c as any).couponPrice || (c as any).price || "0" }}</text>
          </view>
          <view class="coupon-limit">满{{ (c as any).useMinPrice || (c as any).use_min_price || 0 }}可用</view>
        </view>
        <view class="coupon-right">
          <view class="coupon-name">{{ (c as any).couponTitle || (c as any).title || "优惠券" }}</view>
          <view class="coupon-valid">有效期 {{ (c as any).day || 7 }} 天</view>
          <view class="receive-btn" @tap="receive(c)">立即领取</view>
        </view>
      </view>
    </view>
    <view v-else class="empty">暂无可用优惠券</view>
  </view>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { http } from "@/utils/request";

const list = ref<unknown[]>([]);

async function load() {
  try {
    list.value = await http.get<unknown[]>("/coupons");
  } catch {
    list.value = [];
  }
}

async function receive(c: unknown) {
  try {
    const id = Number((c as any).id);
    if (!id) return uni.showToast({ title: "券ID无效", icon: "none" });
    await http.post<null>("/coupon/receive", { id });
    uni.showToast({ title: "领取成功", icon: "success" });
    load();
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "领取失败", icon: "none" });
  }
}

onMounted(load);
</script>

<style scoped>
.coupon-center {
  padding: 20rpx;
}

.coupon-list {
  display: flex;
  flex-direction: column;
  gap: 20rpx;
}

.coupon-card {
  background: #fff;
  border-radius: 16rpx;
  display: flex;
  overflow: hidden;
  position: relative;
}

.coupon-card::before,
.coupon-card::after {
  content: "";
  position: absolute;
  width: 24rpx;
  height: 24rpx;
  background: #f5f5f5;
  border-radius: 50%;
  top: 50%;
  transform: translateY(-50%);
  z-index: 1;
}

.coupon-card::before {
  left: -12rpx;
}

.coupon-card::after {
  right: -12rpx;
}

.coupon-left {
  width: 200rpx;
  background: linear-gradient(135deg, #e93323, #ff7a45);
  color: #fff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24rpx 0;
}

.price-symbol {
  font-size: 28rpx;
}

.price-num {
  font-size: 56rpx;
  font-weight: 700;
}

.coupon-limit {
  font-size: 20rpx;
  opacity: 0.9;
  margin-top: 8rpx;
}

.coupon-right {
  flex: 1;
  padding: 24rpx;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.coupon-name {
  font-size: 28rpx;
  font-weight: 600;
  color: #333;
}

.coupon-valid {
  font-size: 22rpx;
  color: #999;
  margin: 8rpx 0 16rpx;
}

.receive-btn {
  align-self: flex-end;
  background: #e93323;
  color: #fff;
  font-size: 24rpx;
  padding: 10rpx 30rpx;
  border-radius: 28rpx;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 120rpx 0;
}
</style>
