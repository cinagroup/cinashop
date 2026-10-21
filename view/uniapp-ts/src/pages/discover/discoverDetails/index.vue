<template>
  <ThemePage>
    <view class="community-legacy-detail">
      <view role="status">{{ error || '正在打开分享的帖子…' }}</view>
      <button v-if="target" @tap="open">重新打开帖子</button>
    </view>
  </ThemePage>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import ThemePage from '@/components/ThemePage.vue';
import { communityPageQuery, communityInbound, communitySharePath } from '@/utils/communityShare';
import { useShareReferral } from '@/composables/useShareReferral';
const target = ref(''), error = ref(''), referrals = useShareReferral();
function open() { if (target.value) uni.redirectTo({ url: target.value, fail: () => { error.value = '帖子暂时无法打开，请重试'; } }); }
onLoad(input => {
  try {
    const query = communityPageQuery(input ?? {}), post = communityInbound('/pages/discover/discoverDetails/index', query);
    if (!post) throw Error('帖子地址无效');
    referrals.captureInbound({ path: 'pages/discover/discoverDetails/index', query });
    target.value = communitySharePath(post.id, post.contentType, post.spid); open();
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '帖子地址无效'; }
});
</script>
<style scoped>
.community-legacy-detail { padding: 48rpx; font-size: 28rpx; overflow-wrap: anywhere; }
</style>
