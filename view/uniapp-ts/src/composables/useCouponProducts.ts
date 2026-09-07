import { computed, ref, shallowRef, watch } from "vue";
import { onLoad, onShow, onHide, onUnload } from "@dcloudio/uni-app";
import { useAuthStore } from "@/stores/auth";
import { apiCouponProductSearch, apiCouponScopeDescription } from "@/api/couponProducts";
import { emptyScopeDescription, ScopeDescriptionSession } from "../../../common/couponScopeDescription";
import { couponProductId, couponScopeLabels } from "../../../common/couponProducts";
import { couponSearchSorts, couponSearchOptions, defaultCouponSearch, CouponSearchSession, emptyCouponSearch } from "../../../common/couponProductSearch";

export function useCouponProducts() {
  const auth = useAuthStore(), couponId = ref(0), visible = ref(false), guardError = ref("");
  const state = shallowRef(emptyCouponSearch()), filters = shallowRef(defaultCouponSearch()), keyword = ref("");
  const scopeState = shallowRef(emptyScopeDescription());
  const scopeSession = new ScopeDescriptionSession(async (id, before) => {
    const page = await apiCouponScopeDescription(id, before);
    if (page.title !== state.value.title || page.scopeType !== state.value.scopeType) throw new Error("优惠券配置范围已变化，请刷新范围商品");
    return page;
  }, next => { scopeState.value = next; });
  const session = new CouponSearchSession(apiCouponProductSearch, next => { state.value = next; });
  const error = computed(() => guardError.value || state.value.error);
  const blocked = computed(() => !visible.value || !auth.isLoggedIn || auth.uid <= 0 || !couponId.value || !!error.value || state.value.loading || !!scopeState.value.error);
  const scopeLabel = computed(() => couponScopeLabels[state.value.scopeType]);
  async function applySearch(sort: unknown = filters.value.sort) {
    if (!visible.value) return;
    try { filters.value = couponSearchOptions(keyword.value, sort); keyword.value = filters.value.keyword; }
    catch (error) { guardError.value = error instanceof Error ? error.message : "搜索条件无效"; return; }
    await load();
  }
  async function clearSearch() { keyword.value = ""; await applySearch(); }
  async function loadScope(append = false) {
    if (!visible.value || !state.value.loaded || state.value.loading || error.value) return;
    if (!auth.isLoggedIn || auth.uid <= 0) { scopeSession.reset(); return; }
    await scopeSession.load(couponId.value, append);
  }
  async function load(append = false) {
    if (!visible.value || !couponId.value) return;
    if (!append) scopeSession.reset();
    if (!auth.isLoggedIn || auth.uid <= 0) { session.reset(); guardError.value = "请先登录后查看券范围商品"; return; }
    if (!append) guardError.value = "";
    if (guardError.value) return;
    await session.load(couponId.value, filters.value, append);
  }
  function openProduct(id: number) {
    if (!blocked.value && state.value.list.some(row => row.id === id)) uni.navigateTo({ url: `/pages/goods/detail?id=${id}` });
  }
  function suspend() { visible.value = false; session.reset(); scopeSession.reset(); }
  watch(() => auth.sessionVersion, () => { session.reset(); scopeSession.reset(); filters.value = defaultCouponSearch(); keyword.value = ""; guardError.value = "登录状态已变化，请刷新后重新加载"; }, { flush: "sync" });
  onLoad(query => { session.reset(); scopeSession.reset(); filters.value = defaultCouponSearch(); keyword.value = ""; couponId.value = 0; try { couponId.value = couponProductId(query?.couponId); guardError.value = ""; }
    catch { guardError.value = "优惠券标识无效，请返回钱包重新进入"; } });
  onShow(() => { visible.value = true; void load(); }); onHide(suspend); onUnload(suspend);
  return { state, scopeState, error, blocked, scopeLabel, filters, keyword, sorts: couponSearchSorts, applySearch, clearSearch, load, loadScope, openProduct };
}
