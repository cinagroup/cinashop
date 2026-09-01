<template>
  <view class="page">
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

    <view v-if="coupons.length" class="coupon-list">
      <view
        class="coupon-card"
        v-for="coupon in coupons"
        :key="(coupon as CouponItem).id"
        @tap="openDetail(coupon)"
      >
        <view class="coupon-left">
          <text class="amount">¥{{ (coupon as any).couponPrice || (coupon as any).coupon_price }}</text>
          <text class="min">满{{ (coupon as any).useMinPrice || (coupon as any).use_min_price }}可用</text>
        </view>
        <view class="coupon-right">
          <text class="coupon-name">{{ (coupon as any).couponTitle || (coupon as any).coupon_title }}</text>
          <text class="coupon-expire">有效期至 {{ formatTime((coupon as any).endTime || (coupon as any).end_time) }}</text>
          <view v-if="activeType === 0" class="coupon-use" @tap.stop="goUse">去使用</view>
        </view>
      </view>
    </view>
    <view v-else class="empty">暂无优惠券</view>

    <!-- 优惠券详情弹窗 -->
    <view v-if="detail" class="mask" @tap="detail = null">
      <view class="detail-card" @tap.stop>
        <view class="detail-head">
          <text class="detail-amount">¥{{ (detail as any).couponPrice || (detail as any).coupon_price }}</text>
          <text class="detail-title">{{ (detail as any).couponTitle || (detail as any).coupon_title }}</text>
        </view>
        <view class="detail-row">
          <text class="label">使用门槛</text>
          <text class="value">满{{ (detail as any).useMinPrice || (detail as any).use_min_price }}元可用</text>
        </view>
        <view class="detail-row">
          <text class="label">有效期至</text>
          <text class="value">{{ formatTime((detail as any).endTime || (detail as any).end_time) }}</text>
        </view>
        <view class="detail-row">
          <text class="label">使用说明</text>
          <text class="value">仅限本店商品使用, 不可叠加</text>
        </view>
        <view class="detail-btn" @tap="goUse">立即使用</view>
      </view>
    </view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import { http } from "@/utils/request";

interface CouponItem {
  id: number;
  coupon_title: string;
  coupon_price: string;
  use_min_price: string;
  end_time: number;
  status: number;
}

const coupons = ref<unknown[]>([]);
const activeType = ref(0);

const tabs = [
  { type: 0, name: "可用" },
  { type: 1, name: "已用" },
  { type: 2, name: "已过期" },
];

function formatTime(ts: number | Date | null | undefined): string {
  if (!ts) return "—";
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  if (isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function switchTab(type: number) {
  activeType.value = type;
  load();
}

async function load() {
  try {
    coupons.value = await http.get<unknown[]>("/coupons/user/0", { status: activeType.value });
  } catch (e) {
    console.error("优惠券加载失败", e);
  }
}

function goUse() {
  uni.switchTab({ url: "/pages/goods/cate" });
}

const detail = ref<unknown | null>(null);

function openDetail(coupon: unknown) {
  detail.value = coupon;
}

onShow(load);
</script>

<style scoped>
.page {
  padding: 20rpx;
}

.tabs {
  display: flex;
  background: #fff;
  border-radius: 12rpx;
  padding: 6rpx;
  margin-bottom: 20rpx;
}

.tab {
  flex: 1;
  text-align: center;
  padding: 14rpx 0;
  font-size: 26rpx;
  color: #666;
  border-radius: 10rpx;
}

.tab.active {
  background: #e93323;
  color: #fff;
  font-weight: 600;
}

.coupon-card {
  display: flex;
  background: #fff;
  border-radius: 12rpx;
  overflow: hidden;
  margin-bottom: 20rpx;
}

.coupon-left {
  width: 180rpx;
  background: linear-gradient(135deg, #e93323, #ff7a45);
  color: #fff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 30rpx 0;
}

.amount {
  font-size: 40rpx;
  font-weight: 700;
}

.min {
  font-size: 20rpx;
  opacity: 0.9;
  margin-top: 8rpx;
}

.coupon-right {
  flex: 1;
  padding: 20rpx 24rpx;
  display: flex;
  flex-direction: column;
}

.coupon-name {
  font-size: 28rpx;
  font-weight: 600;
  color: #333;
}

.coupon-expire {
  font-size: 22rpx;
  color: #999;
  margin-top: 8rpx;
}

.coupon-use {
  align-self: flex-end;
  margin-top: 10rpx;
  background: #e93323;
  color: #fff;
  font-size: 24rpx;
  padding: 8rpx 28rpx;
  border-radius: 26rpx;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 100rpx 0;
}

.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 99;
}

.detail-card {
  width: 600rpx;
  background: #fff;
  border-radius: 20rpx;
  padding: 40rpx 30rpx;
}

.detail-head {
  text-align: center;
  padding-bottom: 24rpx;
  border-bottom: 1rpx dashed #eee;
  margin-bottom: 20rpx;
}

.detail-amount {
  font-size: 64rpx;
  font-weight: 700;
  color: #e93323;
}

.detail-title {
  display: block;
  font-size: 28rpx;
  color: #333;
  margin-top: 8rpx;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  padding: 16rpx 0;
}

.detail-row .label {
  font-size: 26rpx;
  color: #999;
}

.detail-row .value {
  font-size: 26rpx;
  color: #333;
}

.detail-btn {
  background: #e93323;
  color: #fff;
  text-align: center;
  border-radius: 40rpx;
  padding: 20rpx 0;
  font-size: 28rpx;
  margin-top: 20rpx;
}
</style>
