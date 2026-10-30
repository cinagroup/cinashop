<template>
  <section class="live-broadcast-preview" aria-label="直播只读预览">
    <p class="hint">直播样式只读预览；客户端仅微信小程序显示，此处不启动播放器或提交直播资料。</p>
    <div :style="px(view.wrapperStyle)"><div :style="px(view.panelStyle)">
      <p v-if="loading" role="status">正在读取直播目录…</p><p v-else-if="error" role="alert">{{error}}</p><p v-else-if="!loaded" class="hint">请显式读取当前公开直播目录</p>
      <div v-else :style="px(view.bodyStyle)"><div :class="{'live-broadcast-scroll':view.layout===2}" :style="px(view.listStyle)">
        <DiyLiveBroadcastPreviewCard v-for="entry in entries" :key="entry.room.id" :room="entry.room" :index="entry.index" :view="view" />
      </div><p v-if="!rooms.length" class="hint">暂无直播间</p><p v-if="view.limitNotice" class="hint">{{view.limitNotice}}</p></div>
    </div></div>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import DiyLiveBroadcastPreviewCard from './DiyLiveBroadcastPreviewCard.vue';
import { liveBroadcastPresentation } from '../../../../common/diyLiveBroadcast';
import { listSafeColor } from '@/utils/diyListProjection';
import { liveBroadcastPreviewStyle as px } from '@/utils/diyLiveBroadcastProjection';
import type { LiveBroadcastRoomPreview } from '@/api/diyLiveBroadcastAuthor';
const props=defineProps<{block:Record<string,unknown>;rooms:LiveBroadcastRoomPreview[];loading:boolean;loaded:boolean;error:string}>();
const view=computed(()=>liveBroadcastPresentation(props.block,listSafeColor));
const entries=computed(()=>props.rooms.map((room,index)=>({room,index})));
</script>
<style src="../../../../common/diyLiveBroadcastIcon.css"></style>
<style scoped>
.live-broadcast-preview{container-type:inline-size;width:min(375px,100%);min-width:0;box-sizing:border-box;line-height:normal}.live-broadcast-preview-card{box-sizing:border-box}.live-broadcast-scroll{width:100%;white-space:nowrap;overflow:auto}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary);overflow-wrap:anywhere}.empty-image{display:flex!important;align-items:center;justify-content:center;color:#999;background:#F3F9FF;font-size:3.2cqw}.live-video-icon{font-family:DIYBargainFire!important;font-style:normal;font-weight:normal}img{object-fit:cover}
</style>
