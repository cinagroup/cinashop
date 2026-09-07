import { computed, ref, shallowRef } from "vue";
import { apiMyCoupons, type WalletFilter } from "@/api/user";
import { CouponWalletSession, type CouponWalletState } from "@/api/couponWallet";
import { getUid, isLoggedIn, onAuthChange } from "@/utils/auth";

export function createCouponWalletView(navigate: (path: string) => void) {
  const activeType = ref(0), activeFilter = ref<WalletFilter>(null), detailId = ref<number | null>(null);
  const state = shallowRef<CouponWalletState>({ list: [], nextCursor: null, loading: false, error: "" });
  let disposed = false;
  const wallet = new CouponWalletSession((status, before) => apiMyCoupons(status, before, activeFilter.value), next => { state.value = next; });
  const blocked = computed(() => {
    // Always track the published state: storage-backed auth getters are not reactive.
    const current = state.value;
    return disposed || current.loading || !!current.error || !isLoggedIn() || getUid() <= 0;
  });
  const detail = computed(() => blocked.value ? null : state.value.list.find(c => c.id === detailId.value) ?? null);
  function clearWithError(error: string) { wallet.reset(); detailId.value = null; state.value = { ...state.value, error }; }
  const unbind = onAuthChange(() => clearWithError("登录状态已变化，请刷新后重新加载"));
  async function load(append = false) {
    if (disposed) return;
    if (!isLoggedIn() || getUid() <= 0) { clearWithError("请先登录后查看优惠券"); return; }
    detailId.value = null;
    await wallet.load(activeType.value, append);
  }
  async function switchTab(status: number) {
    if (disposed || ![0, 1, 2, 3].includes(status) || status === activeType.value) return;
    activeType.value = status; await load();
  }
  async function switchFilter(filter: WalletFilter) {
    if (disposed || (filter !== null && ![-1, 0, 1, 2, 3].includes(filter)) || filter === activeFilter.value) return;
    activeFilter.value = filter; detailId.value = null; wallet.reset(); await load();
  }
  function openDetail(id: number) { if (!disposed && !blocked.value && state.value.list.some(c => c.id === id)) detailId.value = id; }
  function closeDetail() { detailId.value = null; }
  function browse(id: number) {
    if (!disposed && !blocked.value && state.value.list.some(c => c.id === id && c.availability === "available")) {
      closeDetail(); navigate(`/user/coupon/${id}/products`);
    }
  }
  function dispose() { disposed = true; unbind(); wallet.reset(); closeDetail(); }
  return { activeType, activeFilter, state, blocked, detail, load, switchTab, switchFilter, openDetail, closeDetail, browse, dispose };
}
