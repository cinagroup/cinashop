<template>
  <view v-if="controller.sharePost.value" class="community-share-mask" @tap="controller.closeShare">
    <view class="community-share-panel" @tap.stop>
      <view class="community-share-title">分享《{{ controller.sharePost.value.title || '社区帖子' }}》</view>
      <view v-if="controller.shareLoading.value">正在核对帖子…</view>
      <view v-if="controller.unknown(controller.sharePost.value.id)" class="share-warning">分享结果未确认，请先刷新互动状态核对，请勿重复分享。</view>
      <view v-if="controller.errors.value[controller.sharePost.value.id]" class="share-warning" role="alert">{{ controller.errors.value[controller.sharePost.value.id] }}</view>
      <view v-if="controller.notices.value[controller.sharePost.value.id]" class="share-notice" role="status">{{ controller.notices.value[controller.sharePost.value.id] }}</view>
      <!-- #ifdef H5 -->
      <button class="community-copy-share" :disabled="locked" @tap="controller.copyShare">复制帖子链接</button>
      <!-- #endif -->
      <!-- #ifdef MP-WEIXIN -->
      <button open-type="share" :data-post-id="controller.sharePost.value.id" :disabled="locked">分享给微信好友</button>
      <view class="share-notice">朋友圈请使用右上角菜单；分享材料已准备不代表对方已收到。</view>
      <!-- #endif -->
      <!-- #ifdef APP-PLUS -->
      <button :disabled="locked" @tap="controller.appShare('WXSceneSession')">分享给微信好友</button>
      <button :disabled="locked" @tap="controller.appShare('WXSceneTimeline')">分享到朋友圈</button>
      <!-- #endif -->
      <button :disabled="controller.busy.value || !!controller.reconciling.value" @tap="controller.reconcile(controller.sharePost.value.id)">刷新互动状态</button>
      <button class="community-share-close" @tap="controller.closeShare">关闭分享</button>
    </view>
  </view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { useCommunityEngagement } from '@/composables/useCommunityEngagement';
const props = defineProps<{ controller: ReturnType<typeof useCommunityEngagement> }>();
const locked = computed(() => props.controller.shareLoading.value || !props.controller.shareReady.value || props.controller.busy.value
  || !!props.controller.reconciling.value || props.controller.unknown(props.controller.sharePost.value?.id ?? 0));
</script>
<style scoped>
.community-share-mask { position: fixed; inset: 0; bottom: var(--window-bottom, 0px); z-index: 130; display: flex; align-items: flex-end; background: rgba(0,0,0,.5); }
.community-share-panel { width: 100%; box-sizing: border-box; padding: 30rpx; max-height: 85vh; overflow-y: auto; background: #fff; border-radius: 24rpx 24rpx 0 0; font-size: 26rpx; overflow-wrap: anywhere; }
/* #ifndef H5 */
.community-share-panel { padding-bottom: calc(30rpx + env(safe-area-inset-bottom, 0px)); }
/* #endif */
.community-share-title { font-size: 30rpx; font-weight: 600; margin-bottom: 24rpx; }
.community-share-panel button { margin-top: 18rpx; font-size: 27rpx; }
.share-notice { color: #637367; margin: 16rpx 0; line-height: 1.6; }
.share-warning { color: #a32920; padding: 16rpx; background: #fff2ee; border-radius: 10rpx; margin: 16rpx 0; }
.community-copy-share { color: #fff; background: var(--view-theme, #e93323); }
</style>
