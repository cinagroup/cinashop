import { computed, reactive, ref, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiBuyerOrderTracking } from '@/api/order';
import { buyerTrackingIntent, buyerTrackingParameters, createBuyerTrackingReader, initialBuyerTracking } from '../../../common/buyerOrderTracking';

export function useBuyerOrderTracking() {
  const auth = useAuthStore(), state = reactive(initialBuyerTracking()), kind = ref<'order' | 'refund'>('order');
  let visible = false, disposed = false, lastHash = '';
  function hash() {
    // #ifdef H5
    if (typeof window !== 'undefined') return window.location.hash;
    // #endif
    return '';
  }
  const reader = createBuyerTrackingReader(state, {
    capture: () => { const uid = auth.uid, token = auth.token, version = auth.sessionVersion, path = hash();
      return { uid, token, current: () => visible && !disposed && auth.uid === uid && auth.token === token && auth.sessionVersion === version && hash() === path }; },
    read: apiBuyerOrderTracking,
    copy: value => new Promise<void>((resolve, reject) => uni.setClipboardData({ data: value,
      showToast: false, success: () => resolve(), fail: () => reject(Error('复制失败')) })),
  });
  const result = computed(() => state.result), selectedPackageId = computed(() => state.selectedPackageId);
  const displayResult = computed(() => reader.selected()), shipment = computed(() => reader.details());
  function setRoute(reference: unknown, type?: unknown) {
    reader.setRoute(reference, type);
    try { kind.value = buyerTrackingIntent(reference, type).kind; } catch { kind.value = 'order'; }
  }
  async function load() { if (visible && !disposed) await reader.load(); }
  function readHash() {
    const current = hash(); if (!current || current === lastHash) return false;
    lastHash = current; const raw = current.replace(/^#/, ''), split = raw.indexOf('?');
    if ((split < 0 ? raw : raw.slice(0, split)) !== '/pages/order/express') { visible = false; reader.setRoute(undefined); reader.clear(); return true; }
    try {
      if (current.length > 8192) throw Error('物流链接过长');
      const intent = buyerTrackingParameters(new URLSearchParams(split < 0 ? '' : raw.slice(split + 1)));
      setRoute(intent.reference, intent.kind === 'refund' ? 'refund' : undefined);
    } catch (error) { reader.setRoute(undefined); reader.clear((error as Error).message); }
    void load(); return true;
  }
  function hashChanged() { if (visible && !disposed) readHash(); }
  function visibilityChanged() {
    // #ifdef H5
    if (typeof document !== 'undefined') {
      if (document.visibilityState === 'hidden') { visible = false; reader.clear(); }
      else if (!disposed) { visible = true; if (!readHash()) void load(); }
    }
    // #endif
  }
  const stopAuth = watch(() => [auth.sessionVersion, auth.uid, auth.token], () => reader.clear('登录状态已变化，请重新查询物流'), { flush: 'sync' });
  onLoad(query => setRoute(query?.orderId, query?.type));
  onShow(() => { if (disposed) return; visible = true; if (!readHash()) void load(); });
  onHide(() => { visible = false; reader.clear(); });
  // #ifdef H5
  if (typeof window !== 'undefined') window.addEventListener('hashchange', hashChanged);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibilityChanged);
  // #endif
  onUnload(() => {
    disposed = true; visible = false; reader.clear(); stopAuth();
    // #ifdef H5
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', hashChanged);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibilityChanged);
    // #endif
  });
  function login() { if (visible && !disposed && !auth.isLoggedIn) uni.navigateTo({ url: '/pages/auth/login' }); }
  return { auth, state, result, kind, selectedPackageId, displayResult, shipment, load, login,
    select: reader.select, copy: reader.copy, expand: reader.expand };
}
