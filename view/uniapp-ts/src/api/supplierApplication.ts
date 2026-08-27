import { useAuthStore } from "@/stores/auth";
import { API_BASE, getFormType, http } from "@/utils/request";

export interface SupplierApplication {
  id: number;
  uid: number;
  relation_id: number;
  phone: string;
  system_name: string;
  name: string;
  images: string[];
  image_refs?: string[];
  mark: string;
  status: 0 | 1 | 2;
  status_label: string;
  fail_msg: string;
  status_time: number;
  add_time: number;
  account: string;
  activation_required: boolean;
  activated: boolean;
}

export interface SupplierImageUpload {
  att_id: number;
  name: string;
  size: number;
  type: string;
  url: string;
  src: string;
}

export function resolveSupplierAssetUrl(value: string): string {
  if (/^https:\/\//i.test(value)) return value;
  return value.startsWith("/") ? `${API_BASE}${value}` : value;
}

export function apiSupplierImageUpload(filePath: string): Promise<SupplierImageUpload> {
  const auth = useAuthStore();
  return new Promise((resolve, reject) => {
    uni.uploadFile({
      url: `${API_BASE}/api/upload/image`,
      filePath,
      name: "file",
      formData: { pid: "0" },
      header: {
        "Authori-zation": `Bearer ${auth.token}`,
        "Form-type": getFormType(),
      },
      success: (response) => {
        let parsed: unknown = null;
        try { parsed = JSON.parse(response.data) as unknown; } catch { parsed = null; }
        const body = parsed && typeof parsed === "object"
          ? parsed as { status?: number; msg?: string; data?: SupplierImageUpload }
          : null;
        if (body?.status === 200 && body.data) {
          resolve({ ...body.data, src: resolveSupplierAssetUrl(body.data.src) });
          return;
        }
        reject(new Error(body?.msg ?? "图片上传失败"));
      },
      fail: (error) => reject(new Error(error.errMsg ?? "图片上传失败")),
    });
  });
}

export function apiSupplierApplications() {
  return http.get<{ list: SupplierApplication[]; count: number }>("/user/apply/record", {
    page: 1,
    limit: 50,
  });
}

export function apiSupplierCode(params: {
  phone: string;
  purpose: "apply" | "activate";
  application_id?: number;
}) {
  return http.post<{ queued: boolean; expires_in: number }>("/user/apply/supplier/code", params);
}

export function apiSupplierApply(
  id: number,
  params: { phone: string; system_name: string; name: string; images: string[]; code: string },
) {
  return http.post<{ id: number }>(`/user/apply/supplier/${id}`, params);
}

export function apiSupplierActivate(
  id: number,
  params: { code: string; password: string; password_confirmation: string },
) {
  return http.post<{ account: string; activated: boolean }>(
    `/user/apply/activate/${id}`,
    params,
  );
}
