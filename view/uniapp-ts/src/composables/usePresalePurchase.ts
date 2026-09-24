import { computed, ref, shallowRef, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiPresaleSelection } from '@/api/presale';
import { apiCartAdd } from '@/api/order';
import { RequestError } from '@/utils/request';
import { presaleProductId, presaleOpen, presaleCartInput, presaleCheckoutQuery,
  type PresaleSelection } from '../../../common/presalePurchase';

export function usePresalePurchase() {
  const auth = useAuthStore(), productId = ref(0), visible = ref(false);
  const detail = shallowRef<PresaleSelection | null>(null), selected = ref(''), quantity = ref<number | string>(1);
  const loading = ref(false), buying = ref(false), navigating = ref(false), error = ref(''), prepared = ref<number | null>(null), clock = ref(Date.now());
  let generation = 0, navigationRevision = 0, pageRevision = 0, visibilityRevision = 0, disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let loginSelection: { id: number; unique: string; quantity: number } | null = null;
  const selectedSku = computed(() => detail.value?.skus.find(sku => sku.unique === selected.value));
  const open = computed(() => !!detail.value && presaleOpen(detail.value, clock.value));
  const locked = computed(() => buying.value || navigating.value || prepared.value !== null);
  const canBuy = computed(() => visible.value && !loading.value && !buying.value && !navigating.value && !!detail.value &&
    (prepared.value !== null || open.value && !!selectedSku.value && typeof quantity.value === 'number' &&
      Number.isSafeInteger(quantity.value) && quantity.value > 0 && quantity.value <= selectedSku.value.max_quantity));
  function reset() {
    generation++; navigationRevision++; navigating.value = false; buying.value = false;
    detail.value = null; selected.value = ''; quantity.value = 1; prepared.value = null; loading.value = false;
  }
  function choose(key: string) {
    if (!visible.value || locked.value || loading.value || !detail.value?.skus.some(sku => sku.unique === key && sku.max_quantity > 0)) return;
    selected.value = key; quantity.value = 1; error.value = '';
  }
  async function load() {
    if (!visible.value || !productId.value || disposed || locked.value) return;
    const current = ++generation;
    detail.value = null; selected.value = ''; quantity.value = 1; error.value = ''; loading.value = true;
    try {
      const result = await apiPresaleSelection(productId.value);
      if (current !== generation || !visible.value || disposed) return;
      detail.value = result;
      const resume = loginSelection; loginSelection = null;
      if (resume?.id === result.product_id) {
        const sku = result.skus.find(sku => sku.unique === resume.unique && sku.max_quantity > 0);
        if (sku) {
          selected.value = sku.unique; quantity.value = resume.quantity;
          if (resume.quantity > sku.max_quantity) error.value = '返回时库存或限购已变化，请重新确认数量';
        } else error.value = '原规格已失效，请重新选择';
      }
    } catch (e) { if (current === generation && visible.value) error.value = e instanceof Error ? e.message : '预售规格加载失败'; }
    finally { if (current === generation && visible.value) loading.value = false; }
  }
  function navigate(url: string, onFailure: () => void) {
    const current = generation, revision = ++navigationRevision;
    navigating.value = true;
    const fail = () => {
      if (current !== generation || revision !== navigationRevision || !visible.value || disposed) return;
      navigating.value = false; onFailure();
    };
    // Native success precedes onHide; retain the gate until that boundary.
    try { uni.navigateTo({ url, fail }); } catch { fail(); }
  }
  function goCheckout(id: number) {
    const query = presaleCheckoutQuery(id);
    const encoded = Object.entries(query).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    navigate(`/pages/order/confirm?${encoded}`, () => { error.value = '结算页面打开失败，可继续结算，无需重新加购'; });
  }
  async function purchase() {
    if (!canBuy.value || !detail.value) return;
    const submitted = { id: productId.value, unique: selected.value, quantity: Number(quantity.value) };
    if (!auth.isLoggedIn) {
      loginSelection = submitted;
      navigate('/pages/auth/login', () => { loginSelection = null; error.value = '登录页面打开失败，请重试'; }); return;
    }
    if (prepared.value !== null) { goCheckout(prepared.value); return; }
    const current = generation, page = pageRevision, life = visibilityRevision, identityVersion = auth.sessionVersion;
    buying.value = true; error.value = '';
    try {
      // Recheck the real clock at the write boundary, not the last UI timer tick.
      const result = await apiCartAdd(presaleCartInput(detail.value, submitted.unique, submitted.quantity));
      if (current !== generation || !visible.value || disposed) return;
      if (!Number.isSafeInteger(result.id) || result.id < 1 || result.id > 2_147_483_647) throw new Error('购买记录响应无效，请刷新商品');
      prepared.value = result.id; goCheckout(result.id);
    } catch (e) {
      if (e instanceof RequestError && e.status !== undefined && [410000, 410001, 410002].includes(e.status) &&
        !disposed && page === pageRevision && life === visibilityRevision && !auth.isLoggedIn &&
        auth.sessionVersion === identityVersion + 1 && productId.value === submitted.id) loginSelection = submitted;
      if (current === generation && visible.value) {
        detail.value = null; selected.value = '';
        error.value = e instanceof Error ? e.message : '加购失败，请刷新商品重新确认';
      }
    } finally { if (current === generation) buying.value = false; }
  }
  function setRoute(value: unknown) {
    reset(); pageRevision++; loginSelection = null; productId.value = 0;
    try { productId.value = presaleProductId(value); error.value = ''; }
    catch { error.value = '预售商品链接无效，请返回商品列表'; }
  }
  function readHashRoute(): boolean {
    // #ifdef H5
    if (typeof window !== 'undefined') {
      const hash = window.location.hash, route = hash.replace(/^#/, '').split('?');
      if (route[0] !== '/pages/activity/presaleDetail') return false;
      try {
        const ids = new URLSearchParams(route.slice(1).join('?')).getAll('id');
        if (hash.length > 8192 || ids.length !== 1) throw new Error('invalid route');
        const id = presaleProductId(ids[0]);
        if (id !== productId.value) setRoute(String(id));
      } catch { setRoute(undefined); }
      return true;
    }
    // #endif
    return false;
  }
  function hashChanged() {
    if (!visible.value || disposed) return;
    if (readHashRoute()) void load();
    // A login/checkout hash can arrive before native onHide. That lifecycle
    // clears the view; do not destroy the explicit login intent here.
  }
  function suspend() {
    visible.value = false; visibilityRevision++; reset();
    if (timer) { clearInterval(timer); timer = undefined; }
  }
  watch(() => auth.sessionVersion, () => {
    if (visible.value) loginSelection = null;
    reset(); error.value = '登录状态已变化，请刷新商品';
  }, { flush: 'sync' });
  onLoad(query => { if (!disposed) { setRoute(query?.id); if (visible.value) void load(); } });
  onShow(() => {
    if (disposed) return;
    visible.value = true; clock.value = Date.now(); readHashRoute();
    if (timer) clearInterval(timer);
    timer = setInterval(() => { clock.value = Date.now(); }, 1000); void load();
  });
  onHide(suspend);
  // #ifdef H5
  if (typeof window !== 'undefined') window.addEventListener('hashchange', hashChanged);
  // #endif
  onUnload(() => {
    disposed = true; pageRevision++; loginSelection = null; suspend();
    // #ifdef H5
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', hashChanged);
    // #endif
  });
  return { productId, visible, detail, selected, quantity, loading, buying, navigating, error, prepared,
    selectedSku, open, locked, canBuy, choose, load, purchase };
}
