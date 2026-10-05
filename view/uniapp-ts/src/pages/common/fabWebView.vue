<template>
  <ThemePage>
  <web-view v-if="url && !failed" :src="url" @error="failed = true" />
  <view v-else class="fab-link-error"><text>{{ failed ? '目标网页加载失败，请返回重试。' : '悬浮按钮网页地址无效，请联系管理员修改。' }}</text><button @tap="back">返回</button></view>
  </ThemePage>
</template>
<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { fabWebViewUrl } from '@/utils/fab';
const url = ref(''), failed = ref(false);
onLoad(options => { url.value = fabWebViewUrl(options?.url); failed.value = false; });
function back() { uni.navigateBack({ fail: () => uni.switchTab({ url: '/pages/index/index' }) }); }
</script>
<style scoped>.fab-link-error{display:flex;min-height:80vh;flex-direction:column;align-items:center;justify-content:center;gap:32rpx;padding:40rpx;color:#666;text-align:center}.fab-link-error button{font-size:28rpx}</style>
