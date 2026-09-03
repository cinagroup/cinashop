import request, { getData } from "@/utils/request";

const previewMode = import.meta.env.DEV
  && new URLSearchParams(window.location.search).get("preview") === "1";

export interface PrintDocumentView {
  id: number;
  type: 1 | 2;
  supplier_id: number;
  print_name: string;
  yly_user_id: string;
  yly_app_id: string;
  yly_app_secret: "";
  yly_app_secret_configured: boolean;
  yly_sn: string;
  fey_user: string;
  fey_ukey: "";
  fey_ukey_configured: boolean;
  fey_sn: string;
  times: number;
  print_type: 1 | 2;
  add_time: number;
  status: 0 | 1;
  is_del: 0 | 1;
  provider_ready: boolean;
  content_configured: boolean;
  content_valid: boolean;
  ready: boolean;
}

export interface PrintContent {
  header: number;
  delivery: number;
  buyer_remarks: number;
  goods: number[];
  freight: number;
  preferential: number;
  pay: number[];
  custom: number;
  order: number[];
  code: number;
  code_url: string;
  show_notice: number;
  notice_content: string;
}

export interface PrintDocumentListResult {
  list: PrintDocumentView[];
  count: number;
  page: number;
  limit: number;
}

export type PrintJobStatus =
  | "PENDING" | "ENQUEUING" | "ENQUEUED" | "PROCESSING" | "RETRYABLE"
  | "SENT" | "UNKNOWN" | "DEAD" | "CLOSED";

export interface PrintJobView {
  id: number;
  event_key: string;
  order_id: number;
  order_no: string;
  printer_id: number;
  trigger: "created" | "paid" | "manual";
  provider: "yilianyun" | "feieyun";
  status: PrintJobStatus;
  attempt_count: number;
  replay_count: number;
  provider_reference: string;
  response_code: string;
  content_hash: string;
  last_error: string;
  add_time: number;
  update_time: number;
}

export interface PrintJobListResult {
  list: PrintJobView[];
  next_cursor: number | null;
  summary: { pending: number; sent: number; unknown: number; dead: number; closed: number };
}

const previewContent: PrintContent = {
  header: 1, delivery: 1, buyer_remarks: 1, goods: [0, 1], freight: 1,
  preferential: 1, pay: [0, 1], custom: 0, order: [0, 1, 2, 3],
  code: 0, code_url: "", show_notice: 1, notice_content: "感谢惠顾，请核对商品",
};
const previewDocuments: PrintDocumentView[] = [
  {
    id: 3, type: 2, supplier_id: 0, print_name: "平台仓库打印机",
    yly_user_id: "", yly_app_id: "", yly_app_secret: "",
    yly_app_secret_configured: false, yly_sn: "", fey_user: "preview-user",
    fey_ukey: "", fey_ukey_configured: true, fey_sn: "PREVIEW-SN", times: 1,
    print_type: 1, add_time: 1_700_000_000, status: 1, is_del: 0,
    provider_ready: true, content_configured: true, content_valid: true, ready: true,
  },
  {
    id: 2, type: 1, supplier_id: 0, print_name: "前台易联云",
    yly_user_id: "preview-yly", yly_app_id: "preview-app", yly_app_secret: "",
    yly_app_secret_configured: true, yly_sn: "YLY-PREVIEW", fey_user: "",
    fey_ukey: "", fey_ukey_configured: false, fey_sn: "", times: 2,
    print_type: 2, add_time: 1_699_999_900, status: 0, is_del: 0,
    provider_ready: true, content_configured: false, content_valid: true, ready: false,
  },
];
const previewContents = new Map<number, PrintContent>([
  [3, structuredClone(previewContent)],
  [2, { ...structuredClone(previewContent), show_notice: 0, notice_content: "" }],
]);

function clonePrintContent(content: PrintContent): PrintContent {
  return {
    ...content,
    goods: [...content.goods],
    pay: [...content.pay],
    order: [...content.order],
  };
}

export function apiPrintDocuments(params: Record<string, string | number> = {}) {
  if (previewMode) {
    const keyword = String(params.keyword ?? "").trim().toLocaleLowerCase();
    const type = Number(params.type ?? 0);
    const page = Math.max(1, Number(params.page ?? 1));
    const limit = Math.max(1, Math.min(100, Number(params.limit ?? 15)));
    const filtered = previewDocuments.filter((row) => (
      (!keyword || row.print_name.toLocaleLowerCase().includes(keyword))
      && (!type || row.type === type)
    ));
    const start = (page - 1) * limit;
    return Promise.resolve({
      list: filtered.slice(start, start + limit).map((row) => ({ ...row })),
      count: filtered.length,
      page,
      limit,
    });
  }
  return getData<PrintDocumentListResult>(request.get("/print/list", { params }));
}

export function apiPrintDocument(id: number) {
  if (previewMode) {
    const row = previewDocuments.find((item) => item.id === id);
    if (row) return Promise.resolve({ ...row });
    return Promise.resolve({
      id: 0, type: 1, supplier_id: 0, print_name: "", yly_user_id: "", yly_app_id: "",
      yly_app_secret: "" as const, yly_app_secret_configured: false, yly_sn: "",
      fey_user: "", fey_ukey: "" as const, fey_ukey_configured: false, fey_sn: "",
      times: 1, print_type: 1, add_time: 0, status: 0 as const, is_del: 0 as const,
      provider_ready: false, content_configured: false, content_valid: true, ready: false,
    });
  }
  return getData<PrintDocumentView>(request.get(`/print/form/${id}`));
}

export function apiSavePrintDocument(id: number, data: Record<string, string | number>) {
  if (previewMode) {
    let row = previewDocuments.find((item) => item.id === id);
    if (!row) {
      const template = previewDocuments[0];
      if (!template) return Promise.reject(new Error("预览数据不可用"));
      row = { ...template, id: Math.max(0, ...previewDocuments.map((item) => item.id)) + 1 };
      previewDocuments.unshift(row);
      previewContents.set(row.id, structuredClone(previewContent));
    }
    row.print_name = String(data.print_name ?? row.print_name);
    row.type = Number(data.type ?? row.type) === 2 ? 2 : 1;
    row.print_type = Number(data.print_type ?? row.print_type) === 2 ? 2 : 1;
    row.times = Number(data.times ?? row.times);
    return Promise.resolve({ ...row });
  }
  return getData<PrintDocumentView>(request.post(`/print/save/${id}`, data));
}

export function apiSetPrintDocumentStatus(id: number, status: 0 | 1) {
  if (previewMode) {
    const row = previewDocuments.find((item) => item.id === id);
    if (!row) return Promise.reject(new Error("打印机不存在"));
    row.status = status;
    return Promise.resolve({ ...row });
  }
  return getData<PrintDocumentView>(request.put(`/print/set_status/${id}/${status}`));
}

export function apiDeletePrintDocument(id: number) {
  if (previewMode) {
    const index = previewDocuments.findIndex((item) => item.id === id);
    if (index >= 0) previewDocuments.splice(index, 1);
    previewContents.delete(id);
    return Promise.resolve(null);
  }
  return getData<null>(request.delete(`/print/del/${id}`));
}

export function apiPrintContent(id: number) {
  if (previewMode) {
    const value = previewContents.get(id);
    if (!value) return Promise.reject(new Error("打印机不存在"));
    return Promise.resolve(clonePrintContent(value));
  }
  return getData<PrintContent>(request.get(`/print/content/${id}`));
}

export function apiSavePrintContent(id: number, content: PrintContent) {
  if (previewMode) {
    const row = previewDocuments.find((item) => item.id === id);
    if (!row) return Promise.reject(new Error("打印机不存在"));
    previewContents.set(id, clonePrintContent(content));
    row.content_configured = true;
    row.content_valid = true;
    row.ready = row.provider_ready;
    return Promise.resolve({ ...row });
  }
  return getData<PrintDocumentView>(request.post(`/print/save_content/${id}`, content));
}

export function apiPrintJobs(params: Record<string, string | number> = {}) {
  if (previewMode) return Promise.resolve({
    list: [], next_cursor: null,
    summary: { pending: 0, sent: 0, unknown: 0, dead: 0, closed: 0 },
  });
  return getData<PrintJobListResult>(request.get("/print/jobs", { params }));
}

export function apiOperatePrintJob(
  id: number,
  action: "confirm-sent" | "confirm-retry" | "close",
  reason: string,
) {
  if (previewMode) return Promise.resolve({ duplicate: false });
  return getData<{ duplicate: boolean }>(request.post(`/print/jobs/${id}/${action}`, {
    request_key: crypto.randomUUID(),
    reason,
  }));
}

export function apiAdminManualPrint(orderId: number, printerId?: number) {
  if (previewMode) return Promise.resolve({ duplicate: false, jobs: [{ id: 1, status: "PENDING" }] });
  return getData<{ duplicate: boolean; jobs: Array<{ id: number; status: string }> }>(
    request.post(`/order/print/${orderId}`, {
      request_key: crypto.randomUUID(),
      printer_id: printerId,
    }),
  );
}
