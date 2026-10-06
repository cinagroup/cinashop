import { computed, ref, shallowRef, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiIntegralDetail,type IntegralDisplayDetail } from '@/api/activity';
import { apiCartAdd } from '@/api/order';
import { RequestError } from '@/utils/request';
import { integralActivityId, integralRouteQuery, integralCartInput, integralCheckoutUrl, integralDetailUrl, integralMaxQuantity,
  integralSelectionTotals } from '../../../common/integralPurchase';

/** One owned selection for both the mall sheet and an activity-ID detail page. */
export function useIntegralPurchase(mode: 'page' | 'dialog' = 'page') {
  const auth = useAuthStore(), activityId = ref(0), visible = ref(false), active = ref(mode === 'page');
  const detail = shallowRef<IntegralDisplayDetail | null>(null), selected = ref(''), quantity = ref<number | string>(1);
  const loading = ref(false), buying = ref(false), navigating = ref(false), error = ref(''), prepared = ref<number | null>(null);
  const needsRefresh = ref(false), referral = ref(0);
  let generation = 0, navigationRevision = 0, pageRevision = 0, visibilityRevision = 0, disposed = false;
  let loginSelection: { id: number; unique: string; quantity: number; spid: number } | null = null;
  const selectedSku = computed(() => selected.value ? detail.value?.skus.find(sku => sku.unique === selected.value) : undefined);
  const locked = computed(() => buying.value || navigating.value || prepared.value !== null);
  const maxQuantity = computed(() => detail.value ? integralMaxQuantity(detail.value, selected.value) : 0);
  const totals = computed(() => detail.value && typeof quantity.value === 'number' ? integralSelectionTotals(detail.value, selected.value, quantity.value) : null);
  const canBuy = computed(() => visible.value && active.value && !loading.value && !buying.value && !navigating.value &&
    (prepared.value !== null || !needsRefresh.value && !!totals.value));
  const sharePath = computed(() => activityId.value ? `${integralDetailUrl(activityId.value)}${auth.isLoggedIn && auth.uid > 0 ? `&spid=${auth.uid}` : ''}` : '/pages/user/integral');
  function reset() {
    generation++; navigationRevision++; detail.value = null; selected.value = ''; quantity.value = 1;
    loading.value = false; buying.value = false; navigating.value = false; prepared.value = null; needsRefresh.value = false;
  }
  function choose(unique: string) {
    if (!visible.value || !active.value || locked.value || loading.value || needsRefresh.value || !detail.value) return;
    const bound = integralMaxQuantity(detail.value, unique);
    if (bound < 1) return;
    selected.value = unique;
    quantity.value = typeof quantity.value === 'number' && Number.isSafeInteger(quantity.value) ? Math.max(1, Math.min(quantity.value, bound)) : 1;
    error.value = '';
  }
  function setQuantity(value: unknown) {
    if (!visible.value || !active.value || locked.value || loading.value || needsRefresh.value) return;
    const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
    quantity.value = /^[1-9]\d{0,4}$/u.test(raw) ? Number(raw) : raw;
  }
  function stepQuantity(diff: -1 | 1) {
    if (maxQuantity.value < 1) return;
    const current = typeof quantity.value === 'number' && Number.isSafeInteger(quantity.value) ? quantity.value : 1;
    setQuantity(Math.max(1, Math.min(current + diff, maxQuantity.value)));
  }
  async function load() {
    if (!visible.value || !active.value || !activityId.value || disposed || locked.value) return;
    const current = ++generation, id = activityId.value;
    detail.value = null; selected.value = ''; quantity.value = 1; error.value = ''; needsRefresh.value = false; loading.value = true;
    try {
      const result = await apiIntegralDetail(id);
      if (current !== generation || !visible.value || !active.value || disposed || id !== activityId.value) return;
      detail.value = result;
      const resume = loginSelection; loginSelection = null;
      const sku = resume?.id === id ? result.skus.find(sku => sku.unique === resume.unique && integralMaxQuantity(result, sku.unique) > 0)
        : result.skus.find(sku => integralMaxQuantity(result, sku.unique) > 0);
      if (sku) {
        selected.value = sku.unique; quantity.value = resume?.id === id ? resume.quantity : 1;
        if (Number(quantity.value) > integralMaxQuantity(result, sku.unique)) error.value = '返回时库存或限购已变化，请重新确认数量';
      } else if (resume?.id === id) error.value = '原规格已失效，请重新选择';
    } catch (e) { if (current === generation && visible.value && active.value) error.value = e instanceof Error ? e.message : '积分商品加载失败'; }
    finally { if (current === generation) loading.value = false; }
  }
  function setRoute(query: Record<string, unknown>) {
    reset(); pageRevision++; loginSelection = null; activityId.value = 0; referral.value = 0;
    try {
      const { id, spid } = integralRouteQuery(query);
      activityId.value = id; referral.value = spid; error.value = '';
    } catch { error.value = '积分商品链接无效，请返回积分商城'; }
  }
  async function open(id: number) {
    if (mode !== 'dialog' || locked.value || disposed || !visible.value) return;
    setRoute({ id: String(id) }); active.value = true; await load();
  }
  function close() {
    if (mode !== 'dialog' || locked.value) return;
    active.value = false; reset(); activityId.value = 0; error.value = ''; loginSelection = null;
  }
  function navigate(url: string, failed: () => void) {
    const current = generation, revision = ++navigationRevision;
    navigating.value = true;
    const fail = () => {
      if (current !== generation || revision !== navigationRevision || !visible.value || disposed) return;
      navigating.value = false; failed();
    };
    try { uni.navigateTo({ url, fail }); } catch { fail(); }
  }
  function checkout(id: number) { navigate(integralCheckoutUrl(id), () => { error.value = '结算页面打开失败，可继续结算，无需重新加购'; }); }
  async function purchase() {
    if (!canBuy.value) return;
    if (prepared.value !== null) { checkout(prepared.value); return; }
    if (!detail.value) return;
    const submitted = { id: activityId.value, unique: selected.value, quantity: Number(quantity.value), spid: referral.value };
    if (!auth.isLoggedIn) {
      loginSelection = submitted;
      navigate('/pages/auth/login', () => { loginSelection = null; error.value = '登录页面打开失败，请重试'; }); return;
    }
    const current = generation, page = pageRevision, life = visibilityRevision, identityVersion = auth.sessionVersion;
    buying.value = true; error.value = '';
    try {
      const result = await apiCartAdd(integralCartInput(detail.value, submitted.unique, submitted.quantity));
      if (current !== generation || !visible.value || !active.value || disposed || identityVersion !== auth.sessionVersion) return;
      if (typeof result.id !== 'number' || !Number.isSafeInteger(result.id)) throw new Error('购买记录响应无效，请重新读取商品');
      integralActivityId(String(result.id)); prepared.value = result.id; checkout(result.id);
    } catch (e) {
      if (e instanceof RequestError && e.status !== undefined && [410000, 410001, 410002].includes(e.status) &&
        !disposed && page === pageRevision && life === visibilityRevision && !auth.isLoggedIn &&
        auth.sessionVersion === identityVersion + 1 && activityId.value === submitted.id) loginSelection = submitted;
      if (current === generation && visible.value && active.value) {
        // A cart response failure cannot safely be interpreted as no mutation.
        // No automatic second add; require a fresh catalogue and explicit choice.
        needsRefresh.value = true; error.value = e instanceof Error ? e.message : '加购结果未确认，请重新读取商品后再操作';
      }
    } finally { if (current === generation) buying.value = false; }
  }
  function readHashRoute(): boolean {
    // #ifdef H5
    if (mode === 'page' && typeof window !== 'undefined') {
      const route = window.location.hash.replace(/^#/, '').split('?');
      if (route[0] !== '/pages/activity/integralDetail') return false;
      try {
        const raw = route.slice(1).join('?'), params = new URLSearchParams(raw), ids = params.getAll('id'), refs = params.getAll('spid');
        if (raw.length > 2048 || ids.length !== 1 || refs.length > 1) throw new Error('invalid route');
        const id = integralActivityId(ids[0]), spid = refs.length ? integralActivityId(refs[0]) : 0;
        if (id !== activityId.value || spid !== referral.value) setRoute({ id: String(id), ...(spid ? { spid: String(spid) } : {}) });
      } catch { setRoute({}); }
      return true;
    }
    // #endif
    return false;
  }
  function show() {
    if (disposed) return;
    visible.value = true;
    if (mode === 'page') { readHashRoute(); void load(); }
    else if (loginSelection) { activityId.value = loginSelection.id; referral.value = loginSelection.spid; active.value = true; void load(); }
  }
  function suspend() {
    visible.value = false; visibilityRevision++; reset();
    if (mode === 'dialog') active.value = false;
  }
  function dispose() {
    disposed = true; pageRevision++; loginSelection = null; suspend();
    // #ifdef H5
    if (mode === 'page' && typeof window !== 'undefined') window.removeEventListener('hashchange', hashChanged);
    // #endif
  }
  function hashChanged() { if (visible.value && !disposed && readHashRoute()) void load(); }
  watch(() => auth.sessionVersion, () => {
    if (visible.value) loginSelection = null;
    reset(); error.value = '登录状态已变化，请重新读取商品';
  }, { flush: 'sync' });
  if (mode === 'page') {
    onLoad(query => { if (!disposed) { setRoute(query ?? {}); if (visible.value) void load(); } });
    onShow(show); onHide(suspend); onUnload(dispose);
    // #ifdef H5
    if (typeof window !== 'undefined') window.addEventListener('hashchange', hashChanged);
    // #endif
  }
  return { activityId, visible, active, detail, selected, selectedSku, quantity, maxQuantity, totals, locked, canBuy,
    loading, buying, navigating, error, prepared, needsRefresh, referral, sharePath, choose, setQuantity, stepQuantity,
    load, purchase, open, close, show, suspend, dispose };
}
