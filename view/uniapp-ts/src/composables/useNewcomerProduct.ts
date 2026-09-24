import { computed, ref, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiNewcomerProductDetail, type NewcomerProductDetail } from '@/api/newcomer';
import { apiCartAdd } from '@/api/order';

export function useNewcomerProduct() {
  const auth = useAuthStore();
  const detail = ref<NewcomerProductDetail | null>(null), loading = ref(false), error = ref(''), visible = ref(false);
  const selected = ref(''), buying = ref(false), navigating = ref(false), prepared = ref<number | null>(null);
  const selectedSku = computed(() => detail.value?.skus.find(sku => sku.unique === selected.value));
  const canBuy = computed(() => visible.value && !loading.value && !buying.value && !navigating.value &&
    (prepared.value !== null || !!detail.value && !!selectedSku.value && detail.value.stock > 0));
  let productId = 0, generation = 0, navigationRevision = 0, disposed = false, loginPending = false;
  const routeId = (raw: unknown) => typeof raw === 'string' && /^[1-9]\d{0,9}$/.test(raw) && Number(raw) <= 2_147_483_647 ? Number(raw) : 0;
  function clear() { generation++; navigationRevision++; detail.value = null; selected.value = ''; prepared.value = null; loading.value = false; buying.value = false; navigating.value = false; }
  function setRoute(raw: unknown) { clear(); productId = routeId(raw); error.value = productId ? '' : '新人商品链接无效'; }
  function readHashRoute() {
    // #ifdef H5
    if (typeof window !== 'undefined') {
      const hash = window.location.hash;
      const [path, query = ''] = hash.replace(/^#/, '').split('?');
      if (path !== '/pages/activity/newcomerDetail') return false;
      const ids = new URLSearchParams(query).getAll('id');
      const nextId = hash.length <= 8192 && ids.length === 1 ? routeId(ids[0]) : 0;
      if (nextId !== productId) setRoute(ids.length === 1 && nextId ? ids[0] : undefined);
      return true;
    }
    // #endif
    return false;
  }
  function hashChanged() { if (visible.value && !disposed && readHashRoute()) void load(); }
  function login() {
    if (auth.isLoggedIn || loginPending || !visible.value) return;
    loginPending = true;
    uni.navigateTo({ url: '/pages/auth/login', fail: () => { loginPending = false; error.value = '登录页面打开失败，请重试'; } });
  }
  function choose(unique: string) {
    if (!visible.value || loading.value || buying.value || navigating.value || prepared.value !== null ||
      !detail.value?.skus.some(sku => sku.unique === unique)) return;
    selected.value = unique; error.value = '';
  }
  async function load() {
    if (!visible.value || disposed || loading.value || buying.value || navigating.value || prepared.value !== null) return;
    clear();
    if (!productId) { error.value = '新人商品链接无效'; return; }
    if (!auth.isLoggedIn) { error.value = '登录后查看新人商品'; login(); return; }
    const current = ++generation, owner = auth.sessionVersion;
    error.value = ''; loading.value = true;
    try {
      const row = await apiNewcomerProductDetail(productId);
      if (current === generation && visible.value && owner === auth.sessionVersion) detail.value = row;
    } catch (cause) {
      if (current === generation && visible.value && owner === auth.sessionVersion) error.value = cause instanceof Error ? cause.message : '新人商品加载失败';
    } finally { if (current === generation) loading.value = false; }
  }
  function navigate(url: string, onFailure: () => void) {
    const current = generation, revision = ++navigationRevision;
    navigating.value = true;
    const fail = () => {
      if (current !== generation || revision !== navigationRevision || !visible.value || disposed) return;
      navigating.value = false; onFailure();
    };
    try { uni.navigateTo({ url, fail }); } catch { fail(); }
  }
  function goCheckout(id: number) {
    navigate(`/pages/order/confirm?mode=buy&cartId=${id}&type=7&newcomerId=${productId}`,
      () => { error.value = '结算页面打开失败，可继续结算，无需重新加购'; });
  }
  async function purchase() {
    if (!canBuy.value) return;
    if (!auth.isLoggedIn) { login(); return; }
    if (prepared.value !== null) { goCheckout(prepared.value); return; }
    const row = detail.value, sku = selectedSku.value;
    if (!row || !sku || row.id !== productId) return;
    const current = generation, owner = auth.sessionVersion;
    buying.value = true; error.value = '';
    try {
      const cart = await apiCartAdd({ productId: row.productId, unique: sku.unique, cartNum: 1,
        type: 7, activityId: row.id, new: 1 });
      if (current !== generation || !visible.value || disposed || owner !== auth.sessionVersion) return;
      if (!Number.isSafeInteger(cart.id) || cart.id <= 0) throw new Error('新人专享加购响应无效，请刷新活动');
      prepared.value = cart.id; goCheckout(cart.id);
    } catch (cause) {
      if (current === generation && visible.value && owner === auth.sessionVersion) {
        // A rejected add can reflect a changed campaign, SKU or eligibility.
        // Reload before another attempt instead of trusting the stale display.
        detail.value = null; selected.value = '';
        error.value = cause instanceof Error ? cause.message : '加购失败，请刷新活动重新选择';
      }
    } finally { if (current === generation) buying.value = false; }
  }
  watch(() => auth.sessionVersion, () => {
    clear();
    if (!visible.value) return;
    if (auth.isLoggedIn) void load();
    else error.value = '登录后查看新人商品';
  }, { flush: 'sync' });
  onLoad(query => { setRoute(query?.id); });
  onShow(() => { if (!disposed) { visible.value = true; loginPending = false; readHashRoute(); void load(); } });
  onHide(() => { visible.value = false; loginPending = false; clear(); });
  // #ifdef H5
  if (typeof window !== 'undefined') window.addEventListener('hashchange', hashChanged);
  // #endif
  onUnload(() => {
    disposed = true; visible.value = false; clear();
    // #ifdef H5
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', hashChanged);
    // #endif
  });
  return { auth, detail, selected, selectedSku, loading, buying, navigating, prepared, canBuy, error, visible, choose, load, login, purchase };
}
