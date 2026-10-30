<template>
  <view v-if="active && state.config.value.enabled" class="diy-promotion-widget" :data-component-key="state.config.value.key" :data-style="state.config.value.style">
    <template v-if="state.ready()">
      <view class="promotion-nav" :class="{sticky:state.config.value.sticky}" :style="[state.config.value.wrapperStyle, {top:state.config.value.sticky?`calc(var(--window-top, 0px) + ${headerTop}px)`:'0px'}]">
        <scroll-view scroll-x :show-scrollbar="false" class="promotion-tabs">
          <button v-for="tab in state.tabs.value" :key="tab.key" class="promotion-tab" :data-tab="tab.index" :class="{active:tab.index===state.selectedTab.value}" :style="tab.styles.itemStyle" @tap="tab.tap">
            <view v-if="state.config.value.style===4" class="promotion-image-wrap" :style="tab.styles.imageWrapStyle"><image v-if="tab.image && !state.imageFailures.value[tab.index]" :src="tab.image" :style="tab.styles.imageStyle" mode="aspectFill" @load="tab.loaded" @error="tab.failed" /></view>
            <text class="promotion-text" :style="tab.styles.textStyle">{{tab.label}}</text>
            <view v-if="state.config.value.style===1 || state.config.value.style===2" class="promotion-line" :style="tab.styles.lineStyle" />
            <text v-if="state.config.value.style===0 && tab.description" class="promotion-description" :style="tab.styles.descriptionStyle">{{tab.description}}</text>
          </button>
        </scroll-view>
      </view>
      <DiyListWidget v-if="state.productBlock.value" :key="`${state.epoch.value}:${state.selectedTab.value}`" :block="state.productBlock.value" :active="state.ready()" />
      <view v-else class="promotion-status">暂无可展示的商品分组</view>
    </template>
    <view v-else class="promotion-status" role="status">选项卡图片授权已失效，请刷新页面</view>
  </view>
</template>
<script setup lang="ts">
import type { DiyComponent } from '@/api/diy';
import { useDiyPromotion } from '@/composables/useDiyPromotion';
import DiyListWidget from './DiyListWidget.vue';
const props = withDefaults(defineProps<{block:DiyComponent;active?:boolean;headerTop?:number}>(),{active:true,headerTop:0});
const state = useDiyPromotion(() => props.block, () => props.active);
</script>
<style scoped>
.diy-promotion-widget{width:100%;min-width:0;box-sizing:border-box}.promotion-nav{box-sizing:border-box;min-width:0;position:relative;z-index:2}.promotion-nav.sticky{position:sticky}.promotion-tabs{white-space:nowrap}.promotion-tab::after{border:0}.promotion-status{font-size:24rpx;padding:20rpx;overflow-wrap:anywhere}
</style>
