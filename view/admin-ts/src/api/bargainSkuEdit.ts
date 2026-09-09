export interface BargainSkuOption {
  id: number; unique: string; suk: string; stock: number; quota: number; price: string; image: string;
}
export interface BargainSkuOptions {
  productId: number; activityId: number; options: BargainSkuOption[]; current: BargainSkuOption[];
}

/** Add the single-SKU write only for an explicit selection/rule/inventory edit.
 * A rename must never replay a stale activity-SKU inventory snapshot.
 */
export function withBargainSku(payload: Record<string, unknown>, options: BargainSkuOptions | null, baseUnique: string,
  selectedOriginally: string, productId: number): Record<string, unknown> {
  const needsSku = !payload.id || ['stock','quota','price','productId'].some(key => key in payload) || baseUnique !== selectedOriginally;
  if (!needsSku) return payload;
  if (!options || options.productId !== productId || options.activityId !== (payload.id ?? 0)) throw new Error('请先加载当前商品的砍价规格');
  if (!baseUnique || !options.options.some(row => row.unique === baseUnique)) throw new Error('请选择砍价规格');
  if (options.current.length > 1) throw new Error('现有多规格砍价须专项整理，不能自动删减规格');
  const existing = options.current[0];
  return { ...payload, sku: { baseUnique, ...(payload.id ? { expected: existing ? {
    id: existing.id, unique: existing.unique, stock: existing.stock, quota: existing.quota,
  } : null } : {}) } };
}
