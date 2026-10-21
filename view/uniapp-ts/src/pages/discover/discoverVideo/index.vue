<template>
  <ThemePage>
  <view v-if="routeError" class="community-route-error" role="alert">{{ routeError }}</view>
  <CommunityDeepLinkFeed v-if="ready" ref="feed" mode="video" :query="query" />
  </ThemePage>
</template>

<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { ref } from "vue";
import { onLoad, onReachBottom, onShareAppMessage, onShareTimeline } from "@dcloudio/uni-app";
import CommunityDeepLinkFeed from "@/components/community/CommunityDeepLinkFeed.vue";
import type { CommunityRouteQuery } from "@/composables/useCommunityDeepLink";
import { communityPageQuery, communityInbound, communitySharePath } from '@/utils/communityShare';
import { useShareReferral } from '@/composables/useShareReferral';

const ready = ref(false), routeError = ref('');
const referrals = useShareReferral();
const query = ref<CommunityRouteQuery>({});
const feed = ref<InstanceType<typeof CommunityDeepLinkFeed> | null>(null);
onLoad((options) => {
  try {
    const current = communityPageQuery(options ?? {});
    const incoming = communityInbound('/pages/discover/discoverVideo/index', current);
    referrals.captureInbound({ path: 'pages/discover/discoverVideo/index', query: current });
    if (incoming && (current.post_id !== undefined || current.post_type !== undefined)) {
      uni.redirectTo({ url: communitySharePath(incoming.id, incoming.contentType, incoming.spid),
        fail: () => { routeError.value = '分享帖子暂时无法打开，请重新打开链接'; } }); return;
    }
    query.value = current; ready.value = true;
  } catch (reason) { routeError.value = reason instanceof Error ? reason.message : '社区地址无效'; }
});
onReachBottom(() => void feed.value?.loadMore());
// #ifdef MP-WEIXIN
onShareAppMessage(event => feed.value?.shareMessage(event) ?? {});
onShareTimeline(() => feed.value?.shareTimeline() ?? {});
// #endif
</script>

<style scoped>
.community-route-error { padding: 48rpx; color: #a32920; overflow-wrap: anywhere; }
</style>
