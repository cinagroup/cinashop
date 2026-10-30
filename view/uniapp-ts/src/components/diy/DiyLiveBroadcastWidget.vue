<template>
  <view v-if="miniProgram && active && config.enabled" class="diy-live-broadcast-widget" :data-live-layout="config.layout" :style="config.wrapperStyle">
    <view class="live-broadcast-panel" :style="config.panelStyle">
      <view v-if="loading" class="live-broadcast-status-message" role="status">正在读取直播目录…</view>
      <view v-else-if="error" class="live-broadcast-error" role="alert">{{error}}</view>
      <view v-else-if="loaded" class="live-broadcast-body" :style="config.bodyStyle">
        <scroll-view v-if="config.layout===2" scroll-x :show-scrollbar="false" class="live-broadcast-scroll"><view :style="config.listStyle"><DiyLiveBroadcastCard v-for="entry in entries" :key="entry.key" :room="entry.room" :index="entry.index" :view="config" :tap="entry.tap" :media="entry.media" /></view></scroll-view>
        <view v-else :style="config.listStyle"><DiyLiveBroadcastCard v-for="entry in entries" :key="entry.key" :room="entry.room" :index="entry.index" :view="config" :tap="entry.tap" :media="entry.media" /></view>
        <view v-if="!entries.length" class="live-broadcast-status-message">暂无直播间</view>
        <view v-if="config.limitNotice" class="live-broadcast-status-message">{{config.limitNotice}}</view>
      </view>
      <template v-for="action in [actions]" :key="action.key"><button class="live-broadcast-refresh" :disabled="loading" @tap="action.refresh">{{error?'重试直播目录':'刷新直播目录'}}</button></template>
    </view>
  </view>
</template>
<script setup lang="ts">
import type { DiyComponent } from '@/api/diy';
import { useDiyLiveBroadcast } from '@/composables/useDiyLiveBroadcast';
import DiyLiveBroadcastCard from './DiyLiveBroadcastCard.vue';
const props=withDefaults(defineProps<{block:DiyComponent;active?:boolean}>(),{active:true});
const {config,entries,loading,loaded,error,actions,miniProgram}=useDiyLiveBroadcast(()=>props.block,()=>props.active);
</script>
<style scoped>
.diy-live-broadcast-widget,.live-broadcast-panel,.live-broadcast-body{box-sizing:border-box;min-width:0}.live-broadcast-scroll{width:100%;white-space:nowrap}.live-broadcast-status-message,.live-broadcast-error{padding:20rpx;font-size:24rpx;line-height:1.6;overflow-wrap:anywhere}.live-broadcast-error{color:#a33}.live-broadcast-refresh{font-size:23rpx;line-height:2.2;margin:12rpx 20rpx}
</style>
