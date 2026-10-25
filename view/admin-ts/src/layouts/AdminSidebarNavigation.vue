<template>
  <el-menu ref="menu" close-on-click-outside class="admin-navigation" aria-label="管理导航" :default-active="active"
    :default-openeds="openedSections" :collapse="collapsed" :collapse-transition="false"
    unique-opened router background-color="#ffffff" text-color="#515a6e" active-text-color="#2d8cf0">
    <el-menu-item v-for="item in navigation.shortcuts" :key="item.path" :index="item.path" :aria-label="item.label">
      <el-icon><component :is="item.icon" /></el-icon>
      <template #title><span>{{ item.label }}</span></template>
    </el-menu-item>
    <el-sub-menu v-for="section in navigation.sections" :key="section.id" :index="section.id"
      :aria-label="section.label" :tabindex="collapsed ? 0 : undefined" @click="openCollapsedSection(section.id)"
      @keydown="openCollapsedByKeyboard(section.id, $event)" popper-class="admin-navigation-popup" :show-timeout="0" :hide-timeout="100">
      <template #title><el-icon><component :is="section.icon" /></el-icon><span>{{ section.label }}</span></template>
      <el-menu-item v-for="item in section.items" :key="item.path" :index="item.path" :aria-label="item.label">
        <el-icon><component :is="item.icon" /></el-icon>
        <template #title><span>{{ item.label }}</span></template>
      </el-menu-item>
    </el-sub-menu>
  </el-menu>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { MenuInstance } from 'element-plus';
import { activeAdminSection, visibleAdminNavigation } from '@/utils/adminNavigation';
const props = defineProps<{ active: string; collapsed: boolean; canMenu: (path: string) => boolean }>();
const menu = ref<MenuInstance>();
const navigation = computed(() => visibleAdminNavigation(props.canMenu));
const openedSections = computed(() => props.collapsed ? [] : activeAdminSection(props.active, navigation.value.sections));
// Element Plus reads default-openeds on mount, so route/role changes also use
// its public open() API after the matching menu items have rendered.
watch([() => props.active, () => props.collapsed, () => navigation.value.sections], async () => {
  await nextTick();
  if (!props.collapsed) for (const id of openedSections.value) menu.value?.open(id);
}, { flush: 'post' });
function openCollapsedSection(id: string) {
  if (props.collapsed) menu.value?.open(id);
}
function openCollapsedByKeyboard(id: string, event: KeyboardEvent) {
  if (props.collapsed && event.key === 'Enter') {
    event.preventDefault();
    menu.value?.open(id);
  }
}
</script>
<style>
.admin-navigation-popup .el-menu-item {
  height: 52px;
  line-height: 52px;
}
.admin-navigation-popup .el-menu--popup {
  max-height: calc(100vh - 32px);
  max-height: min(640px, calc(100dvh - 32px));
  overflow-y: auto;
  overscroll-behavior: contain;
}
</style>
