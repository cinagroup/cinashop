<template>
  <div class="points-card" :data-points-id="product.id" :data-points-layout="view.layout" :style="px(view.cardStyle)">
    <img v-if="product.image" class="points-product-image" :src="product.image" :style="px(view.imageStyle)" mode="aspectFill" /><div v-else class="points-product-image points-empty-image" :style="px(view.imageStyle)">暂无图片</div>
    <div v-if="view.layout===2" class="points-product-title" :style="px(view.nameStyle)">{{product.title}}</div>
    <div class="points-price" :style="px(view.priceStyle)">
      <template v-if="view.layout===0"><span class="points-integral" :style="px(view.integralStyle)">{{product.integral}}</span><span>积分+{{product.price}}元</span></template>
      <template v-else><div class="points-price-part"><img class="points-icon" :src="POINTS_ICON" :style="px(view.iconStyle)" mode="aspectFit" /><span class="points-integral" :style="px(view.integralStyle)">{{product.integral}}</span></div><div class="points-price-part"><span style="color:#333333">+</span><span class="points-cash" :style="px(view.numberStyle)">{{product.price}}</span><span>元</span></div></template>
    </div>
    <div v-if="view.layout===1" class="points-product-title" :style="px(view.nameStyle)">{{product.title}}</div>
  </div>
</template>
<script setup lang="ts">
import { POINTS_ICON, type DiyPointsPresentation, type DiyPointsRow } from '../../../../common/diyPoints';
import { listPixelStyle as px } from '@/utils/diyListEditor';
defineProps<{product:DiyPointsRow;view:DiyPointsPresentation}>();
</script>
<style scoped>
.points-product-image{object-fit:cover}
.points-price-part{display:flex;align-items:center}.points-empty-image{display:flex;align-items:center;justify-content:center;color:#999;background:#f5f5f5;font-size:11px}
</style>
