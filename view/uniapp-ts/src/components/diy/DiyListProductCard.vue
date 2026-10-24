<template>
  <view class="diy-list-product" :data-product-id="product.id" :data-layout="config.style" :style="config.panelStyle" @tap="$emit('open', product.id)">
    <view class="list-picture" :style="config.imageStyle">
      <image v-if="product.image" class="list-image" :src="product.image" :style="config.imageStyle" mode="aspectFill" @load="measure" />
      <view v-else class="list-image list-image-empty">暂无图片</view>
      <image v-if="config.showFrame && product.frameImage" class="list-frame" :src="product.frameImage" mode="scaleToFill" />
    </view>
    <view class="list-copy">
      <text v-if="config.showName" class="list-name" :style="config.nameStyle"><text v-if="config.showBrand && product.brand_name" class="list-brand">{{product.brand_name}}</text>{{product.store_name}}</text>
      <view v-if="config.showLabels" class="list-labels"><view v-for="label in product.labels" :key="label.id" class="list-label" :style="{color:label.color,background:label.background,borderColor:label.border}"><image v-if="label.icon" :src="label.icon" />{{label.name}}</view></view>
      <view class="list-price-line"><text v-if="config.showPrice" class="list-price" :style="config.priceStyle">¥{{product.price}}</text><text v-if="config.showOffer && product.offer" class="list-offer">{{product.offer.label}} ¥{{product.offer.price}}</text></view>
      <view class="list-meta"><text v-if="config.showSales" class="list-sales" :style="config.salesStyle">已售{{product.sales}}{{product.unit_name}}</text><text v-if="config.showRating" class="list-rating" :style="config.ratingStyle">评分{{product.star}}</text></view>
      <button v-if="config.showAction" class="list-action" :data-action-style="config.actionStyle" :style="config.buttonStyle" :disabled="disabled" :aria-label="config.cartMode?'选择规格加入购物车':'查看商品'" @tap.stop="$emit('action',product.id)">{{config.style===0 || config.style===4 ? config.actionStyle===0?'购买':config.actionStyle===1?'＋':'购物车' : config.actionStyle===0?'＋':'购物车'}}</button>
    </view>
  </view>
</template>
<script setup lang="ts">
import { getCurrentInstance, nextTick, onScopeDispose, watch } from 'vue';
import type { DiyListConfig } from '@/utils/diyListConfig';
import type { DiyListProduct } from '@/utils/diyListData';
const props=defineProps<{product:DiyListProduct;config:DiyListConfig;disabled:boolean;allowed:()=>boolean}>();
const emit=defineEmits<{open:[id:number];action:[id:number];measured:[row:{id:number;height:number;current:()=>boolean}]}>();
const instance=getCurrentInstance();let alive=true;
async function measure(){
  const allowed=props.allowed,id=props.product.id;
  const current=()=>alive&&allowed()&&props.product.id===id;
  if(props.config.style!==1||!instance?.proxy||!current())return;
  await nextTick();if(!current())return;
  // Query inside this card's own component scope; MP selectors do not need to
  // cross a custom-component boundary to obtain the actual rendered height.
  uni.createSelectorQuery().in(instance.proxy).select('.diy-list-product').boundingClientRect(value=>{
    const row=Array.isArray(value)?value[0]:value;
    if(current()&&row&&typeof row.height==='number')emit('measured',{id,height:row.height,current});
  }).exec();
}
watch([()=>props.product.id,()=>props.config],()=>{void measure();},{immediate:true,flush:'post'});
onScopeDispose(()=>{alive=false;});
</script>
<style scoped>
.diy-list-product{min-width:0;position:relative;overflow:hidden;box-sizing:border-box;background:#fff;}.list-picture{position:relative;overflow:hidden;flex-shrink:0;}.list-image{display:block;width:100%;height:224rpx;object-fit:cover;}.list-image-empty{display:flex;align-items:center;justify-content:center;color:#999;background:#f5f5f5;font-size:22rpx;}.list-frame{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;}.list-copy{position:relative;padding:20rpx;box-sizing:border-box;min-width:0;}.list-name{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;font-size:28rpx;line-height:40rpx;overflow-wrap:anywhere;}.list-brand{font-size:21rpx;background:#333;color:#fff;padding:0 6rpx;margin-right:6rpx;}.list-labels{display:flex;gap:6rpx;flex-wrap:wrap;margin-top:8rpx;}.list-label{display:flex;align-items:center;font-size:20rpx;border:1rpx solid transparent;border-radius:6rpx;padding:0 5rpx;max-width:100%;overflow-wrap:anywhere;}.list-label image{width:24rpx;height:24rpx;margin-right:4rpx;}.list-price-line{display:flex;gap:8rpx;align-items:center;flex-wrap:wrap;margin-top:10rpx;}.list-price{font-size:36rpx;font-weight:600;}.list-offer{font-size:21rpx;background:#f7e9cd;color:#484643;}.list-meta{display:flex;gap:12rpx;flex-wrap:wrap;font-size:22rpx;line-height:34rpx;margin-top:8rpx;}.list-action{font-size:23rpx;line-height:1.6;margin:10rpx 0 0 auto;padding:4rpx 12rpx;border-radius:28rpx;width:max-content;max-width:100%;}.list-action::after{border:0;}.diy-list-product[data-layout='0']{display:flex;padding:20rpx;}.diy-list-product[data-layout='0'] .list-picture{width:224rpx;}.diy-list-product[data-layout='0'] .list-copy{flex:1;padding:0 0 0 20rpx;}.diy-list-product[data-layout='1'] .list-image{height:346rpx;}.diy-list-product[data-layout='2'] .list-image{height:210rpx;}.diy-list-product[data-layout='2'] .list-copy{padding:16rpx 8rpx;}.diy-list-product[data-layout='2'] .list-price{font-size:28rpx;}.diy-list-product[data-layout='3']{display:flex;}.diy-list-product[data-layout='3'] .list-picture{width:144rpx;}.diy-list-product[data-layout='3'] .list-image{height:144rpx;}.diy-list-product[data-layout='3'] .list-copy{flex:1;padding:0 0 0 14rpx;}.diy-list-product[data-layout='3'] .list-name{font-size:26rpx;line-height:36rpx;}.diy-list-product[data-layout='3'] .list-price{font-size:28rpx;}.diy-list-product[data-layout='4'] .list-image{height:360rpx;}.diy-list-product[data-layout='4'] .list-name{-webkit-line-clamp:1;}.diy-list-product[data-layout='5'] .list-image{height:200rpx;}.diy-list-product[data-layout='5'] .list-copy{padding:14rpx 8rpx;}.diy-list-product[data-layout='5'] .list-price{font-size:30rpx;}
</style>
