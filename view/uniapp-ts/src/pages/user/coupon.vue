<template>
  <view class="page">
    <view class="tabs">
      <button v-for="tab in tabs" :key="tab.type" class="tab" :class="{ active: activeType === tab.type }" @tap="switchTab(tab.type)">{{ tab.name }}</button>
    </view>
    <view class="notice">钱包状态不代表当前订单一定可用，商品范围、门槛及首单互斥以结算报价为准。</view>
    <button size="mini" :disabled="state.loading" @tap="load(false)">刷新优惠券</button>
    <view v-if="state.loading" class="notice">正在加载优惠券…</view>
    <view v-if="error" class="error">
      <view>{{ error }}</view><button size="mini" :disabled="state.loading" @tap="load(state.nextCursor !== null)">重试加载优惠券</button>
      <button v-if="!auth.isLoggedIn" size="mini" @tap="login">登录后查看</button>
    </view>
    <view class="coupon-list">
      <view v-for="coupon in state.list" :key="coupon.id" class="coupon-card">
        <view class="coupon-left" :class="{ unavailable: coupon.availability !== 'available' }">
          <text class="amount">{{ coupon.benefit }}</text>
          <text class="minimum">{{ coupon.minimum === '0.00' ? '无门槛券' : '满' + coupon.minimum + '可用' }}</text>
        </view>
        <view class="coupon-right">
          <view class="coupon-name">{{ coupon.title }}</view>
          <view class="muted">{{ coupon.scope }}</view>
          <view class="muted">{{ coupon.validity }}</view>
          <view class="status">{{ coupon.message }}</view>
          <view class="actions">
            <button size="mini" :disabled="blocked || state.loading" @tap="openDetail(coupon.id)">查看详情</button>
            <button v-if="coupon.availability === 'available'" size="mini" :disabled="blocked || state.loading" @tap="browseGoods(coupon.id)">浏览商品</button>
          </view>
        </view>
      </view>
    </view>
    <view v-if="!state.loading && !error && !state.list.length" class="empty">该状态下暂无优惠券</view>
    <button v-if="state.nextCursor !== null" class="more" :disabled="blocked || state.loading" @tap="load(true)">加载更多优惠券</button>
    <view v-else-if="!state.loading && !error && state.list.length" class="notice">已加载全部优惠券</view>
    <view v-if="detail" class="mask" @tap="detailId = null">
      <view class="detail-card" @tap.stop>
        <view class="detail-head"><text class="detail-amount">{{ detail.benefit }}</text><view>{{ detail.title }}</view></view>
        <view class="detail-row">使用门槛：{{ detail.minimum === '0.00' ? '无门槛' : '满' + detail.minimum + '元' }}</view>
        <view class="detail-row">适用范围：{{ detail.scope }}</view>
        <view class="detail-row">有效期：{{ detail.validity }}</view>
        <view class="detail-row">状态：{{ detail.message }}</view>
        <view class="notice">是否可用于具体商品、可抵扣金额及叠加规则，以结算页服务端报价为准。浏览商品不会自动使用此券。</view>
        <button v-if="detail.availability === 'available'" :disabled="blocked || state.loading" @tap="browseGoods(detail.id)">浏览商品</button>
        <button @tap="detailId = null">关闭详情</button>
      </view>
    </view>
  </view>
  <DiySuspendedNavigation />
</template>
<script setup lang="ts">
import { useAuthStore } from "@/stores/auth";
import { useCouponWallet } from "@/composables/useCouponWallet";
import type { WalletStatus } from "@/api/couponWallet";
const auth = useAuthStore();
const tabs: { type: WalletStatus; name: string }[] = [{ type: 0, name: "未使用" }, { type: 1, name: "已使用" }, { type: 2, name: "已过期/失效" }, { type: 3, name: "订单占用中" }];
const { activeType, state, blocked, error, detail, detailId, load, switchTab, openDetail, browseGoods } = useCouponWallet();
function login() { uni.navigateTo({ url: "/pages/auth/login" }); }
</script>
<style scoped>
.page { padding: 20rpx 20rpx calc(30rpx + env(safe-area-inset-bottom)); font-size: 28rpx; overflow-wrap: anywhere; }
.tabs { display: flex; flex-wrap: wrap; gap: 8rpx; padding: 8rpx; background: white; border-radius: 12rpx; }
.tab { flex: 1 0 40%; margin: 0; font-size: 26rpx; line-height: 2.7; padding: 0 10rpx; }
.active { color: white; background: #d83122; }
.notice { color: #666; font-size: 24rpx; margin: 20rpx 0; line-height: 1.6; }
.error { color: #b72a1d; padding: 20rpx 0; line-height: 1.7; }
.coupon-list { margin-top: 20rpx; }
.coupon-card { display: flex; background: white; border-radius: 12rpx; overflow: hidden; margin-bottom: 20rpx; }
.coupon-left { flex: 0 0 180rpx; background: linear-gradient(135deg,#d83122,#e95a27); color: white; padding: 28rpx 10rpx; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.unavailable { background: #727272; }
.amount { font-size: 36rpx; font-weight: 700; }
.minimum { font-size: 20rpx; margin-top: 10rpx; }
.coupon-right { flex: 1; min-width: 0; padding: 20rpx; }
.coupon-name { font-size: 28rpx; font-weight: 600; }
.muted, .status { font-size: 22rpx; line-height: 1.6; margin-top: 10rpx; }
.muted { color: #666; }
.actions { display: flex; flex-wrap: wrap; gap: 10rpx; margin-top: 16rpx; }
.actions button { margin: 0; font-size: 22rpx; padding: 0 14rpx; }
.empty { text-align: center; color: #777; padding: 80rpx 0; }
.more { font-size: 28rpx; }
.mask { position: fixed; inset: 0; z-index: 120; background: #0008; display: flex; align-items: center; justify-content: center; padding: 28rpx; }
.detail-card { box-sizing: border-box; width: 620rpx; max-width: 100%; max-height: 80vh; overflow-y: auto; background: white; border-radius: 20rpx; padding: 30rpx; }
.detail-head { text-align: center; padding-bottom: 20rpx; border-bottom: 1rpx dashed #ddd; }
.detail-amount { font-size: 52rpx; font-weight: 700; color: #c8271a; }
.detail-row { padding: 14rpx 0; line-height: 1.6; }
.detail-card button { margin-top: 14rpx; font-size: 26rpx; }
</style>
