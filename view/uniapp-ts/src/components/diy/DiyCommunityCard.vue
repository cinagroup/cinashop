<template>
  <view class="diy-community-card" :class="layout" :data-post-id="post.id" :style="layout === 'horizontal' ? imageStyle : undefined" @tap="native.tap">
    <view class="diy-community-picture" :style="imageStyle">
      <image v-if="image && !imageFailed" class="diy-community-image" :src="native.image" :style="imageStyle"
        :mode="layout === 'columns' ? 'widthFix' : 'aspectFill'" @load="native.loaded" @error="native.failed" />
      <view v-else class="diy-community-placeholder">{{ post.contentType === 2 ? '视频' : '图文' }}</view>
      <template v-if="layout === 'columns'">
        <text v-if="post.contentType === 2" class="diy-community-player">▶</text>
        <text v-else class="diy-community-media-type">{{ post.sliderImage?.length || 0 }}张</text>
      </template>
    </view>
    <view class="diy-community-copy">
      <text v-if="post.title" class="diy-community-post-title">{{ post.title }}</text>
      <view class="diy-community-byline" @tap.stop="layout === 'horizontal' ? native.tap() : undefined">
        <image v-if="avatar && !avatarFailed" class="diy-community-avatar" :src="native.avatar" mode="aspectFill" @load="native.avatarLoaded" @error="native.avatarFailed" />
        <text class="diy-community-author">{{ post.author || (post.type === 0 ? '平台' : '社区内容') }}</text>
        <text v-if="layout === 'columns'" class="diy-community-likes" :class="{liked:post.isLike === 1}">{{ post.isLike === 1 ? '♥' : '♡' }} {{ post.likeNum }}</text>
      </view>
    </view>
  </view>
</template>
<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onScopeDispose, ref, watch } from 'vue';
import type { CommunityPost } from '@/api/community';
const props = defineProps<{ post: CommunityPost; layout: 'horizontal' | 'columns'; imageStyle: Record<string, string>; image: string; avatar: string; allowed: () => boolean }>();
const emit = defineEmits<{ open: [post: CommunityPost]; measured: [row: { id: number; height: number; current: () => boolean }] }>();
const instance = getCurrentInstance(), imageFailed = ref(false), avatarFailed = ref(false);
let alive = true, generation = 0;
async function measure(current: () => boolean, id: number) {
  if (!current() || props.layout !== 'columns' || !instance?.proxy || typeof uni.createSelectorQuery !== 'function') return;
  await nextTick(); if (!current()) return;
  uni.createSelectorQuery().in(instance.proxy).select('.diy-community-card').boundingClientRect(value => {
    const row = Array.isArray(value) ? value[0] : value;
    if (current() && row && typeof row.height === 'number' && Number.isFinite(row.height) && row.height > 0 && row.height <= 1_000_000) emit('measured', { id, height: row.height, current });
  }).exec();
}
const native = computed(() => {
  const allowed = props.allowed, post = props.post, id = post.id, kind = post.contentType, source = props.image, avatar = props.avatar, layout = props.layout, revision = generation;
  const current = () => alive && revision === generation && allowed() && props.allowed === allowed && props.post === post
    && props.post.id === id && props.post.contentType === kind && props.image === source && props.avatar === avatar && props.layout === layout;
  return { image: source, avatar, current,
    loaded: () => { if (current()) void measure(current, id); },
    failed: () => { if (current()) { imageFailed.value = true; void measure(current, id); } },
    avatarLoaded: () => { if (current()) void measure(current, id); },
    avatarFailed: () => { if (current()) { avatarFailed.value = true; void measure(current, id); } },
    tap: () => { if (current()) emit('open', post); },
  };
});
watch([() => props.post, () => props.image, () => props.avatar, () => props.layout, () => props.allowed], () => {
  generation++; imageFailed.value = false; avatarFailed.value = false;
  const issued = native.value; void measure(issued.current, props.post.id);
}, { immediate: true, flush: 'sync' });
onScopeDispose(() => { alive = false; generation++; });
</script>
<style scoped>
.diy-community-card{box-sizing:border-box;min-width:0;overflow:hidden;background:#fff;}.diy-community-card.horizontal{width:296rpx;flex-shrink:0;position:relative;}.diy-community-card.columns{padding-bottom:20rpx;}.diy-community-picture{position:relative;overflow:hidden;}.diy-community-image{display:block;width:100%;height:369rpx;background:#f5f5f5;}.columns .diy-community-image{height:auto;}.diy-community-placeholder{display:flex;align-items:center;justify-content:center;height:240rpx;background:#f2f2f2;color:#888;}.horizontal .diy-community-placeholder{height:369rpx;}.diy-community-media-type{position:absolute;right:16rpx;bottom:16rpx;color:#fff;background:#6668;padding:2rpx 8rpx;font-size:22rpx;border-radius:4rpx;}.diy-community-player{position:absolute;right:20rpx;top:20rpx;color:#fff;background:#3338;width:40rpx;height:40rpx;line-height:40rpx;text-align:center;font-size:20rpx;border-radius:50%;}.diy-community-copy{padding:24rpx 0;}.horizontal .diy-community-copy{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;color:#fff;background:linear-gradient(180deg,transparent,rgba(0,0,0,.4));padding:0 16rpx 14rpx;}.diy-community-post-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:28rpx;line-height:40rpx;}.horizontal .diy-community-post-title{display:block;font-size:24rpx;line-height:38rpx;white-space:nowrap;text-overflow:ellipsis;}.diy-community-byline{display:flex;align-items:center;gap:8rpx;font-size:22rpx;padding-top:22rpx;min-width:0;color:#999;}.horizontal .diy-community-byline{padding-top:0;font-size:20rpx;color:#fff;}.diy-community-avatar{width:34rpx;height:34rpx;border-radius:50%;flex-shrink:0;}.horizontal .diy-community-avatar{width:36rpx;height:36rpx;}.diy-community-author{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;}.diy-community-likes{white-space:nowrap;}.diy-community-likes.liked{color:#e93323;}
</style>
