import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useCartStore } from '@/stores/cart';
import { apiGoodsDetail } from '@/api/product';
import { apiCartAdd, apiCartDel } from '@/api/order';
import type { GoodsDetail, GoodsSku } from '@/types/product';
import { ordinaryRecoveryKey, parseOrdinaryRecovery, type CategoryProduct, type OrdinaryCartRecovery as Recovery } from '../../../common/categoryCatalog';
import { prepareProductCart, type PreparedProductCart } from '../../../common/preparedProductCart';
import { skuDisplayPrice } from '../../../common/skuMembershipPrice';

/** Ordinary type-0 purchase. Catalogue/SKU prices are display only; checkout owns the quote. */
export function useCategoryPurchase(visible: Ref<boolean>) {
  const auth = useAuthStore(), cart = useCartStore();
  const detail = shallowRef<GoodsDetail | null>(null), selected = ref(''), quantity = ref<number | string>(1);
  const opened = ref(false), loading = ref(false), buying = ref(false), navigating = ref(false), needsRefresh = ref(false), error = ref('');
  const prepared = shallowRef<PreparedProductCart | null>(null), cartOpen = ref(false);
  const recovery = shallowRef<Recovery | null>(null), recoveryInvalid = ref(false);
  const recoveryKey = ordinaryRecoveryKey;
  const mode = ref<'cart' | 'buy'>('cart'); let generation = 0, navigationVersion = 0, productId = 0;
  const sku = computed(() => detail.value?.skus.find(item => item.unique === selected.value));
  const maximum = computed(() => Math.min(sku.value?.stock ?? 0, detail.value?.stock ?? 0, 32767));
  const locked = computed(() => loading.value || buying.value || navigating.value || needsRefresh.value || prepared.value !== null || recovery.value !== null || recoveryInvalid.value);
  const price = computed(() => sku.value ? skuDisplayPrice(sku.value) : null);
  function owner() {
    const life = generation, version = auth.sessionVersion, token = auth.token, uid = auth.uid;
    return () => visible.value && life === generation && version === auth.sessionVersion && token === auth.token && uid === auth.uid;
  }
  function reset() { generation++; navigationVersion++; detail.value = null; selected.value = ''; quantity.value = 1; opened.value = false; loading.value = false; buying.value = false; navigating.value = false; prepared.value = null; recovery.value = null; recoveryInvalid.value = false; needsRefresh.value = false; cartOpen.value = false; error.value = ''; }
  function saveRecovery(value: Recovery) { uni.setStorageSync(recoveryKey(value.actor), JSON.stringify(value)); recovery.value = value; }
  function restore() {
    if (!visible.value || !auth.isLoggedIn || auth.uid < 1) return;
    const raw = uni.getStorageSync(recoveryKey(auth.uid)); if (raw === undefined || raw === null || raw === '') return;
    try {
      const row = parseOrdinaryRecovery(raw, auth.uid);
      recovery.value = row; productId = row.productId;
      if (row.state === 'acknowledged' && row.mode === 'buy') { prepared.value = prepareProductCart({id:row.cartId},0); error.value = '已加入本次购买记录，可继续同一笔结算'; }
      else if (row.state === 'acknowledged') error.value = '商品已加入购物车，请重新读取购物车报价';
      else { needsRefresh.value = true; error.value = '上次加购结果尚未确认。可读取购物车核对，不能再次提交该购买意图'; }
    } catch { recoveryInvalid.value = true; needsRefresh.value = true; error.value = '本账号购买恢复资料异常，请在购物车核对；当前页面暂停加购'; }
  }
  function navigate(url: string, failed = '页面打开失败，请重试') {
    if (!visible.value || navigating.value) return;
    const current = owner(), version = ++navigationVersion; navigating.value = true;
    const fail = () => { if (current() && version === navigationVersion) { navigating.value = false; error.value = failed; } };
    try { uni.navigateTo({ url, fail, success: () => { if (current() && version === navigationVersion) navigating.value = false; } }); } catch { fail(); }
  }
  function goDetail(product: Pick<CategoryProduct, 'id' | 'is_presale_product'>) {
    if (!visible.value || buying.value || navigating.value) return;
    navigate(product.is_presale_product ? `/pages/activity/presaleDetail?id=${product.id}` : `/pages/goods/detail?id=${product.id}`);
  }
  function special(goods: GoodsDetail): boolean { return goods.is_presale_product === 1 || goods.cart_button === 0 || (goods.product_type ?? 0) > 0 || (goods.system_form_id ?? 0) > 0; }
  async function read(id: number) {
    const current = owner(); loading.value = true; error.value = '';
    try {
      const result = await apiGoodsDetail(id);
      if (!current() || id !== productId) return;
      if (special(result)) { opened.value = false; navigate(result.is_presale_product ? `/pages/activity/presaleDetail?id=${id}` : `/pages/goods/detail?id=${id}`); return; }
      detail.value = result; selected.value = result.skus.find(item => item.stock > 0)?.unique ?? result.skus[0]?.unique ?? ''; quantity.value = 1;
    } catch (e) { if (current()) error.value = e instanceof Error ? e.message : '规格读取失败'; }
    finally { if (current()) loading.value = false; }
  }
  async function open(product: CategoryProduct, requestedMode: 'cart' | 'buy' = 'cart', quickSingle = false) {
    if (!visible.value || locked.value || cart.updating) return;
    if (product.is_presale_product || product.cart_button === 0) { goDetail(product); return; }
    if (!auth.isLoggedIn) { navigate('/pages/auth/login'); return; }
    reset(); productId = product.id; mode.value = requestedMode; opened.value = true;
    await read(product.id);
    if (quickSingle && opened.value && detail.value?.id === product.id && detail.value.skus.length === 1 && maximum.value > 0) await purchase();
  }
  function choose(unique: string) {
    if (!visible.value || locked.value || !detail.value) return;
    const target = detail.value.skus.find(item => item.unique === unique); if (!target) return;
    selected.value = unique; quantity.value = typeof quantity.value === 'number' && Number.isSafeInteger(quantity.value) ? Math.max(1, Math.min(quantity.value, maximum.value)) : 1;
  }
  function setQuantity(value: unknown) {
    if (!visible.value || locked.value) return;
    const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
    quantity.value = /^[1-9]\d{0,4}$/u.test(raw) ? Number(raw) : raw;
  }
  function step(diff: -1 | 1) { if (maximum.value > 0) setQuantity(Math.max(1, Math.min((typeof quantity.value === 'number' ? quantity.value : 1) + diff, maximum.value))); }
  function continueCheckout() {
    if (!visible.value || !auth.isLoggedIn || !prepared.value || navigating.value) return;
    navigate(`/pages/order/confirm?mode=buy&cartId=${prepared.value.ids[0]}&from=sku`, '结算页面未打开，请点击继续结算，无需重新加购');
  }
  async function purchase() {
    if (prepared.value) { continueCheckout(); return; }
    if (!visible.value || locked.value || !detail.value || !sku.value || !auth.isLoggedIn || special(detail.value)) return;
    if (typeof quantity.value !== 'number' || !Number.isSafeInteger(quantity.value) || quantity.value < 1 || quantity.value > maximum.value) { error.value = '请输入库存范围内的整数数量'; return; }
    const current = owner(), input = { productId: detail.value.id, unique: sku.value.unique, cartNum: quantity.value, type: 0, new: mode.value === 'buy' ? 1 as const : 0 as const };
    const frozen: Recovery = { version: 1, actor: auth.uid, state: 'unknown', mode: mode.value, productId: input.productId, unique: input.unique, quantity: input.cartNum, cartId: null };
    if (uni.getStorageSync(recoveryKey(auth.uid))) { restore(); return; }
    try { saveRecovery(frozen); } catch { error.value = '无法保存购买恢复资料，本次尚未提交'; return; }
    buying.value = true; error.value = '';
    try {
      const result = prepareProductCart(await apiCartAdd(input), 0);
      if (!current()) return;
      const acknowledged: Recovery = { ...frozen, state: 'acknowledged', cartId: result.ids[0] };
      // Record success before any secondary I/O or navigation. A failed read must never repeat add.
      saveRecovery(acknowledged);
      if (mode.value === 'buy') { prepared.value = result; continueCheckout(); }
      else { opened.value = false; await cart.fetchList(); if (current()) { uni.removeStorageSync(recoveryKey(frozen.actor)); recovery.value = null; void cart.fetchCount(); uni.showToast({ title: '已加入购物车', icon: 'success' }); } }
    } catch (e) {
      if (current()) { needsRefresh.value = true; error.value = e instanceof Error ? e.message : '加购结果未确认，请重新读取购物车'; }
    } finally { if (current()) buying.value = false; }
  }
  async function reread() {
    if (!visible.value || buying.value || navigating.value || !auth.isLoggedIn) return;
    const current = owner(), row = recovery.value;
    try {
      await cart.fetchList(); if (!current()) return; cartOpen.value = true;
      if (row?.state === 'acknowledged' && row.mode === 'cart') { uni.removeStorageSync(recoveryKey(row.actor)); recovery.value = null; needsRefresh.value = false; error.value = ''; }
      else if (row?.state === 'unknown' || recoveryInvalid.value) error.value = '购物车已读取，但无法证明上次加购结果；继续保留购买保护，请在购物车核对';
    } catch { if (current()) error.value = '购物车读取失败，原购买保护仍保留，请稍后重试'; }
  }
  function close() { if (!buying.value && !navigating.value) opened.value = false; }
  function quantityInCart(id: number): number { return cart.ready ? cart.items.filter(item => item.productId === id && item.type === 0 && item.isValid).reduce((n, item) => n + item.cartNum, 0) : 0; }
  async function changeCard(product: CategoryProduct, delta: -1 | 1, input?: unknown) {
    if (!visible.value || locked.value || cart.updating) return;
    if (!auth.isLoggedIn) { navigate('/pages/auth/login'); return; }
    const rows = cart.items.filter(item => item.productId === product.id && item.type === 0 && item.isValid);
    if (rows.length !== 1 || product.spec_type !== 0 || product.cart_button === 0) { if (delta > 0) await open(product, 'cart', true); else cartOpen.value = true; return; }
    const row = rows[0], next = input === undefined ? row.cartNum + delta : typeof input === 'string' && /^\d{1,5}$/u.test(input) ? Number(input) : NaN;
    if (!Number.isSafeInteger(next) || next < 0 || next > Math.min(row.productInfo?.stock ?? 0, product.stock, 32767)) { error.value = '数量无效或库存不足'; return; }
    const current=owner();
    if (next === 0) await cart.removeItem(row.id); else await cart.updateQuantity(row.id, next);
    if(current())void cart.fetchCount();
  }
  async function changeCart(id: number, delta: -1 | 1) {
    if (!visible.value || locked.value || !cart.ready || cart.updating) return;
    const row = cart.items.find(item => item.id === id && item.isValid); if (!row) return;
    const current=owner();
    if (row.cartNum + delta === 0) await cart.removeItem(id); else await cart.updateQuantity(id, row.cartNum + delta);
    if(current())void cart.fetchCount();
  }
  async function clearCart() {
    if (!visible.value || locked.value || !cart.ready || cart.updating || !cart.items.length || !auth.isLoggedIn) return;
    const current = owner(), ids = cart.items.map(row => row.id); buying.value = true;
    try { await apiCartDel(ids); if (current()) { await cart.fetchList(); void cart.fetchCount(); } }
    catch (e) { if (current()) error.value = e instanceof Error ? e.message : '清空结果未确认，请重新读取购物车'; }
    finally { if (current()) buying.value = false; }
  }
  async function checkoutCart() {
    if (!visible.value || locked.value || cart.updating || !auth.isLoggedIn) return;
    const current = owner();
    try { await cart.fetchList(); if (!current() || !cart.ready) return; cart.toggleAll(true); if (!cart.checkedItems.length) { error.value = '购物车没有可结算商品'; return; } navigate('/pages/order/confirm'); }
    catch (e) { if (current()) error.value = e instanceof Error ? e.message : '购物车读取失败'; }
  }
  watch(visible, value => { reset(); if (value) restore(); }, { flush: 'sync' });
  watch(() => auth.sessionVersion, () => { reset(); void Promise.resolve().then(restore); }, { flush: 'sync' });
  return { detail, selected, sku, quantity, maximum, locked, price, opened, loading, buying, navigating, needsRefresh, error, prepared, cartOpen, mode,
    recovery, recoveryInvalid, open, goDetail, choose, setQuantity, step, purchase, continueCheckout, reread, close, quantityInCart, changeCard, changeCart, clearCart, checkoutCart };
}
