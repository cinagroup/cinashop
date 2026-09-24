import { computed, ref, watch } from 'vue';
import { onHide, onLoad, onReachBottom, onShow, onUnload } from '@dcloudio/uni-app';
import { useAdminSession } from '@/stores/adminSession';
import { useAssistedDraft } from '@/stores/assistedDraft';
import { apiAssistedProducts, apiAssistedSkus, apiAssistedCart, apiAssistedCartAdd, apiAssistedCartQuantity,
  apiAssistedCartDelete, ASSISTED_SELECTION_PAGE_SIZE, type AssistedProduct, type AssistedSku, type AssistedCartRow } from '@/api/assistedSelection';

export function useAssistedShopping() {
  const session = useAdminSession(), draft = useAssistedDraft(), visible = ref(false), boundVersion = ref(-1), routeUid = ref(-1);
  const keyword = ref(''), products = ref<AssistedProduct[]>([]), loading = ref(false), loaded = ref(false), error = ref('');
  const hasMore = ref(false), nextPage = ref(1), selected = ref<AssistedProduct | null>(null), skus = ref<AssistedSku[]>([]);
  const skuKey = ref(''), quantity = ref(1), skuLoading = ref(false), skuError = ref('');
  const cart = ref<AssistedCartRow[]>([]), cartLoading = ref(false), cartLoaded = ref(false), cartError = ref(''), note = ref('');
  const reviewRead = ref(false), confirming = ref(false);
  const canUse = computed(() => draft.current && draft.version === boundVersion.value && draft.scope?.uid === routeUid.value
    && session.canAssist && session.permissions.includes('product.view'));
  const blocked = computed(() => !canUse.value || draft.checkoutLock || draft.pending || draft.needsReview || cartLoading.value || !cartLoaded.value || !!cartError.value || confirming.value);
  const canCheckout = computed(() => !blocked.value && !!cart.value.length && cart.value.every(row => row.valid)
    && new Set(cart.value.map(row => row.productType)).size === 1);
  const chosenSku = computed(() => skus.value.find(sku => sku.unique === skuKey.value));
  const maxQuantity = computed(() => Math.min(chosenSku.value?.stock ?? 0, selected.value?.stock ?? 0, 32767));
  let generation = 0, catalogEpoch = 0, skuEpoch = 0, cartEpoch = 0, applied = '';
  const current = (epoch: number) => visible.value && canUse.value && generation === epoch;
  function clearSku() { skuEpoch++; selected.value = null; skus.value = []; skuKey.value = ''; quantity.value = 1; skuLoading.value = false; skuError.value = ''; }
  function reset() {
    generation++; catalogEpoch++; cartEpoch++; clearSku(); products.value = []; loading.value = false; loaded.value = false;
    error.value = ''; hasMore.value = false; nextPage.value = 1; cart.value = []; cartLoading.value = false; cartLoaded.value = false;
    cartError.value = ''; note.value = ''; reviewRead.value = false; confirming.value = false;
  }
  async function load(append = false) {
    session.ensureFresh();
    if (!visible.value || !canUse.value || draft.pending || confirming.value) return;
    if (append && (loading.value || !hasMore.value)) return;
    if (!append) { catalogEpoch++; clearSku(); products.value = []; loaded.value = false; hasMore.value = false; nextPage.value = 1; applied = keyword.value.trim(); }
    const epoch = generation, request = catalogEpoch, page = nextPage.value;
    loading.value = true; error.value = '';
    try {
      const rows = await apiAssistedProducts(page, applied);
      if (!current(epoch) || request !== catalogEpoch) return;
      if (append && rows.some(row => products.value.some(old => old.id === row.id))) throw Error('商品列表已变化，请重新查询');
      products.value = append ? [...products.value, ...rows] : rows; loaded.value = true;
      nextPage.value = page + 1; hasMore.value = rows.length === ASSISTED_SELECTION_PAGE_SIZE && page < 10_000;
    } catch (e) { if (current(epoch) && request === catalogEpoch) error.value = message(e); }
    finally { if (current(epoch) && request === catalogEpoch) loading.value = false; }
  }
  async function selectProduct(id: number) {
    session.ensureFresh();
    if (!visible.value || blocked.value || loading.value || error.value) return;
    const product = products.value.find(row => row.id === id);
    if (!product || product.presale || product.stock <= 0) return;
    clearSku(); selected.value = product; skuLoading.value = true;
    const epoch = generation, request = skuEpoch;
    try {
      const rows = await apiAssistedSkus(id);
      if (!current(epoch) || request !== skuEpoch) return;
      skus.value = rows; if (!rows.length) skuError.value = '没有可购买的规格';
    } catch (e) { if (current(epoch) && request === skuEpoch) skuError.value = message(e); }
    finally { if (current(epoch) && request === skuEpoch) skuLoading.value = false; }
  }
  function selectSku(key: string) {
    session.ensureFresh();
    if (!visible.value || blocked.value || skuLoading.value || !skus.value.some(sku => sku.unique === key && sku.stock > 0)) return;
    skuKey.value = key; quantity.value = 1;
  }
  async function refreshCart(internal = false): Promise<boolean> {
    session.ensureFresh();
    if (!visible.value || !canUse.value || !draft.scope || (!internal && (draft.pending || confirming.value))) return false;
    const epoch = generation, request = ++cartEpoch;
    cartLoading.value = true; cartLoaded.value = false; cart.value = []; cartError.value = ''; reviewRead.value = false;
    try {
      const rows = await apiAssistedCart({ ...draft.scope });
      if (!current(epoch) || request !== cartEpoch) return false;
      cart.value = rows; cartLoaded.value = true; reviewRead.value = draft.needsReview; return true;
    } catch (e) { if (current(epoch) && request === cartEpoch) cartError.value = message(e); return false; }
    finally { if (current(epoch) && request === cartEpoch) cartLoading.value = false; }
  }
  // No optimistic edits or automatic retry: add is additive, not idempotent.
  async function mutate(write: () => Promise<unknown>) {
    if (draft.checkCheckout()) { note.value = '存在待确认订单，请先恢复原订单结果'; return; }
    const owner = { admin: session.version, draft: draft.version }, epoch = generation;
    const owns = () => session.version === owner.admin && draft.version === owner.draft;
    draft.pending = true; draft.needsReview = true; reviewRead.value = false; note.value = '';
    try {
      await write();
      if (!owns()) return;
      if (current(epoch) && await refreshCart(true)) {
        if (owns() && current(epoch)) { draft.needsReview = false; reviewRead.value = false; note.value = '服务器已确认操作，购物车已重新读取。'; }
      }
    } catch (e) {
      if (owns() && current(epoch)) note.value = `操作未确认：${message(e)}。不要重复提交；请重新读取并人工核对购物车。`;
    } finally { if (owns()) draft.pending = false; }
  }
  async function add() {
    session.ensureFresh();
    if (!visible.value || blocked.value || skuLoading.value || !selected.value || !chosenSku.value || !draft.scope) return;
    if (!Number.isSafeInteger(quantity.value) || quantity.value < 1 || quantity.value > maxQuantity.value) { skuError.value = '数量无效或库存不足'; return; }
    const scope = { ...draft.scope }, sku = { ...chosenSku.value }, count = quantity.value;
    skuError.value = ''; await mutate(() => apiAssistedCartAdd(scope, sku, count));
  }
  async function changeQuantity(id: number, delta: number) {
    session.ensureFresh();
    if (!visible.value || blocked.value || !draft.scope || ![-1, 1].includes(delta)) return;
    const row = cart.value.find(item => item.id === id), scope = { ...draft.scope };
    if (!row?.valid || row.quantity + delta < 1 || row.quantity + delta > Math.min(row.stock, 32767)) return;
    await mutate(() => apiAssistedCartQuantity(scope, id, row.quantity + delta));
  }
  function remove(id: number) {
    session.ensureFresh();
    if (!visible.value || blocked.value || !draft.scope || !cart.value.some(row => row.id === id)) return;
    const epoch = generation, request = cartEpoch, scope = { ...draft.scope };
    confirming.value = true;
    const failed = () => { if (current(epoch)) { confirming.value = false; note.value = '确认窗口打开失败，未发送删除请求'; } };
    try { uni.showModal({ title: '移除商品', content: '确认从当前代客购物车移除此商品？',
      success: result => {
        session.ensureFresh();
        if (!current(epoch) || request !== cartEpoch) return;
        confirming.value = false;
        if (result.confirm && !blocked.value && cart.value.some(row => row.id === id)) void mutate(() => apiAssistedCartDelete(scope, id));
      }, fail: failed }); } catch { failed(); }
  }
  function acknowledgeReview() {
    session.ensureFresh();
    if (!visible.value || !canUse.value || draft.pending || cartLoading.value || !cartLoaded.value || !reviewRead.value || cartError.value) return;
    // This is operator acknowledgement, never a claim that a timed-out write was cancelled.
    draft.needsReview = false; reviewRead.value = false; clearSku(); note.value = '已人工核对当前购物车；若此前请求超时，仍需留意迟到的服务器处理。';
  }
  function chooseBuyer() {
    session.ensureFresh();
    if (draft.pending || draft.needsReview || confirming.value) return;
    uni.navigateTo({ url: '/pages/behalf/user_list/index' });
  }
  function recoverCheckout() { session.ensureFresh(); if (session.authenticated && session.canAssist) uni.navigateTo({ url: '/pages/behalf/order_confirm/index?resume=1' }); }
  function checkout() {
    session.ensureFresh();
    if (draft.checkCheckout()) { recoverCheckout(); return; }
    if (visible.value && canCheckout.value && draft.scope) uni.navigateTo({ url: `/pages/behalf/order_confirm/index?uid=${draft.scope.uid}` });
  }
  watch(() => session.version, reset, { flush: 'sync' }); watch(() => draft.version, reset, { flush: 'sync' });
  onLoad(options => {
    const uid = String(options?.uid ?? ''); routeUid.value = /^(0|[1-9]\d{0,9})$/.test(uid) ? Number(uid) : -1;
    boundVersion.value = draft.version;
  });
  function suspend() { visible.value = false; reset(); }
  onShow(() => { session.ensureFresh(); visible.value = true; draft.checkCheckout(); void load(); void refreshCart(); }); onHide(suspend); onUnload(suspend);
  onReachBottom(() => { if (!error.value) void load(true); });
  return { session, draft, canUse, blocked, keyword, products, loading, loaded, error, hasMore, nextPage, selected, skus,
    skuKey, quantity, skuLoading, skuError, chosenSku, maxQuantity, cart, cartLoading, cartLoaded, cartError, note, reviewRead,
    confirming, canCheckout, checkout, recoverCheckout, load, selectProduct, selectSku, refreshCart, add, changeQuantity, remove, acknowledgeReview, chooseBuyer };
}
function message(error: unknown) { return error instanceof Error ? error.message : '代客操作失败'; }
