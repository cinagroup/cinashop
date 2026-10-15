<template>
  <el-popover v-if="allowed" trigger="click" placement="bottom-end" :width="280">
    <template #reference><button class="stock-notice" type="button" aria-label="库存通知"><el-badge is-dot :hidden="!lastProduct"><el-icon :size="18"><Warning /></el-icon></el-badge></button></template>
    <section aria-label="库存预警通知"><strong>库存预警</strong><p v-if="lastProduct">商品 #{{ lastProduct }} 库存预警，请核对当前库存。</p><p v-else>暂无新的库存预警通知。</p><p role="status">{{ noticeStateText[state] }}</p><el-button v-if="state === 'denied' || state === 'retrying'" text size="small" @click="notice.retry()">重连库存通知</el-button></section>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { Warning } from '@element-plus/icons-vue';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { StaffNoticeClient, bindNoticeLifecycle, noticeStateText, type NoticeState } from '../../../common/staff-notifications';
import { parseStockNoticeFrame } from '../../../common/product-stock-notifications';

const auth = useAuthStore(), state = ref<NoticeState>('idle'), lastProduct = ref<number | null>(null), version = ref(0);
const allowed = computed(() => {
  void version.value; const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && !!auth.userInfo && session?.userInfo.id === auth.userInfo.id && session.userInfo.level === auth.userInfo.level && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('product.view') && session.uniqueAuth.includes('product.view'));
});
const identity = computed(() => `${auth.token}:${auth.userInfo?.id}:${auth.uniqueAuth.join(',')}`);
const notice = new StaffNoticeClient({
  url: () => { const url = new URL('/adminapi/product/stock/notifications/socket', location.origin); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; return url.toString(); },
  parseFrame: parseStockNoticeFrame,
  onState: value => { state.value = value; },
  onRefresh: productId => {
    if (!allowed.value || document.hidden) return;
    if (productId) lastProduct.value = productId;
    window.dispatchEvent(new Event('cinashop:admin-todos-changed'));
    window.dispatchEvent(new CustomEvent('cinashop:product-stock-changed', { detail: { productId: productId ?? 0 } }));
  },
  onDenied: () => { lastProduct.value = null; window.dispatchEvent(new Event('cinashop:product-stock-notice-denied')); },
});
let release: (() => void) | undefined;
function sync(): void { version.value++; lastProduct.value = null; notice.setSession(allowed.value ? auth.token : ''); }
watch(identity, sync, { flush: 'pre' });
onMounted(() => { release = bindNoticeLifecycle(notice, window, document, () => navigator.onLine); sync(); window.addEventListener('admin-session-changed', sync); window.addEventListener('storage', sync); window.addEventListener('admin-auth-expired', sync); });
onUnmounted(() => { release?.(); notice.dispose(); window.removeEventListener('admin-session-changed', sync); window.removeEventListener('storage', sync); window.removeEventListener('admin-auth-expired', sync); });
</script>

<style scoped>
.stock-notice { display: flex; align-items: center; border: 0; background: none; cursor: pointer; padding: 8px; color: inherit; }.stock-notice:focus-visible { outline: 2px solid #409eff; outline-offset: 2px; }
</style>
