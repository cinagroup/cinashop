<template>
  <ThemePage>
    <view class="community-legacy-entry">
      <view role="status">{{ error || '正在打开社区页面…' }}</view>
      <button v-if="target" @tap="open">重新打开页面</button>
    </view>
  </ThemePage>
</template>
<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { useCommunityLegacyEntry } from '@/composables/useCommunityLegacyEntry';
const { target, error, open } = useCommunityLegacyEntry('/pages/discover/discoverUser/index');
</script>
<style scoped>
.community-legacy-entry { padding: 48rpx; font-size: 28rpx; overflow-wrap: anywhere; }
</style>
