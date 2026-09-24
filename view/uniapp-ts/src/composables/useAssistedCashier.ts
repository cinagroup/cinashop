import { computed, ref, watch } from 'vue';
import { onHide, onLoad, onShow, onUnload } from '@dcloudio/uni-app';
import { useAdminSession } from '@/stores/adminSession';
import { apiAssistedOrderDetail, validAssistedOrderNo, type AssistedOrderDetail } from '@/api/assistedDetail';
import { apiAssistedPaidStatus } from '@/api/assistedRecords';
import { apiAssistedPay, type AssistedPaymentMethod } from '@/api/assistedCashier';

type QrState = { method: 'weixin' | 'alipay'; code: string; expiresAt: number };

export function useAssistedCashier() {
  const session = useAdminSession();
  const visible = ref(false), detail = ref<AssistedOrderDetail | null>(null);
  const loading = ref(false), busy = ref(false), error = ref(''), actionError = ref(''), notice = ref('');
  const method = ref<AssistedPaymentMethod>('weixin'), qr = ref<QrState | null>(null), now = ref(Date.now());
  const uncertain = ref(false);
  const canRead = computed(() => session.authenticated && session.canAssist);
  const canPay = computed(() => !!detail.value && !detail.value.paid);
  const isZeroDue = computed(() => canPay.value && detail.value?.amount === '0.00');
  const secondsLeft = computed(() => qr.value ? Math.max(0, Math.ceil((qr.value.expiresAt - now.value) / 1000)) : 0);
  let orderNo = '', generation = 0, disposed = false;
  let clock: ReturnType<typeof setInterval> | undefined;

  function clearClock() { if (clock) clearInterval(clock); clock = undefined; }
  function clearQr() { clearClock(); qr.value = null; }
  function reset() {
    generation++; clearQr(); detail.value = null; loading.value = false; busy.value = false;
    error.value = ''; actionError.value = ''; notice.value = ''; uncertain.value = false;
  }
  function setRoute(value: unknown) {
    const next = validAssistedOrderNo(value) ? value : '';
    if (next !== orderNo) { orderNo = next; reset(); }
  }
  function readHashRoute(): boolean {
    // #ifdef H5
    if (typeof window !== 'undefined') {
      const hash = window.location.hash, route = hash.replace(/^#/, '').split('?');
      if (route[0] !== '/pages/behalf/cashier/index') return false;
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
    return visible.value && !disposed && canRead.value && epoch === generation
      && session.version === version && session.token === token && session.id === adminId;
  }
  function owner() { return { epoch: generation, version: session.version, token: session.token, adminId: session.id }; }
  function still(ownerValue: ReturnType<typeof owner>) {
    return current(ownerValue.epoch, ownerValue.version, ownerValue.token, ownerValue.adminId);
  }
  function markPaid() {
    clearQr(); uncertain.value = false;
    if (detail.value) detail.value = { ...detail.value, paid: true, statusTitle: '服务器已确认付款' };
    notice.value = '服务器已确认付款。此页面不提供退款操作。';
  }
  function startClock() {
    clearClock(); now.value = Date.now();
    clock = setInterval(() => {
      now.value = Date.now();
      if (qr.value && qr.value.expiresAt <= now.value) {
        clearQr(); uncertain.value = true;
        notice.value = '二维码已到期。请先核对服务器付款状态；不会自动重新发起支付。';
      }
    }, 1000);
    const nodeTimer = clock as unknown as { unref?: () => void };
    if (typeof nodeTimer.unref === 'function') nodeTimer.unref();
  }
  async function load() {
    reset();
    if (!visible.value || !canRead.value) return;
    if (!orderNo) { error.value = '订单号无效，请从代客记录重新进入'; return; }
    const request = owner(); loading.value = true;
    try {
      const value = await apiAssistedOrderDetail(orderNo);
      if (!still(request)) return;
      detail.value = value;
      if (!value.paid && value.amount === '0.00') {
        notice.value = '此代客订单应付 0 元。管理员确认前不会自动完成，也不会生成付款二维码。';
      }
    } catch (cause) {
      if (still(request)) error.value = cause instanceof Error ? cause.message : '收银订单读取失败';
    } finally { if (still(request)) loading.value = false; }
  }
  async function checkPaid() {
    if (!visible.value || !canRead.value || !detail.value || loading.value || busy.value) return;
    const request = owner(); busy.value = true; actionError.value = '';
    try {
      const paid = await apiAssistedPaidStatus(orderNo);
      if (!still(request)) return;
      if (paid) markPaid();
      else {
        uncertain.value = false;
        notice.value = '服务器尚未确认付款。若买家已经付款，请稍后再次核对；重新发起支付必须由管理员再次点击。';
      }
    } catch (cause) {
      if (still(request)) actionError.value = cause instanceof Error ? cause.message : '付款状态无法核对，请稍后重试';
    } finally { if (still(request)) busy.value = false; }
  }
  function chooseMethod(value: AssistedPaymentMethod) {
    if (!visible.value || !canRead.value || busy.value || qr.value || uncertain.value) return;
    method.value = value; actionError.value = ''; notice.value = '';
  }
  function confirmCash(amount: string): Promise<boolean> {
    return new Promise(resolve => {
      uni.showModal({ title: '确认线下现金收款', content: `订单 ${orderNo}，应付 ¥${amount}。仅在已实际收到现金后确认；确认后服务器会立即将订单标记为已付款。`,
        confirmText: '已收现金', cancelText: '取消', success: result => resolve(!!result.confirm), fail: () => resolve(false) });
    });
  }
  function confirmZero(): Promise<boolean> {
    return new Promise(resolve => {
      uni.showModal({ title: '确认零元代客订单', content: `订单 ${orderNo}，服务器应付 ¥0.00。无需收取现金或扫码；确认后服务器会立即将订单标记为已付款。请核对订单和买家。`,
        confirmText: '确认完成', cancelText: '取消', success: result => resolve(!!result.confirm), fail: () => resolve(false) });
    });
  }
  async function startPayment() {
    if (!visible.value || !canRead.value || loading.value || busy.value || !canPay.value || qr.value || uncertain.value) return;
    const original = detail.value;
    if (!original) return;
    const zeroDue = original.amount === '0.00';
    const selected: AssistedPaymentMethod = zeroDue
      ? (original.payType === 'other' ? 'cash' : original.payType) : method.value;
    const request = owner();
    busy.value = true; actionError.value = ''; notice.value = '';
    try {
      // A direct URL never supplies the buyer UID. Both reads are scoped to this Admin.
      if (await apiAssistedPaidStatus(orderNo)) { if (still(request)) markPaid(); return; }
      if (!still(request)) return;
      const fresh = await apiAssistedOrderDetail(orderNo);
      if (!still(request)) return;
      if (fresh.paid) { markPaid(); return; }
      if (fresh.uid !== original.uid || fresh.amount !== original.amount) {
        detail.value = fresh;
        notice.value = '订单买家或应付金额已变化，请重新核对后再由管理员点击发起。';
        return;
      }
      if (zeroDue ? !(await confirmZero()) : selected === 'cash' && !(await confirmCash(fresh.amount))) return;
      if (!still(request)) return;
      // Any failure after this point is uncertain, including malformed provider data.
      // A new write is barred until an actor-scoped status read succeeds.
      uncertain.value = true;
      const result = await apiAssistedPay(orderNo, fresh.uid, selected, fresh.amount);
      if (!still(request)) return;
      if (result.kind === 'paid') { markPaid(); return; }
      if (zeroDue) throw Error('零元代客订单返回了扫码结果，请核对付款状态');
      if (result.amount !== fresh.amount || result.method !== selected) {
        throw Error('支付金额或方式与订单不一致，请核对付款状态');
      }
      qr.value = { method: result.method, code: result.code, expiresAt: result.expiresAt };
      uncertain.value = false; startClock();
      notice.value = '请让买家扫码付款。二维码到期后不会自动重新发起；以服务器付款状态为准。';
    } catch (cause) {
      if (still(request)) actionError.value = `${cause instanceof Error ? cause.message : '收银请求结果未知'}。请先核对付款状态，不要直接重复发起。`;
    } finally { if (still(request)) busy.value = false; }
  }
  function goRecords() { uni.navigateTo({ url: '/pages/behalf/record/index' }); }
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
  return { session, canRead, detail, loading, busy, error, actionError, notice, method, qr,
    uncertain, canPay, isZeroDue, secondsLeft, load, checkPaid, chooseMethod, startPayment, goRecords };
}
