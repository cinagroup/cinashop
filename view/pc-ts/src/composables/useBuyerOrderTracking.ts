import { computed, reactive, ref, watch, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { captureAuthSession, getUid, isCurrentAuthSession, onAuthChange } from '@/utils/auth';
import { apiBuyerOrderTracking } from '@/api/order';
import { buyerTrackingIntent, createBuyerTrackingReader, initialBuyerTracking } from '../../../common/buyerOrderTracking';

export function useBuyerOrderTracking() {
  const route = useRoute(), state = reactive(initialBuyerTracking()), search = ref(''), kind = ref<'order' | 'refund'>('order');
  let disposed = false, visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const reader = createBuyerTrackingReader(state, {
    capture: () => { const session = captureAuthSession(), uid = getUid(), path = route.fullPath;
      return { uid, token: session.token ?? '', current: () => visible && !disposed && route.path === '/express' && route.fullPath === path && getUid() === uid && isCurrentAuthSession(session) }; },
    read: apiBuyerOrderTracking, copy: value => navigator.clipboard.writeText(value),
  });
  const result = computed(() => state.result), selectedPackageId = computed(() => state.selectedPackageId);
  const displayResult = computed(() => reader.selected()), shipment = computed(() => reader.details());
  async function query() {
    if (!visible || disposed || route.path !== '/express') return;
    const next = search.value.trim(); search.value = next;
    reader.setRoute(next, kind.value === 'refund' ? 'refund' : undefined); await reader.load();
  }
  const stopInput = watch(search, () => reader.clear(), { flush: 'sync' });
  const stopAuth = onAuthChange(() => reader.clear('登录状态已变化，请重新查询物流'));
  watch(() => route.fullPath, () => {
    reader.clear(); search.value = ''; kind.value = 'order';
    if (route.path !== '/express') return;
    if (route.query.orderId === undefined && route.query.type === undefined) return;
    try {
      const intent = buyerTrackingIntent(route.query.orderId, route.query.type);
      search.value = intent.reference; kind.value = intent.kind; reader.setRoute(search.value, kind.value === 'refund' ? 'refund' : undefined);
      void reader.load();
    } catch (error) { reader.setRoute(undefined); reader.clear((error as Error).message); }
  }, { immediate: true, flush: 'sync' });
  function visibilityChanged() {
    if (typeof document === 'undefined') return;
    visible = document.visibilityState !== 'hidden';
    reader.clear(); if (visible && search.value && !disposed) void query();
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibilityChanged);
  onBeforeUnmount(() => {
    disposed = true; visible = false; stopAuth(); stopInput(); reader.clear();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibilityChanged);
  });
  return { state, result, search, kind, selectedPackageId, displayResult, shipment, query,
    select: reader.select, copy: reader.copy, expand: reader.expand };
}
