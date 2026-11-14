import { computed, reactive, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiBuyerInvoiceApply, apiBuyerInvoiceDefault, apiBuyerInvoiceDelete, apiBuyerInvoiceOrder, apiBuyerInvoicePage, apiBuyerInvoiceSave } from '@/api/buyerInvoice';
import { buyerInvoiceParameters, createBuyerInvoiceFlow, initialBuyerInvoiceFlow } from '../../../common/buyerInvoiceFlow';
import type { BuyerInvoiceRecord } from '../../../common/buyerInvoices';

export function useBuyerInvoices(orderPage = false) {
  const auth = useAuthStore(), state = reactive(initialBuyerInvoiceFlow()), path = orderPage ? '/pages/user/invoiceOrder' : '/pages/user/invoice';
  let disposed = false, shown = false, documentVisible = true, lastHash = '';
  function hash() {
    // #ifdef H5
    if (typeof window !== 'undefined') return window.location.hash;
    // #endif
    return '';
  }
  const flow = createBuyerInvoiceFlow(state, {
    capture: () => { const uid = auth.uid, token = auth.token, version = auth.sessionVersion, location = hash();
      return { uid, token, current: () => shown && documentVisible && !disposed && auth.uid === uid && auth.token === token && auth.sessionVersion === version && hash() === location }; },
    page: apiBuyerInvoicePage, order: apiBuyerInvoiceOrder, save: apiBuyerInvoiceSave, remove: apiBuyerInvoiceDelete, setDefault: apiBuyerInvoiceDefault, apply: apiBuyerInvoiceApply,
    confirm: content => new Promise(resolve => uni.showModal({ title: '核对发票资料', content, success: r => resolve(r.confirm), fail: () => resolve(false) })),
  });
  function readHash() {
    const current = hash(); if (!current || current === lastHash) return false; lastHash = current;
    const raw = current.replace(/^#/, ''), split = raw.indexOf('?');
    if ((split < 0 ? raw : raw.slice(0, split)) !== path) { shown = false; flow.setRoute(undefined, true); flow.clear(); return true; }
    try {
      if (current.length > 8192) throw Error('发票链接过长');
      flow.setRoute(buyerInvoiceParameters(new URLSearchParams(split < 0 ? '' : raw.slice(split + 1)), orderPage), orderPage);
    } catch (e) { flow.setRoute(undefined, true); flow.clear((e as Error).message); }
    return true;
  }
  async function load() { if (shown && documentVisible && !disposed) await flow.load(); }
  function hashChanged() { if (shown && !disposed && readHash()) void load(); }
  function visibilityChanged() {
    // #ifdef H5
    if (typeof document !== 'undefined') { documentVisible = document.visibilityState !== 'hidden'; flow.clear(); if (shown && documentVisible && !disposed) { readHash(); void load(); } }
    // #endif
  }
  const stopAuth = watch(() => [auth.uid, auth.token, auth.sessionVersion], () => flow.clear('登录状态已变化，请重新读取发票'), { flush: 'sync' });
  onLoad(query => {
    try {
      const keys = Object.keys(query ?? {}); if (keys.some(k => k !== 'orderId') || (orderPage ? keys.length !== 1 : keys.length !== 0)) throw Error('发票链接无效，请重新进入');
      flow.setRoute(query?.orderId, orderPage);
    } catch (e) { flow.setRoute(undefined, true); flow.clear((e as Error).message); }
  });
  onShow(() => { if (!disposed) { shown = true; readHash(); void load(); } });
  onHide(() => { shown = false; flow.clear(); });
  // #ifdef H5
  if (typeof window !== 'undefined') window.addEventListener('hashchange', hashChanged);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibilityChanged);
  // #endif
  onUnload(() => {
    disposed = true; shown = false; flow.clear(); stopAuth();
    // #ifdef H5
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', hashChanged);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibilityChanged);
    // #endif
  });
  function openRecord(record: BuyerInvoiceRecord) {
    if (shown && documentVisible && !disposed && flow.records().includes(record) && record.uid === auth.uid)
      uni.navigateTo({ url: `/pages/user/invoiceOrder?orderId=${encodeURIComponent(record.orderNo)}`, fail: () => flow.clear('无法打开发票详情，请重试') });
  }
  return { auth, state, ...flow, load, titles: computed(flow.titles), records: computed(flow.records), hasPrevious: computed(flow.canBack), openRecord,
    login: () => { if (shown && !disposed) uni.navigateTo({ url: '/pages/auth/login' }); }, manage: () => { if (shown && !disposed) uni.navigateTo({ url: '/pages/user/invoice' }); } };
}
