import { reactive, type UnwrapNestedRefs } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { apiCartAdd } from '@/api/order';
import { checkoutApi } from '@/api/checkout';
import { createProductCouponRequests, type ProductCoupon } from '@/api/productCoupons';
import { productCouponClaimKey, readProductCouponClaimJournal, type ClaimJournal, type ProductCouponClaimHooks, type useProductCoupons } from './useProductCoupons';
import { ProductCouponBuyJournal, type ProductCouponBuyIntent } from '../../../common/productCouponBuyIntent';
import { ordinaryRecoveryKey, type OrdinaryCartRecovery } from '../../../common/categoryCatalog';
import { prepareProductCart } from '../../../common/preparedProductCart';

const writers = new Set<number>();
let serial = 0;
async function exclusive(uid: number, action: () => Promise<void>) {
  // A different lock from the existing grant lock: this flow calls that sole
  // writer only after acknowledging its original cart.
  // #ifdef H5
  if (typeof window !== 'undefined') {
    if (!window.navigator?.locks?.request) throw Error('当前浏览器暂不能领券购买，请查看原购买记录');
    await window.navigator.locks.request(`cinashop-product-coupon-buy-${uid}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw Error('另一页面正在处理原购买，请稍后核对');
      await action();
    }); return;
  }
  // #endif
  if (writers.has(uid)) throw Error('另一页面正在处理原购买，请稍后核对');
  writers.add(uid); try { await action(); } finally { writers.delete(uid); }
}
const message = (error: unknown) => error instanceof Error ? error.message : '原领券购买暂不可继续，请重新核对';

export function useProductCouponBuy(deps: {
  coupons: UnwrapNestedRefs<ReturnType<typeof useProductCoupons>>;
  productId(): number;
  capture(): () => boolean;
  navigate(url: string, fail: () => void): void;
}) {
  const auth = useAuthStore();
  const storage = { get: (key: string) => uni.getStorageSync(key), set: (key: string, value: string) => uni.setStorageSync(key, value), remove: (key: string) => uni.removeStorageSync(key) };
  const journal = new ProductCouponBuyJournal(storage);
  const state = reactive({ selected: null as { issueId: number; title: string; received: boolean } | null,
    intent: null as ProductCouponBuyIntent | null, busy: false, error: '', invalid: false });
  let generation = 0;
  function persisted() {
    try { return !!auth.token && Number(storage.get('uni_uid')) === auth.uid && storage.get('uni_token') === auth.token; } catch { return false; }
  }
  function restore() {
    state.intent = null; state.invalid = false; state.error = '';
    if (!persisted() || auth.uid < 1) return;
    try { state.intent = journal.read(auth.uid); }
    catch (error) { state.invalid = true; state.error = message(error); }
  }
  function reset() { generation++; state.selected = null; state.intent = null; state.busy = false; state.error = ''; state.invalid = false; }
  function choose(item: ProductCoupon) {
    if (!persisted() || state.busy || state.intent || state.invalid || deps.coupons.state.pending || deps.coupons.state.journalBlocked
      || !deps.coupons.state.items.includes(item) || (!deps.coupons.received(item) && !deps.coupons.canClaim(item))) return false;
    state.selected = { issueId: item.id, title: item.title, received: deps.coupons.received(item) }; state.error = ''; return true;
  }
  function sameClaim(intent: ProductCouponBuyIntent, row: ClaimJournal) {
    return row.uid === intent.uid && row.productId === intent.productId && row.couponId === intent.issueId
      && (intent.claimAttempt === null || intent.claimAttempt === row.attempt);
  }
  async function advance(initial: ProductCouponBuyIntent, current: () => boolean) {
    let intent = journal.assertCurrent(initial);
    if (!current() || !persisted()) return;
    if (intent.productId !== deps.productId()) throw Error('请返回原商品继续领券购买');
    // The original cart is re-read, never rebuilt. This also binds a restored
    // same-account intent to the current login instead of a stored epoch.
    const rows = await checkoutApi.items({ mode: 'buy', ids: intent.cartId ? [intent.cartId] : [] }, []);
    if (!current() || !persisted()) return;
    journal.assertCurrent(intent);
    const row = rows[0];
    if (rows.length !== 1 || row.id !== intent.cartId || row.type !== 0 || row.isNew !== 1 || !row.isValid
      || row.productId !== intent.productId || row.unique !== intent.unique || row.cartNum !== intent.quantity) throw Error('原购买商品、规格或数量已变化，请核对原购物车');
    const hooks: ProductCouponClaimHooks = {
      beforeDispatch(claim) {
        if (!current() || !persisted() || !sameClaim(intent, claim) || intent.phase !== 'cart-ready') throw Error('原购买状态已变化，本次没有领取');
        intent = journal.update(intent, { phase: 'claim-unknown', claimAttempt: claim.attempt }); state.intent = intent;
      },
      beforeConfirm(claim, ownedId, source) {
        if (!current() || !persisted() || intent.phase !== 'claim-unknown' || !sameClaim(intent, claim)) throw Error('请重新核对原购买领取结果');
        // A receipt's maximum ID can be spent/expired. Its count proves receipt;
        // only the current checkout picker may resolve a usable owned ID.
        intent = journal.update(intent, { phase: 'ready', evidence: source, ownedId: source === 'grant' ? ownedId : null }); state.intent = intent;
      },
    };
    // A claim save may have reached storage and failed its read-back before the
    // purchase hook ran. Adopt that exact original attempt for GET recovery;
    // never infer that an existing journal permits another POST.
    if (intent.phase === 'cart-ready' && intent.evidence === 'none') {
      const claim = readProductCouponClaimJournal(intent.uid);
      if (claim) {
        if (!sameClaim(intent, claim)) throw Error('请先核对本账号另一笔领取结果');
        intent = journal.update(intent, { phase: 'claim-unknown', claimAttempt: claim.attempt }); state.intent = intent;
      }
    }
    if (intent.phase === 'cart-ready') {
      if (intent.evidence === 'directory') { intent = journal.update(intent, { phase: 'ready' }); state.intent = intent; }
      else {
        const outcome = await deps.coupons.claimForPurchase(intent.issueId, intent.title, hooks);
        if (!current() || !persisted()) return;
        if (outcome.kind === 'rejected' || outcome.kind === 'not-sent') {
          // Only this known-unsent/rolled-back result may restore the claim
          // preflight. A surviving claim record remains a blocker.
          const live = journal.read(intent.uid);
          if (live?.attempt === intent.attempt && live.phase === 'claim-unknown' && !storage.get(productCouponClaimKey(intent.uid))) {
            intent = journal.update(live, { phase: 'cart-ready', claimAttempt: null }); state.intent = intent;
          }
          throw Error(deps.coupons.state.actionError || '本次尚未领取，请重新核对后继续原购买');
        }
        if (outcome.kind !== 'received') throw Error('原领取结果尚未确认，请核对原领取状态，不会重复提交');
      }
    } else if (intent.phase === 'claim-unknown') {
      const claim = readProductCouponClaimJournal(intent.uid);
      if (claim) {
        if (!sameClaim(intent, claim)) throw Error('领取记录不属于原购买，请先核对');
        const outcome = await deps.coupons.check(hooks);
        if (!current() || !persisted()) return;
        if (outcome.kind !== 'received') throw Error('暂未确认原领取结果，请稍后再次核对；当前不会重复领取');
      } else {
        // A separately opened coupon directory may have cleared its confirmed
        // claim journal. Reconstruct only from the exact original GET receipt.
        const r = createProductCouponRequests(current);
        try {
          const receipt = await r.receipt(intent.productId, intent.issueId);
          if (!r.active() || !current() || !persisted()) return;
          if (receipt.receivedCount <= 0) throw Error('暂未查到原领取，仍保留保护，不会重复提交');
          intent = journal.update(intent, { phase: 'ready', evidence: 'receipt', ownedId: null }); state.intent = intent;
        } finally { r.abort(); }
      }
    }
    if (!current() || !persisted()) return;
    intent = journal.assertCurrent(intent);
    if (intent.phase !== 'ready') throw Error('原购买尚未确认，请核对');
    // The ready save can succeed while its read-back or the subsequent claim
    // cleanup fails. Preserve the exact owned hint and finish only this claim.
    if (intent.claimAttempt !== null) {
      const claim = readProductCouponClaimJournal(intent.uid);
      if (claim && sameClaim(intent, claim)) {
        const outcome = await deps.coupons.check({ beforeConfirm(row) {
          if (!current() || !persisted() || !sameClaim(intent, row)) throw Error('请核对原领取记录');
          journal.assertCurrent(intent);
        } });
        if (!current() || !persisted()) return;
        if (outcome.kind !== 'received') throw Error('已保存原购买，请继续核对原领取回执');
      }
    }
    deps.navigate(`/pages/order/confirm?mode=buy&cartId=${intent.cartId}&couponBuy=${encodeURIComponent(intent.attempt)}`, () => {
      if (current()) state.error = '结算页面未打开，请继续原购买，不会重复加购或领取';
    });
  }
  async function begin(unique: string, quantity: number) {
    if (!state.selected || state.busy || state.intent || state.invalid || !persisted()) return;
    const currentView = deps.capture(), epoch = generation, current = () => currentView() && epoch === generation;
    const selected = { ...state.selected }, uid = auth.uid, productId = deps.productId(); state.busy = true; state.error = '';
    try {
      await exclusive(uid, async () => {
        if (!current() || !persisted()) return;
        if (storage.get(ordinaryRecoveryKey(uid))) throw Error('请先核对本账号原加购记录');
        const intent: ProductCouponBuyIntent = { version: 1, uid, productId, unique, quantity, issueId: selected.issueId, title: selected.title,
          attempt: `${Date.now()}:${++serial}:${Array.from({ length: 4 }, () => Math.floor(Math.random() * 65536).toString(16).padStart(4, '0')).join('')}`,
          phase: 'cart-unknown', cartId: null, ownedId: null, claimAttempt: null, evidence: selected.received ? 'directory' : 'none', decision: 'apply' };
        state.intent = journal.begin(intent);
        const ordinary: OrdinaryCartRecovery = { version: 1, actor: uid, mode: 'buy', state: 'unknown', productId, unique, quantity, cartId: null };
        if (storage.get(ordinaryRecoveryKey(uid))) throw Error('原加购记录已变化，本次尚未加购');
        const raw = JSON.stringify(ordinary); storage.set(ordinaryRecoveryKey(uid), raw);
        if (storage.get(ordinaryRecoveryKey(uid)) !== raw) throw Error('原购物车恢复资料未保存，本次尚未加购');
        journal.assertCurrent(intent);
        if (!current() || !persisted()) throw Error('登录或商品状态已变化，本次尚未加购');
        const result = await apiCartAdd({ productId, unique, cartNum: quantity, new: 1 });
        if (!current() || !persisted()) return;
        const cartId = prepareProductCart(result, 0).ids[0];
        journal.assertCurrent(intent);
        // Save the acknowledged server identity in this attempt before updating
        // the shared legacy ledger, whose format contains no attempt identity.
        state.intent = journal.update(intent, { phase: 'cart-ready', cartId });
        if (storage.get(ordinaryRecoveryKey(uid)) !== raw) throw Error('原加购记录已变化，请核对；当前不会覆盖另一笔记录');
        const ack = JSON.stringify({ ...ordinary, state: 'acknowledged', cartId }); storage.set(ordinaryRecoveryKey(uid), ack);
        if (storage.get(ordinaryRecoveryKey(uid)) !== ack) throw Error('原加购已响应，恢复资料保存失败，请核对');
        await advance(state.intent, current);
      });
    } catch (error) { if (current()) { restore(); state.error = message(error); } }
    finally { if (current()) state.busy = false; }
  }
  async function resume() {
    if (state.busy || !persisted()) return;
    const currentView = deps.capture(), epoch = generation, current = () => currentView() && epoch === generation;
    const uid = auth.uid; state.busy = true; state.error = '';
    try {
      await exclusive(uid, async () => {
        if (!current() || !persisted()) return;
        const intent = journal.read(uid); if (!intent) throw Error('原领券购买记录已不存在，请重新读取商品'); state.intent = intent;
        if (intent.productId !== deps.productId()) throw Error('请返回原商品继续原购买');
        if (intent.phase === 'cart-unknown') {
          // Matching SKU/quantity in a legacy ledger is not proof that its cart
          // belongs to this attempt. Never borrow another page's acknowledged ID.
          throw Error('原加购结果尚未确认，请到购物车核对；当前不会重复加购');
        }
        await advance(intent, current);
      });
    } catch (error) { if (current()) state.error = message(error); }
    finally { if (current()) state.busy = false; }
  }
  return { state, restore, reset, choose, begin, resume };
}
