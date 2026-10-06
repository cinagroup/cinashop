<template><view class="theme-page" :style="theme.style"><slot /></view></template>
<script setup lang="ts">
import { onMounted } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { useThemeStore } from '@/stores/theme';
const theme = useThemeStore();
onMounted(() => theme.syncPlatform());
onShow(() => theme.syncPlatform());
</script>
<style scoped>.theme-page{min-width:0;min-height:100%;width:100%;}</style>
