/** The generic editor must not replay unchanged, stale inventory on rename.
 * Explicit inventory changes carry both original values for server comparison.
 */
const fields = ["productId", "storeName", "image", "price", "minPrice", "stock", "quota", "num", "people", "sort", "status"] as const;
/** DatePicker uses Date objects; server strings have an explicit UTC offset. */
export function bargainFormDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (!(value instanceof Date) && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))) {
    throw new Error("砍价时间格式无效，请刷新后重试");
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime()) || typeof value === "string" && date.toISOString() !== value) throw new Error("砍价时间无效");
  return date;
}
export function bargainEditPayload(form: Record<string, unknown>, original: Record<string, unknown> | null): Record<string, unknown> {
  const payload: Record<string, unknown> = { type: "bargain" };
  if (original) payload.id = original.id;
  for (const key of fields) {
    if (!original || form[key] !== original[key]) payload[key] = form[key];
  }
  const start = bargainFormDate(form.startTime), stop = bargainFormDate(form.stopTime);
  if (!start || !stop) throw new Error("请选择砍价开始和结束时间");
  if (start >= stop) throw new Error("活动开始时间必须早于结束时间");
  for (const key of ["startTime", "stopTime"] as const) {
    const value = (key === "startTime" ? start : stop).toISOString();
    if (!original || value !== bargainFormDate(original[key])?.toISOString()) payload[key] = value;
  }
  if (original && ("stock" in payload || "quota" in payload)) {
    if (!Number.isSafeInteger(original.stock) || !Number.isSafeInteger(original.quota)) {
      throw new Error("库存原值无效，请刷新后重试");
    }
    payload.expected = { stock: original.stock, quota: original.quota };
  }
  return payload;
}
