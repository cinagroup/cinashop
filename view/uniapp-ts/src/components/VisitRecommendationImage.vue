<template>
  <view class="recommendation-image">
    <template v-for="snapshot in [media]" :key="snapshot.key">
      <image v-if="showImage" class="recommendation-main-image" :src="snapshot.image" mode="aspectFill" @load="snapshot.onLoad" @error="snapshot.onError" />
      <view v-else class="image-placeholder">暂无商品图片</view>
      <image v-if="showFrame" class="promotion-frame" :src="snapshot.frame" mode="scaleToFill" aria-hidden="true" @error="snapshot.onFrameError" />
    </template>
  </view>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import type { VisitRecommendation } from "@/api/visitHistory";

const props = defineProps<{ item: VisitRecommendation }>();
const imageLoaded = ref(false), imageFailed = ref(false), frameFailed = ref(false);
let generation = 0;
const media = shallowRef({ key: 0, image: "", frame: "", onLoad() {}, onError() {}, onFrameError() {} });
// Refreshes can replace a row with identical URLs in the same render tick.
// The keyed template scope binds events to that snapshot (including with Vue's
// handler caching), keeping late native image events on the old row.
watch(() => [props.item, props.item.image, props.item.activityFrame?.image], () => {
  const key = ++generation;
  imageLoaded.value = false; imageFailed.value = false; frameFailed.value = false;
  media.value = {
    key, image: props.item.image, frame: props.item.activityFrame?.image ?? "",
    onLoad() { if (key === generation && !imageFailed.value) imageLoaded.value = true; },
    onError() { if (key === generation) { imageFailed.value = true; imageLoaded.value = false; } },
    onFrameError() { if (key === generation) frameFailed.value = true; },
  };
}, { immediate: true, flush: "sync" });
onScopeDispose(() => { generation++; });
const showImage = computed(() => !!media.value.image && !imageFailed.value);
const showFrame = computed(() => showImage.value && imageLoaded.value && !!media.value.frame && !frameFailed.value);
</script>

<style scoped>
.recommendation-image { position: relative; width: 100%; height: 280rpx; }
.recommendation-main-image, .promotion-frame, .image-placeholder { display: block; width: 100%; height: 100%; }
.promotion-frame { position: absolute; inset: 0; pointer-events: none; }
.image-placeholder { background: #ededed; color: #777; display: flex; justify-content: center; align-items: center; font-size: 24rpx; }
@media (min-width: 700px) { .recommendation-image { height: 180px; } }
</style>
