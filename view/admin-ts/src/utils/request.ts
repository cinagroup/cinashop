/**
 * 统一请求层 (admin)
 *
 * 契约:
 *   - baseURL: /adminapi (生产 Pages Function 转发)
 *   - Header: Authori-zation: Bearer <token>
 *   - 信封: { status, msg, data }
 *   - 410000/410001/410002 → 清登录态跳登录
 */
import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import type { ApiResponse } from "@/types/admin";
import { getToken, clearAuth } from "@/utils/auth";

const request: AxiosInstance = axios.create({
  baseURL: "/adminapi",
  timeout: 30000,
});

request.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers["Authori-zation"] = `Bearer ${token}`;
  }
  return config;
});

request.interceptors.response.use(
  (response) => {
    const data = response.data as ApiResponse;
    if (data && data.status === 200) {
      return response;
    }
    if (data && [410000, 410001, 410002].includes(data.status)) {
      clearAuth();
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(new Error(data?.msg ?? "请求失败"));
  },
  (error) => Promise.reject(error),
);

/** 解包信封 */
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
