import { computed, reactive, ref, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiRefundRecords, apiRefundRecord, apiRefundCancel } from '@/api/order';
import { RequestError } from '@/utils/request';
import { apiReturnCarriers, apiReturnExpress, apiReturnImage } from '@/api/refundReturn';
import { createRefundReader, initialRefundReader } from '../../../common/refundReader';
import { refundQuery, refundRecordId, type RefundRecord } from '../../../common/refundRecords';

export function useRefundRecords(mode: 'list' | 'detail') {
  const auth = useAuthStore(), state = reactive(initialRefundReader(10));
  const search = ref(''), navigationError = ref(''), routeError = ref(''), navigating = ref(false);
  let visible = false, disposed = false, id = 0, lastHash = '', navigationVersion = 0;
  const list = computed(() => state.items), detail = computed(() => state.detail);
  function hash() {
    // #ifdef H5
    if (typeof window !== 'undefined') return window.location.hash;
    // #endif
    return '';
  }
  function capture() {
    const uid = auth.uid, token = auth.token, session = auth.sessionVersion, path = hash(), revision = state.revision, expectedId = id;
    return { uid, id, current: () => visible && !disposed && !!token && auth.uid === uid && auth.token === token
      && auth.sessionVersion === session && path === hash() && revision === state.revision && expectedId === id && !routeError.value };
  }
  function confirm(): Promise<boolean> {
    return new Promise((resolve, reject) => uni.showModal({ title: '撤销售后', content: '确认撤销本次退款申请？退款渠道处理中的申请可能无法撤销。',
      confirmText: '确认撤销', cancelText: '保留申请', success: result => resolve(result.confirm === true), fail: () => reject(Error('确认窗口未打开，请重试')) }));
  }
  const reader = createRefundReader(state, mode, { capture, page: apiRefundRecords, detail: apiRefundRecord,
    cancel: apiRefundCancel, confirm, carriers: apiReturnCarriers, returnExpress: apiReturnExpress,
    isRejected: error => error instanceof RequestError && error.status === 400 });
  const busy = computed(() => state.loading || state.operating || navigating.value);
  const canCancel = computed(() => reader.canCancel() && !navigating.value);
  const canReturn = computed(() => reader.canReturn() && !navigating.value);
  async function uploadReturnImage() {
    if (navigating.value) return;
    await reader.uploadImage(async current => {
      const file = await new Promise<{ path: string; size: number } | null>((resolve, reject) => uni.chooseImage({ count: 1, sizeType: ['original'],
        success(result) {
          const files = result.tempFiles, paths = result.tempFilePaths;
          if (!Array.isArray(files) || files.length !== 1 || !Array.isArray(paths) || paths.length !== 1 || typeof paths[0] !== 'string' || !paths[0]) { reject(Error('请选择一张图片')); return; }
          resolve({ path: paths[0], size: files[0].size });
        }, fail(error) { if (error.errMsg?.includes('cancel')) resolve(null); else reject(Error('无法选择图片，请重试')); },
      }));
      if (!current() || !file) return null;
      if (!Number.isFinite(file.size) || file.size <= 0 || file.size > 10 * 1024 * 1024) throw Error('图片大小须在10 MiB以内');
      return apiReturnImage(file.path);
    });
  }
  async function submitReturn() { if (!navigating.value) await reader.submitReturn(); }
  function removeReturnImage(index: number) { if (!navigating.value) reader.removeImage(index); }
  function clear(preserveOutcome = false) {
    reader.clear(preserveOutcome); navigationVersion++; navigating.value = false; navigationError.value = '';
  }
  async function load(append = false) { if (visible && !disposed && !routeError.value && !navigating.value) await reader.load(append); }
  function setRoute(options: Record<string, unknown>) {
    routeError.value = '';
    try {
      const nextId = mode === 'detail' ? refundRecordId(options.id) : 0;
      clear(mode === 'detail' && id === nextId); id = nextId;
      if (mode === 'list') { const query = refundQuery(options.filter, options.q, 10); state.filter = query.filter; state.q = query.q; search.value = query.q; }
    } catch (error) { clear(); id = 0; routeError.value = (error as Error).message; }
  }
  function readHash() {
    const current = hash(); if (!current || current === lastHash) return false;
    const route = current.replace(/^#/, ''), split = route.indexOf('?'), target = '/pages/order/' + (mode === 'list' ? 'refundList' : 'refundDetail');
    if ((split < 0 ? route : route.slice(0, split)) !== target) { visible = false; clear(true); return true; }
    lastHash = current;
    try {
      if (current.length > 8192) throw Error('退款链接过长');
      const params = new URLSearchParams(split < 0 ? '' : route.slice(split + 1));
      for (const key of ['id', 'filter', 'q']) if (params.getAll(key).length > 1) throw Error('退款链接包含重复参数');
      setRoute(Object.fromEntries(params));
    } catch (error) { clear(); id = 0; routeError.value = (error as Error).message; }
    void load(); return true;
  }
  function hashChanged() { if (visible && !disposed) readHash(); }
  function navigate(url: string) {
    if (!visible || disposed || busy.value) return;
    const uid = auth.uid, session = auth.sessionVersion, expectedId = id, path = hash(), version = ++navigationVersion;
    navigating.value = true; navigationError.value = '';
    const fail = () => { if (visible && !disposed && uid === auth.uid && session === auth.sessionVersion && expectedId === id && path === hash() && version === navigationVersion) {
      navigating.value = false; navigationError.value = '页面未打开，请重试查看';
    } };
    try { uni.navigateTo({ url, success() {}, fail }); } catch { fail(); }
  }
  function goDetail(row: RefundRecord) { if (reader.canOpen(row)) navigate(`/pages/order/refundDetail?id=${row.id}`); }
  function goOrder() { if (reader.currentView() && state.detail) navigate(`/pages/order/detail?orderId=${state.detail.orderId}`); }
  function goList() { navigate('/pages/order/refundList'); }
  function goService() { navigate('/pages/user/kefu'); }
  function login() { if (!auth.isLoggedIn && !routeError.value) navigate('/pages/auth/login'); }
  function setFilter(value: unknown) {
    if (!visible || disposed || navigating.value || state.operating) return;
    try { const query = refundQuery(value, search.value, 10); clear(); state.filter = query.filter; state.q = query.q; void load(); }
    catch (error) { state.error = (error as Error).message; }
  }
  const applySearch = () => setFilter(state.filter);
  async function cancel() { if (!navigating.value) await reader.cancel(); }
  const stopAuth = watch(() => auth.sessionVersion, () => {
    clear(); search.value = ''; state.q = ''; state.filter = 'all'; state.error = '登录状态已变化，请重新读取退款记录';
  }, { flush: 'sync' });
  onLoad(options => setRoute(options ?? {}));
  onShow(() => { if (disposed) return; visible = true; if (!readHash()) void load(); });
  onHide(() => { visible = false; clear(true); });
  // #ifdef H5
  if (typeof window !== 'undefined') window.addEventListener('hashchange', hashChanged);
  // #endif
  onUnload(() => {
    disposed = true; visible = false; stopAuth(); clear();
    // #ifdef H5
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', hashChanged);
    // #endif
  });
  return { auth, state, list, detail, search, busy, canCancel, canReturn, uploadReturnImage, submitReturn, removeReturnImage, navigationError, routeError, load, goDetail, goList, goOrder, goService, login, setFilter, applySearch, cancel };
}
