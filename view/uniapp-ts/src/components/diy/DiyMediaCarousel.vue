<template>
  <swiper v-if="items.length" class="diy-carousel" indicator-dots autoplay circular :interval="4000">
    <swiper-item v-for="(item, index) in items" :key="`${index}-${item.image}`" @tap="emit('open', item.link)">
      <image class="diy-carousel-image" :src="item.image" mode="aspectFill" />
    </swiper-item>
  </swiper>
</template>

<script setup lang="ts">
interface MediaItem {
  image: string;
  label: string;
  link: string;
}

defineProps<{ items: MediaItem[] }>();
const emit = defineEmits<{ open: [value: string] }>();
</script>

<style scoped>
.diy-carousel { width: auto; height: 320rpx; margin: 20rpx; overflow: hidden; border-radius: 18rpx; background: #eee; }
.diy-carousel-image { width: 100%; height: 320rpx; }
</style>
