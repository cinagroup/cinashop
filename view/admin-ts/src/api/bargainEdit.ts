/** The generic editor must not replay unchanged, stale inventory on rename.
 * Explicit inventory changes carry both original values for server comparison.
 */
const fields = ["productId", "storeName", "image", "price", "minPrice", "stock", "quota", "num", "people", "sort", "status"] as const;
export function bargainEditPayload(form: Record<string, unknown>, original: Record<string, unknown> | null): Record<string, unknown> {
  const payload: Record<string, unknown> = { type: "bargain" };
  if (original) payload.id = original.id;
  for (const key of fields) {
    if (!original || form[key] !== original[key]) payload[key] = form[key];
  }
  if (original && ("stock" in payload || "quota" in payload)) {
    if (!Number.isSafeInteger(original.stock) || !Number.isSafeInteger(original.quota)) {
      throw new Error("库存原值无效，请刷新后重试");
    }
    payload.expected = { stock: original.stock, quota: original.quota };
  }
  return payload;
}
