import { http } from "@/utils/request";
import { useAuthStore } from "@/stores/auth";
import { createCheckoutApi } from "../../../common/checkoutApi";

/** Each response remains bound to the account that issued it, even after logout/login. */
async function owned<T>(read: () => Promise<T>): Promise<T> {
  const auth = useAuthStore();
  const uid = auth.uid, token = auth.token, version = auth.sessionVersion;
  if (!Number.isSafeInteger(uid) || uid <= 0 || !token) throw new Error("请先登录后结算");
  const result = await read();
  if (auth.uid !== uid || auth.token !== token || auth.sessionVersion !== version) throw new Error("登录状态已变化，请重新结算");
  return result;
}

export const checkoutApi = createCheckoutApi({
  get: (url, params) => owned(() => http.getResponse<unknown>(url, params)),
  post: (url, body) => owned(() => http.post<unknown>(url, body)),
});
