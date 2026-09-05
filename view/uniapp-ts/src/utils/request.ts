/**
 * 统一请求层 (uni.request 封装)
 *
 * 契约与后端一致:
 *   - URL: {baseURL}/api/{url}
 *   - Header: Authori-zation: Bearer <token> + Form-type: <platform>
 *   - 信封: { status, msg, data }
 *   - 410000/410001/410002 → 跳登录
 */
import { useAuthStore } from "@/stores/auth";

/**
 * API 基础地址
 * - H5: 同源 /api (Pages Function 转发到 Workers)
 * - 小程序/APP: 直接指向 Workers 域名
 */
let apiBase = "https://cinashop-api.cinagroup.workers.dev";
// #ifdef H5
apiBase = "";
// #endif
export const API_BASE = apiBase;

/** Undefined status means transport/invalid-response uncertainty, not a business rejection. */
export class RequestError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "RequestError"; }
}

/** 平台标识 (对应后端 Form-type) */
export function getFormType(): string {
  // #ifdef MP-WEIXIN
  return "routine";
  // #endif
  // #ifdef APP-PLUS
  return "app";
  // #endif
  // #ifdef H5
  return "h5";
  // #endif
  // #ifndef MP-WEIXIN || APP-PLUS || H5
  return "h5";
  // #endif
}

export interface RequestOptions {
  noAuth?: boolean;
  loading?: boolean;
  /** Additional request headers for isolated authorization domains. */
  headers?: Record<string, string>;
  /** H5 cookies are opt-in for one-time OAuth state verification. */
  withCredentials?: boolean;
}

/** 跳转登录 */
export function toLogin(): void {
  uni.navigateTo({ url: "/pages/auth/login" });
}

/**
 * 发送请求
 * @param url 相对路径 (如 "products")
 * @param method HTTP 方法
 * @param data 请求体
 */
export function baseRequest<T>(
  url: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  data: Record<string, unknown> = {},
  options: RequestOptions = {},
): Promise<T> {
  const authStore = useAuthStore();
  const header: Record<string, string> = {
    "Form-type": getFormType(),
  };

  if (!options.noAuth && authStore.token) {
    header["Authori-zation"] = `Bearer ${authStore.token}`;
  }
  Object.assign(header, options.headers ?? {});

  // 规范化 URL: 避免双斜杠 (API_BASE 为空时 /api/products)
  const cleanUrl = url.replace(/^\/+/, "");
  return new Promise<T>((resolve, reject) => {
    uni.request({
      url: `${API_BASE}/api/${cleanUrl}`,
      method,
      header,
      data,
      withCredentials: options.withCredentials,
      success: (res) => {
        const body = res.data as { status: number; msg: string; data: T };
        if (body && body.status === 200) {
          resolve(body.data);
          return;
        }
        // 登录失效
        if (body && [410000, 410001, 410002].includes(body.status)) {
          authStore.clear();
          toLogin();
        }
        reject(new RequestError(body?.msg ?? "请求失败", typeof body?.status === "number" ? body.status : undefined));
      },
      fail: (err) => {
        reject(new RequestError(err.errMsg ?? "网络错误"));
      },
    });
  });
}

export const http = {
  get: <T>(url: string, data?: Record<string, unknown>, opt?: RequestOptions) =>
    baseRequest<T>(url, "GET", data, opt),
  post: <T>(url: string, data?: Record<string, unknown>, opt?: RequestOptions) =>
    baseRequest<T>(url, "POST", data, opt),
  put: <T>(url: string, data?: Record<string, unknown>, opt?: RequestOptions) =>
    baseRequest<T>(url, "PUT", data, opt),
  delete: <T>(url: string, data?: Record<string, unknown>, opt?: RequestOptions) =>
    baseRequest<T>(url, "DELETE", data, opt),
};
