import { computed, onBeforeUnmount, reactive, shallowReactive, watch, type Ref } from 'vue';
import { useRoute } from 'vue-router';
import { captureAuthSession, getUid, isCurrentAuthSession, onAuthChange } from '@/utils/auth';
import { apiProductDescription, apiProductDetailRecommendations, apiProductDetailCoupons, apiProductDetailCouponReceipt, apiProductDetailCouponClaim,
  type DetailRecommendation, type ProductDetailCoupon, type ProductDetailCouponPage } from '@/api/productDetailContent';

interface Claim { productId: number; couponId: number; title: string; phase: 'inflight' | 'uncertain' | 'confirmed'; checked: boolean; couponUserId?: number | null }
// Same-tab memory only. A remount, another product or a repeated login with the
// same bearer must never turn an unresolved self-claim into a second POST.
const claims = shallowReactive(new Map<string, Claim>());
const claimKey = (uid: number, token: string | null, couponId: number) => JSON.stringify([uid, token, couponId]);
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export function useProductDetailContent(productId: Ref<number>, initialDescription: Ref<string>, initialRecommendations: Ref<DetailRecommendation[]>) {
  const route = useRoute();
  const state = reactive({ page: null as ProductDetailCouponPage | null, items: [] as ProductDetailCoupon[], loading: false, loadingMore: false,
    error: '', invalidPagination: false, writingId: 0, checkingId: 0, notice: '', actionError: '',
    description: '', recommendations: [] as DetailRecommendation[], descriptionLoading: false, recommendationLoading: false,
    descriptionError: '', recommendationError: '', contentVersion: 0, recommendationVersion: 0, contentVisible: true });
  let disposed = false, visible = typeof document === 'undefined' || document.visibilityState !== 'hidden', epoch = 0, descriptionEpoch = 0, recommendationEpoch = 0;
  const session = reactive({ uid: getUid(), token: captureAuthSession().token });
  const pending = (couponId: number) => claims.get(claimKey(session.uid, session.token, couponId));
  const validProduct = () => Number.isSafeInteger(productId.value) && productId.value > 0 && productId.value <= 2147483647;
  function capture() {
    const auth = captureAuthSession(), uid = auth.token ? getUid() : 0, id = productId.value, path = route.fullPath, generation = epoch;
    return { uid, id, auth, current: () => !disposed && visible && generation === epoch && productId.value === id && route.fullPath === path && isCurrentAuthSession(auth) && (auth.token ? getUid() : 0) === uid };
  }
  function clear() {
    epoch++; descriptionEpoch++; recommendationEpoch++;
    Object.assign(state, { page: null, items: [], loading: false, loadingMore: false, error: '', invalidPagination: false, writingId: 0, checkingId: 0, notice: '', actionError: '',
      description: '', recommendations: [], descriptionLoading: false, recommendationLoading: false, descriptionError: '', recommendationError: '', contentVisible: false });
    state.contentVersion++; state.recommendationVersion++;
  }
  async function load(more = false) {
    if (!visible || disposed || !validProduct() || state.loading || state.loadingMore || state.writingId || (more && (!state.page || state.invalidPagination || state.items.length >= state.page.total))) return;
    const owner = capture(), page = more ? state.page!.page + 1 : 1;
    if (!more) { state.page = null; state.items = []; state.invalidPagination = false; }
    state.error = ''; state[more ? 'loadingMore' : 'loading'] = true;
    try {
      const result = await apiProductDetailCoupons({ uid: owner.uid, productId: owner.id, page, limit: 10 });
      if (!owner.current()) return;
      if (more && (result.total !== state.page!.total || result.items.some(item => state.items.some(old => old.id === item.id)))) {
        state.invalidPagination = true;
        throw Error('优惠券目录已变化，请刷新优惠券后继续查看');
      }
      state.items = more ? [...state.items, ...result.items] : result.items; state.page = result;
    } catch (error) { if (owner.current()) state.error = message(error, '优惠券读取失败，请重试'); }
    finally { if (owner.current()) state[more ? 'loadingMore' : 'loading'] = false; }
  }
  async function refreshDescription() {
    if (!visible || disposed || !validProduct()) return;
    const owner = capture(), generation = ++descriptionEpoch;
    state.description = ''; state.descriptionError = ''; state.descriptionLoading = true; state.contentVersion++; state.contentVisible = true;
    try { const result = await apiProductDescription(owner.id); if (owner.current() && generation === descriptionEpoch) state.description = result; }
    catch (error) { if (owner.current() && generation === descriptionEpoch) state.descriptionError = message(error, '商品正文读取失败，请重试'); }
    finally { if (owner.current() && generation === descriptionEpoch) state.descriptionLoading = false; }
  }
  async function refreshRecommendations() {
    if (!visible || disposed || !validProduct()) return;
    const owner = capture(), generation = ++recommendationEpoch;
    state.recommendations = []; state.recommendationError = ''; state.recommendationLoading = true; state.recommendationVersion++; state.contentVisible = true;
    try { const result = await apiProductDetailRecommendations(owner.id); if (owner.current() && generation === recommendationEpoch) state.recommendations = result; }
    catch (error) { if (owner.current() && generation === recommendationEpoch) state.recommendationError = message(error, '商品推荐读取失败，请重试'); }
    finally { if (owner.current() && generation === recommendationEpoch) state.recommendationLoading = false; }
  }
  function received(item: ProductDetailCoupon) { return item.receivedCount > 0 || pending(item.id)?.phase === 'confirmed'; }
  function canClaim(item: ProductDetailCoupon) { return visible && !disposed && !state.loading && !state.loadingMore && !state.writingId && !state.checkingId && !state.error && !received(item) && !pending(item.id) && (session.uid === 0 || item.claimable); }
  async function claim(couponId: number) {
    const item = state.items.find(row => row.id === couponId);
    if (!item || !canClaim(item) || !session.token || session.uid < 1) return;
    const owner = capture(), key = claimKey(owner.uid, owner.auth.token, couponId);
    if (claims.has(key)) return;
    const intent = { productId: owner.id, couponId, title: item.title };
    claims.set(key, { ...intent, phase: 'inflight', checked: false }); state.writingId = couponId; state.notice = ''; state.actionError = '';
    try {
      const couponUserId = await apiProductDetailCouponClaim(couponId);
      if (!owner.current()) { claims.set(key, { ...intent, phase: 'uncertain', checked: false }); return; }
      claims.set(key, { ...intent, phase: 'confirmed', checked: true, couponUserId }); state.notice = '优惠券领取已确认，可在我的优惠券中查看';
      state.writingId = 0;
      // The server catalogue remains authoritative; do not optimistically
      // decrement stock or change a different issuer's row.
      await load();
    } catch (error) {
      claims.set(key, { ...intent, phase: 'uncertain', checked: false });
      if (owner.current()) state.actionError = '领取结果尚未确认，请核对领取状态后再操作';
    } finally { if (owner.current()) state.writingId = 0; }
  }
  async function check(couponId: number) {
    const record = pending(couponId);
    if (!record || record.phase === 'inflight' || record.phase === 'confirmed' || state.checkingId || state.writingId || !visible || disposed || !session.token || session.uid < 1) return;
    const owner = capture(), key = claimKey(owner.uid, owner.auth.token, couponId); state.checkingId = couponId; state.actionError = ''; state.notice = '';
    try {
      const receipt = await apiProductDetailCouponReceipt({ uid: owner.uid, productId: owner.id, couponId });
      if (!owner.current() || claims.get(key) !== record) return;
      if (receipt.receivedCount > 0) {
        claims.set(key, { ...record, phase: 'confirmed', checked: true, couponUserId: receipt.latestCouponUserId });
        state.notice = '已核对当前账号领取记录，请到我的优惠券查看';
        state.checkingId = 0; await load();
      } else {
        claims.set(key, { ...record, phase: 'uncertain', checked: true });
        state.notice = '暂未查到领取记录。可结束本次操作后，重新主动领取；原请求结果仍未确认';
      }
    } catch (error) { if (owner.current()) state.actionError = message(error, '领取状态核对失败，请重试核对'); }
    finally { if (owner.current()) state.checkingId = 0; }
  }
  function finish(couponId: number) {
    const record = pending(couponId);
    if (!visible || disposed || state.checkingId || state.writingId || !record || record.phase !== 'uncertain' || !record.checked) return;
    claims.delete(claimKey(session.uid, session.token, couponId));
    state.notice = '本次操作已结束，原请求结果仍未确认；如需领取，请再次主动点击领取'; state.actionError = '';
  }
  let initial = true;
  watch(() => [productId.value, route.fullPath], () => {
    clear(); state.contentVisible = visible;
    if (initial && visible && validProduct()) { state.description = initialDescription.value; state.recommendations = initialRecommendations.value; }
    else if (visible) { void refreshDescription(); void refreshRecommendations(); }
    initial = false; if (visible) void load();
  }, { immediate: true, flush: 'sync' });
  const stopAuth = onAuthChange(() => {
    session.uid = captureAuthSession().token ? getUid() : 0; session.token = captureAuthSession().token; clear();
    if (visible && !disposed) { void load(); void refreshDescription(); void refreshRecommendations(); }
  });
  function visibility() { visible = document.visibilityState !== 'hidden'; clear(); if (visible && !disposed) { void load(); void refreshDescription(); void refreshRecommendations(); } }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
  onBeforeUnmount(() => { disposed = true; visible = false; clear(); stopAuth(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility); });
  const unlistedPending = computed(() => state.contentVisible ? [...claims.entries()].filter(([key, record]) =>
    record.productId === productId.value && record.phase !== 'confirmed' && key === claimKey(session.uid, session.token, record.couponId)
      && !state.items.some(item => item.id === record.couponId)).map(([, record]) => record) : []);
  return { state, session, pending, unlistedPending, received, canClaim, load, claim, check, finish, refreshDescription, refreshRecommendations,
    hasMore: computed(() => !!state.page && state.items.length < state.page.total), loginPath: computed(() => '/login?redirect=' + encodeURIComponent(route.fullPath)) };
}
