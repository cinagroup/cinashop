import { computed, ref, watch } from 'vue';
import { onHide, onLoad, onShow, onUnload } from '@dcloudio/uni-app';
import { useAdminSession } from '@/stores/adminSession';
import { apiAssistedOrderDetail, validAssistedOrderNo, type AssistedOrderDetail } from '@/api/assistedDetail';

export function useAssistedDetail() {
  const session = useAdminSession();
  const visible = ref(false), detail = ref<AssistedOrderDetail | null>(null), loading = ref(false), error = ref('');
  const canRead = computed(() => session.authenticated && session.canAssist);
  let orderNo = '', generation = 0, disposed = false;
  function reset() { generation++; detail.value = null; loading.value = false; error.value = ''; }
  function setRoute(value: unknown) {
    const next = validAssistedOrderNo(value) ? value : '';
    if (next !== orderNo) { orderNo = next; reset(); }
  }
  function readHashRoute(): boolean {
    // #ifdef H5
    if (typeof window !== 'undefined') {
      const hash = window.location.hash, route = hash.replace(/^#/, '').split('?');
      if (route[0] !== '/pages/behalf/order_detail/index') return false;
      try {
        const values = new URLSearchParams(route.slice(1).join('?')).getAll('orderId');
        if (hash.length > 8192 || values.length !== 1) throw Error('订单号无效');
        setRoute(values[0]);
      } catch { setRoute(undefined); }
      return true;
    }
    // #endif
    return false;
  }
  function current(epoch: number, version: number, token: string, adminId: number) {
    return visible.value && canRead.value && epoch === generation && session.version === version
      && session.token === token && session.id === adminId;
  }
  async function load() {
    reset();
    if (!visible.value || !canRead.value) return;
    if (!orderNo) { error.value = '订单号无效，请返回代客记录重新打开'; return; }
    const epoch = generation, version = session.version, token = session.token, adminId = session.id;
    loading.value = true;
    try {
      const value = await apiAssistedOrderDetail(orderNo);
      if (current(epoch, version, token, adminId)) detail.value = value;
    } catch (cause) {
      if (current(epoch, version, token, adminId)) error.value = cause instanceof Error ? cause.message : '订单详情加载失败';
    } finally { if (current(epoch, version, token, adminId)) loading.value = false; }
  }
  function goRecords() { uni.navigateTo({ url: '/pages/behalf/record/index' }); }
  function goCashier() {
    if (!visible.value || !canRead.value || loading.value || error.value || !detail.value || detail.value.paid
      || !validAssistedOrderNo(orderNo)) return;
    uni.navigateTo({ url: `/pages/behalf/cashier/index?orderId=${encodeURIComponent(orderNo)}` });
  }
  function hashChanged() {
    if (!visible.value || disposed) return;
    if (readHashRoute()) void load();
    else { visible.value = false; reset(); }
  }
  watch(() => [session.version, session.token, session.id, session.canAssist], reset, { flush: 'sync' });
  onLoad(query => { if (!disposed) setRoute(query?.orderId); });
  onShow(() => { if (disposed) return; session.ensureFresh(); visible.value = true; readHashRoute(); void load(); });
  onHide(() => { visible.value = false; reset(); });
  // #ifdef H5
  if (typeof window !== 'undefined') window.addEventListener('hashchange', hashChanged);
  // #endif
  onUnload(() => {
    disposed = true; visible.value = false; reset();
    // #ifdef H5
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', hashChanged);
    // #endif
  });
  return { session, canRead, detail, loading, error, load, goRecords, goCashier };
}
