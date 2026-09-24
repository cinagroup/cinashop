<template>
  <view class="newcomer-detail">
    <view class="heading">新人专享商品</view>
    <view v-if="loading" class="notice" role="status">正在加载新人商品…</view>
    <view v-if="error" class="error" role="alert">{{ error }}</view>
    <button v-if="!auth.isLoggedIn" @tap="login">登录后查看</button>
    <button v-else size="mini" :disabled="loading" @tap="load">刷新商品</button>
    <view v-if="detail" class="product">
      <image v-if="detail.image" :src="detail.image" mode="aspectFit" class="hero-image" />
      <view class="content">
        <view class="name">{{ detail.title }}</view>
        <view v-if="detail.description" class="notice">{{ detail.description }}</view>
        <view class="price">新人价 ¥{{ selectedSku?.price ?? detail.price }} <text v-if="Number(detail.originalPrice) > Number(selectedSku?.price ?? detail.price)" class="original">¥{{ detail.originalPrice }}</text></view>
        <view class="notice">基础商品库存快照 {{ detail.stock }}，下单以服务端实时校验为准</view>
        <view class="section-title">活动规格</view>
        <button v-for="sku in detail.skus" :key="sku.unique" size="mini" class="sku" :class="{ chosen: selected === sku.unique }"
          :disabled="buying || navigating || prepared !== null" @tap="choose(sku.unique)">
          <image v-if="sku.image" :src="sku.image" mode="aspectFill" class="sku-image" />
          <view><view>{{ sku.name || '默认规格' }}</view><view class="sku-price">¥{{ sku.price }}</view></view>
        </button>
        <view v-if="!detail.skus.length" class="notice">当前没有可购买的活动规格</view>
        <view class="notice">新人专享限购 1 件。活动规格库存仅为配置快照，具体可购状态将在加购和结算时核验。</view>
        <button class="purchase" :disabled="!canBuy" @tap="purchase">{{ prepared !== null ? '继续结算' : buying ? '正在加购…' : '立即购买' }}</button>
      </view>
    </view>
  </view>
</template>
<script setup lang="ts">
import { useNewcomerProduct } from '@/composables/useNewcomerProduct';
const { auth, detail, selected, selectedSku, loading, buying, navigating, prepared, canBuy, error, load, login, choose, purchase } = useNewcomerProduct();
</script>
<style scoped>
.newcomer-detail { max-width: 900px; margin: auto; padding: 24rpx 24rpx calc(60rpx + env(safe-area-inset-bottom)); overflow-wrap: anywhere; }
.heading { font-size: 38rpx; font-weight: 700; margin-bottom: 20rpx; }.notice { color: #67636a; font-size: 25rpx; line-height: 1.6; margin: 18rpx 0; }.error { color: #a62b22; padding: 18rpx; background: #fff0ee; margin-bottom: 14rpx; }
.product { border-radius: 18rpx; overflow: hidden; background: white; }.hero-image { width: 100%; height: 400rpx; background: #f5f5f5; }.content { padding: 26rpx; }.name { font-size: 34rpx; font-weight: 650; }.price { color: #c32e1e; font-size: 34rpx; margin: 22rpx 0; }.original { color: #888; text-decoration: line-through; font-size: 23rpx; }.section-title { font-size: 28rpx; font-weight: 600; margin: 26rpx 0 12rpx; }.sku { display: flex; width: 100%; box-sizing: border-box; align-items: center; gap: 18rpx; margin: 0; padding: 18rpx 14rpx; border: 1rpx solid #ece7e4; border-radius: 12rpx; background: white; color: #262326; text-align: left; font-size: 27rpx; line-height: 1.35; }.sku + .sku { margin-top: 12rpx; }.sku::after { border: 0; }.sku.chosen { border-color: #c32e1e; background: #fff5f2; }.sku-image { flex: none; width: 70rpx; height: 70rpx; }.sku-price { color: #b63725; font-size: 24rpx; margin-top: 6rpx; }.purchase { margin-top: 22rpx; background: #c32e1e; color: white; }.purchase[disabled] { background: #d6d0ce; color: #696362; }
</style>
