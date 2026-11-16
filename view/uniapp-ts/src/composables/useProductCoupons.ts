import { computed, onScopeDispose, reactive, watch, type Ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { RequestError } from '@/utils/request';
import { createProductCouponRequests, type ProductCoupon, type ProductCouponPage, type ProductCouponRequests } from '@/api/productCoupons';

export interface ClaimJournal { version: 1; uid: number; productId: number; couponId: number; title: string; attempt: string }
export interface ProductCouponClaimHooks {
  beforeDispatch?(row: ClaimJournal): void;
  beforeConfirm?(row: ClaimJournal, ownedId: number | null, source: 'grant' | 'receipt'): void;
}
export type ProductCouponClaimOutcome = { kind: 'not-sent' | 'rejected' | 'uncertain' | 'stale' }
  | { kind: 'received'; row: ClaimJournal; ownedId: number | null };
const writers = new Set<number>();
let serial = 0;
export const productCouponClaimKey = (uid: number) => `cinashop-product-coupon-claim-v1-${uid}`;
const validId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
function journal(uid: number): ClaimJournal | null {
  const raw = uni.getStorageSync(productCouponClaimKey(uid));
  if (raw === undefined || raw === null || raw === '') return null;
  const invalid = () => Error('原领券恢复资料暂不可读取，请到我的优惠券核对');
  if (typeof raw !== 'string' || raw.length > 2048) throw invalid();
  let row: Record<string, unknown>;
  try { row = JSON.parse(raw); } catch { throw invalid(); }
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'attempt,couponId,productId,title,uid,version'
    || row.version !== 1 || row.uid !== uid || !validId(row.productId) || !validId(row.couponId)
    || typeof row.title !== 'string' || [...row.title].length > 255 || /[\u0000-\u001f\u007f]/u.test(row.title)
    || typeof row.attempt !== 'string' || !/^\d{1,16}:\d{1,12}$/u.test(row.attempt)) throw invalid();
  return row as unknown as ClaimJournal;
}
export const readProductCouponClaimJournal = journal;
function save(row: ClaimJournal) {
  const raw = JSON.stringify(row); uni.setStorageSync(productCouponClaimKey(row.uid), raw);
  if (uni.getStorageSync(productCouponClaimKey(row.uid)) !== raw) throw Error('领券恢复记录未能保存，本次没有提交领取');
}
async function exclusive(uid: number, action: () => Promise<void>) {
  // #ifdef H5
  if (typeof window !== 'undefined') {
    if (!window.navigator?.locks?.request) throw Error('当前浏览器暂不能领取，请到我的优惠券查看原领取结果');
    await window.navigator.locks.request(`cinashop-product-coupons-${uid}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw Error('另一页面正在领取，请稍后核对原领取结果');
      await action();
    }); return;
  }
  // #endif
  if (writers.has(uid)) throw Error('另一页面正在领取，请稍后核对原领取结果');
  writers.add(uid); try { await action(); } finally { writers.delete(uid); }
}
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

/** Unknown ordinary grants are never replayed or forgotten. A zero receipt is
 * only an observation: the original transaction may still be in flight. */
export function useProductCoupons(productId: Ref<number>, active: Ref<boolean>) {
  const auth = useAuthStore(), state = reactive({ page: null as ProductCouponPage | null, items: [] as ProductCoupon[], loading: false, loadingMore: false,
    error: '', actionError: '', notice: '', invalidPagination: false, writingId: 0, checking: false, pending: null as ClaimJournal | null,
    journalBlocked: false, expanded: [] as number[], confirmed: [] as number[], confirmedOwnedId: 0, confirmedIssue: 0 });
  const requests = new Set<ProductCouponRequests>();
  let generation = 0, disposed = false, browserVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  function persisted() {
    try { return String(uni.getStorageSync('uni_token') || '') === auth.token && (Number(uni.getStorageSync('uni_uid')) || 0) === auth.uid; } catch { return false; }
  }
  const current = () => !disposed && active.value && browserVisible && validId(productId.value) && persisted();
  const loggedIn = computed(() => !!auth.token && validId(auth.uid) && persisted());
  function scope() {
    const epoch = generation, id = productId.value;
    const r = createProductCouponRequests(() => current() && epoch === generation && id === productId.value);
    requests.add(r); return r;
  }
  function finish(r: ProductCouponRequests) { requests.delete(r); r.abort(); }
  function clear() {
    generation++; for (const r of requests) r.abort(); requests.clear();
    Object.assign(state, { page: null, items: [], loading: false, loadingMore: false, error: '', actionError: '', notice: '', invalidPagination: false,
      writingId: 0, checking: false, pending: null, journalBlocked: false, expanded: [], confirmed: [], confirmedOwnedId: 0, confirmedIssue: 0 });
  }
  function restore() {
    state.pending = null; state.journalBlocked = false;
    if (!loggedIn.value) return;
    try { state.pending = journal(auth.uid); } catch (error) { state.journalBlocked = true; state.actionError = message(error, '原领券恢复资料暂不可读取'); }
  }
  async function load(more = false) {
    if (!current() || state.loading || state.loadingMore || state.writingId || state.checking || more && (!state.page || state.invalidPagination || state.items.length >= state.page.total)) return;
    restore(); const r = scope(), id = productId.value, page = more ? state.page!.page + 1 : 1;
    if (!more) { state.page = null; state.items = []; state.expanded = []; state.invalidPagination = false; }
    state.error = ''; state[more ? 'loadingMore' : 'loading'] = true;
    try {
      const fresh = await r.list(id, page); if (!r.active()) return;
      if (more && (fresh.total !== state.page!.total || fresh.items.some(item => state.items.some(old => old.id === item.id)))) {
        state.invalidPagination = true; throw Error('优惠券目录已变化，请刷新完整目录后继续查看');
      }
      state.items = more ? [...state.items, ...fresh.items] : fresh.items; state.page = fresh;
    } catch (error) { if (r.active()) state.error = message(error, '商品优惠券读取失败，请重新读取'); }
    finally { if (r.active()) state[more ? 'loadingMore' : 'loading'] = false; finish(r); }
  }
  function received(item: ProductCoupon) { return item.receivedCount > 0 || state.confirmed.includes(item.id); }
  function canClaim(item: ProductCoupon) {
    if (!current() || !loggedIn.value || state.loading || state.loadingMore || state.writingId || state.checking || state.error || state.pending || state.journalBlocked || !item.claimable || received(item)) return false;
    try { return journal(auth.uid) === null; } catch { return false; }
  }
  function sameJournal(row: ClaimJournal) {
    const live = journal(row.uid); return !!live && live.attempt === row.attempt && live.couponId === row.couponId && live.productId === row.productId;
  }
  function remove(row: ClaimJournal) {
    if (!sameJournal(row)) throw Error('原领取记录已变化，请重新核对');
    uni.removeStorageSync(productCouponClaimKey(row.uid));
    if (uni.getStorageSync(productCouponClaimKey(row.uid))) throw Error('已确认领取，本机记录暂未清理，请继续核对原领取状态');
    state.pending = null;
  }
  function confirmed(row: ClaimJournal, ownedId: number | null) {
    state.confirmedOwnedId = ownedId ?? 0; state.confirmedIssue = row.couponId;
    if (row.productId === productId.value && !state.confirmed.includes(row.couponId)) state.confirmed.push(row.couponId);
    state.notice = '当前账号已领取该优惠券，可在我的优惠券中查看'; state.actionError = '';
    try { remove(row); } catch (error) { state.actionError = message(error, '已领取，本机记录暂未清理'); }
  }
  async function claim(couponId: number, hooks: ProductCouponClaimHooks = {}, purchase?: { title: string }): Promise<ProductCouponClaimOutcome> {
    const item = state.items.find(row => row.id === couponId);
    if (purchase ? !validId(couponId) || !current() || !loggedIn.value || state.loading || state.loadingMore || state.writingId || state.checking || state.journalBlocked
      : !item || !canClaim(item)) return { kind: 'not-sent' };
    let outcome: ProductCouponClaimOutcome = { kind: 'not-sent' };
    const r = scope(), uid = r.owner.uid, id = productId.value; state.writingId = couponId; state.actionError = ''; state.notice = '';
    state.confirmedIssue = 0; state.confirmedOwnedId = 0;
    try {
      await exclusive(uid, async () => {
        if (!r.active()) return;
        if (journal(uid)) throw Error('请先核对原领取结果');
        const row: ClaimJournal = { version: 1, uid, productId: id, couponId, title: purchase?.title ?? item!.title, attempt: `${Date.now()}:${++serial}` };
        save(row); state.pending = row;
        // A purchase sidecar must record this exact claim attempt before the
        // sole POST. A failed preflight is known-unsent, not an unknown grant.
        try { hooks.beforeDispatch?.(row); }
        catch (error) { try { remove(row); } catch { /* A remaining record is still a blocker. */ } throw error; }
        try {
          outcome = { kind: 'uncertain' };
          const ownedId = await r.claim(couponId); if (!r.active() || !sameJournal(row)) { outcome = { kind: 'stale' }; return; }
          hooks.beforeConfirm?.(row, ownedId, 'grant');
          outcome = { kind: 'received', row, ownedId };
          confirmed(row, ownedId); state.writingId = 0; await load();
        } catch (error) {
          if (!r.active()) { outcome = { kind: 'stale' }; return; }
          // Only the controller's successful-HTTP business400 denotes a
          // rolled-back initial grant. Transport/5xx/shape/owner failures stay unknown.
          if (error instanceof RequestError && error.status === 400 && error.httpStatus !== undefined && error.httpStatus >= 200 && error.httpStatus < 300) {
            try { remove(row); } catch { /* Preserve the original durable evidence. */ }
            outcome = { kind: 'rejected' };
            state.actionError = message(error, '优惠券领取未成功');
          } else state.actionError = '领取结果尚未确认，请核对领取状态；不要重复提交';
        }
      });
    } catch (error) { if (r.active()) { restore(); state.actionError = message(error, '领取暂不可操作，请核对原领取结果'); } }
    finally { if (r.active()) state.writingId = 0; finish(r); }
    return outcome;
  }
  async function check(hooks: ProductCouponClaimHooks = {}): Promise<ProductCouponClaimOutcome> {
    if (!current() || !loggedIn.value || state.loading || state.loadingMore || state.writingId || state.checking) return { kind: 'not-sent' };
    restore(); const row = state.pending; if (!row) return { kind: 'not-sent' };
    let outcome: ProductCouponClaimOutcome = { kind: 'uncertain' };
    const r = scope(); state.checking = true; state.actionError = ''; state.notice = '';
    try {
      const receipt = await r.receipt(row.productId, row.couponId); if (!r.active() || !sameJournal(row)) return { kind: 'stale' };
      if (receipt.receivedCount > 0) {
        hooks.beforeConfirm?.(row, receipt.latestCouponUserId, 'receipt');
        outcome = { kind: 'received', row, ownedId: receipt.latestCouponUserId };
        confirmed(row, receipt.latestCouponUserId); state.checking = false; await load();
      }
      else state.notice = '暂未查到领取记录，原请求仍可能处理中。请稍后再次核对，当前不会重复领取';
    } catch (error) { if (r.active()) state.actionError = message(error, '领取状态核对失败，请重试核对'); }
    finally { if (r.active()) state.checking = false; finish(r); }
    return outcome;
  }
  function toggleRule(id: number) {
    if (!current() || !state.items.some(item => item.id === id && item.rule)) return;
    state.expanded = state.expanded.includes(id) ? state.expanded.filter(value => value !== id) : [...state.expanded, id];
  }
  function navigate(url: string) {
    if (!current() || state.writingId) return; const r = scope();
    const fail = () => { if (r.active()) state.actionError = '页面暂未打开，请重试'; finish(r); };
    try { uni.navigateTo({ url, fail, success: () => finish(r) }); } catch { fail(); }
  }
  function wallet() { if (loggedIn.value) navigate('/pages/user/coupon'); }
  function login() { if (!loggedIn.value) navigate('/pages/auth/login'); }
  function membership() { if (loggedIn.value) navigate('/pages/user/vipOpen'); }
  function reload() { clear(); if (current()) void load(); }
  watch(() => [active.value, productId.value, auth.uid, auth.token, auth.sessionVersion], () => {
    clear(); void Promise.resolve().then(() => { if (current()) void load(); });
  }, { immediate: true, flush: 'sync' });
  function changed() {
    if (disposed || !active.value) return;
    let token = '', uid = 0;
    try { token = String(uni.getStorageSync('uni_token') || ''); uid = Number(uni.getStorageSync('uni_uid')) || 0; } catch { clear(); return; }
    if (token !== auth.token || uid !== auth.uid) { clear(); auth.$patch({ token, uid, sessionVersion: auth.sessionVersion + 1 }); }
    else reload();
  }
  function visibility() { browserVisible = document.visibilityState !== 'hidden'; reload(); }
  // #ifdef H5
  if (typeof window !== 'undefined') { window.addEventListener('focus', changed); window.addEventListener('storage', changed); }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
  // #endif
  onScopeDispose(() => {
    disposed = true; clear();
    // #ifdef H5
    if (typeof window !== 'undefined') { window.removeEventListener('focus', changed); window.removeEventListener('storage', changed); }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility);
    // #endif
  });
  function date(value: number | null) { return value === null ? '' : new Date((value + 8 * 3600) * 1000).toISOString().slice(0, 10); }
  function validity(item: ProductCoupon) {
    if (item.validity.kind === 'relative') return `领取后 ${item.validity.days} 天内可用`;
    const start = date(item.validity.startTime), end = date(item.validity.endTime);
    return start && end ? `${start} 至 ${end} 可用` : end ? `有效期至 ${end}` : start ? `${start} 起可用` : '有效期以我的优惠券为准';
  }
  function amount(item: ProductCoupon) { return item.benefitType === 1 ? `¥${item.benefitValue}` : `${Number(item.benefitValue) / 10} 折`; }
  return { state, loggedIn, load, claim, check,
    // Only the purchase coordinator supplies this frozen issue. The server
    // rechecks grant eligibility; a stale catalogue item never authorizes it.
    claimForPurchase: (id: number, title: string, hooks: ProductCouponClaimHooks) => claim(id, hooks, { title }),
    toggleRule, received, canClaim, wallet, login, membership, validity, amount,
    scope: (value: number) => ['通用券', '品类券', '商品券', '品牌券'][value] ?? '优惠券',
    retry: () => load(!!state.page && !state.invalidPagination), hasMore: computed(() => !!state.page && state.items.length < state.page.total) };
}
