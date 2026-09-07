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
import { captureAuthSession, isCurrentAuthSession, clearAuthIfCurrent, type AuthSessionSnapshot } from "@/utils/auth";
import { ApiResponseError } from "./apiError";
import { expiredLoginDestination } from "./authNavigation";

const request: AxiosInstance = axios.create({
  baseURL: "/api",
  timeout: 30000,
  withCredentials: true,
});

const requestSessions = new WeakMap<object, AuthSessionSnapshot>();

/** Old-session responses must neither log out a newer identity nor repopulate its private state. */
function guardResponse(response: AxiosResponse): void {
  const snapshot = requestSessions.get(response.config);
  if (snapshot && !isCurrentAuthSession(snapshot)) throw new Error("登录状态已变化，请重新操作");
  const data = response.data as ApiResponse | undefined;
  if (data && [410000, 410001, 410002].includes(data.status) && snapshot?.token && clearAuthIfCurrent(snapshot)) {
    const destination = expiredLoginDestination(window.location);
    if (destination) window.location.replace(destination);
  }
}

// 请求拦截
request.interceptors.request.use((config) => {
  const snapshot = captureAuthSession();
  requestSessions.set(config, snapshot);
  if (snapshot.token) config.headers.set("Authori-zation", `Bearer ${snapshot.token}`);
  else config.headers.delete("Authori-zation");
  config.headers["Form-type"] = "pc";
  return config;
});

// 响应拦截
request.interceptors.response.use(
  (response) => {
    guardResponse(response);
    const data = response.data as ApiResponse;
    // 业务成功
    if (data && data.status === 200) {
      return response;
    }
    return Promise.reject(new ApiResponseError(data?.msg ?? "请求失败", data?.status, data?.data));
  },
  (error) => {
    if (axios.isAxiosError(error) && error.response) guardResponse(error.response);
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
    throw new ApiResponseError(body.msg ?? "请求失败", body.status, body.data);
  }
  return body.data;
}

export default request;
