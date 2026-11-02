import { computed, ref, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { createAssignedRequests, type AssignedRequests } from '@/api/managerAssignedFulfillment';
import { parseMerchantEnvelope, isMerchantContext } from '@/utils/merchantOrders';
import type { MerchantStoreIdentity } from '../../../common/merchantManagement';
import { parseAssignedInbox, parseAssignedReview, parseAssignedResult, parseAssignedRecovery, makeAssignedInput,
  type AssignedInboxItem, type AssignedReview, type AssignedReceipt } from '../../../common/managerAssignedFulfillment';
import { readAssignedJournal, beginAssignedIntent, assertAssignedIntent, recordAssignedReceipt, assignedRequestKey,
  assignedJournalKey, withAssignedJournalLock, type AssignedIntent } from '@/utils/managerAssignedFulfillment';

export function useManagerAssignedFulfillment() {
  const auth = useAuthStore(), visible = ref(false), stores = ref<MerchantStoreIdentity[]>([]), selectedStore = ref<number | null>(null);
  const items = ref<AssignedInboxItem[]>([]), nextAfter = ref<number | null>(null), review = ref<AssignedReview | null>(null);
  const carrierIndex = ref(-1), tracking = ref(''), pending = ref<AssignedIntent[]>([]), receipt = ref<AssignedReceipt | null>(null);
  const error = ref(''), notice = ref(''), journalError = ref(''), loading = ref(false), busy = ref(false);
  const requests = new Set<AssignedRequests>(); let disposed = false, epoch = 0, scopeKey = '';
  function persisted() { try { return uni.getStorageSync('uni_token') === auth.token && Number(uni.getStorageSync('uni_uid')) === auth.uid; } catch { return false; } }
  const current = () => visible.value && !disposed && auth.uid > 0 && !!auth.token && persisted();
  function clearPrivate() { items.value = []; nextAfter.value = null; review.value = null; carrierIndex.value = -1; tracking.value = ''; receipt.value = null; }
  function cancel() { epoch++; for (const r of requests) r.abort(); requests.clear(); loading.value = false; busy.value = false; clearPrivate(); }
  function request() { const version = epoch, r = createAssignedRequests(() => current() && epoch === version); requests.add(r); return r; }
  function finish(r: AssignedRequests) { requests.delete(r); r.abort(); }
  function readPending() {
    pending.value = []; journalError.value = '';
    if (!current()) return;
    try { pending.value = readAssignedJournal(auth.uid).records.filter(r => !r.receipt); }
    catch (reason) { journalError.value = reason instanceof Error ? reason.message : '原操作记录无法读取，请人工核对'; }
  }
  function fail(reason: unknown) { error.value = reason instanceof Error ? reason.message : '分配订单暂不可用，请重新核对'; }
  async function loadInbox(after = 0) {
    if (!current() || !selectedStore.value || loading.value || busy.value) return;
    const store = selectedStore.value, r = request(); loading.value = true; error.value = '';
    try {
      const result = parseAssignedInbox(await r.inbox(store, after), r.owner.uid, store, after);
      if (!r.active()) return;
      if (result.scope_key !== scopeKey || selectedStore.value !== store
        || result.list.some(row => after > 0 && items.value.some(old => old.order_id === row.order_id))) throw Error('门店身份或待办分页已变化，请刷新');
      items.value = after ? [...items.value, ...result.list] : result.list; nextAfter.value = result.next_after;
    } catch (reason) { if (r.active()) { clearPrivate(); fail(reason); } }
    finally { if (r.active()) loading.value = false; finish(r); }
  }
  async function refresh() {
    if (!visible.value || disposed) return;
    cancel(); stores.value = []; scopeKey = ''; error.value = ''; notice.value = ''; readPending();
    if (!current()) { error.value = '请登录后核对后台分配订单'; return; }
    const r = request(); loading.value = true;
    try {
      const result = parseMerchantEnvelope(await r.context(selectedStore.value ?? undefined), r.owner.uid, null, isMerchantContext);
      if (!r.active()) return;
      if (result.store_id !== result.data.selected_store_id) throw Error('当前门店身份响应不一致');
      stores.value = result.data.stores; selectedStore.value = result.data.selected_store_id; scopeKey = result.scope_key;
      loading.value = false;
      if (selectedStore.value) await loadInbox();
    } catch (reason) { if (r.active()) { stores.value = []; scopeKey = ''; clearPrivate(); fail(reason); } }
    finally { if (r.active()) loading.value = false; finish(r); }
  }
  function chooseStore(event: { detail: { value: string | number } }) {
    const selected = stores.value[Number(event.detail.value)]; if (!current() || !selected || selected.store_id === selectedStore.value) return;
    cancel(); selectedStore.value = selected.store_id; error.value = ''; notice.value = ''; readPending(); void refresh();
  }
  async function open(item: AssignedInboxItem) {
    if (!current() || !selectedStore.value || !scopeKey || busy.value || loading.value || !items.value.some(row => row === item)) return;
    review.value = null; carrierIndex.value = -1; tracking.value = ''; receipt.value = null; error.value = ''; notice.value = '';
    const r = request(), store = selectedStore.value; busy.value = true;
    try { const result = parseAssignedReview(await r.review(item.order_id, store), item.order_id, store, scopeKey);
      if (r.active() && selectedStore.value === store) review.value = result;
    } catch (reason) { if (r.active()) fail(reason); }
    finally { if (r.active()) busy.value = false; finish(r); }
  }
  function closeReview() { if (!busy.value) { review.value = null; carrierIndex.value = -1; tracking.value = ''; } }
  const storeName = computed(() => stores.value.find(s => s.store_id === selectedStore.value)?.name || '请选择当前门店');
  function canRestore(intent: AssignedIntent) {
    return current() && !journalError.value && !!scopeKey && selectedStore.value === intent.input.store_id && scopeKey === intent.input.scope_key
      && stores.value.some(s => s.store_id === intent.input.store_id);
  }
  const canSubmit = computed(() => current() && !busy.value && !loading.value && !journalError.value && !!review.value
    && review.value.store_id === selectedStore.value && review.value.scope_key === scopeKey
    && !!review.value.carriers[carrierIndex.value] && !!tracking.value.trim()
    && !pending.value.some(intent => intent.input.order_id === review.value?.order_id));
  async function confirm(title: string, content: string) {
    return new Promise<boolean>(resolve => uni.showModal({ title, content, success: answer => resolve(answer.confirm), fail: () => resolve(false) }));
  }
  function accept(intent: AssignedIntent, value: AssignedReceipt) {
    const saved = recordAssignedReceipt(intent, value); readPending(); receipt.value = saved.receipt;
    review.value = null; carrierIndex.value = -1; tracking.value = '';
    items.value = items.value.filter(row => row.order_id !== intent.input.order_id);
    notice.value = '发货信息已记录。渠道上报由后台继续处理，请以原回执核对。';
  }
  async function submit() {
    if (!current() || !canSubmit.value || !review.value) return;
    const original = review.value, carrier = original.carriers[carrierIndex.value]; if (!carrier) return;
    const r = request(); busy.value = true; error.value = ''; notice.value = ''; let intent: AssignedIntent | null = null;
    try {
      const input = makeAssignedInput(original, carrier, tracking.value);
      if (!await confirm('确认整单快递发货', `订单 ${original.order_no}，${carrier.name}，单号 ${input.payload.delivery_id}。请确认已真实交付整单商品。`) || !r.active()) return;
      await withAssignedJournalLock(r.owner.uid, async () => {
        if (!r.active() || review.value !== original) return;
        const key = await assignedRequestKey(); if (!r.active()) return;
        intent = beginAssignedIntent(r.owner.uid, key, input); readPending();
        const saved = assertAssignedIntent(intent); if (!r.active()) return;
        if (saved.receipt) { accept(saved, saved.receipt); return; }
        const result = parseAssignedResult(await r.commit(saved.request_key, saved.input), saved);
        if (r.active()) accept(saved, result.receipt);
      });
    } catch (reason) { if (r.active()) { readPending(); error.value = intent
      ? '原发货结果待确认。请查询原操作；恢复时只使用同一编号和原内容。'
      : reason instanceof Error ? reason.message : '尚未提交'; } }
    finally { if (r.active()) busy.value = false; finish(r); }
  }
  async function check(intent: AssignedIntent) {
    if (!current() || busy.value || intent.actor_uid !== auth.uid || journalError.value) return;
    const r = request(); busy.value = true; error.value = ''; notice.value = '';
    try { await withAssignedJournalLock(r.owner.uid, async () => {
      const saved = assertAssignedIntent(intent); if (!r.active()) return;
      const result = parseAssignedRecovery(await r.receipt(saved.request_key), saved); if (!r.active()) return;
      if (!result) { notice.value = '服务端尚未确认原请求。请保留原编号和内容，继续查询；这不表示发货失败。'; return; }
      accept(saved, result);
    }); } catch (reason) { if (r.active()) fail(reason); }
    finally { if (r.active()) busy.value = false; finish(r); }
  }
  async function restore(intent: AssignedIntent) {
    if (!canRestore(intent) || busy.value) return;
    const r = request(); busy.value = true; error.value = ''; notice.value = '';
    try {
      if (!await confirm('恢复原发货请求', '将使用同一请求编号和完全相同的物流内容核对。如已记录，只会恢复原回执。') || !r.active()) return;
      await withAssignedJournalLock(r.owner.uid, async () => {
        const saved = assertAssignedIntent(intent); if (!r.active() || !canRestore(saved)) return;
        if (saved.receipt) { accept(saved, saved.receipt); return; }
        const result = parseAssignedResult(await r.commit(saved.request_key, saved.input), saved);
        if (r.active()) accept(saved, result.receipt);
      });
    } catch (reason) { if (r.active()) { readPending(); fail(reason); } }
    finally { if (r.active()) busy.value = false; finish(r); }
  }
  function login() { if (visible.value && !disposed) uni.navigateTo({ url: '/pages/auth/login' }); }
  function back() { if (visible.value && !disposed) uni.navigateBack({ fail: () => uni.switchTab({ url: '/pages/user/index' }) }); }
  function credentialsChanged() {
    if (!visible.value || disposed) return;
    let token = '', uid = 0; try { token = String(uni.getStorageSync('uni_token') || ''); uid = Number(uni.getStorageSync('uni_uid')) || 0; } catch { /* closed */ }
    if (token !== auth.token || uid !== auth.uid) auth.$patch({ token, uid, sessionVersion: auth.sessionVersion + 1 });
    else void refresh();
  }
  function stored(event: StorageEvent) { if (event.key === 'uni_token' || event.key === 'uni_uid' || event.key === null) credentialsChanged();
    else if (current() && event.key === assignedJournalKey(auth.uid)) { cancel(); readPending(); notice.value = '另一页面已更新原操作，请刷新后核对。'; } }
  watch(() => [auth.uid, auth.token, auth.sessionVersion], () => {
    cancel(); stores.value = []; selectedStore.value = null; scopeKey = ''; pending.value = []; error.value = ''; notice.value = ''; journalError.value = '';
    void Promise.resolve().then(() => { if (current()) void refresh(); });
  }, { flush: 'sync' });
  onLoad(query => { const raw = query?.store_id; if (typeof raw === 'string' && /^[1-9][0-9]{0,9}$/u.test(raw)
    && Number(raw) <= 2147483647) selectedStore.value = Number(raw); });
  onShow(() => { visible.value = true; credentialsChanged();
    if (typeof window !== 'undefined') { window.addEventListener('focus', credentialsChanged); window.addEventListener('storage', stored); } });
  function leave() { visible.value = false; cancel(); stores.value = []; scopeKey = ''; pending.value = []; error.value = ''; notice.value = ''; journalError.value = '';
    if (typeof window !== 'undefined') { window.removeEventListener('focus', credentialsChanged); window.removeEventListener('storage', stored); } }
  onHide(leave); onUnload(() => { disposed = true; leave(); });
  return { auth, stores, selectedStore, storeName, items, nextAfter, review, carrierIndex, tracking, pending, receipt,
    error, notice, journalError, loading, busy, canSubmit, current, canRestore, refresh, chooseStore,
    more: () => nextAfter.value === null ? Promise.resolve() : loadInbox(nextAfter.value), open, closeReview, submit, check, restore, login, back };
}
