<template>
  <section aria-label="内容组件实际字段预览" class="preview-shell">
    <p class="hint">375 像素预览；链接在用户端执行。播报此处显示首条，发布后按配置滚动。</p>
    <div class="editorial-preview" :data-kind="p.kind" :style="px(p.outerStyle)">
      <p v-if="hidden" class="hint">发布时隐藏此组件</p>
      <template v-if="p.kind==='news'">
        <div class="news" :style="px(p.cardStyle)">
          <div v-if="p.newsListStyle" class="heading"><img v-if="p.titleImage" :src="p.titleImage" alt="公告标题" /><strong v-else :style="px(p.titleStyle)">{{p.titleText}}</strong><span v-if="p.showMore" :style="px(p.buttonStyle)">{{p.moreText}} ›</span></div>
          <template v-if="p.newsListStyle"><p v-for="(item,index) in p.newsItems" :key="index" class="line" :style="px(p.newsTextStyle)">{{item.title}}</p></template>
          <div v-else class="ticker"><img v-if="p.titleImage" :src="p.titleImage" alt="公告标题" /><strong v-else class="ticker-title" :style="px(p.tickerTitleStyle)">{{p.titleText}}</strong><span class="ticker-text" :style="px(p.newsTextStyle)">{{p.newsItems[0]?.title||'暂无显示的公告'}}</span><span v-if="p.showMore" :style="px(p.buttonStyle)">›</span></div>
        </div>
      </template>
      <template v-else-if="p.kind==='activeParty'"><div class="party" :style="px(p.partyStyle)"><div class="heading"><strong :style="px(p.partyTitleStyle)">{{p.partyTitle}}</strong><span class="badge" :style="px(p.partyBadgeStyle)">{{p.partyBadge}}</span></div><div class="cards"><article v-for="(item,index) in p.partyItems" :key="index"><div><strong>{{item.title}}</strong><p>{{item.description}}</p></div><img v-if="item.image" :src="item.image" alt="活动卡片" /></article></div></div></template>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { normalizeDiyEditorial } from '@/utils/diyEditorialProjection';
import { statePixelStyle as px } from '@/utils/diyStateEditor';
import { statePreviewTheme } from '@/utils/diyStateProjection';
import { navFlag } from '@/utils/diyNavigationEditor';
const props=defineProps<{block:Record<string,unknown>}>(),p=computed(()=>normalizeDiyEditorial(props.block,statePreviewTheme)),hidden=computed(()=>navFlag(props.block.isHide));
</script>
<style scoped>
.preview-shell{max-width:100%;margin-top:16px}.editorial-preview{box-sizing:border-box;width:375px;max-width:100%;overflow:hidden;font-size:14px;line-height:1.5}.news{padding:12px}.heading,.ticker{display:flex;align-items:center;gap:8px}.heading{justify-content:space-between}.heading>img,.ticker>img{width:28px;height:24px;object-fit:contain}.heading>strong{font-size:16px}.heading>span{font-size:12px}.ticker-title{font-size:11px;border-radius:4px;padding:4px 6px;flex-shrink:0;max-width:70px}.ticker-text{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.line{margin:12px 0 0;overflow-wrap:anywhere}.party{padding:12px}.badge{color:white;padding:2px 6px;border-radius:2px}.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}.cards article{display:flex;min-width:0;background:white;padding:10px;border-radius:8px;gap:4px}.cards article>div{min-width:0;flex:1}.cards strong{font-size:14px}.cards p{font-size:10px;color:#999;overflow-wrap:anywhere}.cards img{width:48px;height:48px;object-fit:cover}.hint{font-size:12px;color:#909399}
</style>
