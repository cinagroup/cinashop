import { http } from "@/utils/request";
import { useAuthStore } from "@/stores/auth";
import { normalizeCouponPage, normalizeCouponCounts, type CouponPage } from "../../../common/couponWallet";

export type WalletStatus = 0 | 1 | 2 | 3;
export type WalletFilter = -1 | 0 | 1 | 2 | 3 | null;
/** Wallet availability is not an order-specific entitlement or reservation. */
export async function apiCouponWallet(status: WalletStatus, before?: number, filter: WalletFilter = null): Promise<CouponPage> {
  const auth = useAuthStore();
  if (!auth.isLoggedIn || !Number.isSafeInteger(auth.uid) || auth.uid <= 0) throw new Error("请先登录后查看优惠券");
  if (![0, 1, 2, 3].includes(status) || (before !== undefined && (!Number.isSafeInteger(before) || before <= 0))) throw new Error("优惠券查询参数无效");
  if (filter !== null && ![-1, 0, 1, 2, 3].includes(filter)) throw new Error("优惠券筛选参数无效");
  const owner = { uid: auth.uid, token: auth.token, version: auth.sessionVersion };
  const response = await http.getResponse<unknown>(`/coupons/user/${status}`, { limit: 20, ...(before !== undefined ? { before } : { include_counts: 1 }), ...(filter !== null ? { type: filter } : {}) });
  if (auth.uid !== owner.uid || auth.token !== owner.token || auth.sessionVersion !== owner.version) throw new Error("登录状态已变化，请重新加载优惠券");
  const page = normalizeCouponPage(response.data, response.headers["x-coupon-next-cursor"]);
  const rawCounts = response.headers["x-coupon-counts"];
  if (rawCounts !== undefined && rawCounts !== "") {
    if (rawCounts.length > 512) throw new Error("优惠券数量无效");
    page.counts = normalizeCouponCounts(JSON.parse(rawCounts));
  }
  return page;
}
