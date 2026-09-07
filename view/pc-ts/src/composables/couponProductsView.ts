import { computed, ref, shallowRef } from "vue";
import { getUid, isLoggedIn, onAuthChange } from "@/utils/auth";
import { apiCouponProducts, apiCouponScopeDescription } from "@/api/couponProducts";
import { emptyScopeDescription, ScopeDescriptionSession } from "../../../common/couponScopeDescription";
import { couponProductId, couponScopeLabels, CouponProductsSession, emptyCouponProducts } from "../../../common/couponProducts";

export function createCouponProductsView(navigate: (path: string) => void) {
  const couponId = ref(0), guardError = ref("");
  const state = shallowRef(emptyCouponProducts());
  const scopeState = shallowRef(emptyScopeDescription());
  const scopeSession = new ScopeDescriptionSession(async (id, before) => {
    const page = await apiCouponScopeDescription(id, before);
    if (page.title !== state.value.title || page.scopeType !== state.value.scopeType) throw new Error("优惠券配置范围已变化，请刷新范围商品");
    return page;
  }, next => { scopeState.value = next; });
  let disposed = false;
  const session = new CouponProductsSession(apiCouponProducts, next => { state.value = next; });
  const error = computed(() => guardError.value || state.value.error);
  const blocked = computed(() => disposed || !couponId.value || !!error.value || state.value.loading || !!scopeState.value.error);
  const scopeLabel = computed(() => couponScopeLabels[state.value.scopeType]);
  const unbind = onAuthChange(() => { session.reset(); scopeSession.reset(); guardError.value = "登录状态已变化，请刷新后重新加载"; });
  async function loadScope(append = false) {
    if (disposed || !state.value.loaded || state.value.loading || error.value) return;
    if (!isLoggedIn() || getUid() <= 0) { scopeSession.reset(); return; }
    await scopeSession.load(couponId.value, append);
  }
  async function load(append = false) {
    if (disposed || !couponId.value) return;
    if (!append) scopeSession.reset();
    if (!isLoggedIn() || getUid() <= 0) { session.reset(); guardError.value = "请先登录后查看券范围商品"; return; }
    if (!append) guardError.value = "";
    if (guardError.value) return;
    await session.load(couponId.value, append);
  }
  async function setCouponId(value: unknown) {
    session.reset(); scopeSession.reset(); couponId.value = 0;
    try { couponId.value = couponProductId(value); guardError.value = ""; }
    catch { guardError.value = "优惠券标识无效，请返回钱包重新进入"; return; }
    await load();
  }
  function openProduct(id: number) {
    if (!disposed && !blocked.value && isLoggedIn() && getUid() > 0 && state.value.list.some(row => row.id === id)) navigate(`/goods/${id}`);
  }
  function dispose() { disposed = true; unbind(); session.reset(); scopeSession.reset(); }
  async function setRoute(name: unknown, value: unknown) {
    // Vue Router updates the old component's reactive params before it unmounts.
    // A goods/:id destination must never be interpreted as a different coupon ID.
    if (name !== "coupon-products") { dispose(); return; }
    await setCouponId(value);
  }
  return { state, scopeState, error, blocked, scopeLabel, load, loadScope, setCouponId, setRoute, openProduct, dispose };
}
