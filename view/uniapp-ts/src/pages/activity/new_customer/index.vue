<template>
  <view class="newcomer-page">
    <view class="hero">
      <view class="eyebrow">NEW MEMBER BENEFITS</view>
      <view class="title">新人礼</view>
      <view class="subtitle">欢迎来到 CinaShop，查看当前账户的新客福利</view>
      <button v-if="info" class="rule-button" size="mini" @tap="showRules">新人礼规则</button>
    </view>
    <view v-if="!auth.isLoggedIn" class="notice-card">
      <view>登录后查看已发放的新人礼和专享商品</view>
      <button size="mini" @tap="login">去登录</button>
    </view>
    <template v-else>
      <button size="mini" :disabled="loading || navigating" @tap="load(false)">刷新新人礼</button>
      <view v-if="loading && !products.length" class="notice" role="status">正在加载新人礼…</view>
      <view v-if="error" class="error" role="alert">{{ error }}<button size="mini" :disabled="loading" @tap="load(page > 0)">重试</button></view>
      <view v-if="info" class="benefits">
        <view v-if="info.coupons.length" class="card">
          <view class="section-title">新人优惠券</view>
          <view class="coupon-grid">
            <view v-for="coupon in info.coupons" :key="coupon.id" class="coupon">
              <view class="coupon-benefit">{{ coupon.benefit }}</view>
              <view>{{ coupon.scope }}</view>
              <view>{{ coupon.minimum === '0.00' ? '无门槛' : `满${coupon.minimum}可用` }}</view>
            </view>
          </view>
          <button :disabled="navigating" @tap="openWallet">查看我的优惠券</button>
        </view>
        <view v-if="info.points || Number(info.balance) || info.firstOrderDiscount" class="card">
          <view class="section-title">新人福利</view>
          <view v-if="info.points" class="benefit"><text>赠送 {{ info.points }} 积分</text><button size="mini" :disabled="navigating" @tap="openPoints">去查看</button></view>
          <view v-if="Number(info.balance)" class="benefit"><text>赠送 ¥{{ info.balance }} 余额</text><button size="mini" :disabled="navigating" @tap="openBalance">去查看</button></view>
          <view v-if="info.firstOrderDiscount" class="benefit"><text>首单 {{ info.firstOrderDiscount }} 优惠</text><button size="mini" :disabled="navigating" @tap="openGoods">浏览商品</button></view>
          <view class="fine-print">实际领取状态和订单优惠以账户、商品及结算页为准。</view>
        </view>
      </view>
      <view class="card">
        <view class="section-title">新人商品专区</view>
        <view class="fine-print">列表价供查看；购买资格、规格和最终应付需由结算页确认。</view>
        <view v-for="product in products" :key="product.id" class="product" @tap="openProduct(product.id)">
          <image v-if="product.image" :src="product.image" mode="aspectFill" class="product-image" />
          <view class="product-content">
            <view class="product-name">{{ product.title }}</view>
            <view class="price">¥{{ product.price }} <text v-if="Number(product.originalPrice) > Number(product.price)" class="original">¥{{ product.originalPrice }}</text></view>
            <view class="fine-print">库存 {{ product.stock }} · 查看新人规格 ›</view>
          </view>
        </view>
        <view v-if="!loading && !error && !products.length" class="notice">当前没有可展示的新人商品</view>
        <button v-if="hasMore" :disabled="loading || navigating" @tap="load(true)">加载更多</button>
        <view v-else-if="products.length && !loading && !error" class="notice">已加载全部新人商品</view>
      </view>
      <view v-if="rulesOpen" class="overlay" @tap="hideRules">
        <view class="rules-card" @tap.stop>
          <view class="section-title">新人礼规则</view>
          <scroll-view scroll-y class="rules-scroll"><rich-text v-if="agreement" :nodes="agreement" /><view v-else class="notice">商家尚未配置新人礼规则，请以结算页为准。</view></scroll-view>
          <button @tap="hideRules">我知道了</button>
        </view>
      </view>
    </template>
  </view>
</template>
<script setup lang="ts">
import { useNewcomerGift } from '@/composables/useNewcomerGift';
const { auth, info, products, loading, error, page, hasMore, navigating, rulesOpen, agreement,
  load, login, openProduct, openWallet, openBalance, openPoints, openGoods, showRules, hideRules } = useNewcomerGift();
</script>
<style scoped>
.newcomer-page { max-width: 1000px; margin: auto; padding: 24rpx 24rpx calc(48rpx + env(safe-area-inset-bottom)); color: #292521; overflow-wrap: anywhere; }
.hero { position: relative; min-height: 185rpx; border-radius: 22rpx; padding: 34rpx; box-sizing: border-box; color: white; background: linear-gradient(125deg, #a72b24, #ed7442); }
.eyebrow { font-size: 20rpx; letter-spacing: 3rpx; opacity: .85; }.title { margin-top: 12rpx; font-size: 46rpx; font-weight: 700; }.subtitle { margin-top: 8rpx; font-size: 24rpx; }
.rule-button { position: absolute; right: 20rpx; top: 20rpx; margin: 0; font-size: 22rpx; }
.notice-card,.card { margin-top: 22rpx; padding: 26rpx; border-radius: 18rpx; background: white; }
.notice,.fine-print { color: #6e6864; font-size: 24rpx; line-height: 1.6; margin: 15rpx 0; }.error { margin: 16rpx 0; color: #ac251d; }
.section-title { font-size: 31rpx; font-weight: 650; margin-bottom: 20rpx; }.coupon-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12rpx; }
.coupon { padding: 20rpx; border-radius: 12rpx; background: #fff1ea; font-size: 23rpx; line-height: 1.6; }.coupon-benefit { color: #c3341d; font-size: 34rpx; font-weight: 700; }
.benefit { display: flex; align-items: center; justify-content: space-between; gap: 12rpx; padding: 18rpx 0; border-bottom: 1rpx solid #eee; }.benefit button { margin: 0; flex: none; }
.product { display: flex; gap: 18rpx; padding: 20rpx 0; border-bottom: 1rpx solid #eee; }.product-image { width: 145rpx; height: 145rpx; flex: none; border-radius: 12rpx; background: #f4f4f4; }
.product-content { min-width: 0; flex: 1; }.product-name { font-size: 27rpx; font-weight: 600; }.price { margin-top: 14rpx; font-size: 30rpx; color: #c33320; }.original { font-size: 22rpx; text-decoration: line-through; color: #888; }
.overlay { position: fixed; inset: 0; z-index: 100; display: flex; align-items: flex-end; background: #0008; }.rules-card { width: 100%; max-height: 70vh; box-sizing: border-box; padding: 26rpx; border-radius: 22rpx 22rpx 0 0; background: white; }.rules-scroll { max-height: 50vh; }
</style>
