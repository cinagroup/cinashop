<template>
  <view v-if="active && state.ready()" class="diy-presentation" :data-kind="config?.kind" :style="config?.wrapperStyle">
    <view v-if="config?.kind==='titles'" class="presentation-title-panel" :style="config.panelStyle"><view class="presentation-title" :style="config.titleRowStyle" @tap="titleTap"><text class="presentation-heading" :style="config.titleStyle">{{config.title}}</text><text v-if="config.more" class="presentation-more" :style="config.moreStyle">{{config.right}} ›</text></view></view>
    <view v-else-if="config?.kind==='blankPage'" class="presentation-blank" :style="{...config.panelStyle,...config.blankStyle}" />
    <view v-else-if="config?.kind==='guide'" class="presentation-guide" :style="config.lineStyle" />
    <view v-else-if="config?.kind==='videos' && config.video" class="presentation-video-panel" :style="{borderRadius:config.panelStyle.borderRadius}"><DiyPresentationVideo :key="epoch" :src="config.video" :poster="config.poster" :ratio="config.ratio" :allowed="state.lease()" :start="positions[0]??0" @position="state.position(0,$event)" /></view>
    <view v-else-if="config?.kind==='richText' && config.richNodes.length" class="presentation-rich" :style="config.panelStyle">
      <DiyPresentationRichNode v-for="(node,index) in config.richNodes" :key="`${epoch}:${index}`" :node="node" :allowed="state.lease()" :positions="positions" @position="state.position($event.index,$event.value)" @link="state.open($event)" />
    </view>
  </view>
  <view v-else-if="active && expired" class="presentation-status" role="status">正在更新媒体链接…</view>
  <view v-else-if="active && state.config.value.error" class="presentation-status" role="alert">{{state.config.value.error}}</view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { DiyComponent } from '@/api/diy';
import { useDiyPresentation } from '@/composables/useDiyPresentation';
import DiyPresentationVideo from './DiyPresentationVideo.vue';
import DiyPresentationRichNode from './DiyPresentationRichNode.vue';
const props=withDefaults(defineProps<{block:DiyComponent;active?:boolean;refreshing?:boolean}>(),{active:true,refreshing:false});
const state=useDiyPresentation(()=>props.block,()=>props.active,()=>props.refreshing),{epoch,positions,expired}=state;
const config=computed(()=>state.config.value.value);
const titleTap=computed(()=>{const allowed=state.lease(),link=config.value?.link??'';return ()=>{if(allowed())state.open(link);};});

</script>
<style scoped>
.diy-presentation{box-sizing:border-box;min-width:0;max-width:100%;}.presentation-title-panel,.presentation-video-panel{overflow:hidden;min-width:0;}.presentation-title{display:flex;align-items:center;gap:12rpx;padding:26rpx 24rpx;line-height:44rpx;}.presentation-heading{min-width:0;overflow-wrap:anywhere;}.presentation-more{flex-shrink:0;font-weight:400;line-height:34rpx;}.presentation-blank{width:100%;}.presentation-guide{box-sizing:border-box;border-width:0;border-bottom-width:1rpx;}.presentation-rich{padding:30rpx;overflow-wrap:anywhere;overflow:hidden;box-sizing:border-box;max-width:100%;}.presentation-rich-link{display:inline-block;color:#007aff;}.presentation-status{padding:24rpx;color:#888;font-size:26rpx;}
</style>
