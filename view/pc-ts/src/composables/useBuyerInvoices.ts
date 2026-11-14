import { computed, reactive, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { captureAuthSession, getUid, isCurrentAuthSession, onAuthChange } from '@/utils/auth';
import { apiBuyerInvoiceApply, apiBuyerInvoiceDefault, apiBuyerInvoiceDelete, apiBuyerInvoiceOrder, apiBuyerInvoicePage, apiBuyerInvoiceSave } from '@/api/buyerInvoice';
import { buyerInvoiceParameters, createBuyerInvoiceFlow, initialBuyerInvoiceFlow } from '../../../common/buyerInvoiceFlow';
import type { BuyerInvoiceRecord } from '../../../common/buyerInvoices';

export function useBuyerInvoices(orderPage = false) {
  const route = useRoute(), router = useRouter(), state = reactive(initialBuyerInvoiceFlow()), path = orderPage ? '/user/invoice/order' : '/user/invoice';
  let disposed = false, visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const flow = createBuyerInvoiceFlow(state, {
    capture: () => { const session = captureAuthSession(), uid = getUid(), currentPath = route.fullPath;
      return { uid, token: session.token ?? '', current: () => visible && !disposed && route.path === path && route.fullPath === currentPath && getUid() === uid && isCurrentAuthSession(session) }; },
    page: apiBuyerInvoicePage, order: apiBuyerInvoiceOrder, save: apiBuyerInvoiceSave, remove: apiBuyerInvoiceDelete, setDefault: apiBuyerInvoiceDefault, apply: apiBuyerInvoiceApply,
    confirm: content => ElMessageBox.confirm(content, '核对发票资料', { confirmButtonText: '确认', cancelButtonText: '取消', type: 'warning' }).then(() => true).catch(() => false),
  });
  function setRoute() {
    flow.clear(); if (route.path !== path) { flow.setRoute(undefined, true); return; }
    try { const url = new URL(route.fullPath, 'http://127.0.0.1'); flow.setRoute(buyerInvoiceParameters(url.searchParams, orderPage), orderPage); }
    catch (e) { flow.setRoute(undefined, true); flow.clear((e as Error).message); }
  }
  watch(() => route.fullPath, () => { setRoute(); if (visible && !disposed && route.path === path) void flow.load(); }, { immediate: true, flush: 'sync' });
  const stopAuth = onAuthChange(() => flow.clear('登录状态已变化，请重新读取发票'));
  function visibilityChanged() { visible = document.visibilityState !== 'hidden'; flow.clear(); if (visible && !disposed && route.path === path) { setRoute(); void flow.load(); } }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibilityChanged);
  onBeforeUnmount(() => { disposed = true; visible = false; stopAuth(); flow.clear(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibilityChanged); });
  function openRecord(record: BuyerInvoiceRecord) {
    if (!disposed && visible && route.path === path && flow.records().includes(record) && record.uid === getUid())
      void router.push(`/user/invoice/order?orderId=${encodeURIComponent(record.orderNo)}`).catch(() => { flow.clear('无法打开发票详情，请重试'); });
  }
  return { state, ...flow, titles: computed(flow.titles), records: computed(flow.records), hasPrevious: computed(flow.canBack),
    openRecord, login: () => router.push('/login'), manage: () => router.push('/user/invoice') };
}
