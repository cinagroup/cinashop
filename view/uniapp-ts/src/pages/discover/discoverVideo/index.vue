<template>
  <CommunityDeepLinkFeed v-if="ready" ref="feed" mode="video" :query="query" />
</template>

<script setup lang="ts">
import { ref } from "vue";
import { onLoad, onReachBottom } from "@dcloudio/uni-app";
import CommunityDeepLinkFeed from "@/components/community/CommunityDeepLinkFeed.vue";
import type { CommunityRouteQuery } from "@/composables/useCommunityDeepLink";

const ready = ref(false);
const query = ref<CommunityRouteQuery>({});
const feed = ref<InstanceType<typeof CommunityDeepLinkFeed> | null>(null);
onLoad((options) => { query.value = (options ?? {}) as CommunityRouteQuery; ready.value = true; });
onReachBottom(() => void feed.value?.loadMore());
</script>
