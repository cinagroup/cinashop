<template>
  <view v-if="controller.config.value.enabled && active" class="diy-community-widget" :data-component-key="controller.config.value.key"
    :data-layout="controller.config.value.layout" :style="controller.config.value.wrapperStyle">
    <CommunityAvailability :closed="controller.availability.closed.value" :checking="controller.availability.checking.value"
      :message="controller.availability.message.value" @retry="controller.recover" />
    <view v-if="controller.availability.allowed.value" class="diy-community-panel" :style="controller.config.value.panelStyle">
      <view class="diy-community-header" :style="controller.config.value.headerStyle">
        <text v-if="controller.config.value.titleMode === 'text'" class="diy-community-title" :style="controller.config.value.titleStyle">{{ controller.config.value.title }}</text>
        <image v-else-if="controller.config.value.titleImage" class="diy-community-title-image" :src="controller.config.value.titleImage" mode="aspectFit" />
        <button class="diy-community-more" :style="controller.config.value.buttonStyle" :disabled="controller.loading.value || !!controller.error.value" @tap="controller.openMore">{{ controller.config.value.more }} ›</button>
      </view>
      <view v-if="controller.loading.value" class="diy-community-state" role="status">正在加载社区内容…</view>
      <view v-else-if="controller.error.value" class="diy-community-error" role="alert">{{ controller.error.value }}</view>
      <view v-else-if="controller.loaded.value && !controller.rows.value.length" class="diy-community-state">暂无社区内容</view>
      <scroll-view v-if="controller.rows.value.length" :scroll-x="controller.config.value.layout === 'horizontal'" :show-scrollbar="false">
        <view class="diy-community-list" :class="controller.config.value.layout" :style="controller.config.value.listStyle">
          <view v-for="post in controller.rows.value" :key="post.id" class="diy-community-card" :data-post-id="post.id" :style="controller.config.value.imageStyle" @tap="controller.openPost(post)">
            <view class="diy-community-picture">
              <image v-if="controller.media(post.image || post.sliderImage?.[0])" class="diy-community-image" :src="controller.media(post.image || post.sliderImage?.[0])"
                :style="controller.config.value.imageStyle" :mode="controller.config.value.layout === 'columns' ? 'widthFix' : 'aspectFill'" />
              <view v-else class="diy-community-placeholder">{{ post.contentType === 2 ? '视频' : '图文' }}</view>
              <text class="diy-community-media-type">{{ post.contentType === 2 ? '▶ 视频' : `${post.sliderImage?.length || 1} 张` }}</text>
            </view>
            <view class="diy-community-copy">
              <text class="diy-community-post-title">{{ post.title || '分享' }}</text>
              <view class="diy-community-byline">
                <image v-if="controller.media(post.author_image)" class="diy-community-avatar" :src="controller.media(post.author_image)" mode="aspectFill" />
                <text class="diy-community-author">{{ post.author || (post.type === 0 ? '平台' : '社区内容') }}</text>
                <text class="diy-community-likes">♡ {{ post.likeNum }}</text>
              </view>
            </view>
          </view>
        </view>
      </scroll-view>
      <button class="diy-community-refresh" :disabled="controller.loading.value" @tap="controller.load">{{ controller.error.value ? '重试社区内容' : '刷新社区内容' }}</button>
    </view>
  </view>
</template>
<script setup lang="ts">
import CommunityAvailability from '@/components/community/CommunityAvailability.vue';
import { useDiyCommunity } from '@/composables/useDiyCommunity';
import type { DiyComponent } from '@/api/diy';
const props = defineProps<{ block: DiyComponent; active: boolean }>();
const controller = useDiyCommunity(() => props.block, () => props.active);
</script>
<style scoped>
.diy-community-widget { box-sizing: border-box; min-width: 0; overflow-wrap: anywhere; }
.diy-community-panel { overflow: hidden; background: #fff; }
.diy-community-header { display: flex; align-items: center; justify-content: space-between; gap: 12rpx; padding: 20rpx 24rpx; }
.diy-community-title { min-width: 0; }
.diy-community-title-image { width: 134rpx; height: 34rpx; flex-shrink: 0; }
.diy-community-more { flex-shrink: 0; padding: 0 4rpx; margin: 0; background: transparent; line-height: 1.8; }
.diy-community-more::after { border: 0; }
.diy-community-list { box-sizing: border-box; padding: 20rpx; }
.diy-community-list.horizontal { display: flex; width: max-content; min-width: 100%; }
.diy-community-list.columns { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); align-items: start; }
.diy-community-card { min-width: 0; overflow: hidden; background: #fff; }
.horizontal .diy-community-card { width: 296rpx; flex-shrink: 0; position: relative; }
.diy-community-picture { position: relative; }
.diy-community-image { display: block; width: 100%; height: 369rpx; background: #f5f5f5; }
.columns .diy-community-image { height: auto; }
.diy-community-placeholder { display: flex; align-items: center; justify-content: center; height: 240rpx; background: #f2f2f2; color: #888; }
.diy-community-media-type { position: absolute; right: 12rpx; bottom: 12rpx; color: #fff; background: #555a; padding: 4rpx 8rpx; font-size: 22rpx; border-radius: 6rpx; }
.diy-community-copy { padding: 16rpx; }
.horizontal .diy-community-copy { position: absolute; bottom: 0; left: 0; right: 0; color: #fff; background: linear-gradient(transparent,#000b); padding-top: 40rpx; }
.diy-community-post-title { display: block; font-size: 26rpx; line-height: 1.6; }
.horizontal .diy-community-post-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diy-community-byline { display: flex; align-items: center; gap: 8rpx; font-size: 21rpx; padding-top: 10rpx; min-width: 0; }
.diy-community-avatar { width: 34rpx; height: 34rpx; border-radius: 50%; flex-shrink: 0; }
.diy-community-author { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.diy-community-likes { white-space: nowrap; }
.diy-community-state, .diy-community-error { padding: 24rpx; font-size: 25rpx; }
.diy-community-error { color: #a32920; }
.diy-community-refresh { margin: 12rpx 20rpx; font-size: 24rpx; }
</style>
