import { computed, ref, shallowRef, watch } from "vue";
import { onShow, onHide, onUnload } from "@dcloudio/uni-app";
import { useAuthStore } from "@/stores/auth";
import { apiCouponWallet, type WalletStatus, type WalletFilter } from "@/api/couponWallet";
import { CouponWalletSession, type CouponWalletState } from "../../../common/couponWallet";

export function useCouponWallet() {
  const auth = useAuthStore();
  const activeType = ref<WalletStatus>(0), visible = ref(false), authError = ref("");
  const activeFilter = ref<WalletFilter>(null);
  const detailId = ref<number | null>(null);
  const state = shallowRef<CouponWalletState>({ list: [], nextCursor: null, loading: false, error: "" });
  const wallet = new CouponWalletSession((status, before) => apiCouponWallet(status as WalletStatus, before, activeFilter.value), next => { state.value = next; });
  const blocked = computed(() => !visible.value || !auth.isLoggedIn || auth.uid <= 0 || !!authError.value);
  const detail = computed(() => !blocked.value ? state.value.list.find(c => c.id === detailId.value) ?? null : null);
  const error = computed(() => authError.value || state.value.error);
  async function load(append = false) {
    if (!visible.value) return;
    if (!auth.isLoggedIn || auth.uid <= 0) { wallet.reset(); detailId.value = null; authError.value = "请先登录后查看优惠券"; return; }
    if (!append) { authError.value = ""; detailId.value = null; }
    if (blocked.value) return;
    await wallet.load(activeType.value, append);
  }
  function switchTab(status: WalletStatus) {
    if (![0, 1, 2, 3].includes(status) || status === activeType.value) return;
    activeType.value = status; detailId.value = null; void load();
  }
  function openDetail(id: number) {
    if (!blocked.value && !state.value.loading && state.value.list.some(c => c.id === id)) detailId.value = id;
  }
  function switchFilter(filter: WalletFilter) {
    if ((filter !== null && ![-1, 0, 1, 2, 3].includes(filter)) || filter === activeFilter.value) return;
    activeFilter.value = filter; detailId.value = null; wallet.reset(); void load();
  }
  function browseGoods(id: number) {
    if (blocked.value || state.value.loading || !state.value.list.some(c => c.id === id && c.availability === "available")) return;
    detailId.value = null;
    // Browsing is not automatic coupon application; checkout establishes actual eligibility.
    uni.navigateTo({ url: `/pages/user/couponProducts?couponId=${id}` });
  }
  function suspend() { visible.value = false; detailId.value = null; wallet.reset(); }
  watch(() => auth.sessionVersion, () => { wallet.reset(); detailId.value = null; authError.value = "登录状态已变化，请重新加载优惠券"; }, { flush: "sync" });
  onShow(() => { visible.value = true; void load(); });
  onHide(suspend); onUnload(suspend);
  return { activeType, activeFilter, state, blocked, error, detail, detailId, load, switchTab, switchFilter, openDetail, browseGoods };
}
