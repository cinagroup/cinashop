<template>
  <view class="points-card" :data-points-id="product.id" :data-points-layout="view.layout" :style="view.cardStyle" @tap="tap">
    <image v-if="product.image" class="points-product-image" :src="product.image" :style="view.imageStyle" mode="aspectFill" /><view v-else class="points-product-image points-empty-image" :style="view.imageStyle">暂无图片</view>
    <view v-if="view.layout===2" class="points-product-title" :style="view.nameStyle">{{product.title}}</view>
    <view class="points-price" :style="view.priceStyle">
      <template v-if="view.layout===0"><text class="points-integral" :style="view.integralStyle">{{product.integral}}</text><text>积分+{{product.price}}元</text></template>
      <template v-else><view class="points-price-part"><image class="points-icon" :src="POINTS_ICON" :style="view.iconStyle" mode="aspectFit" /><text class="points-integral" :style="view.integralStyle">{{product.integral}}</text></view><view class="points-price-part"><text style="color:#333333">+</text><text class="points-cash" :style="view.numberStyle">{{product.price}}</text><text>元</text></view></template>
    </view>
    <view v-if="view.layout===1" class="points-product-title" :style="view.nameStyle">{{product.title}}</view>
  </view>
</template>
<script setup lang="ts">
import { POINTS_ICON, type DiyPointsPresentation, type DiyPointsRow } from '../../../../common/diyPoints';
defineProps<{product:DiyPointsRow;view:DiyPointsPresentation;tap:()=>void}>();
</script>
<style scoped>
.points-price-part{display:flex;align-items:center}.points-empty-image{display:flex;align-items:center;justify-content:center;color:#999;background:#f5f5f5;font-size:22rpx}
</style>
