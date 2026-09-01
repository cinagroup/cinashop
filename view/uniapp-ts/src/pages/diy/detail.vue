<template>
  <view class="diy-detail" :style="pageStyle">
    <view v-if="loading" class="diy-state">正在加载微页面…</view>
    <view v-else-if="error" class="diy-state error">
      <text>{{ error }}</text>
      <button class="retry" size="mini" @tap="reload(true)">重新加载</button>
    </view>
    <DiyHomeRenderer
      v-else-if="page && isDiyEnabled(page.is_show)"
      :components="page.value"
      micro-page
    />
    <view v-else class="diy-state">微页面暂未开放</view>
    <DiySuspendedNavigation />
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad, onPullDownRefresh } from "@dcloudio/uni-app";
import type { DiyPage } from "@/api/diy";
import DiyHomeRenderer from "@/components/diy/DiyHomeRenderer.vue";
import DiySuspendedNavigation from "@/components/diy/DiySuspendedNavigation.vue";
import { diyPageStyle, isDiyEnabled, loadDiyPage } from "@/utils/diy";

const pageId = ref(0);
const page = ref<DiyPage | null>(null);
const loading = ref(true);
const error = ref("");
const pageStyle = computed(() => diyPageStyle(page.value));

async function reload(force = false): Promise<void> {
  if (pageId.value <= 0) return;
  loading.value = true;
  error.value = "";
  try {
    page.value = await loadDiyPage(pageId.value, force);
    if (!page.value) {
      error.value = "微页面不存在";
      return;
    }
    uni.setNavigationBarTitle({ title: page.value.title || "专题页" });
  } catch {
    error.value = "微页面加载失败，请稍后重试";
  } finally {
    loading.value = false;
  }
}

onLoad((options) => {
  const id = Number(options?.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    loading.value = false;
    error.value = "微页面链接无效";
    return;
  }
  pageId.value = id;
  void reload();
});

onPullDownRefresh(async () => {
  await reload(true);
  uni.stopPullDownRefresh();
});
</script>

<style scoped>
.diy-detail { min-height: 100vh; padding: 1rpx 0 40rpx; box-sizing: border-box; }
.diy-state { display: flex; min-height: 60vh; align-items: center; justify-content: center; gap: 24rpx; color: #999; text-align: center; flex-direction: column; }
.diy-state.error { color: #777; }
.retry { color: #fff; border: 0; background: #e93323; }
</style>
