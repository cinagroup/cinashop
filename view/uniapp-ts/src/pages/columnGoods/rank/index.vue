<template>
  <view class="rank-page">
    <view class="rank-hero">
      <text class="rank-eyebrow">CINASHOP · TOP PICKS</text>
      <text class="rank-title">商品排行榜</text>
      <text class="rank-subtitle">按当前商品销量、评分与收藏数实时排序</text>
      <view class="rank-tabs">
        <button v-for="tab in PRODUCT_RANK_TABS" :key="tab.type" class="rank-tab"
          :class="{ active: type === tab.type }" :disabled="navigating" @tap="select(tab.type)">
          {{ tab.label }}
        </button>
      </view>
    </view>

    <view class="rank-content">
      <view v-if="error" class="rank-error">
        <text>{{ error }}</text>
        <button size="mini" :disabled="loading || navigating" @tap="load(page > 0)">重试</button>
      </view>
      <view v-for="(item, index) in products" :key="item.id" class="rank-card" @tap="openProduct(item.id)">
        <view class="rank-image-wrap">
          <image v-if="item.image" :src="item.image" mode="aspectFill" class="rank-image" />
          <view v-else class="rank-image rank-image-empty">暂无图片</view>
          <text class="rank-position" :class="{ medal: index < 3 }">{{ index + 1 }}</text>
        </view>
        <view class="rank-info">
          <text v-if="item.brand" class="rank-brand">{{ item.brand }}</text>
          <text class="rank-name">{{ item.title }}</text>
          <text class="rank-stats">{{ item.sales }} 人买过 · 评分 {{ item.star }}</text>
          <view class="rank-bottom">
            <text class="rank-price">¥{{ item.price }}</text>
            <text class="rank-link">{{ item.navigationHint }}</text>
          </view>
        </view>
      </view>
      <text v-if="loading" class="rank-note">正在加载商品排行…</text>
      <text v-else-if="!error && !products.length" class="rank-note">当前榜单暂无商品</text>
      <button v-if="hasMore && !error" class="more-button" :disabled="loading || navigating" @tap="load(true)">加载更多</button>
      <text v-else-if="products.length && !loading && !error" class="rank-note">已显示全部商品</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { PRODUCT_RANK_TABS } from '@/api/productRank';
import { useProductRank } from '@/composables/useProductRank';

const { type, products, page, hasMore, loading, error, navigating, load, select, openProduct } = useProductRank();
</script>

<style scoped>
.rank-page{min-height:100vh;background:#f8f6f3;color:#302c29}.rank-hero{padding:60rpx 28rpx 32rpx;background:linear-gradient(155deg,#963327,#ca5a36 63%,#e9ad65);color:white;display:flex;flex-direction:column;gap:10rpx}.rank-eyebrow{font-size:20rpx;letter-spacing:4rpx;opacity:.8}.rank-title{font-size:52rpx;line-height:1.2;font-weight:750}.rank-subtitle{font-size:24rpx;opacity:.86}.rank-tabs{display:flex;gap:12rpx;margin-top:30rpx}.rank-tab{flex:1;min-width:0;border:1rpx solid rgba(255,255,255,.4);border-radius:999rpx;background:rgba(255,255,255,.12);color:white;font-size:26rpx;line-height:1.4;padding:14rpx 4rpx}.rank-tab.active{background:white;color:#a83b28;font-weight:700}.rank-content{max-width:1100px;margin:0 auto;padding:24rpx}.rank-card{display:flex;gap:22rpx;background:white;border:1rpx solid #eee5df;border-radius:22rpx;padding:20rpx;margin-bottom:16rpx;box-shadow:0 5rpx 16rpx rgba(63,35,23,.045)}.rank-image-wrap{position:relative;flex-shrink:0}.rank-image{width:210rpx;height:210rpx;border-radius:14rpx;background:#f3eae3}.rank-image-empty{display:flex;align-items:center;justify-content:center;color:#9b8b80;font-size:22rpx}.rank-position{position:absolute;top:0;left:0;min-width:40rpx;height:40rpx;padding:0 6rpx;display:flex;align-items:center;justify-content:center;border-radius:12rpx 0 12rpx 0;background:#544b45;color:white;font-size:22rpx;font-weight:700}.rank-position.medal{background:#c3552d}.rank-info{min-width:0;flex:1;display:flex;flex-direction:column;gap:8rpx}.rank-brand{font-size:20rpx;color:#9e5540}.rank-name{font-size:28rpx;font-weight:650;line-height:1.35;overflow-wrap:anywhere}.rank-stats{font-size:21rpx;color:#81786f}.rank-bottom{margin-top:auto;display:flex;gap:8rpx;align-items:end;justify-content:space-between}.rank-price{font-size:34rpx;color:#b8402b;font-weight:700}.rank-link{font-size:22rpx;color:#8f4332;white-space:nowrap}.rank-note{display:block;text-align:center;color:#84776c;font-size:24rpx;padding:32rpx 0}.rank-error{display:flex;align-items:center;justify-content:space-between;gap:16rpx;background:#fff2ec;color:#9c3528;border-radius:12rpx;padding:16rpx 22rpx;margin-bottom:16rpx;font-size:24rpx}.more-button{margin:18rpx 0 24rpx;background:white;color:#a83b28;border:1rpx solid #eed8cd;font-size:26rpx}@media screen and (max-width:360px){.rank-image{width:176rpx;height:176rpx}.rank-card{gap:14rpx}.rank-price{font-size:30rpx}}
</style>
