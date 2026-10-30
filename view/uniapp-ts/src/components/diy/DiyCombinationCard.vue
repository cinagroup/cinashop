<template>
 <view class="combination-card" :data-combination-id="product.id" :data-combination-layout="view.layout" :style="view.cardStyle" @tap="tap">
  <view v-if="view.layout>=2" class="combination-badge" :style="view.badgeStyle"><text :style="view.badgeTextStyle">{{product.people}}人团</text></view>
  <image v-if="product.image" class="combination-product-image" :src="product.image" :style="view.imageStyle" mode="aspectFill" /><view v-else class="combination-product-image combination-empty-image" :style="view.imageStyle">暂无图片</view>
  <view class="combination-product-content" :style="view.contentStyle">
   <view v-if="view.layout===0" class="combination-top"><view v-if="view.showName" class="combination-product-title" :style="view.nameStyle">{{product.title}}</view><view v-if="view.showTag" :style="view.tagRowStyle"><view class="combination-tag" :style="view.tagStyle"><text :style="view.peopleStyle">{{product.people}}人团</text><text :style="view.countStyle">已拼{{product.count}}份</text></view></view></view>
   <view v-else-if="view.showName" class="combination-product-title" :style="view.nameStyle">{{product.title}}</view>
   <view v-if="view.layout<=1" class="combination-price-row" :style="view.priceRowStyle"><view class="combination-price-column"><DiyCombinationMoney v-if="view.showPrice" :price="product.price" :view="view" /><text v-if="view.showOldPrice" class="combination-old-price" :style="view.oldPriceStyle">¥{{product.oldPrice}}</text></view><view v-if="view.showButton" class="combination-join-button" :style="view.buttonStyle">去拼团</view></view>
   <template v-else><view v-if="view.layout===2" :style="view.priceRowStyle"><DiyCombinationMoney v-if="view.showPrice" :price="product.price" :view="view" /></view><DiyCombinationMoney v-else-if="view.showPrice" :price="product.price" :view="view" /><view v-if="view.showOldPrice" class="combination-old-price" :style="view.oldPriceStyle">¥{{product.oldPrice}}</view></template>
  </view>
 </view>
</template>
<script setup lang="ts">
import type { DiyCombinationPresentation, DiyCombinationRow } from '../../../../common/diyCombination';
import DiyCombinationMoney from './DiyCombinationMoney.vue';
defineProps<{product:DiyCombinationRow;view:DiyCombinationPresentation;tap:()=>void}>();
</script>
<style scoped>
.combination-price-column{display:flex;flex-direction:column}.combination-empty-image{display:flex;align-items:center;justify-content:center;color:#999;background:#f5f5f5;font-size:22rpx}
</style>
