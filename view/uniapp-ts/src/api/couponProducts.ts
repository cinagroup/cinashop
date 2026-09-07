import { http } from "@/utils/request";
import { useAuthStore } from "@/stores/auth";
import { couponProductId, normalizeCouponProducts } from "../../../common/couponProducts";

export async function apiCouponProducts(couponId: number, before?: number) {
  couponProductId(couponId); if (before !== undefined) couponProductId(before);
  const auth = useAuthStore();
  if (!auth.isLoggedIn || auth.uid <= 0) throw new Error("请先登录后查看券范围商品");
  const owner = { uid: auth.uid, token: auth.token, version: auth.sessionVersion };
  const data = await http.get<unknown>(`/coupons/user/${couponId}/products`, { limit: 20, ...(before !== undefined ? { before } : {}) });
  if (auth.uid !== owner.uid || auth.token !== owner.token || auth.sessionVersion !== owner.version) throw new Error("登录状态已变化，请重新加载");
  return normalizeCouponProducts(data, couponId, before);
}
