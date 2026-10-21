<template>
  <view class="community-post-actions" :data-post-id="post.id" @tap.stop>
    <view class="post-action-row">
      <button class="post-like" :class="{ liked: post.isLike === 1 }" :disabled="busy || unknown || !writable"
        @tap.stop="emit('like')">{{ post.isLike === 1 ? '取消点赞' : '点赞' }} {{ post.likeNum }}</button>
      <button class="post-share" :disabled="busy || !writable" @tap.stop="emit('share')">分享 {{ post.shareNum ?? post.share_num ?? 0 }}</button>
      <button class="post-state-refresh" :disabled="busy || refreshing" @tap.stop="emit('refresh')">{{ refreshing ? '核对中…' : '刷新互动状态' }}</button>
    </view>
    <view v-if="!writable" class="post-action-notice">本人预览内容不能点赞或分享</view>
    <view v-if="unknown" class="post-action-error" role="alert">互动结果未确认，请刷新互动状态核对，请勿重复提交。</view>
    <view v-if="error" class="post-action-error" role="alert">{{ error }}</view>
    <view v-if="notice" class="post-action-notice" role="status">{{ notice }}</view>
  </view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { communityPreviewMode, type CommunityPost } from '@/api/community';
const props = defineProps<{ post: CommunityPost; busy: boolean; unknown: boolean; refreshing: boolean; notice?: string; error?: string }>();
const emit = defineEmits<{ like: []; share: []; refresh: [] }>();
const writable = computed(() => props.post.status === 1 && (props.post.is_verify === 1 || communityPreviewMode));
</script>
<style scoped>
.community-post-actions { margin-top: 16rpx; font-size: 23rpx; overflow-wrap: anywhere; }
.post-action-row { display: flex; flex-wrap: wrap; gap: 10rpx; }
.post-action-row button { margin: 0; padding: 8rpx 16rpx; font-size: 23rpx; line-height: 1.5; border: 0; }
.post-action-row button::after { border: 0; }
.liked { color: var(--view-theme, #e93323); }
.post-action-notice { margin-top: 12rpx; color: #637367; line-height: 1.6; }
.post-action-error { margin-top: 12rpx; padding: 14rpx; border-radius: 10rpx; background: #fff2ee; color: #a32920; line-height: 1.6; }
</style>
