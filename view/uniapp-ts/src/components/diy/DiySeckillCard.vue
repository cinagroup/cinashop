<template>
 <view class="seckill-card" :data-seckill-id="product.id" :data-seckill-layout="view.layout" :style="view.cardStyle" @tap="tap">
  <view class="seckill-image-frame" :style="[view.imageStyle,{position:'relative',overflow:'hidden'}]">
   <template v-for="baseImage in [media.base]" :key="baseImage.key"><image v-if="baseImage.src" :key="baseImage.key" class="seckill-product-image" :src="baseImage.src" mode="aspectFill" @load="baseImage.loaded" @error="baseImage.failed" />
   <view v-else class="seckill-product-image seckill-empty-image">暂无图片</view></template>
   <template v-for="overlayImage in [media.overlay]" :key="overlayImage.key"><image v-if="overlayImage.src" :key="overlayImage.key" class="seckill-activity-image" :src="overlayImage.src" mode="aspectFill" @load="overlayImage.loaded" @error="overlayImage.failed" /></template>
  </view>
  <view class="seckill-product-content" :style="view.contentStyle">
   <view v-if="view.layout===0"><view v-if="view.showName" class="seckill-product-title" :style="view.nameStyle">{{product.title}}</view>
    <view class="seckill-progress-row" :style="view.progressRowStyle"><view class="seckill-progress" :style="view.progressStyle"><view class="seckill-progress-fill" :style="[view.progressFillStyle,{width:product.percent+'%'}]" /><image class="seckill-lightning" src="/static/images/diy/seckill-lightning.png" :style="[view.lightningStyle,{left:seckillLightningLeft(product.percent)}]" /></view><text class="seckill-progress-text" :style="view.progressTextStyle">{{product.percent}}%</text></view>
   </view><view v-else-if="view.showName" class="seckill-product-title" :style="view.nameStyle">{{product.title}}</view>
   <template v-if="view.layout===2"><view class="seckill-price-bar" :style="view.priceBarStyle"><DiySeckillMoney v-if="view.showPrice" :price="product.price" :view="view" /><image class="seckill-shandian" src="/static/images/diy/seckill-shandian.png" :style="view.shandianStyle" /></view><view v-if="view.showOldPrice" class="seckill-old-price" :style="view.oldPriceStyle">¥{{product.oldPrice}}</view></template>
   <view v-else class="seckill-price-row" :style="view.priceRowStyle"><view class="seckill-price-column"><DiySeckillMoney v-if="view.showPrice" :price="product.price" :view="view" /><text v-if="view.showOldPrice" class="seckill-old-price" :style="view.oldPriceStyle">¥{{product.oldPrice}}</text></view><view v-if="view.showButton" class="seckill-buy-button" :style="view.buttonStyle"><image v-if="view.layout===3" class="seckill-button-shandian" src="/static/images/diy/seckill-shandian.png" :style="[view.shandianStyle,{height:'40rpx'}]" />{{view.layout===3?'抢':'去抢购'}}</view></view>
  </view>
 </view>
</template>
<script setup lang="ts">
import { seckillLightningLeft, type DiySeckillPresentation, type DiySeckillRow } from '../../../../common/diySeckill';
import DiySeckillMoney from './DiySeckillMoney.vue';
defineProps<{product:DiySeckillRow;view:DiySeckillPresentation;tap:()=>void;media:{base:{src:string;key:string;loaded:()=>void;failed:()=>void};overlay:{src:string;key:string;loaded:()=>void;failed:()=>void}}}>();
</script>
<style scoped>
.seckill-product-image,.seckill-activity-image{position:absolute;top:0;left:0;width:100%;height:100%;border-radius:inherit}.seckill-activity-image{pointer-events:none}.seckill-price-column{display:flex;flex-direction:column}.seckill-empty-image{display:flex;align-items:center;justify-content:center;color:#999;background:#f5f5f5;font-size:22rpx}
</style>
