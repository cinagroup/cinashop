import request, { getData } from "@/utils/request";

export interface SupplierDirectoryRow {
  id: number;
  supplier_name: string;
  name: string;
  phone: string;
  address: string;
  is_show: 0 | 1;
  add_time: number;
  _add_time: string;
  mark: string;
  sort: number;
  revision: string;
}

export interface SupplierDirectoryDetail extends SupplierDirectoryRow {
  email: string;
  province: number;
  city: number;
  area: number;
  street: number;
  detailed_address: string;
  account: string;
  pwd: "";
  conf_pwd: "";
}

export interface SupplierDirectoryForm {
  supplier_name: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  province: number;
  city: number;
  area: number;
  street: number;
  detailed_address: string;
  mark: string;
  account: string;
  pwd: string;
  conf_pwd: string;
  sort: number;
  is_show: 0 | 1;
}

export interface SupplierDirectoryPage {
  list: SupplierDirectoryRow[];
  count: number;
  page: number;
  limit: number;
}

export interface SupplierDirectoryCity {
  value: number;
  id: number;
  label: string;
  pid: number;
  level: number;
  children?: [];
}

const base = "/supplier/supplier";
const revisionPattern = /^[0-9a-f]{64}$/;
const idValid = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;

export function validateSupplierDirectoryForm(form: SupplierDirectoryForm, creating: boolean): void {
  const length = (value: string) => [...value.trim()].length;
  if (!form.supplier_name.trim() || length(form.supplier_name) > 25) throw new Error("供应商名称须填写且不超过25字");
  if (length(form.name) > 25 || !/^1[3-9]\d{9}$/.test(form.phone.trim())) throw new Error("联系人或联系电话无效");
  if (form.email && (length(form.email) > 50 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))) {
    throw new Error("供应商邮箱无效");
  }
  if ([form.address, form.detailed_address, form.mark].some((value) => length(value) > 255) ||
    ![form.province, form.city, form.area].every(idValid) ||
    !Number.isSafeInteger(form.street) || form.street < 0 || form.street > 2_147_483_647) {
    throw new Error("请选择完整省市区并检查地址和备注");
  }
  if (!form.account.trim() || length(form.account) > 32 || /[\u0000-\u001f\u007f]/.test(form.account)) {
    throw new Error("登录用户名须填写且不超过32字");
  }
  if (creating || form.pwd) {
    if (length(form.pwd) < 12 || length(form.pwd) > 72 ||
      new TextEncoder().encode(form.pwd).byteLength > 72 || form.pwd !== form.conf_pwd) {
      throw new Error("登录密码须为12至72位，且两次输入一致");
    }
  } else if (form.conf_pwd) throw new Error("请填写登录密码");
  if (!Number.isSafeInteger(form.sort) || form.sort < 0 || form.sort > 999_999 ||
    ![0, 1].includes(form.is_show)) throw new Error("排序或供应商状态无效");
}

export function apiSupplierDirectoryList(
  query: { keywords: string; page: number; limit: number }, signal?: AbortSignal,
): Promise<SupplierDirectoryPage> {
  if (typeof query.keywords !== "string" || [...query.keywords.trim()].length > 80 ||
    !Number.isSafeInteger(query.page) || query.page < 1 || query.page > 100_000 ||
    !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) {
    return Promise.reject(new Error("供应商目录筛选条件无效"));
  }
  return getData(request.get(base, { params: query, signal }));
}

export function apiSupplierDirectoryDetail(id: number, signal?: AbortSignal): Promise<SupplierDirectoryDetail> {
  if (!idValid(id)) return Promise.reject(new Error("供应商ID无效"));
  return getData(request.get(`${base}/${id}`, { signal }));
}

export function apiSupplierDirectoryCreate(form: SupplierDirectoryForm, signal?: AbortSignal): Promise<{ id: number; admin_id: number }> {
  validateSupplierDirectoryForm(form, true);
  return getData(request.post(base, form, { signal }));
}

export function apiSupplierDirectoryUpdate(id: number, form: SupplierDirectoryForm,
  expectedRevision: string, expectedAccount: string, signal?: AbortSignal): Promise<SupplierDirectoryDetail> {
  if (!idValid(id) || !revisionPattern.test(expectedRevision) || !expectedAccount) {
    return Promise.reject(new Error("供应商编辑版本无效，请重新打开"));
  }
  validateSupplierDirectoryForm(form, false);
  return getData(request.put(`${base}/${id}`,
    { ...form, expected_revision: expectedRevision, expected_account: expectedAccount }, { signal }));
}

export function apiSupplierDirectoryStatus(id: number, status: 0 | 1, expectedRevision: string,
  signal?: AbortSignal): Promise<{ id: number; is_show: 0 | 1; revision: string }> {
  if (!idValid(id) || ![0, 1].includes(status) || !revisionPattern.test(expectedRevision)) {
    return Promise.reject(new Error("供应商状态版本无效，请刷新列表"));
  }
  return getData(request.put(`${base}/set_status/${id}/${status}`,
    { expected_revision: expectedRevision }, { signal }));
}

export function apiSupplierDirectoryDelete(id: number, expectedRevision: string,
  signal?: AbortSignal): Promise<{ id: number; is_del: 1 }> {
  if (!idValid(id) || !revisionPattern.test(expectedRevision)) {
    return Promise.reject(new Error("供应商删除版本无效，请刷新列表"));
  }
  return getData(request.delete(`${base}/${id}`, {
    data: { expected_revision: expectedRevision }, signal,
  }));
}

/** Bounded lazy region tree behind the directory view permission. */
export function apiSupplierDirectoryCities(pid: number, signal?: AbortSignal): Promise<SupplierDirectoryCity[]> {
  if (!Number.isSafeInteger(pid) || pid < 0 || pid > 2_147_483_647) {
    return Promise.reject(new Error("地区ID无效"));
  }
  return getData(request.get(`${base}/cities`, { params: { pid }, signal }));
}
