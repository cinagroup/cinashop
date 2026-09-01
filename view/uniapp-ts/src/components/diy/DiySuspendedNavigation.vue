<template>
  <view v-if="visible" class="suspended" :class="`style-${styleIndex}`" :style="positionStyle">
    <view v-show="opened" class="suspended-items">
      <view
        v-for="(item, index) in buttons"
        :key="`${index}-${item.url}`"
        class="suspended-item"
        @tap.stop="follow(item.url)"
      >
        <image class="suspended-image" :src="item.img" mode="aspectFill" />
      </view>
    </view>
    <view class="suspended-main" @tap.stop="opened = !opened">
      <image v-if="mainImage" class="suspended-image" :src="mainImage" mode="aspectFill" />
      <text v-else class="suspended-symbol">{{ opened ? '×' : '＋' }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { apiDiySuspended, type DiySuspendedButton, type DiySuspendedConfig } from "@/api/diy";
import { isDiyEnabled, normalizeDiyLink, openDiyLink, safeDiyImageUrl } from "@/utils/diy";

const config = ref<DiySuspendedConfig | null>(null);
const opened = ref(false);

const buttons = computed<DiySuspendedButton[]>(() => (
  (Array.isArray(config.value?.button) ? config.value.button : [])
    .slice(0, 6)
    .flatMap((item) => {
      const img = safeDiyImageUrl(item?.img);
      const url = normalizeDiyLink(item?.url);
      return img && url ? [{ img, url }] : [];
    })
));

const mainImage = computed(() => safeDiyImageUrl(
  opened.value ? config.value?.main_after_image : config.value?.main_ago_image,
) || safeDiyImageUrl(config.value?.main_ago_image));

const visible = computed(() => Boolean(
  config.value
  && isDiyEnabled(config.value.is_show)
  && (mainImage.value || buttons.value.length),
));

const styleIndex = computed(() => {
  const value = Number(config.value?.index);
  return Number.isInteger(value) && value >= 1 && value <= 4 ? value : 1;
});

const positionStyle = computed(() => {
  const raw = Number(config.value?.shifting);
  const percent = Number.isFinite(raw) ? Math.min(90, Math.max(10, raw)) : 72;
  return { top: `${percent}%` };
});

function follow(url: string): void {
  opened.value = false;
  openDiyLink(url);
}

onMounted(async () => {
  try {
    config.value = await apiDiySuspended();
  } catch {
    // A missing optional navigation config must not affect the page.
  }
});
</script>

<style scoped>
.suspended { position: fixed; z-index: 900; right: 20rpx; display: flex; align-items: flex-end; transform: translateY(-50%); flex-direction: column; }
.suspended-items { display: flex; margin-bottom: 12rpx; padding: 10rpx; gap: 12rpx; border-radius: 40rpx; background: rgba(255, 255, 255, .94); box-shadow: 0 8rpx 30rpx rgba(0, 0, 0, .14); flex-direction: column; }
.style-2 .suspended-items { flex-direction: row; }
.style-3 .suspended-items, .style-4 .suspended-items { display: grid; grid-template-columns: repeat(2, 72rpx); border-radius: 24rpx; }
.suspended-main, .suspended-item { display: flex; width: 72rpx; height: 72rpx; overflow: hidden; align-items: center; justify-content: center; border-radius: 50%; background: #fff; box-shadow: 0 6rpx 24rpx rgba(0, 0, 0, .16); }
.suspended-image { width: 100%; height: 100%; border-radius: 50%; }
.suspended-symbol { color: #e93323; font-size: 38rpx; line-height: 1; }
</style>
