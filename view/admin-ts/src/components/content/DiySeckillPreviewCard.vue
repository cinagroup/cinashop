<template>
 <div class="seckill-card" :data-seckill-id="product.id" :data-seckill-layout="view.layout" :style="px(view.cardStyle)" >
  <div class="seckill-image-frame" :style="pxMerge([view.imageStyle,{position:'relative',overflow:'hidden'}])">
   <template v-for="baseImage in [media.base]" :key="baseImage.key"><img v-if="baseImage.src" :key="baseImage.key" class="seckill-product-image" :src="baseImage.src" mode="aspectFill" @load="baseImage.loaded" @error="baseImage.failed" />
   <div v-else class="seckill-product-image seckill-empty-image">暂无图片</div></template>
   <template v-for="overlayImage in [media.overlay]" :key="overlayImage.key"><img v-if="overlayImage.src" :key="overlayImage.key" class="seckill-activity-image" :src="overlayImage.src" mode="aspectFill" @load="overlayImage.loaded" @error="overlayImage.failed" /></template>
  </div>
  <div class="seckill-product-content" :style="px(view.contentStyle)">
   <div v-if="view.layout===0"><div v-if="view.showName" class="seckill-product-title" :style="px(view.nameStyle)">{{product.title}}</div>
    <div class="seckill-progress-row" :style="px(view.progressRowStyle)"><div class="seckill-progress" :style="px(view.progressStyle)"><div class="seckill-progress-fill" :style="pxMerge([view.progressFillStyle,{width:product.percent+'%'}])" /><img class="seckill-lightning" src="/static/images/diy/seckill-lightning.png" :style="pxMerge([view.lightningStyle,{left:seckillLightningLeft(product.percent)}])" /></div><span class="seckill-progress-text" :style="px(view.progressTextStyle)">{{product.percent}}%</span></div>
   </div><div v-else-if="view.showName" class="seckill-product-title" :style="px(view.nameStyle)">{{product.title}}</div>
   <template v-if="view.layout===2"><div class="seckill-price-bar" :style="px(view.priceBarStyle)"><DiySeckillPreviewMoney v-if="view.showPrice" :price="product.price" :view="view" /><img class="seckill-shandian" src="/static/images/diy/seckill-shandian.png" :style="px(view.shandianStyle)" /></div><div v-if="view.showOldPrice" class="seckill-old-price" :style="px(view.oldPriceStyle)">¥{{product.oldPrice}}</div></template>
   <div v-else class="seckill-price-row" :style="px(view.priceRowStyle)"><div class="seckill-price-column"><DiySeckillPreviewMoney v-if="view.showPrice" :price="product.price" :view="view" /><span v-if="view.showOldPrice" class="seckill-old-price" :style="px(view.oldPriceStyle)">¥{{product.oldPrice}}</span></div><div v-if="view.showButton" class="seckill-buy-button" :style="px(view.buttonStyle)"><img v-if="view.layout===3" class="seckill-button-shandian" src="/static/images/diy/seckill-shandian.png" :style="pxMerge([view.shandianStyle,{height:'40rpx'}])" />{{view.layout===3?'抢':'去抢购'}}</div></div>
  </div>
 </div>
</template>
<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { seckillPreviewStyle as px } from '@/utils/diySeckillProjection';
import { seckillLightningLeft, type DiySeckillPresentation, type DiySeckillRow, type SeckillStyle } from '../../../../common/diySeckill';
import DiySeckillPreviewMoney from './DiySeckillPreviewMoney.vue';
const props=defineProps<{product:DiySeckillRow;view:DiySeckillPresentation}>();
const pxMerge=(styles:SeckillStyle[])=>styles.map(px);
let alive=true;
onBeforeUnmount(()=>{alive=false;epoch.value++;});
const epoch=ref(0),baseLoaded=ref(false),baseFailed=ref(false),overlayFailed=ref(false);
watch(()=>[props.product,props.product.image,props.product.activityImage],()=>{epoch.value++;baseLoaded.value=baseFailed.value=overlayFailed.value=false;},{immediate:true,flush:'sync'});
const media=computed(()=>{const version=epoch.value,product=props.product,valid=()=>alive&&epoch.value===version&&props.product===product;
 return{base:{key:`${version}:base:${product.image}`,src:baseFailed.value?'':product.image,loaded:()=>{if(valid())baseLoaded.value=true;},failed:()=>{if(valid()){epoch.value++;baseFailed.value=true;baseLoaded.value=false;}}},overlay:{key:`${version}:overlay:${product.activityImage}`,src:baseLoaded.value&&!baseFailed.value&&!overlayFailed.value?product.activityImage:'',loaded:()=>{},failed:()=>{if(valid()){epoch.value++;overlayFailed.value=true;}}}};
});
</script>
<style scoped>
.seckill-product-image,.seckill-activity-image{position:absolute;top:0;left:0;width:100%;height:100%;border-radius:inherit;object-fit:cover}.seckill-activity-image{pointer-events:none}.seckill-price-column{display:flex;flex-direction:column}.seckill-empty-image{display:flex;align-items:center;justify-content:center;color:#999;background:#f5f5f5;font-size:11px}
</style>
