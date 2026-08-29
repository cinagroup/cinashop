/**
 * 统一请求层
 *
 * 与后端契约一致:
 *   - baseURL: /api (生产同源, 开发走 vite proxy)
 *   - Header: Authori-zation: Bearer <token>
 *   - Header: Form-type: pc
 *   - 响应信封: { status, msg, data }
 *   - 410000/410001/410002 → 清除登录态跳转登录
 */
import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import type { ApiResponse } from "@/types/api";
import { getToken, clearAuth } from "@/utils/auth";

const request: AxiosInstance = axios.create({
  baseURL: "/api",
  timeout: 30000,
  withCredentials: true,
});

// 请求拦截
request.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers["Authori-zation"] = `Bearer ${token}`;
  }
  config.headers["Form-type"] = "pc";
  return config;
});

// 响应拦截
request.interceptors.response.use(
  (response) => {
    const data = response.data as ApiResponse;
    // 业务成功
    if (data && data.status === 200) {
      return response;
    }
    // 登录失效
    if (data && [410000, 410001, 410002].includes(data.status)) {
      clearAuth();
      if (window.location.pathname !== "/login") {
        window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
      }
    }
    return Promise.reject(new Error(data?.msg ?? "请求失败"));
  },
  (error) => {
    return Promise.reject(error);
  },
);

/**
 * 获取 data (解包信封)
 * 接受 axios 的 Promise<AxiosResponse<unknown>>, 运行时从信封解包
 * 类型安全由调用方的泛型 T 保证
 */
export async function getData<T>(
  promise: Promise<AxiosResponse<unknown>>,
): Promise<T> {
  const resp = await promise;
  const body = resp.data as ApiResponse<T>;
  if (body.status !== 200) {
    throw new Error(body.msg ?? "请求失败");
  }
  return body.data;
}

export default request;
