<template>
  <section ref="root" class="community-preview" aria-label="社区只读预览">
    <p class="hint">客户端样式预览 · 仅显示读取到的公开帖子，链接与点赞仅展示</p>
    <p v-if="!config.enabled" class="hint">此社区组件已隐藏，配置仍保留。</p>
    <div v-else :style="px(config.wrapperStyle)">
      <div class="panel" :style="px(config.panelStyle)">
        <div class="heading" :style="px(config.headerStyle)"><span v-if="config.titleMode === 'text'" :style="px(config.titleStyle)">{{ config.title }}</span><img v-else-if="config.titleImage" class="title-image" :src="config.titleImage" alt="社区图片标题" /><button type="button" :style="px(config.buttonStyle)" disabled>{{ config.more }} ›</button></div>
        <div class="post-list" :class="config.layout" :style="px(config.listStyle)">
          <div v-for="(column, side) in columns" :key="side" class="post-column">
            <article v-for="post in column" :key="post.id" class="post-card" :data-post-id="post.id" :style="config.layout === 'horizontal' ? px(config.imageStyle) : undefined">
              <div class="picture"><img v-if="media(post.image || post.sliderImage?.[0])" :key="imageSession.key + ':' + post.id" class="cover" :src="media(post.image || post.sliderImage?.[0])" :style="px(config.imageStyle)" alt="公开社区帖子封面" @load="imageSession.measure" @error="imageSession.measure" /><div v-else class="placeholder">{{ post.contentType === 2 ? '视频' : '图文' }}</div><template v-if="config.layout === 'columns'"><span v-if="post.contentType === 2" class="video-badge">▶</span><span v-else class="count-badge">{{ post.sliderImage?.length || 0 }} 张</span></template></div>
              <div class="copy"><span v-if="post.title" class="post-title">{{ post.title }}</span><div class="byline"><img v-if="media(post.author_image)" class="avatar" :src="media(post.author_image)" alt="作者头像" /><span class="author">{{ post.author || (post.type === 0 ? '平台' : '社区内容') }}</span><span v-if="config.layout === 'columns'" class="likes" :class="{ liked: post.isLike === 1 }">{{ post.isLike ? '♥' : '♡' }} {{ post.likeNum }}</span></div></div>
            </article>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { normalizeDiyCommunityPreview } from '@/utils/diyCommunityProjection';
import { editorialPixels as px } from '@/utils/diyEditorialProjection';
import { safeDiyImageUrl } from '@/utils/diyStateProjection';
import { diyCommunityColumns } from '../../../../common/diyCommunityColumns';
import type { CommunityAuthorPost } from '@/api/diyCommunityAuthor';
const props = withDefaults(defineProps<{ block: unknown; rows?: CommunityAuthorPost[]; previews?: Record<string, string>; editorKey?: string }>(), { rows: () => [], previews: () => ({}), editorKey: '' });
const root = ref<HTMLElement | null>(null), heights = ref<Map<number, number>>(new Map()), epoch = ref(0);
const config = computed(() => normalizeDiyCommunityPreview(JSON.parse(JSON.stringify(props.block ?? null)), props.previews));
const identity = computed(() => JSON.stringify([props.block, props.rows, props.previews, props.editorKey]));
let alive = true;
const media = (value: unknown) => { const url = safeDiyImageUrl(value); return /[\s\\]/u.test(url) ? '' : url; };
const columns = computed(() => config.value.layout === 'columns' ? diyCommunityColumns(props.rows, heights.value) : [props.rows]);
watch(identity, () => { epoch.value++; heights.value = new Map(); void imageSession.value.measure(); }, { flush: 'post' });
const imageSession = computed(() => {
  const generation = epoch.value, key = identity.value;
  const current = () => alive && config.value.enabled && generation === epoch.value && key === identity.value;
  return { key: `${props.editorKey}:${generation}`, measure: async () => {
    if (!current() || config.value.layout !== 'columns') return;
    await nextTick(); if (!current() || !root.value || typeof root.value.querySelectorAll !== 'function') return;
    const next = new Map(heights.value); let changed = false;
    root.value.querySelectorAll<HTMLElement>('.post-card').forEach(card => {
      const id = Number(card.dataset.postId), height = card.getBoundingClientRect().height;
      if (props.rows.some(post => post.id === id) && Number.isFinite(height) && height > 0 && height <= 1_000_000 && next.get(id) !== height) { next.set(id, height); changed = true; }
    });
    if (current() && changed) heights.value = next;
  } };
});
onBeforeUnmount(() => { alive = false; epoch.value++; heights.value.clear(); });
</script>
<style scoped>
.community-preview{width:min(375px,100%);min-width:0;box-sizing:border-box;overflow-wrap:anywhere}.hint{font-size:12px;color:var(--el-text-color-secondary);line-height:1.6}.panel{overflow:hidden;background:white}.heading{height:48px;padding:0 12px;display:flex;align-items:center;justify-content:space-between;gap:8px;box-sizing:border-box}.title-image{width:67px;height:17px;object-fit:contain}.heading button{padding:0;background:transparent;border:0;opacity:1}.post-list{box-sizing:border-box;overflow:auto}.horizontal{padding:12px 0 12px 10px;display:flex}.horizontal>.post-column{display:contents}.columns{padding:10px;display:flex;align-items:flex-start;overflow:hidden}.columns>.post-column{width:calc((100% - 10px)/2);min-width:0}.post-card{min-width:0;box-sizing:border-box;overflow:hidden}.picture{position:relative;line-height:0}.cover{display:block;width:100%;object-fit:cover}.placeholder{height:120px;display:flex;align-items:center;justify-content:center;background:#f2f2f2;color:#888;font-size:12px}.horizontal .post-card{width:148px;flex:none;height:184.5px;position:relative}.horizontal .cover{height:184.5px}.horizontal .copy{position:absolute;inset:0;color:#fff;background:linear-gradient(180deg,transparent,rgba(0,0,0,.4));padding:0 8px 7px;display:flex;justify-content:flex-end;flex-direction:column}.horizontal .post-title{font-size:12px;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.byline{display:flex;align-items:center;gap:4px;min-width:0;line-height:1.5}.horizontal .byline{font-size:10px;padding-top:0}.avatar{width:17px;height:17px;border-radius:50%;flex:none;object-fit:cover}.horizontal .avatar{width:18px;height:18px}.author{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.columns .post-card{padding-bottom:10px}.columns .cover{height:auto}.columns .copy{padding:12px 0;border-radius:0 0 12px 12px}.columns .post-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:14px;line-height:20px}.columns .byline{padding-top:11px;font-size:11px;color:#666}.likes{white-space:nowrap}.liked{color:#e93323}.video-badge{position:absolute;right:10px;top:10px;width:20px;height:20px;border-radius:50%;border:1px solid white;color:white;background:#0005;display:grid;place-items:center;font-size:10px}.count-badge{position:absolute;right:8px;bottom:8px;background:#0005;color:white;font-size:10px;line-height:1.5;padding:0 4px;border-radius:4px}
</style>
