<template>
 <view v-if="active && config.enabled" class="diy-seckill-widget" :data-seckill-layout="config.layout" :data-seckill-style="config.style" :style="config.wrapperStyle">
  <view v-if="ready()" class="seckill-panel" :style="config.panelStyle">
   <view class="seckill-header" :style="[config.headerStyle,imageFailures.imgBgConfig?{backgroundImage:'none'}:{}]">
    <template v-for="background in [images.imgBgConfig]" :key="background.key"><image v-if="config.style && background.src && !imageFailures.imgBgConfig" :key="background.key" class="seckill-background-probe" :src="background.src" @load="background.loaded" @error="background.failed" /></template>
    <view class="seckill-heading-group"><text v-if="config.textTitle" class="seckill-heading" :style="config.titleStyle">{{config.title}}</text><template v-else><template v-for="titleImage in [images[config.style?'imgConfig':'imgColorConfig']]" :key="titleImage.key"><image v-if="titleImage.src && !imageFailures[config.style?'imgConfig':'imgColorConfig']" :key="titleImage.key" class="seckill-title-image" :src="titleImage.src" :style="config.titleImageStyle" @load="titleImage.loaded" @error="titleImage.failed" /></template></template><text class="seckill-tip" :style="config.tipStyle">{{config.tip}}</text><view class="seckill-countdown" :style="config.countdownStyle"><template v-for="(part,index) in state.countdown.value" :key="index"><text v-if="index" class="seckill-countdown-dot" :style="config.dotStyle">:</text><text class="seckill-countdown-digit" :style="config.digitStyle">{{part}}</text></template></view></view>
    <template v-for="action in [actions]" :key="action.key"><button class="seckill-more" :style="config.moreStyle" :disabled="state.loading.value || !state.loaded.value || !!state.error.value" @tap="action.more">{{config.moreText}}<text style="font-size:24rpx"> ›</text></button></template>
   </view>
   <view v-if="state.loading.value" class="seckill-status" role="status">正在读取秒杀商品…</view><view v-else-if="state.error.value" class="seckill-error" role="alert">{{state.error.value}}</view>
   <template v-else-if="state.loaded.value"><view class="seckill-body" :style="config.bodyStyle"><scroll-view v-if="config.layout===3" scroll-x :show-scrollbar="false" class="seckill-scroll"><view class="seckill-list" :style="config.listStyle"><DiySeckillCard v-for="entry in entries" :key="entry.media.base.key" :product="entry.product" :view="config" :tap="entry.tap" :media="entry.media" /></view></scroll-view><view v-else class="seckill-list" :style="config.listStyle"><DiySeckillCard v-for="entry in entries" :key="entry.media.base.key" :product="entry.product" :view="config" :tap="entry.tap" :media="entry.media" /></view><view v-if="!entries.length" class="seckill-status">暂无可展示的秒杀商品</view></view><view v-if="config.limitNotice" class="seckill-status">{{config.limitNotice}}</view></template>
   <template v-for="action in [actions]" :key="action.key"><button class="seckill-refresh" :disabled="state.loading.value" @tap="action.refresh">{{state.error.value?'重试秒杀商品':'刷新秒杀商品'}}</button></template>
  </view><view v-else class="seckill-status" role="status">秒杀图片授权已失效，请刷新页面</view>
 </view>
</template>
<script setup lang="ts">
import type { DiyComponent } from '@/api/diy';
import { useDiySeckill } from '@/composables/useDiySeckill';
import DiySeckillCard from './DiySeckillCard.vue';
const props=withDefaults(defineProps<{block:DiyComponent;active?:boolean}>(),{active:true});
const {config,state,images,entries,actions,imageFailures,ready}=useDiySeckill(()=>props.block,()=>props.active);
</script>
<style scoped>
.diy-seckill-widget,.seckill-panel,.seckill-body,.seckill-list{min-width:0;box-sizing:border-box}.seckill-header{position:relative}.seckill-heading-group{display:flex;align-items:center;min-width:0}.seckill-more::after{border:0}.seckill-background-probe{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.seckill-status,.seckill-error{font-size:24rpx;padding:20rpx;overflow-wrap:anywhere}.seckill-error{color:#a33}.seckill-refresh{font-size:23rpx;line-height:2.2;margin:12rpx 20rpx}.seckill-scroll{width:100%;white-space:nowrap;vertical-align:middle}
</style>
