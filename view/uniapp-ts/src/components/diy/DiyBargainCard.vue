<template>
 <view class="bargain-card" :data-bargain-id="product.id" :data-bargain-layout="view.layout" :style="view.cardStyle" @tap="tap">
  <image v-if="product.image" class="bargain-product-image" :src="product.image" :style="view.imageStyle" mode="aspectFill" /><view v-else class="bargain-product-image bargain-empty-image" :style="view.imageStyle">暂无图片</view>
  <view class="bargain-product-content" :style="view.contentStyle">
   <view v-if="view.showName" class="bargain-product-title" :style="view.nameStyle">{{product.title}}</view>
   <view v-if="view.layout===0 && view.showTag" class="bargain-participants" :style="view.participantsStyle"><text class="bargain-fire" :style="view.fireStyle">&#xe69d;</text><text :style="view.participantTextStyle">{{product.people}}人正在参与</text></view>
   <text v-if="view.layout===3 && view.showName" class="bargain-success" :style="view.successStyle">{{product.people}}人已砍成功</text>
   <view v-if="view.layout<=1" class="bargain-price-row" :style="view.priceRowStyle"><view class="bargain-price-column"><DiyBargainMoney v-if="view.showPrice" :price="product.price" :view="view" /><text v-if="view.showOldPrice" class="bargain-old-price" :style="view.oldPriceStyle">¥{{product.oldPrice}}</text></view><view v-if="view.showButton" class="bargain-join-button" :style="view.buttonStyle">参与砍价</view></view>
   <template v-else><view :style="view.layout===2?view.priceRowStyle:{}"><DiyBargainMoney v-if="view.showPrice" :price="product.price" :view="view" /></view><view v-if="view.showOldPrice" class="bargain-old-price" :style="view.oldPriceStyle">¥{{product.oldPrice}}</view></template>
  </view>
 </view>
</template>
<script setup lang="ts">
import type { DiyBargainPresentation, DiyBargainRow } from '../../../../common/diyBargain';
import DiyBargainMoney from './DiyBargainMoney.vue';
defineProps<{product:DiyBargainRow;view:DiyBargainPresentation;tap:()=>void}>();
</script>
<style src="../../../../common/diyBargainFire.css"></style>
<style scoped>
.bargain-price-column{display:flex;flex-direction:column}.bargain-empty-image{display:flex;align-items:center;justify-content:center;color:#999;background:#f5f5f5;font-size:22rpx}
</style>
