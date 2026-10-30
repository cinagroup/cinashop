<template>
 <view v-if="active && config.enabled" class="diy-bargain-widget" :data-bargain-layout="config.layout" :data-bargain-style="config.style" :style="config.wrapperStyle">
  <view v-if="ready()" class="bargain-panel" :style="config.panelStyle">
   <view class="bargain-header" :style="[config.headerStyle,imageFailures.imgBgConfig?{backgroundImage:'none'}:{}]">
    <image v-if="config.style && images.imgBgConfig.src && !imageFailures.imgBgConfig" :key="images.imgBgConfig.key" class="bargain-background-probe" :src="images.imgBgConfig.src" @load="images.imgBgConfig.loaded" @error="images.imgBgConfig.failed" />
    <view class="bargain-heading-group"><text v-if="config.textTitle" class="bargain-heading" :style="config.titleStyle">{{config.title}}</text><image v-else-if="config.titleImage && !imageFailures[config.style?'imgConfig':'imgColorConfig']" :key="images[config.style?'imgConfig':'imgColorConfig'].key" class="bargain-title-image" :src="images[config.style?'imgConfig':'imgColorConfig'].src" :style="config.titleImageStyle" @load="images[config.style?'imgConfig':'imgColorConfig'].loaded" @error="images[config.style?'imgConfig':'imgColorConfig'].failed" /><text class="bargain-divider" :style="config.dividerStyle">|</text><text class="bargain-tip" :style="config.tipStyle">{{config.tip}}</text></view>
    <button class="bargain-more" :style="config.moreStyle" :disabled="state.loading.value || !state.loaded.value || !!state.error.value" @tap="actions.more">{{config.moreText}}<text style="font-size:24rpx"> ›</text></button>
   </view>
   <view v-if="state.loading.value" class="bargain-status" role="status">正在读取砍价商品…</view><view v-else-if="state.error.value" class="bargain-error" role="alert">{{state.error.value}}</view>
   <template v-else-if="state.loaded.value"><view class="bargain-body" :style="config.bodyStyle"><scroll-view v-if="config.layout===3" scroll-x :show-scrollbar="false" class="bargain-scroll"><view class="bargain-list" :style="config.listStyle"><DiyBargainCard v-for="entry in entries" :key="entry.product.id" :product="entry.product" :view="config" :tap="entry.tap" /></view></scroll-view><view v-else class="bargain-list" :style="config.listStyle"><DiyBargainCard v-for="entry in entries" :key="entry.product.id" :product="entry.product" :view="config" :tap="entry.tap" /></view><view v-if="!entries.length" class="bargain-status">暂无可展示的砍价商品</view></view><view v-if="config.limitNotice" class="bargain-status">{{config.limitNotice}}</view></template>
   <button class="bargain-refresh" :disabled="state.loading.value" @tap="actions.refresh">{{state.error.value?'重试砍价商品':'刷新砍价商品'}}</button>
  </view><view v-else class="bargain-status" role="status">砍价图片授权已失效，请刷新页面</view>
 </view>
</template>
<script setup lang="ts">
import type { DiyComponent } from '@/api/diy';
import { useDiyBargain } from '@/composables/useDiyBargain';
import DiyBargainCard from './DiyBargainCard.vue';
const props=withDefaults(defineProps<{block:DiyComponent;active?:boolean}>(),{active:true});
const {config,state,images,entries,actions,imageFailures,ready}=useDiyBargain(()=>props.block,()=>props.active);
</script>
<style scoped>
.diy-bargain-widget,.bargain-panel,.bargain-body,.bargain-list{min-width:0;box-sizing:border-box}.bargain-header{position:relative}.bargain-heading-group{display:flex;align-items:center;min-width:0}.bargain-more::after{border:0}.bargain-background-probe{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.bargain-status,.bargain-error{font-size:24rpx;padding:20rpx;overflow-wrap:anywhere}.bargain-error{color:#a33}.bargain-refresh{font-size:23rpx;line-height:2.2;margin:12rpx 20rpx}.bargain-scroll{width:100%;white-space:nowrap;vertical-align:middle}
</style>
