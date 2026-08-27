import axios from "axios";

interface ApiEnvelope<T> {
  status: number;
  msg: string;
  data: T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const http = axios.create({
  baseURL:
    import.meta.env.VITE_API_BASE_URL ??
    "https://cinashop-api.cinagroup.workers.dev/supplierapi",
  timeout: 20_000,
});

http.interceptors.request.use((config) => {
  const token = localStorage.getItem("supplier-token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export async function apiRequest<T>(config: Parameters<typeof http.request>[0]): Promise<T> {
  const response = await http.request<ApiEnvelope<T>>(config);
  if (response.data.status !== 200) {
    if ([410000, 410001, 410002].includes(response.data.status)) {
      localStorage.removeItem("supplier-token");
      localStorage.removeItem("supplier-user");
    }
    throw new ApiError(response.data.msg || "请求失败", response.data.status);
  }
  return response.data.data;
}
