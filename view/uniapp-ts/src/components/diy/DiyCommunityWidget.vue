<template>
  <view v-if="controller.config.value.enabled && active" class="diy-community-widget" :data-component-key="controller.config.value.key"
    :data-layout="controller.config.value.layout" :style="controller.config.value.wrapperStyle">
    <CommunityAvailability :closed="controller.availability.closed.value" :checking="controller.availability.checking.value"
      :message="controller.availability.message.value" @retry="controller.recover" />
    <view v-if="controller.ready()" class="diy-community-panel" :style="controller.config.value.panelStyle">
      <view class="diy-community-header" :style="controller.config.value.headerStyle">
        <text v-if="controller.config.value.titleMode === 'text'" class="diy-community-title" :style="controller.config.value.titleStyle">{{ controller.config.value.title }}</text>
        <image v-else-if="header.image && !headerFailed" :key="header.key" class="diy-community-title-image" :src="header.image" mode="aspectFit" @load="header.loaded" @error="header.failed" />
        <button class="diy-community-more" :style="controller.config.value.buttonStyle" :disabled="controller.loading.value || !!controller.error.value" @tap="header.more">{{ controller.config.value.more }} ›</button>
      </view>
      <view v-if="controller.loading.value" class="diy-community-state" role="status">正在加载社区内容…</view>
      <view v-else-if="controller.error.value" class="diy-community-error" role="alert">{{ controller.error.value }}</view>
      <view v-else-if="controller.loaded.value && !controller.rows.value.length" class="diy-community-state">暂无社区内容</view>
      <template v-if="controller.rows.value.length">
        <scroll-view v-if="controller.config.value.layout === 'horizontal'" scroll-x :show-scrollbar="false">
          <view class="diy-community-list horizontal" :style="controller.config.value.listStyle">
            <DiyCommunityCard v-for="slot in slots" :key="slot.key" :post="slot.post" layout="horizontal" :image-style="controller.config.value.imageStyle"
              :image="slot.image" :avatar="slot.avatar" :allowed="slot.allowed" @open="controller.openPost" />
          </view>
        </scroll-view>
        <view v-else class="diy-community-list columns" :style="controller.config.value.listStyle">
          <view v-for="(column,index) in columns" :key="index" class="diy-community-column">
            <DiyCommunityCard v-for="slot in column" :key="slot.key" :post="slot.post" layout="columns" :image-style="controller.config.value.imageStyle"
              :image="slot.image" :avatar="slot.avatar" :allowed="slot.allowed" @open="controller.openPost" @measured="controller.adoptMeasurement" />
          </view>
        </view>
      </template>
      <button class="diy-community-refresh" :disabled="controller.loading.value" @tap="header.refresh">{{ controller.error.value ? '重试社区内容' : '刷新社区内容' }}</button>
    </view>
    <view v-else-if="controller.availability.allowed.value" class="diy-community-state" role="status">社区标题图片授权已失效，请刷新页面</view>
  </view>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import CommunityAvailability from '@/components/community/CommunityAvailability.vue';
import DiyCommunityCard from './DiyCommunityCard.vue';
import { useDiyCommunity } from '@/composables/useDiyCommunity';
import type { DiyComponent } from '@/api/diy';
const props = defineProps<{ block: DiyComponent; active: boolean }>();
const controller = useDiyCommunity(() => props.block, () => props.active), headerFailed = ref(false);
const header = computed(() => {
  const image = controller.mediaTitle(), epoch = controller.nativeEpoch.value;
  const current = controller.lease(() => controller.mediaTitle());
  return { image, key: `${epoch}:${image}`, current,
    loaded: () => { if (current()) headerFailed.value = false; },
    failed: () => { if (current()) headerFailed.value = true; },
    more: () => { if (current()) controller.openMore(); },
    refresh: () => { if (current()) void controller.load(); },
  };
});
watch(() => header.value.key, () => { headerFailed.value = false; }, { flush: 'sync' });
const slots = computed(() => controller.rows.value.map(post => {
  const image = controller.media(post.image || post.sliderImage?.[0]), avatar = controller.media(post.author_image), epoch = controller.nativeEpoch.value;
  const allowed = controller.lease(() => `${controller.media(post.image || post.sliderImage?.[0])}\0${controller.media(post.author_image)}`);
  return { post, image, avatar, allowed, key: `${post.id}:${epoch}:${image}:${avatar}` };
}));
const columns = computed(() => {
  const byId = new Map(slots.value.map(slot => [slot.post.id, slot]));
  return controller.columns.value.map(column => column.flatMap(post => { const slot = byId.get(post.id); return slot ? [slot] : []; }));
});
</script>
<style scoped>
.diy-community-widget{box-sizing:border-box;min-width:0;overflow-wrap:anywhere;}.diy-community-panel{overflow:hidden;background:#fff;}.diy-community-header{display:flex;align-items:center;justify-content:space-between;gap:12rpx;padding:0 24rpx;height:96rpx;box-sizing:border-box;}.diy-community-title{min-width:0;}.diy-community-title-image{width:134rpx;height:34rpx;flex-shrink:0;}.diy-community-more{flex-shrink:0;padding:0 4rpx;margin:0;background:transparent;line-height:1.8;}.diy-community-more::after{border:0;}.diy-community-list{box-sizing:border-box;}.diy-community-list.horizontal{display:flex;width:max-content;min-width:100%;padding:24rpx 0 24rpx 20rpx;}.diy-community-list.columns{display:flex;align-items:flex-start;padding:20rpx;}.diy-community-column{flex:1;min-width:0;}.diy-community-state,.diy-community-error{padding:24rpx;font-size:25rpx;}.diy-community-error{color:#a32920;}.diy-community-refresh{margin:12rpx 20rpx;font-size:24rpx;}
</style>
