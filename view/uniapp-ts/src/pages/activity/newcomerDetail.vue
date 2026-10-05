<template>
  <ThemePage>
  <view class="newcomer-detail">
    <view class="heading">新人专享商品</view>
    <view v-if="loading" class="notice" role="status">正在加载新人商品…</view>
    <view v-if="error" class="error" role="alert">{{ error }}</view>
    <button v-if="!auth.isLoggedIn" @tap="login">登录后查看</button>
    <button v-else size="mini" :disabled="loading" @tap="load">刷新商品</button>
    <view v-if="detail" class="product">
      <ProductMedia :images="detail.image?[detail.image]:[]" video="" :picture-config="activityDesign.pictureConfig" :dots="activityDesign.swiperDot" :active="visible"/>
      <view v-if="activityDesignError" class="notice">{{activityDesignError}}<button size="mini" @tap="reloadActivityDesign">重试展示设置</button></view>
      <ActivityDetailMenu :menu="activityDesign.menuList" :product-id="detail.id" :path="'/pages/activity/newcomerDetail?id='+detail.id" :title="detail.title" :image="detail.image" :active="visible"/>
      <view class="content">
        <view class="name">{{ detail.title }}</view>
        <view v-if="detail.description" class="notice">{{ detail.description }}</view>
        <view class="price">新人展示价 ¥{{ detail.price }} <text v-if="Number(detail.originalPrice) > Number(detail.price)" class="original">¥{{ detail.originalPrice }}</text></view>
        <view class="notice">基础商品库存 {{ detail.stock }}</view>
        <view class="section-title">活动规格</view>
        <view v-for="sku in detail.skus" :key="sku.unique" class="sku">
          <image v-if="sku.image" :src="sku.image" mode="aspectFill" class="sku-image" />
          <view><view>{{ sku.name || '默认规格' }}</view><view class="sku-price">¥{{ sku.price }} · 库存 {{ sku.stock }}</view></view>
        </view>
        <view v-if="!detail.skus.length" class="notice">当前没有可购买的活动规格</view>
        <view class="notice">新人专享加购与结算正在验收。当前页面仅供查看活动信息，暂不能在新端按此价格下单。</view>
      </view>
    </view>
  </view>
  </ThemePage>
</template>
<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import ProductMedia from '@/components/productDetail/ProductMedia.vue';
import ActivityDetailMenu from '@/components/productDetail/ActivityDetailMenu.vue';
import {useActivityDetailDesign,useActivityDetailShare} from '@/composables/useActivityDetailDesign';
const {activityDesign,activityDesignError,reloadActivityDesign}=useActivityDetailDesign();
import { useNewcomerProduct } from '@/composables/useNewcomerProduct';
const { auth, detail, loading, error, visible,load, login } = useNewcomerProduct();
useActivityDetailShare(()=>detail.value?{title:detail.value.title,path:`/pages/activity/newcomerDetail?id=${detail.value.id}`,image:detail.value.image}:null,()=>visible.value);
</script>
<style scoped>
.newcomer-detail { max-width: 900px; margin: auto; padding: 24rpx 24rpx calc(60rpx + env(safe-area-inset-bottom)); overflow-wrap: anywhere; }
.heading { font-size: 38rpx; font-weight: 700; margin-bottom: 20rpx; }.notice { color: #67636a; font-size: 25rpx; line-height: 1.6; margin: 18rpx 0; }.error { color: #a62b22; padding: 18rpx; background: #fff0ee; margin-bottom: 14rpx; }
.product { border-radius: 18rpx; overflow: hidden; background: white; }.hero-image { width: 100%; height: 400rpx; background: #f5f5f5; }.content { padding: 26rpx; }.name { font-size: 34rpx; font-weight: 650; }.price { color: var(--view-priceColor, #e93323); font-size: 34rpx; margin: 22rpx 0; }.original { color: #888; text-decoration: line-through; font-size: 23rpx; }.section-title { font-size: 28rpx; font-weight: 600; margin: 26rpx 0 12rpx; }.sku { display: flex; align-items: center; gap: 18rpx; border-top: 1rpx solid #eee; padding: 15rpx 0; }.sku-image { flex: none; width: 70rpx; height: 70rpx; }.sku-price { color: var(--view-priceColor, #e93323); font-size: 24rpx; margin-top: 6rpx; }
</style>
