<template>
 <view v-if="active && config.enabled" class="diy-combination-widget" :data-combination-layout="config.layout" :data-combination-style="config.style" :style="config.wrapperStyle">
  <view v-if="ready()" class="combination-panel" :style="config.panelStyle">
   <view class="combination-header" :style="[config.headerStyle,imageFailures.imgBgConfig?{backgroundImage:'none'}:{}]">
    <image v-if="config.style && images.imgBgConfig.src && !imageFailures.imgBgConfig" :key="images.imgBgConfig.key" class="combination-background-probe" :src="images.imgBgConfig.src" @load="images.imgBgConfig.loaded" @error="images.imgBgConfig.failed" />
    <view class="combination-heading-group"><text v-if="config.textTitle" class="combination-heading" :style="config.titleStyle">{{config.title}}</text><image v-else-if="config.titleImage && !imageFailures[config.style?'imgConfig':'imgColorConfig']" :key="images[config.style?'imgConfig':'imgColorConfig'].key" class="combination-title-image" :src="images[config.style?'imgConfig':'imgColorConfig'].src" :style="config.titleImageStyle" @load="images[config.style?'imgConfig':'imgColorConfig'].loaded" @error="images[config.style?'imgConfig':'imgColorConfig'].failed" /><text class="combination-divider" :style="config.dividerStyle">|</text><view v-if="state.pink.value" class="combination-avatars"><image v-for="(avatar,index) in state.pink.value.avatars" :key="index" :src="avatar" :style="config.avatarStyle" /></view><text v-if="state.pink.value" class="combination-tip" :style="config.tipStyle">{{state.pink.value.pink_count}}人拼团成功</text></view>
    <button class="combination-more" :style="config.moreStyle" :disabled="state.loading.value || !state.loaded.value || !!state.error.value" @tap="actions.more">{{config.moreText}}<text style="font-size:24rpx"> ›</text></button>
   </view>
   <view v-if="state.loading.value" class="combination-status" role="status">正在读取拼团商品…</view><view v-else-if="state.error.value" class="combination-error" role="alert">{{state.error.value}}</view>
   <template v-else-if="state.loaded.value"><view class="combination-body" :style="config.bodyStyle"><scroll-view v-if="config.layout===3" scroll-x :show-scrollbar="false" class="combination-scroll"><view class="combination-list" :style="config.listStyle"><DiyCombinationCard v-for="entry in entries" :key="entry.product.id" :product="entry.product" :view="config" :tap="entry.tap" /></view></scroll-view><view v-else class="combination-list" :style="config.listStyle"><DiyCombinationCard v-for="entry in entries" :key="entry.product.id" :product="entry.product" :view="config" :tap="entry.tap" /></view><view v-if="!entries.length" class="combination-status">暂无可展示的拼团商品</view></view><view v-if="config.limitNotice" class="combination-status">{{config.limitNotice}}</view></template>
   <button class="combination-refresh" :disabled="state.loading.value" @tap="actions.refresh">{{state.error.value?'重试拼团商品':'刷新拼团商品'}}</button>
  </view><view v-else class="combination-status" role="status">拼团图片授权已失效，请刷新页面</view>
 </view>
</template>
<script setup lang="ts">
import type { DiyComponent } from '@/api/diy';
import { useDiyCombination } from '@/composables/useDiyCombination';
import DiyCombinationCard from './DiyCombinationCard.vue';
const props=withDefaults(defineProps<{block:DiyComponent;active?:boolean}>(),{active:true});
const {config,state,images,entries,actions,imageFailures,ready}=useDiyCombination(()=>props.block,()=>props.active);
</script>
<style scoped>
.diy-combination-widget,.combination-panel,.combination-body,.combination-list{min-width:0;box-sizing:border-box}.combination-header{position:relative}.combination-avatars{display:flex;align-items:center}.combination-heading-group{display:flex;align-items:center;min-width:0}.combination-more::after{border:0}.combination-background-probe{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.combination-status,.combination-error{font-size:24rpx;padding:20rpx;overflow-wrap:anywhere}.combination-error{color:#a33}.combination-refresh{font-size:23rpx;line-height:2.2;margin:12rpx 20rpx}.combination-scroll{width:100%;white-space:nowrap;vertical-align:middle}
</style>
