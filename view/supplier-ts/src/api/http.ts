import axios from "axios";
import { clearSupplierSession, createSupplierSessionScope } from '@/utils/supplierSession';

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
    "/supplierapi",
  timeout: 20_000,
});

// Keep dispatch asynchronous so a mounted scope can cancel a queued request.
// Authorization is captured by apiRequest, never replaced with a newer account.
http.interceptors.request.use(config => config);

export async function apiRequest<T>(config: Parameters<typeof http.request>[0]): Promise<T> {
  const session = createSupplierSessionScope(() => {}, true);
  const token = localStorage.getItem('supplier-token');
  const headers = { ...config.headers, Authorization: token ? `Bearer ${token}` : null };
  try {
    const response = await http.request<ApiEnvelope<T>>({ ...config, headers });
    const body = response.data;
    if (!body || typeof body !== 'object' || !Number.isInteger(body.status)) throw new ApiError('请求结果未知，请核对后再操作', 0);
    if (body.status !== 200) {
      if ([410000, 410001, 410002].includes(body.status) && session.isCurrent()) clearSupplierSession();
      throw new ApiError(typeof body.msg === 'string' && body.msg ? body.msg : '请求失败', body.status);
    }
    return body.data;
  } catch (error) {
    if (axios.isAxiosError(error) && (error.response?.status === 401 || [410000, 410001, 410002].includes(error.response?.data?.status)) && session.isCurrent()) clearSupplierSession();
    throw error;
  } finally { session.dispose(); }
}
