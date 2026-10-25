<template>
<section class="community-preview" aria-label="社区组件实际字段预览">
  <div v-if="config.enabled" class="community-widget" :data-layout="config.layout" :style="config.wrapperStyle">
    <div class="community-panel" :style="config.panelStyle">
      <div class="community-header" :style="config.headerStyle">
        <span v-if="config.titleMode==='text'" class="community-title" :style="config.titleStyle">{{config.title}}</span>
        <img v-else-if="config.titleImage" class="community-title-image" :src="config.titleImage" alt="社区标题" />
        <span class="community-more" :style="config.buttonStyle">{{config.more}} ›</span>
      </div>
      <p v-if="loading" class="community-state" role="status">正在读取社区内容…</p>
      <p v-else-if="error" class="community-state error" role="alert">{{error}}</p>
      <p v-else-if="data?.closed" class="community-state">社区暂未开放</p>
      <template v-else-if="loaded"><div v-if="rows.length" class="community-scroll">
        <div class="community-list" :class="config.layout" :style="config.listStyle">
          <div v-for="post in rows" :key="post.id" class="community-card" :data-post-id="post.id" :style="config.imageStyle">
            <div class="community-picture"><img v-if="post.image||post.sliderImage[0]" class="community-image" :src="post.image||post.sliderImage[0]" :style="config.imageStyle" :alt="post.title" /><div v-else class="community-placeholder">{{post.contentType===2?'视频':'图文'}}</div><span class="community-media-type">{{post.contentType===2?'▶ 视频':`${post.sliderImage.length||1} 张`}}</span></div>
            <div class="community-copy"><span class="community-post-title">{{post.title||'分享'}}</span><div class="community-byline"><img v-if="post.author_image" class="community-avatar" :src="post.author_image" alt="作者头像" /><span class="community-author">{{post.author}}</span><span class="community-likes">♡ {{post.likeNum}}</span></div></div>
          </div>
        </div>
      </div><p v-else class="community-state">暂无社区内容</p></template>
      <p v-else class="community-state">读取公开预览后显示社区内容。</p>
    </div>
  </div>
  <p v-else class="community-state">当前组件已隐藏。</p>
</section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { normalizeDiyCommunity } from '@/utils/diyCommunityProjection';
import { listPixelStyle } from '@/utils/diyListEditor';
import type { CommunityRecord } from '@/utils/diyCommunityEditor';
import type { CommunityPreview } from '@/api/diyCommunityAuthor';
const props=defineProps<{block:CommunityRecord;data:CommunityPreview|null;loading:boolean;loaded:boolean;error:string}>();
const config=computed(()=>{const cfg=normalizeDiyCommunity(props.block);for(const key of Object.keys(cfg)){const value=cfg[key as keyof typeof cfg];if(key.endsWith('Style')&&value&&typeof value==='object')(cfg as unknown as Record<string,unknown>)[key]=listPixelStyle(value as Record<string,string>);}return cfg;});
const rows=computed(()=>props.data?.rows??[]);
</script>
<style scoped>
.community-preview{width:375px;max-width:100%;min-width:0}
.community-widget{box-sizing:border-box;min-width:0;overflow-wrap:anywhere}
.community-panel{overflow:hidden;background:#fff}
.community-header{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:10px 12px}
.community-title{min-width:0}.community-title-image{width:67px;height:17px;object-fit:contain;flex-shrink:0}
.community-more{flex-shrink:0;padding:0 2px;line-height:1.8}
.community-scroll{overflow-x:auto}.community-list{box-sizing:border-box;padding:10px}
.community-list.horizontal{display:flex;width:max-content;min-width:100%}
.community-list.columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}
.community-card{min-width:0;overflow:hidden;background:#fff}
.horizontal .community-card{width:148px;flex-shrink:0;position:relative}
.community-picture{position:relative}.community-image{display:block;width:100%;height:184.5px;object-fit:cover;background:#f5f5f5}
.columns .community-image{height:auto}.community-placeholder{display:flex;align-items:center;justify-content:center;height:120px;background:#f2f2f2;color:#888}
.community-media-type{position:absolute;right:6px;bottom:6px;color:#fff;background:#555a;padding:2px 4px;font-size:11px;border-radius:3px}
.community-copy{padding:8px}.horizontal .community-copy{position:absolute;bottom:0;left:0;right:0;color:#fff;background:linear-gradient(transparent,#000b);padding-top:20px}
.community-post-title{display:block;font-size:13px;line-height:1.6}.horizontal .community-post-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.community-byline{display:flex;align-items:center;gap:4px;font-size:10.5px;padding-top:5px;min-width:0}
.community-avatar{width:17px;height:17px;border-radius:50%;object-fit:cover;flex-shrink:0}.community-author{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}.community-likes{white-space:nowrap}
.community-state{padding:12px;font-size:12.5px;margin:0}.error{color:#a32920}
</style>
