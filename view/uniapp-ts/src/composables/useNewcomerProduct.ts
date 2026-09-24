import { ref, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiNewcomerProductDetail, type NewcomerProductDetail } from '@/api/newcomer';

export function useNewcomerProduct() {
  const auth = useAuthStore();
  const detail = ref<NewcomerProductDetail | null>(null), loading = ref(false), error = ref(''), visible = ref(false);
  let productId = 0, generation = 0, disposed = false, loginPending = false;
  const routeId = (raw: unknown) => typeof raw === 'string' && /^[1-9]\d{0,9}$/.test(raw) && Number(raw) <= 2_147_483_647 ? Number(raw) : 0;
  function clear() { generation++; detail.value = null; loading.value = false; }
  function setRoute(raw: unknown) { clear(); productId = routeId(raw); error.value = productId ? '' : '新人商品链接无效'; }
  function readHashRoute() {
    // #ifdef H5
    if (typeof window !== 'undefined') {
      const hash = window.location.hash;
      const [path, query = ''] = hash.replace(/^#/, '').split('?');
      if (path !== '/pages/activity/newcomerDetail') return false;
      const ids = new URLSearchParams(query).getAll('id');
      const nextId = hash.length <= 8192 && ids.length === 1 ? routeId(ids[0]) : 0;
      if (nextId !== productId) setRoute(ids.length === 1 && nextId ? ids[0] : undefined);
      return true;
    }
    // #endif
    return false;
  }
  function hashChanged() { if (visible.value && !disposed && readHashRoute()) void load(); }
  function login() {
    if (auth.isLoggedIn || loginPending || !visible.value) return;
    loginPending = true;
    uni.navigateTo({ url: '/pages/auth/login', fail: () => { loginPending = false; error.value = '登录页面打开失败，请重试'; } });
  }
  async function load() {
    if (!visible.value || disposed || loading.value) return;
    clear();
    if (!productId) { error.value = '新人商品链接无效'; return; }
    if (!auth.isLoggedIn) { error.value = '登录后查看新人商品'; login(); return; }
    const current = ++generation, owner = auth.sessionVersion;
    error.value = ''; loading.value = true;
    try {
      const row = await apiNewcomerProductDetail(productId);
      if (current === generation && visible.value && owner === auth.sessionVersion) detail.value = row;
    } catch (cause) {
      if (current === generation && visible.value && owner === auth.sessionVersion) error.value = cause instanceof Error ? cause.message : '新人商品加载失败';
    } finally { if (current === generation) loading.value = false; }
  }
  watch(() => auth.sessionVersion, () => { clear(); if (visible.value) void load(); }, { flush: 'sync' });
  onLoad(query => { setRoute(query?.id); });
  onShow(() => { if (!disposed) { visible.value = true; loginPending = false; readHashRoute(); void load(); } });
  onHide(() => { visible.value = false; loginPending = false; clear(); });
  // #ifdef H5
  if (typeof window !== 'undefined') window.addEventListener('hashchange', hashChanged);
  // #endif
  onUnload(() => {
    disposed = true; visible.value = false; clear();
    // #ifdef H5
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', hashChanged);
    // #endif
  });
  return { auth, detail, loading, error, visible, load, login };
}
