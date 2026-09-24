import { reactive, ref, watch } from 'vue';
import { onShow, onHide, onUnload, onReachBottom } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiPresaleCatalog } from '@/api/presale';
import { createPresaleCatalogSession, newPresaleCatalog } from '../../../common/presaleCatalog';

export function usePresaleCatalog() {
  const auth = useAuthStore(), state = reactive(newPresaleCatalog()), visible = ref(false), navigating = ref(false);
  let disposed = false, navigationRevision = 0;
  const session = createPresaleCatalogSession(state, apiPresaleCatalog, () => visible.value && !disposed);
  function reset() { navigationRevision++; navigating.value = false; session.reset(); }
  function openProduct(id: number) {
    if (!visible.value || disposed || state.loading || navigating.value || !state.list.some(row => row.id === id)) return;
    const current = ++navigationRevision; navigating.value = true;
    const fail = () => { if (current === navigationRevision && visible.value && !disposed) {
      navigating.value = false; uni.showToast({ title: '预售详情打开失败，请重试', icon: 'none' });
    } };
    try { uni.navigateTo({ url: `/pages/activity/presaleDetail?id=${id}`, fail }); } catch { fail(); }
  }
  watch(() => auth.sessionVersion, () => { reset(); state.error = '登录状态已变化，请刷新预售列表'; }, { flush: 'sync' });
  onShow(() => { if (!disposed) { visible.value = true; reset(); void session.load(); } });
  onHide(() => { visible.value = false; reset(); });
  onUnload(() => { disposed = true; visible.value = false; reset(); session.dispose(); });
  onReachBottom(() => { if (!state.error && !navigating.value) void session.load(true); });
  return { state, visible, navigating, openProduct, load: session.load, select: session.select };
}
