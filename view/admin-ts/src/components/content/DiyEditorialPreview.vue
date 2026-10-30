<template>
  <section class="editorial-preview" aria-label="公告与活动只读预览">
    <p class="hint">客户端内容预览 · 所有链接仅展示</p>
    <p v-if="!config.enabled" class="hint">此组件已隐藏，配置仍保留。</p>
    <div v-else :style="px(config.outerStyle)">
      <template v-if="config.kind === 'news'">
        <div v-if="config.newsListStyle" class="news-card" :style="px(config.cardStyle)"><div class="news-heading"><img v-if="config.titleImage" class="news-logo" :src="config.titleImage" alt="公告图片标题" /><strong v-else :style="config.titleStyle">{{ config.titleText }}</strong><button v-if="config.showMore" type="button" :style="config.buttonStyle" disabled>{{ config.moreText }} ›</button></div><div v-for="(item, index) in config.newsItems" :key="item.index" class="news-item" :style="config.newsTextStyle"><b :class="'rank-' + index">{{ index + 1 }}</b><span>{{ item.title }}</span></div></div>
        <div v-else class="news-ticker" :style="px(config.cardStyle)"><img v-if="config.titleImage" class="ticker-logo" :src="config.titleImage" alt="公告图片标题" /><strong v-else class="ticker-title" :style="config.tickerTitleStyle">{{ config.titleText }}</strong><span class="ticker-copy" :style="config.newsTextStyle">{{ config.newsItems[0]?.title || '暂无可显示公告' }}</span><button v-if="config.showMore" type="button" :style="config.buttonStyle" disabled>›</button></div>
        <p v-if="!config.newsListStyle" class="hint">{{ config.horizontalNews ? '左右滚动显示首条有效公告' : '上下轮播有效公告，间隔 2.5 秒' }}；后台保持静态预览。</p>
      </template>
      <div v-else-if="config.kind === 'activeParty'" class="party-card" :style="config.partyStyle"><div class="party-heading"><strong :style="config.partyTitleStyle">{{ config.partyTitle }}</strong><span v-if="config.partyBadge" class="badge" :style="config.partyBadgeStyle">{{ config.partyBadge }}</span></div><div class="party-grid"><article v-for="item in config.partyItems" :key="item.index"><div><strong>{{ item.title }}</strong><small>{{ item.description }}</small><span :style="config.partyTitleStyle">GO！</span></div><img v-if="item.image" :src="item.image" alt="活动卡片图片" /></article></div></div>
      <template v-else-if="config.kind === 'hotspot'"><div v-if="config.hotspotImage" class="hotspot-preview" :style="px(config.radiusStyle)"><img :key="hotspotImageSession.key" :src="config.hotspotImage" alt="只读热区底图" @load="hotspotImageSession.load" @error="hotspotImageSession.error" /><button v-for="area in hotspotAreas" :key="area.index" class="hotspot-area" type="button" :aria-label="`只读热区 ${area.index + 1}`" :style="area.style" disabled>{{ area.index + 1 }}</button></div><p class="hint">只读客户端样式与有效链接区域；链接不执行。{{ !config.hotspotImage ? '请先选择图片。' : '' }}</p></template>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { normalizeDiyEditorialPreview, editorialPixels as px } from '@/utils/diyEditorialProjection';
const props = withDefaults(defineProps<{ block: unknown; previews?: Record<string, string>; editorKey?: string }>(), { previews: () => ({}), editorKey: '' });
const config = computed(() => normalizeDiyEditorialPreview(props.block, props.previews));
const imageSize = ref<{ width: number; height: number } | null>(null), epoch = ref(0);
let alive = true;
watch(() => [config.value.hotspotImage, config.value.kind, config.value.enabled, props.editorKey], () => { epoch.value++; imageSize.value = null; }, { flush: 'sync' });
onBeforeUnmount(() => { alive = false; epoch.value++; imageSize.value = null; });
const hotspotImageSession = computed(() => {
  const generation = epoch.value, image = config.value.hotspotImage, owner = props.editorKey;
  const current = () => alive && config.value.enabled && config.value.kind === 'hotspot' && generation === epoch.value && image === config.value.hotspotImage && owner === props.editorKey;
  return { key: `${owner}:${generation}:${image}`, error: () => { if (current()) imageSize.value = null; }, load: (event: Event) => {
    if (!current()) return; const target = event.currentTarget as HTMLImageElement | null, width = target?.naturalWidth, height = target?.naturalHeight;
    imageSize.value = typeof width === 'number' && typeof height === 'number' && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
  } };
});
const hotspotAreas = computed(() => {
  if (!imageSize.value) return []; const height = 750 * imageSize.value.height / imageSize.value.width;
  return config.value.hotspotAreas.flatMap(area => area.left >= 750 || area.top >= height ? [] : [{ ...area, style: { left: `${area.left / 750 * 100}%`, top: `${area.top / height * 100}%`, width: `${Math.min(area.width, 750 - area.left) / 750 * 100}%`, height: `${Math.min(area.height, height - area.top) / height * 100}%` } }]);
});
</script>
<style scoped>
.editorial-preview{width:min(375px,100%);min-width:0;box-sizing:border-box;overflow-wrap:anywhere}.hint{font-size:12px;color:var(--el-text-color-secondary);line-height:1.6}.news-card{padding:14px 12px;overflow:hidden}.news-heading{display:flex;gap:8px;align-items:center;margin-bottom:12px}.news-heading>strong{flex:1;font-size:15.5px}.news-logo{width:70px;height:20px;object-fit:contain}.news-heading button,.news-ticker button{margin-left:auto;padding:0 0 0 8px;border:0;background:transparent;opacity:1}.news-item{display:flex;align-items:center;min-height:24px;font-size:13px}.news-item+.news-item{margin-top:6px}.news-item b{flex:none;width:19px;color:#999}.news-item .rank-0{color:#e93323}.news-item .rank-1{color:#ff7300}.news-item .rank-2{color:#ffc300}.news-item span,.ticker-copy{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.news-ticker{display:flex;align-items:center;height:44px;padding:0 10px;box-sizing:border-box;overflow:hidden}.ticker-logo{width:26px;height:26px;object-fit:contain;margin-right:8px;flex:none}.ticker-title{font-size:12px;padding:3px 6px;border-radius:4px;margin-right:8px;white-space:nowrap}.ticker-copy{flex:1;font-size:12.5px}.party-card{padding:13px;border-radius:10px}.party-heading{display:flex;gap:6px;align-items:flex-start;justify-content:space-between;margin-bottom:11px}.party-heading>strong{font-size:16px}.badge{max-width:50%;font-size:10px;color:#fff;padding:3.5px 7.5px;border-radius:11px}.party-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.party-grid article{display:flex;align-items:center;min-width:0;min-height:75px;padding:9px;box-sizing:border-box;overflow:hidden;border-radius:7px;background:#ffffffcc}.party-grid article>div{display:grid;min-width:0;flex:1;gap:4px;font-size:12px}.party-grid small{font-size:10px;color:#888}.party-grid img{width:54px;height:54px;object-fit:cover;flex:none;max-width:50%}
</style>
<style scoped>
.hotspot-preview{position:relative;width:100%;overflow:hidden;line-height:0}.hotspot-preview>img{display:block;width:100%;height:auto}.hotspot-area{position:absolute;padding:0;box-sizing:border-box;border:1px dashed #1677ff;background:#1677ff1a;font-size:12px;line-height:1;color:#1254a4;opacity:1}
</style>
