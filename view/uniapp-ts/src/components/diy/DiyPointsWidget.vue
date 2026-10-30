<template>
  <view v-if="active && config.enabled" class="diy-points-widget" :data-points-layout="config.layout" :data-points-style="config.style" :style="config.wrapperStyle">
    <view v-if="ready()" class="points-panel" :style="config.panelStyle">
      <view class="points-header" :style="[config.headerStyle,imageFailures.imgBgConfig?{backgroundImage:'none'}:{}]">
        <image v-if="config.style && images.imgBgConfig.src && !imageFailures.imgBgConfig" :key="images.imgBgConfig.key" class="points-background-probe" :src="images.imgBgConfig.src" @load="images.imgBgConfig.loaded" @error="images.imgBgConfig.failed" />
        <text v-if="config.textTitle" class="points-heading" :style="config.titleStyle">{{config.title}}</text>
        <image v-else-if="config.titleImage && !imageFailures[config.style?'imgConfig':'imgConfig2']" :key="images[config.style?'imgConfig':'imgConfig2'].key" class="points-title-image" :src="images[config.style?'imgConfig':'imgConfig2'].src" :style="config.titleImageStyle" mode="aspectFit" @load="images[config.style?'imgConfig':'imgConfig2'].loaded" @error="images[config.style?'imgConfig':'imgConfig2'].failed" />
        <button class="points-more" :style="config.moreStyle" :disabled="state.loading.value || !state.loaded.value || !!state.error.value" @tap="actions.more">更多<text style="font-size:24rpx"> ›</text></button>
      </view>
      <view v-if="state.loading.value" class="points-status" role="status">正在读取积分商品…</view><view v-else-if="state.error.value" class="points-error" role="alert">{{state.error.value}}</view>
      <template v-else-if="state.loaded.value"><view class="points-body" :style="config.bodyStyle">
        <scroll-view v-if="config.layout===0" scroll-x :show-scrollbar="false" class="points-scroll" :style="config.scrollStyle"><view class="points-list" :style="config.listStyle"><DiyPointsCard v-for="entry in entries" :key="entry.product.id" :product="entry.product" :view="config" :tap="entry.tap" /></view></scroll-view>
        <view v-else class="points-list" :style="config.listStyle"><DiyPointsCard v-for="entry in entries" :key="entry.product.id" :product="entry.product" :view="config" :tap="entry.tap" /></view>
        <view v-if="!entries.length" class="points-status">暂无可展示的积分商品</view>
      </view><view v-if="config.limitNotice" class="points-status">{{config.limitNotice}}</view></template>
      <button class="points-refresh" :disabled="state.loading.value" @tap="actions.refresh">{{state.error.value?'重试积分商品':'刷新积分商品'}}</button>
    </view><view v-else class="points-status" role="status">积分商城图片授权已失效，请刷新页面</view>
  </view>
</template>
<script setup lang="ts">
import type { DiyComponent } from '@/api/diy';
import { useDiyPoints } from '@/composables/useDiyPoints';
import DiyPointsCard from './DiyPointsCard.vue';
const props=withDefaults(defineProps<{block:DiyComponent;active?:boolean}>(),{active:true});
const {config,state,images,entries,actions,imageFailures,ready}=useDiyPoints(()=>props.block,()=>props.active);
</script>
<style scoped>
.diy-points-widget,.points-panel,.points-body,.points-list{min-width:0;box-sizing:border-box}.points-header{position:relative}.points-more{font-size:24rpx}.points-more::after{border:0}.points-background-probe{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.points-status,.points-error{font-size:24rpx;padding:20rpx;overflow-wrap:anywhere}.points-error{color:#a33}.points-refresh{font-size:23rpx;line-height:2.2;margin:12rpx 20rpx}
</style>
