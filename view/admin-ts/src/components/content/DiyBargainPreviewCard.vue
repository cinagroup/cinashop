<template>
 <div class="bargain-card" :data-bargain-id="product.id" :data-bargain-layout="view.layout" :style="px(view.cardStyle)">
  <img v-if="product.image" class="bargain-product-image" :src="product.image" :style="px(view.imageStyle)" mode="aspectFill" /><div v-else class="bargain-product-image bargain-empty-image" :style="px(view.imageStyle)">暂无图片</div>
  <div class="bargain-product-content" :style="px(view.contentStyle)">
   <div v-if="view.showName" class="bargain-product-title" :style="px(view.nameStyle)">{{product.title}}</div>
   <div v-if="view.layout===0 && view.showTag" class="bargain-participants" :style="px(view.participantsStyle)"><span class="bargain-fire" :style="px(view.fireStyle)">&#xe69d;</span><span :style="px(view.participantTextStyle)">{{product.people}}人正在参与</span></div>
   <span v-if="view.layout===3 && view.showName" class="bargain-success" :style="px(view.successStyle)">{{product.people}}人已砍成功</span>
   <div v-if="view.layout<=1" class="bargain-price-row" :style="px(view.priceRowStyle)"><div class="bargain-price-column"><DiyBargainPreviewMoney v-if="view.showPrice" :price="product.price" :view="view" /><span v-if="view.showOldPrice" class="bargain-old-price" :style="px(view.oldPriceStyle)">¥{{product.oldPrice}}</span></div><div v-if="view.showButton" class="bargain-join-button" :style="px(view.buttonStyle)">参与砍价</div></div>
   <template v-else><div :style="px(view.layout===2?view.priceRowStyle:{})"><DiyBargainPreviewMoney v-if="view.showPrice" :price="product.price" :view="view" /></div><div v-if="view.showOldPrice" class="bargain-old-price" :style="px(view.oldPriceStyle)">¥{{product.oldPrice}}</div></template>
  </div>
 </div>
</template>
<script setup lang="ts">
import { bargainPreviewStyle as px } from '@/utils/diyBargainProjection';
import type { DiyBargainPresentation, DiyBargainRow } from '../../../../common/diyBargain';
import DiyBargainPreviewMoney from './DiyBargainPreviewMoney.vue';
defineProps<{product:DiyBargainRow;view:DiyBargainPresentation}>();
</script>
<style src="../../../../common/diyBargainFire.css"></style>
<style scoped>
.bargain-product-image{object-fit:cover}
.bargain-price-column{display:flex;flex-direction:column}.bargain-empty-image{display:flex;align-items:center;justify-content:center;color:#999;background:#f5f5f5;font-size:11px}
</style>
