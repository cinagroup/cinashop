import request, { getData } from "@/utils/request";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

export interface SupplierApplicationItem {
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
  /** Digest of the application material and decision state used for write preconditions. */
  version: string;
}

export interface SupplierApplicationQuery {
  page: number;
  limit: number;
  status?: "all" | 0 | 1 | 2;
  keyword?: string;
  start_time?: string;
  end_time?: string;
}

export interface SupplierApplicationPage {
  list: SupplierApplicationItem[];
  count: number;
}

function wallTime(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error("请选择有效的上海申请时间范围");
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(utc);
  const epoch = (utc - 28_800_000) / 1000;
  if (year < 1970 || year > 2038 || check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
    check.getUTCHours() !== hour || check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second || epoch < 0 || epoch > 2_147_483_647) {
    throw new Error("请选择有效的上海申请时间范围");
  }
  return epoch;
}

/** Picker values are Shanghai wall times regardless of the browser's timezone. */
export function supplierApplicationTimeRange(value: string[] | null): { start_time: string; end_time: string } {
  if (!value || value.length === 0) return { start_time: "", end_time: "" };
  if (value.length !== 2) throw new Error("请选择完整的上海申请时间范围");
  const start = wallTime(value[0]);
  const end = wallTime(value[1]);
  if (end < start) throw new Error("结束时间不得早于开始时间");
  return { start_time: value[0], end_time: value[1] };
}

function validVersion(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }

export function parseSupplierApplicationPage(value: unknown, query: SupplierApplicationQuery): SupplierApplicationPage {
  const page = value as SupplierApplicationPage | null;
  if (!page || !Array.isArray(page.list) || !Number.isSafeInteger(page.count) || page.count < 0 ||
    page.list.length > query.limit || page.list.length > page.count) {
    throw new Error("供应商申请分页响应格式错误");
  }
  const ids = new Set<number>();
  for (const row of page.list) {
    if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id) ||
      !Number.isSafeInteger(row.uid) || row.uid <= 0 ||
      !Number.isSafeInteger(row.add_time) || row.add_time < 0 ||
      ![0, 1, 2].includes(row.status) || !validVersion(row.version) ||
      !Array.isArray(row.images) || !row.images.every((image) => typeof image === "string") ||
      !["phone", "system_name", "name", "mark", "fail_msg", "status_label"].every((field) =>
        typeof row[field as keyof SupplierApplicationItem] === "string")) {
      throw new Error("供应商申请记录格式错误");
    }
    ids.add(row.id);
  }
  return page;
}

let previewRevision = 0;
function previewVersion(id: number, revision = 0): string {
  return `${id.toString(16).padStart(16, "0")}${revision.toString(16).padStart(48, "0")}`;
}

const previewApplications: SupplierApplicationItem[] = [
  {
    id: 106, uid: 8206, relation_id: 0, phone: "13800008206",
    system_name: "苏州澄明家居供应链", name: "林澄", images: ["https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=900"],
    mark: "资质待复核", status: 0, status_label: "待审核", fail_msg: "", status_time: 0,
    add_time: 1786323600, account: "", activation_required: false, activated: false,
    version: previewVersion(106),
  },
  {
    id: 105, uid: 8188, relation_id: 46, phone: "13800008188",
    system_name: "宁波海岸生活选品", name: "周予安", images: ["https://images.unsplash.com/photo-1556740749-887f6717d7e4?w=900"],
    mark: "审核通过", status: 1, status_label: "已通过", fail_msg: "", status_time: 1786240800,
    add_time: 1786154400, account: "13800008188", activation_required: true, activated: false,
    version: previewVersion(105),
  },
  {
    id: 104, uid: 8161, relation_id: 41, phone: "13800008161",
    system_name: "杭州青岚户外用品", name: "沈青", images: [], mark: "", status: 1,
    status_label: "已通过", fail_msg: "", status_time: 1786068000, add_time: 1785981600,
    account: "13800008161", activation_required: false, activated: true,
    version: previewVersion(104),
  },
];

export async function apiSupplierApplicationList(params: SupplierApplicationQuery, signal?: AbortSignal): Promise<SupplierApplicationPage> {
  if (previewMode) {
    const status = params.status === "all" || params.status === undefined
      ? null : Number(params.status);
    const keyword = String(params.keyword ?? "").toLowerCase();
    const start = params.start_time ? wallTime(params.start_time) : 0;
    const end = params.end_time ? wallTime(params.end_time) : Number.MAX_SAFE_INTEGER;
    const list = previewApplications.filter((row) =>
      (status === null || row.status === status) &&
      row.add_time >= start && row.add_time <= end &&
      (!keyword || `${row.id}${row.uid}${row.system_name}${row.name}${row.phone}${row.fail_msg}${row.mark}`.toLowerCase().includes(keyword)),
    );
    return Promise.resolve({ list: list.slice((params.page - 1) * params.limit, params.page * params.limit), count: list.length });
  }
  const data = await getData<unknown>(request.get("/supplier/apply/list", { params, signal }));
  return parseSupplierApplicationPage(data, params);
}

export async function apiSupplierApplicationReview(
  id: number,
  body: { status: 1 | 2; expected_version: string; fail_msg?: string },
  signal?: AbortSignal,
) {
  if (!validVersion(body.expected_version)) return Promise.reject(new Error("申请版本无效，请刷新列表"));
  if (previewMode) {
    const row = previewApplications.find((item) => item.id === id);
    if (row && row.version === body.expected_version && row.status === 0) {
      row.status = body.status;
      row.status_label = body.status === 1 ? "已通过" : "已拒绝";
      row.fail_msg = body.fail_msg ?? "";
      row.version = previewVersion(id, ++previewRevision);
      if (body.status === 1) {
        row.account = row.phone;
        row.activation_required = true;
      }
      return Promise.resolve({ id, status: body.status, activation_required: body.status === 1 });
    }
    return Promise.reject(new Error("申请材料或状态已更新，请刷新列表"));
  }
  return getData<{ id: number; status: number; account?: string; activation_required?: boolean }>(
    request.post(`/supplier/apply/verify/${id}`, body, { signal }),
  );
}

export async function apiSupplierApplicationMark(id: number, mark: string, expectedVersion: string, signal?: AbortSignal) {
  if (!validVersion(expectedVersion)) return Promise.reject(new Error("申请版本无效，请刷新列表"));
  if (previewMode) {
    const row = previewApplications.find((item) => item.id === id);
    if (!row || row.version !== expectedVersion) return Promise.reject(new Error("申请材料或状态已更新，请刷新列表"));
    row.mark = mark;
    row.version = previewVersion(id, ++previewRevision);
    return Promise.resolve({ id, mark });
  }
  return getData<{ id: number; mark: string }>(
    request.post(`/supplier/apply/mark/${id}`, { mark, expected_version: expectedVersion }, { signal }),
  );
}

export async function apiSupplierApplicationDelete(id: number, expectedVersion: string, signal?: AbortSignal) {
  if (!validVersion(expectedVersion)) return Promise.reject(new Error("申请版本无效，请刷新列表"));
  if (previewMode) {
    const index = previewApplications.findIndex((item) => item.id === id);
    if (index < 0 || previewApplications[index].version !== expectedVersion || previewApplications[index].status === 1) {
      return Promise.reject(new Error("申请材料或状态已更新，请刷新列表"));
    }
    previewApplications.splice(index, 1);
    return Promise.resolve({ id });
  }
  return getData<{ id: number }>(request.delete(`/supplier/apply/del/${id}`, {
    params: { expected_version: expectedVersion }, signal,
  }));
}
