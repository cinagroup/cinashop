<template>
 <div class="presale-card" :data-presale-id="product.id" :data-presale-layout="view.layout" :style="px(view.cardStyle)">
  <img v-if="product.image" class="presale-product-image" :src="product.image" :style="px(view.imageStyle)" mode="aspectFill" /><div v-else class="presale-product-image presale-empty-image" :style="px(view.imageStyle)">暂无图片</div>
  <div class="presale-product-content" :style="px(view.contentStyle)">
   <div v-if="view.showName" class="presale-product-title" :style="px(view.nameStyle)">{{product.title}}</div>
   <template v-if="view.layout===0"><div v-if="view.showButton" class="presale-price-bar" :style="px(view.barStyle)"><div class="presale-bar-left" :style="px(view.barLeftStyle)"><DiyPresalePreviewMoney :price="product.price" :view="view" /></div><div class="presale-bar-right" :style="px(view.barRightStyle)">{{presaleStatus(product.status)}}</div><img class="presale-flash" :src="PRESALE_FLASH" :style="px(view.flashStyle)" /></div></template>
   <template v-else><div class="presale-price-row" :style="px(view.priceRowStyle)"><div :class="view.layout===1?'presale-price-column':''"><DiyPresalePreviewMoney v-if="view.showPrice" :price="product.price" :view="view" /><span v-if="view.layout===1" class="presale-old-price" :style="px(view.oldPriceStyle)">¥{{product.oldPrice}}</span></div><div v-if="view.layout===1 && view.showButton" class="presale-book-button" :style="px(view.buttonStyle)">去预定</div></div><div v-if="view.layout>=2 && view.showOldPrice" class="presale-old-price" :style="px(view.oldPriceStyle)">¥{{product.oldPrice}}</div></template>
  </div>
 </div>
</template>
<script setup lang="ts">
import { PRESALE_FLASH, presaleStatus, type DiyPresalePresentation, type DiyPresaleRow } from '../../../../common/diyPresale';
import { presalePreviewStyle as px } from '@/utils/diyPresaleProjection';
import DiyPresalePreviewMoney from './DiyPresalePreviewMoney.vue';
defineProps<{product:DiyPresaleRow;view:DiyPresalePresentation}>();
</script>
<style scoped>
.presale-product-image{object-fit:cover}
.presale-price-column{display:flex;flex-direction:column}.presale-empty-image{display:flex;align-items:center;justify-content:center;color:#999;background:#f5f5f5;font-size:11px}
</style>
