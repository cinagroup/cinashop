<template>
  <view class="community-featured-viewer" :data-active-post-id="viewer.active.value?.id || 0">
    <view class="featured-heading">精选 · 图文与视频</view>
    <view v-if="viewer.active.value" class="featured-current-title">{{ viewer.active.value.title || '分享' }}</view>
    <button v-if="!viewer.requestedId.value && posts.length" class="featured-start" @tap="viewer.activate(0)">查看精选第一条</button>
    <view v-if="viewer.loading.value" class="featured-state">正在打开精选内容…</view>
    <view v-if="viewer.error.value" class="featured-error" role="alert">{{ viewer.error.value }}</view>
    <button v-if="viewer.requestedId.value" class="featured-state-refresh" :disabled="viewer.loading.value" @tap="viewer.refreshState">核对精选状态</button>
    <view v-if="viewer.detached.value" class="featured-restored" role="status">已只读恢复此前精选；当前列表从第一页重新加载，未重复记录浏览。</view>
    <swiper v-if="viewer.items.value.length" class="featured-swiper" vertical :current="Math.max(0, viewer.index.value)" :autoplay="false" :circular="false" @change="swipe">
      <swiper-item v-for="post in viewer.items.value" :key="post.id">
        <view class="featured-item">
          <template v-if="viewer.active.value?.id === post.id && !viewer.error.value">
            <video v-if="viewer.active.value.contentType === 2 && source(viewer.active.value.videoUrl || viewer.active.value.video_url)"
              :key="post.id" class="featured-media" :src="source(viewer.active.value.videoUrl || viewer.active.value.video_url)"
              :poster="source(viewer.active.value.image)" controls :autoplay="false" />
            <view v-else-if="viewer.active.value.contentType === 2" class="featured-state">视频暂时无法播放，请核对状态</view>
            <swiper v-else-if="images(viewer.active.value).length" class="featured-media" :autoplay="false" :indicator-dots="true">
              <swiper-item v-for="image in images(viewer.active.value)" :key="image"><image class="featured-media" :src="image" mode="aspectFit" /></swiper-item>
            </swiper>
            <view class="featured-title">{{ viewer.active.value.title || '分享' }}</view>
            <view class="featured-content">{{ viewer.active.value.content }}</view>
          </template>
          <template v-else>
            <image v-if="source(post.image)" class="featured-media" :src="source(post.image)" mode="aspectFit" />
            <view class="featured-title">{{ post.title || '分享' }}</view>
          </template>
        </view>
      </swiper-item>
    </swiper>
    <view class="featured-controls">
      <button class="featured-previous" :disabled="viewer.loading.value || viewer.index.value <= 0" @tap="viewer.step(-1)">上一条精选</button>
      <text>{{ viewer.detached.value ? '恢复的精选' : `${viewer.index.value >= 0 ? viewer.index.value + 1 : 0} / ${posts.length}` }}</text>
      <button class="featured-next" :disabled="viewer.loading.value || !posts.length || viewer.index.value >= posts.length - 1 && !canMore" @tap="viewer.step(1)">{{ viewer.detached.value ? '查看当前列表第一条' : '下一条精选' }}</button>
    </view>
    <template v-if="viewer.active.value && !viewer.error.value">
      <CommunityPostActions :post="engagement.view(viewer.active.value)" :busy="engagement.busy.value" :unknown="engagement.unknown(viewer.active.value.id)"
        :refreshing="engagement.reconciling.value === viewer.active.value.id" :notice="engagement.notices.value[viewer.active.value.id]" :error="engagement.errors.value[viewer.active.value.id]"
        @like="engagement.toggleLike(viewer.active.value)" @share="engagement.openShare(viewer.active.value)" @refresh="engagement.reconcile(viewer.active.value.id)" />
      <button class="featured-comments" @tap="viewer.openComments">查看精选评论</button>
    </template>
    <CommunityComments :post-id="viewer.commentsOpen.value && viewer.active.value && !viewer.error.value ? viewer.active.value.id : 0"
      :total="viewer.active.value?.commentNum ?? 0" :writable="true" @count="viewer.updateCount" />
  </view>
</template>
<script setup lang="ts">
import CommunityPostActions from './CommunityPostActions.vue';
import CommunityComments from './CommunityComments.vue';
import { communityVideoSource as source } from '@/utils/communityMedia';
import type { CommunityPost } from '@/api/community';
import type { useCommunityFeatured } from '@/composables/useCommunityFeatured';
import type { useCommunityEngagement } from '@/composables/useCommunityEngagement';
const props = defineProps<{ posts: CommunityPost[]; canMore: boolean; viewer: ReturnType<typeof useCommunityFeatured>; engagement: ReturnType<typeof useCommunityEngagement> }>();
const images = (post: CommunityPost) => (post.sliderImage?.length ? post.sliderImage : post.image ? [post.image] : []).map(source).filter(Boolean);
function swipe(event: { detail: { current: number; source?: string } }) {
  // Programmatic current changes and appended swiper items are not user visits.
  if (!props.viewer.detached.value && event.detail.source === 'touch') void props.viewer.activate(event.detail.current);
}
</script>
<style scoped>
.community-featured-viewer { background: #222; color: #fff; padding: 24rpx; border-radius: 18rpx; overflow-wrap: anywhere; }
.featured-heading { font-size: 30rpx; margin-bottom: 18rpx; }
.featured-swiper { height: 690rpx; }
.featured-item { height: 100%; overflow-y: auto; }
.featured-media { display: block; width: 100%; height: 480rpx; background: #151515; }
.featured-title { font-size: 30rpx; margin: 16rpx 0; }
.featured-content { font-size: 25rpx; white-space: pre-wrap; }
.featured-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; margin-top: 16rpx; gap: 8rpx; }
.featured-controls button, .community-featured-viewer > button { font-size: 24rpx; }
.featured-state, .featured-error { padding: 18rpx 0; font-size: 24rpx; }
.featured-error { color: #ffd2c8; }
</style>
