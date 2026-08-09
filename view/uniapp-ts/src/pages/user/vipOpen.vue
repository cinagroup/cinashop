<template>
  <view class="vip-page">
    <view class="vip-banner">
      <text class="vip-title">🥇 开通 SVIP 会员</text>
      <text class="vip-sub">享受全场会员价 · 专属折扣 · 优先发货</text>
    </view>
    <view class="vip-benefits">
      <view class="benefit-item" v-for="b in benefits" :key="b.text">
        <text class="benefit-icon">{{ b.icon }}</text>
        <text class="benefit-text">{{ b.text }}</text>
      </view>
    </view>
    <view class="vip-price-card">
      <text class="price-label">SVIP 年卡</text>
      <text class="price-val">¥{{ price }}</text>
      <text class="price-orig">原价 ¥299/年</text>
    </view>
    <view class="vip-btn" @tap="open">立即开通 ¥{{ price }}/年</view>
  </view>
</template>
<script setup lang="ts">
const benefits = [
  { icon: "💰", text: "全场会员专享价" },
  { icon: "🚚", text: "包邮 + 优先发货" },
  { icon: "🎁", text: "每月专属优惠券" },
  { icon: "⭐", text: "专属客服优先" },
];
const price = "99";
function open() {
  uni.showToast({ title: "SVIP 开通功能即将上线", icon: "none" });
}
</script>
<style scoped>
.vip-page { padding: 20rpx; }
.vip-banner { background: linear-gradient(135deg, #d4a94e, #f5d97a); border-radius: 20rpx; padding: 50rpx 30rpx; text-align: center; margin-bottom: 20rpx; }
.vip-title { display: block; font-size: 40rpx; font-weight: 700; color: #3a2a00; }
.vip-sub { display: block; font-size: 24rpx; color: rgba(58,42,0,0.7); margin-top: 10rpx; }
.vip-benefits { background: #fff; border-radius: 16rpx; padding: 24rpx; margin-bottom: 20rpx; }
.benefit-item { display: flex; align-items: center; padding: 16rpx 0; border-bottom: 1rpx solid #f5f5f5; }
.benefit-icon { font-size: 36rpx; margin-right: 16rpx; }
.benefit-text { font-size: 28rpx; color: #333; }
.vip-price-card { background: #fff; border-radius: 16rpx; padding: 40rpx; text-align: center; margin-bottom: 30rpx; }
.price-label { display: block; font-size: 28rpx; color: #999; }
.price-val { display: block; font-size: 60rpx; font-weight: 700; color: #d4a94e; margin: 10rpx 0; }
.price-orig { display: block; font-size: 24rpx; color: #ccc; text-decoration: line-through; }
.vip-btn { position: fixed; bottom: 30rpx; left: 30rpx; right: 30rpx; background: linear-gradient(135deg, #d4a94e, #f5d97a); color: #3a2a00; text-align: center; padding: 26rpx; border-radius: 44rpx; font-size: 32rpx; font-weight: 700; padding-bottom: calc(26rpx + env(safe-area-inset-bottom)); }
</style>
