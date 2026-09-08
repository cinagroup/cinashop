<template>
  <span class="product-media" :style="{ '--product-image-fit': fit }">
    <img v-if="source && !failed" :key="source" ref="image" :src="source" :alt="alt"
      :loading="loading" decoding="async" @error="onError" />
    <span v-else class="image-unavailable" role="img" :aria-label="`${alt || '商品'}：${message}`">
      <span aria-hidden="true">{{ message }}</span>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

const props = withDefaults(defineProps<{
  src?: string | null;
  alt?: string;
  loading?: "eager" | "lazy";
  fit?: "cover" | "contain";
}>(), { alt: "商品", loading: "eager", fit: "cover" });
const source = computed(() => typeof props.src === "string" ? props.src.trim() : "");
const image = ref<HTMLImageElement | null>(null);
const failed = ref(false);
const message = computed(() => source.value ? "图片加载失败" : "暂无商品图片");

// A reused product/SKU view must try its new source, without retrying a failed URL
// automatically or letting a detached previous image fail the current one.
watch(source, () => { failed.value = false; }, { flush: "sync" });
function onError(event: Event) {
  if (event.currentTarget === image.value) failed.value = true;
}
</script>

<style scoped>
.product-media { display: block; position: relative; width: 100%; aspect-ratio: 1; min-width: 0; overflow: hidden; background: #f5f5f5; }
.product-media > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: var(--product-image-fit); }
.image-unavailable { position: absolute; inset: 0; display: grid; place-items: center; padding: 4px; color: #666; font-size: 12px; line-height: 1.5; text-align: center; overflow-wrap: anywhere; }
</style>
