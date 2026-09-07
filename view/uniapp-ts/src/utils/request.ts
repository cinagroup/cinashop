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
  constructor(message: string, readonly status?: number, readonly data?: unknown, readonly httpStatus?: number) { super(message); this.name = "RequestError"; }
}

export interface ResponseData<T> { data: T; headers: Record<string, string> }

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
  return baseResponse<T>(url, method, data, options).then((response) => response.data);
}

/** Metadata is opt-in: existing callers continue receiving only envelope.data. */
export function baseResponse<T>(
  url: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  data: Record<string, unknown> = {},
  options: RequestOptions = {},
): Promise<ResponseData<T>> {
  const authStore = useAuthStore();
  const owner = { uid: authStore.uid, token: authStore.token, version: authStore.sessionVersion };
  const staleOwner = () => !options.noAuth && (authStore.uid !== owner.uid || authStore.token !== owner.token || authStore.sessionVersion !== owner.version);
  const header: Record<string, string> = {
    "Form-type": getFormType(),
  };

  if (!options.noAuth && authStore.token) {
    header["Authori-zation"] = `Bearer ${authStore.token}`;
  }
  Object.assign(header, options.headers ?? {});

  // 规范化 URL: 避免双斜杠 (API_BASE 为空时 /api/products)
  const cleanUrl = url.replace(/^\/+/, "");
  return new Promise<ResponseData<T>>((resolve, reject) => {
    uni.request({
      url: `${API_BASE}/api/${cleanUrl}`,
      method,
      header,
      data,
      withCredentials: options.withCredentials,
      success: (res) => {
        if (staleOwner()) { reject(new RequestError("登录状态已变化，请重新操作")); return; }
        const body = res.data as { status: number; msg: string; data: T };
        if (body && body.status === 200 && res.statusCode >= 200 && res.statusCode < 300) {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.header ?? {})) {
            // Uni runtimes preserve header casing differently. Reject ambiguous duplicate headers.
            const normalized = key.toLowerCase();
            if (normalized in headers) {
              reject(new RequestError("响应头重复", undefined, undefined, res.statusCode));
              return;
            }
            if (typeof value === "string") headers[normalized] = value;
            else if (typeof value === "number") headers[normalized] = String(value);
          }
          resolve({ data: body.data, headers });
          return;
        }
        // 登录失效
        if (body && [410000, 410001, 410002].includes(body.status)) {
          authStore.clear();
          toLogin();
        }
        reject(new RequestError(body?.msg ?? "请求失败", typeof body?.status === "number" ? body.status : undefined, body?.data, res.statusCode));
      },
      fail: (err) => {
        if (staleOwner()) { reject(new RequestError("登录状态已变化，请重新操作")); return; }
        reject(new RequestError(err.errMsg ?? "网络错误"));
      },
    });
  });
}

export const http = {
  getResponse: <T>(url: string, data?: Record<string, unknown>, opt?: RequestOptions) =>
    baseResponse<T>(url, "GET", data, opt),
  get: <T>(url: string, data?: Record<string, unknown>, opt?: RequestOptions) =>
    baseRequest<T>(url, "GET", data, opt),
  post: <T>(url: string, data?: Record<string, unknown>, opt?: RequestOptions) =>
    baseRequest<T>(url, "POST", data, opt),
  put: <T>(url: string, data?: Record<string, unknown>, opt?: RequestOptions) =>
    baseRequest<T>(url, "PUT", data, opt),
  delete: <T>(url: string, data?: Record<string, unknown>, opt?: RequestOptions) =>
    baseRequest<T>(url, "DELETE", data, opt),
};
