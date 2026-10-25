<template>
  <nav v-if="shortcuts.length" class="dashboard-shortcuts" aria-label="控制台快捷入口">
    <RouterLink v-for="item in shortcuts" :key="item.path" :to="item.path" custom v-slot="{ href, navigate }">
      <a :href="href" class="dashboard-shortcut" @click="followShortcut($event, item.path, navigate)">
        <span class="dashboard-shortcut-icon" :style="{ color: item.color }" aria-hidden="true">{{ item.glyph }}</span>
        <p>{{ item.label }}</p>
      </a>
    </RouterLink>
  </nav>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
// Original PHP gridMenu order, labels, icon glyphs and colors; routes use the current TS screens.
const items = [
  { path: '/user', label: '用户管理', glyph: '\uf3fa', color: '#69c0ff' },
  { path: '/config', label: '系统设置', glyph: '\uf427', color: '#95de64' },
  { path: '/product', label: '商品', glyph: '\uf36d', color: '#ff9c6e' },
  { path: '/order', label: '订单管理', glyph: '\uf376', color: '#b37feb' },
  { path: '/setting/notification', label: '消息配置', glyph: '\uf36f', color: '#ffd666' },
  { path: '/content/article', label: '文章管理', glyph: '\uf36c', color: '#5cdbd3' },
  { path: '/agent', label: '分销管理', glyph: '\uf40a', color: '#ff85c0' },
  { path: '/coupon', label: '优惠券', glyph: '\uf36e', color: '#ffc069' },
];
function canOpen(path: string): boolean {
  return !!auth.token && !!auth.userInfo && (auth.userInfo.level === 0 || auth.menus.some(menu => menu.path === path));
}
const shortcuts = computed(() => items.filter(item => canOpen(item.path)));
function followShortcut(event: MouseEvent, path: string, navigate: (event: MouseEvent) => unknown): void {
  // Recheck the live actor even before Vue removes a link after a permission change.
  if (!canOpen(path)) { event.preventDefault(); return; }
  void navigate(event);
}
</script>

<style scoped>
@font-face {
  font-family: 'PHP Dashboard Icons';
  src: url('/php-assets/admin/ionicons.143146fa.woff2') format('woff2');
  font-style: normal;
  font-weight: 400;
  font-display: block;
  unicode-range: U+F3FA, U+F427, U+F36D, U+F376, U+F36F, U+F36C, U+F40A, U+F36E;
}
.dashboard-shortcuts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 24px;
  margin-bottom: 24px;
}
.dashboard-shortcut {
  display: block;
  min-width: 0;
  padding: 16px;
  border-radius: 4px;
  background: #fff;
  color: #515a6e;
  text-align: center;
  text-decoration: none;
  transition: box-shadow .2s ease-in-out;
}
.dashboard-shortcut:hover { box-shadow: 0 1px 6px rgba(0, 0, 0, .2); }
.dashboard-shortcut:focus-visible { outline: 2px solid #2d8cf0; outline-offset: 2px; }
.dashboard-shortcut-icon {
  display: inline-block;
  font-family: 'PHP Dashboard Icons';
  font-size: 32px;
  font-weight: 400;
  font-style: normal;
  line-height: 1;
  -webkit-font-smoothing: antialiased;
}
.dashboard-shortcut p { margin: 8px 0 0; font-size: 14px; line-height: 1.5; }
@media (min-width: 768px) { .dashboard-shortcuts { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (min-width: 1200px) { .dashboard-shortcuts { grid-template-columns: repeat(8, minmax(0, 1fr)); } }
</style>
