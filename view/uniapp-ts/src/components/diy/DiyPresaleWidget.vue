<template>
 <view v-if="active && config.enabled" class="diy-presale-widget" :data-presale-layout="config.layout" :data-presale-style="config.style" :style="config.wrapperStyle">
  <view v-if="ready()" class="presale-panel" :style="config.panelStyle">
   <view class="presale-header" :style="[config.headerStyle,imageFailures.imgBgConfig?{backgroundImage:'none'}:{}]">
    <image v-if="config.style && images.imgBgConfig.src && !imageFailures.imgBgConfig" :key="images.imgBgConfig.key" class="presale-background-probe" :src="images.imgBgConfig.src" @load="images.imgBgConfig.loaded" @error="images.imgBgConfig.failed" />
    <view class="presale-heading-group"><text v-if="config.textTitle" class="presale-heading" :style="config.titleStyle">{{config.title}}</text><image v-else-if="config.titleImage && !imageFailures[config.style?'imgConfig':'imgColorConfig']" :key="images[config.style?'imgConfig':'imgColorConfig'].key" class="presale-title-image" :src="images[config.style?'imgConfig':'imgColorConfig'].src" :style="config.titleImageStyle" @load="images[config.style?'imgConfig':'imgColorConfig'].loaded" @error="images[config.style?'imgConfig':'imgColorConfig'].failed" /><text class="presale-divider" :style="config.dividerStyle">|</text><text class="presale-tip" :style="config.tipStyle">{{config.tip}}</text></view>
    <button class="presale-more" :style="config.moreStyle" :disabled="state.loading.value || !state.loaded.value || !!state.error.value" @tap="actions.more">{{config.moreText}}<text style="font-size:24rpx"> ›</text></button>
   </view>
   <view v-if="state.loading.value" class="presale-status" role="status">正在读取预售商品…</view><view v-else-if="state.error.value" class="presale-error" role="alert">{{state.error.value}}</view>
   <template v-else-if="state.loaded.value"><view class="presale-body" :style="config.bodyStyle"><scroll-view v-if="config.layout===3" scroll-x :show-scrollbar="false" class="presale-scroll"><view class="presale-list" :style="config.listStyle"><DiyPresaleCard v-for="entry in entries" :key="entry.product.id" :product="entry.product" :view="config" :tap="entry.tap" /></view></scroll-view><view v-else class="presale-list" :style="config.listStyle"><DiyPresaleCard v-for="entry in entries" :key="entry.product.id" :product="entry.product" :view="config" :tap="entry.tap" /></view><view v-if="!entries.length" class="presale-status">暂无可展示的预售商品</view></view><view v-if="config.limitNotice" class="presale-status">{{config.limitNotice}}</view></template>
   <button class="presale-refresh" :disabled="state.loading.value" @tap="actions.refresh">{{state.error.value?'重试预售商品':'刷新预售商品'}}</button>
  </view><view v-else class="presale-status" role="status">预售图片授权已失效，请刷新页面</view>
 </view>
</template>
<script setup lang="ts">
import type { DiyComponent } from '@/api/diy';
import { useDiyPresale } from '@/composables/useDiyPresale';
import DiyPresaleCard from './DiyPresaleCard.vue';
const props=withDefaults(defineProps<{block:DiyComponent;active?:boolean}>(),{active:true});
const {config,state,images,entries,actions,imageFailures,ready}=useDiyPresale(()=>props.block,()=>props.active);
</script>
<style scoped>
.diy-presale-widget,.presale-panel,.presale-body,.presale-list{min-width:0;box-sizing:border-box}.presale-header{position:relative}.presale-heading-group{display:flex;align-items:center;min-width:0}.presale-more::after{border:0}.presale-background-probe{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.presale-status,.presale-error{font-size:24rpx;padding:20rpx;overflow-wrap:anywhere}.presale-error{color:#a33}.presale-refresh{font-size:23rpx;line-height:2.2;margin:12rpx 20rpx}.presale-scroll{width:100%;white-space:nowrap;vertical-align:middle}
</style>
