<template>
  <ThemePage>
  <view class="diy-detail" :style="pageStyle">
    <view v-if="routeError" class="diy-state error">{{ routeError }}</view>
    <view v-else-if="(loading || phase === 'idle') && !page" class="diy-state">正在加载微页面…</view>
    <view v-else-if="error" class="diy-state error">
      <text>{{ error }}</text>
      <button class="retry" size="mini" @tap="reload(true)">重新加载</button>
    </view>
    <view v-else-if="page">
      <view v-if="loading" class="diy-notice">正在核对页面配置…</view>
      <view v-else-if="offline" class="diy-notice diy-offline">当前显示离线缓存 <button size="mini" @tap="reload(true)">重新核实</button></view>
      <DiyHomeRenderer v-if="isDiyEnabled(page.is_show)" :components="page.value" :page-active="diyPageActive" :scroll-top="diyScrollTop" :load-more-signal="diyLoadMoreSignal" micro-page @closed="diyHost.close" />
      <view v-else class="diy-state">微页面暂未开放</view>
    </view>
    <view v-else class="diy-state"><view v-if="offline" class="diy-notice diy-offline">当前显示离线缓存 <button size="mini" @tap="reload(true)">重新核实</button></view>微页面暂未开放</view>
    <DiySuspendedNavigation v-if="diyCommunityVisible && !loading && !error && !routeError" />
  </view>
  </ThemePage>
</template>

<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { computed, ref } from "vue";
import { onLoad, onShow, onHide, onUnload, onPageScroll, onReachBottom, onPullDownRefresh } from "@dcloudio/uni-app";
import DiyHomeRenderer from "@/components/diy/DiyHomeRenderer.vue";
import DiySuspendedNavigation from "@/components/diy/DiySuspendedNavigation.vue";
import { diyPageStyle, isDiyEnabled } from "@/utils/diy";
import { useDiyPageHost } from "@/composables/useDiyPageHost";

const diyCommunityVisible = ref(false);
const diyScrollTop=ref(0),diyLoadMoreSignal=ref(0);
onPageScroll(event=>{if(diyCommunityVisible.value)diyScrollTop.value=event.scrollTop;});
onReachBottom(()=>{if(diyCommunityVisible.value)diyLoadMoreSignal.value++;});
let diyCommunityDisposed = false;
onShow(() => { if (!diyCommunityDisposed) diyCommunityVisible.value = true; });
onHide(() => { diyCommunityVisible.value = false; });
onUnload(() => { diyCommunityDisposed = true; diyCommunityVisible.value = false; diyHost.dispose(); });

const pageId = ref<number | null>(null);
const routeError = ref("");
const diyHost = useDiyPageHost(() => pageId.value, () => diyCommunityVisible.value);
const { page, loading, error, phase, offline, available: diyPageActive, reload } = diyHost;
const pageStyle = computed(() => diyPageStyle(page.value));

onLoad((options) => {
  const raw = options?.id;
  const id = typeof raw === "string" && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id > 2147483647) {
    pageId.value = null; routeError.value = "微页面链接无效";
    return;
  }
  pageId.value = id;
  routeError.value = "";
});

onPullDownRefresh(() => {
  if (pageId.value === null) { if (diyCommunityVisible.value) uni.stopPullDownRefresh(); return; }
  void diyHost.refresh();
});
</script>

<style scoped>
.diy-detail { min-height: 100vh; padding: 1rpx 0 40rpx; box-sizing: border-box; }
.diy-state { display: flex; min-height: 60vh; align-items: center; justify-content: center; gap: 24rpx; color: #999; text-align: center; flex-direction: column; }
.diy-state.error { color: #777; }
.retry { color: #fff; border: 0; background: var(--view-theme, #e93323); }
.diy-notice { padding: 16rpx 24rpx; color: #666; background: #fff7e8; font-size: 24rpx; }
.diy-notice button { display: inline-block; margin-left: 12rpx; }
</style>
