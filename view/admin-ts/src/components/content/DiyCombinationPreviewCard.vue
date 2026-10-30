<template>
 <div class="combination-card" :data-combination-id="product.id" :data-combination-layout="view.layout" :style="px(view.cardStyle)">
  <div v-if="view.layout>=2" class="combination-badge" :style="px(view.badgeStyle)"><span :style="px(view.badgeTextStyle)">{{product.people}}人团</span></div>
  <img v-if="product.image" class="combination-product-image" :src="product.image" :style="px(view.imageStyle)" mode="aspectFill" /><div v-else class="combination-product-image combination-empty-image" :style="px(view.imageStyle)">暂无图片</div>
  <div class="combination-product-content" :style="px(view.contentStyle)">
   <div v-if="view.layout===0" class="combination-top"><div v-if="view.showName" class="combination-product-title" :style="px(view.nameStyle)">{{product.title}}</div><div v-if="view.showTag" :style="px(view.tagRowStyle)"><div class="combination-tag" :style="px(view.tagStyle)"><span :style="px(view.peopleStyle)">{{product.people}}人团</span><span :style="px(view.countStyle)">已拼{{product.count}}份</span></div></div></div>
   <div v-else-if="view.showName" class="combination-product-title" :style="px(view.nameStyle)">{{product.title}}</div>
   <div v-if="view.layout<=1" class="combination-price-row" :style="px(view.priceRowStyle)"><div class="combination-price-column"><DiyCombinationPreviewMoney v-if="view.showPrice" :price="product.price" :view="view" /><span v-if="view.showOldPrice" class="combination-old-price" :style="px(view.oldPriceStyle)">¥{{product.oldPrice}}</span></div><div v-if="view.showButton" class="combination-join-button" :style="px(view.buttonStyle)">去拼团</div></div>
   <template v-else><div v-if="view.layout===2" :style="px(view.priceRowStyle)"><DiyCombinationPreviewMoney v-if="view.showPrice" :price="product.price" :view="view" /></div><DiyCombinationPreviewMoney v-else-if="view.showPrice" :price="product.price" :view="view" /><div v-if="view.showOldPrice" class="combination-old-price" :style="px(view.oldPriceStyle)">¥{{product.oldPrice}}</div></template>
  </div>
 </div>
</template>
<script setup lang="ts">
import { combinationPreviewStyle as px } from '@/utils/diyCombinationProjection';
import type { DiyCombinationPresentation, DiyCombinationRow } from '../../../../common/diyCombination';
import DiyCombinationPreviewMoney from './DiyCombinationPreviewMoney.vue';
defineProps<{product:DiyCombinationRow;view:DiyCombinationPresentation}>();
</script>
<style scoped>
.combination-product-image{object-fit:cover}
.combination-price-column{display:flex;flex-direction:column}.combination-empty-image{display:flex;align-items:center;justify-content:center;color:#999;background:#f5f5f5;font-size:11px}
</style>
