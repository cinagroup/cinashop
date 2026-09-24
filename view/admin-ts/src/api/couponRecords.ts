import request, { getData } from "@/utils/request";

export interface CouponRecordRow {
  id: number;
  uid: number;
  coupon_title: string;
  nickname: string;
  coupon_price: string;
  use_min_price: string;
  coupon_type: 1 | 2 | null;
  start_time: string | null;
  end_time: string | null;
  receive_source: string;
  receive_source_label: string;
  is_fail: number;
  status: number;
  status_label: string;
}

export interface CouponRecordPage {
  list: CouponRecordRow[];
  count: number;
  page: number;
  limit: number;
}

export interface CouponRecordQuery {
  page: number;
  limit: number;
  status?: 0 | 1 | 2 | 3;
  nickname?: string;
  coupon_title?: string;
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,12}(?:\.\d{1,2})?$/u.test(value);
}

function dateText(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value)));
}

export function parseCouponRecordPage(value: unknown): CouponRecordPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("领取记录格式错误");
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.list) || !integer(page.count, 0) || !integer(page.page, 1) ||
    !integer(page.limit, 1) || page.list.length > page.limit || page.list.length > page.count) {
    throw new Error("领取记录格式错误");
  }
  const ids = new Set<number>();
  const list = page.list.map((item): CouponRecordRow => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("领取记录字段错误");
    const row = item as Record<string, unknown>;
    if (!integer(row.id, 1) || !integer(row.uid, 0) || ids.has(row.id) ||
      typeof row.coupon_title !== "string" || typeof row.nickname !== "string" ||
      !decimal(row.coupon_price) || !decimal(row.use_min_price) ||
      (row.coupon_type !== null && row.coupon_type !== 1 && row.coupon_type !== 2) ||
      !dateText(row.start_time) || !dateText(row.end_time) ||
      typeof row.receive_source !== "string" || typeof row.receive_source_label !== "string" ||
      !integer(row.is_fail, 0) || !integer(row.status, 0) || typeof row.status_label !== "string") {
      throw new Error("领取记录字段错误");
    }
    ids.add(row.id);
    return row as unknown as CouponRecordRow;
  });
  return { list, count: page.count, page: page.page, limit: page.limit };
}

export async function apiAdminCouponRecords(query: CouponRecordQuery, signal?: AbortSignal): Promise<CouponRecordPage> {
  return parseCouponRecordPage(await getData<unknown>(request.get("/marketing/coupon-records/list", { params: query, signal })));
}
