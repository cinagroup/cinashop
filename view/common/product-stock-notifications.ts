/** The stock channel carries only a product identifier. Withdrawal frames are
 * never accepted here, and the default withdrawal parser remains unchanged. */
export function parseStockNoticeFrame(value: unknown): { type: 'ready' | 'changed'; revision: number; productId?: number } | null {
  if (typeof value !== 'string' || value.length > 256) return null;
  let frame: Record<string, unknown>;
  try { frame = JSON.parse(value); } catch { return null; }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || !Number.isSafeInteger(frame.revision) || Number(frame.revision) < 0) return null;
  if (frame.type === 'product_stock_ready' && frame.refresh === true && Object.keys(frame).length === 3) return { type: 'ready', revision: Number(frame.revision) };
  if (frame.type !== 'STORE_STOCK' || Number(frame.revision) <= 0 || Object.keys(frame).length !== 3 || !frame.data || typeof frame.data !== 'object' || Array.isArray(frame.data)) return null;
  const data = frame.data as Record<string, unknown>;
  if (Object.keys(data).length !== 1 || !Number.isSafeInteger(data.id) || Number(data.id) < 1 || Number(data.id) > 2_147_483_647) return null;
  return { type: 'changed', revision: Number(frame.revision), productId: Number(data.id) };
}
