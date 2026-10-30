<template>
 <view class="presale-card" :data-presale-id="product.id" :data-presale-layout="view.layout" :style="view.cardStyle" @tap="tap">
  <image v-if="product.image" class="presale-product-image" :src="product.image" :style="view.imageStyle" mode="aspectFill" /><view v-else class="presale-product-image presale-empty-image" :style="view.imageStyle">暂无图片</view>
  <view class="presale-product-content" :style="view.contentStyle">
   <view v-if="view.showName" class="presale-product-title" :style="view.nameStyle">{{product.title}}</view>
   <template v-if="view.layout===0"><view v-if="view.showButton" class="presale-price-bar" :style="view.barStyle"><view class="presale-bar-left" :style="view.barLeftStyle"><DiyPresaleMoney :price="product.price" :view="view" /></view><view class="presale-bar-right" :style="view.barRightStyle">{{presaleStatus(product.status)}}</view><image class="presale-flash" :src="PRESALE_FLASH" :style="view.flashStyle" /></view></template>
   <template v-else><view class="presale-price-row" :style="view.priceRowStyle"><view :class="view.layout===1?'presale-price-column':''"><DiyPresaleMoney v-if="view.showPrice" :price="product.price" :view="view" /><text v-if="view.layout===1" class="presale-old-price" :style="view.oldPriceStyle">¥{{product.oldPrice}}</text></view><view v-if="view.layout===1 && view.showButton" class="presale-book-button" :style="view.buttonStyle">去预定</view></view><view v-if="view.layout>=2 && view.showOldPrice" class="presale-old-price" :style="view.oldPriceStyle">¥{{product.oldPrice}}</view></template>
  </view>
 </view>
</template>
<script setup lang="ts">
import { PRESALE_FLASH, presaleStatus, type DiyPresalePresentation, type DiyPresaleRow } from '../../../../common/diyPresale';
import DiyPresaleMoney from './DiyPresaleMoney.vue';
defineProps<{product:DiyPresaleRow;view:DiyPresalePresentation;tap:()=>void}>();
</script>
<style scoped>
.presale-price-column{display:flex;flex-direction:column}.presale-empty-image{display:flex;align-items:center;justify-content:center;color:#999;background:#f5f5f5;font-size:22rpx}
</style>
