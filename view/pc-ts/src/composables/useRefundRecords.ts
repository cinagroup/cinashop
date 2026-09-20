import { computed, reactive, ref, watch, onBeforeUnmount } from 'vue';
import { useRoute, useRouter, isNavigationFailure } from 'vue-router';
import { captureAuthSession, isCurrentAuthSession, getUid, onAuthChange } from '@/utils/auth';
import { ApiResponseError } from '@/utils/apiError';
import { apiRefundRecords, apiRefundRecord, apiCancelRefund, apiReturnCarriers, apiReturnExpress, apiReturnImage } from '@/api/refund';
import { createRefundReader, initialRefundReader } from '../../../common/refundReader';
import { refundQuery, refundRecordId, type RefundRecord } from '../../../common/refundRecords';

export function useRefundRecords(mode: 'list' | 'detail', confirm: () => Promise<boolean> = async () => false) {
  const route = useRoute(), router = useRouter(), state = reactive(initialRefundReader());
  const search = ref(''), navigating = ref(false), navigationError = ref(''), routeError = ref('');
  let disposed = false, id = 0, navigationVersion = 0;
  function capture() {
    const session = captureAuthSession(), uid = getUid(), path = route.fullPath, revision = state.revision, expectedId = id;
    return { uid, id, current: () => !disposed && !!session.token && uid === getUid() && isCurrentAuthSession(session)
      && route.fullPath === path && expectedId === id && state.revision === revision && !routeError.value };
  }
  const reader = createRefundReader(state, mode, { capture, page: apiRefundRecords, detail: apiRefundRecord, cancel: apiCancelRefund,
    confirm, carriers: apiReturnCarriers, returnExpress: apiReturnExpress, isRejected: error => error instanceof ApiResponseError && error.status === 400 });
  const list = computed(() => state.items), detail = computed(() => state.detail);
  const busy = computed(() => state.loading || state.operating || navigating.value);
  const canCancel = computed(() => reader.canCancel() && !navigating.value);
  const canReturn = computed(() => reader.canReturn() && !navigating.value);
  async function uploadReturnImage(file: File) { if (!navigating.value) await reader.uploadImage(async current => current() ? apiReturnImage(file) : null); }
  async function submitReturn() { if (!navigating.value) await reader.submitReturn(); }
  function removeReturnImage(index: number) { if (!navigating.value) reader.removeImage(index); }
  function clear() { reader.clear(); search.value = ''; navigationVersion++; navigating.value = false; navigationError.value = ''; }
  async function load(append = false) { if (!disposed && !navigating.value && !routeError.value) await reader.load(append); }
  async function navigate(url: string) {
    if (busy.value || !capture().current()) return;
    const owner = capture(), version = ++navigationVersion; navigating.value = true; navigationError.value = '';
    try { const result = await router.push(url); if (owner.current() && isNavigationFailure(result)) navigationError.value = '页面未打开，请重试查看'; }
    catch { if (owner.current()) navigationError.value = '页面未打开，请重试查看'; }
    finally { if (owner.current() && version === navigationVersion) navigating.value = false; }
  }
  function goDetail(row: RefundRecord) { if (reader.canOpen(row)) return navigate(`/user/refunds/${row.id}`); }
  function goList() { return navigate('/user/refunds'); }
  function goOrder() { if (reader.currentView() && state.detail) return navigate(`/order/${state.detail.orderId}`); }
  function goService() { return navigate('/service'); }
  function setFilter(filter: unknown) {
    if (disposed || navigating.value || state.operating) return;
    try {
      const query = refundQuery(filter, search.value);
      if (state.filter === query.filter && state.q === query.q) return load();
      reader.clear();
      return navigate('/user/refunds?filter=' + query.filter + '&q=' + encodeURIComponent(query.q));
    }
    catch (error) { state.error = (error as Error).message; }
  }
  const applySearch = () => setFilter(state.filter);
  async function cancel() { if (!navigating.value) await reader.cancel(); }
  const stopAuth = onAuthChange(() => { clear(); state.filter = 'all'; state.q = ''; state.error = '登录状态已变化，请重新读取退款记录'; });
  watch(() => route.fullPath, () => {
    clear(); id = 0; routeError.value = '';
    if (mode === 'list' ? route.path !== '/user/refunds' : !route.path.startsWith('/user/refunds/')) return;
    try {
      if (mode === 'detail') id = refundRecordId(route.params.id);
      else { const query = refundQuery(route.query.filter, route.query.q); state.filter = query.filter; state.q = query.q; search.value = query.q; }
      void load();
    } catch (error) { routeError.value = (error as Error).message; }
  }, { immediate: true, flush: 'sync' });
  onBeforeUnmount(() => { disposed = true; stopAuth(); clear(); });
  return { state, list, detail, search, busy, canCancel, canReturn, uploadReturnImage, submitReturn, removeReturnImage, navigationError, routeError, load, goDetail, goList, goOrder, goService, setFilter, applySearch, cancel };
}
