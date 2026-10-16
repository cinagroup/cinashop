import type { storeOrder, storeOrderCartInfo } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { planOrderFinancialSplit } from './OrderSplitFinance';
import { LEGACY_GAIN_EDIT_MARKER, legacyGainIntegralState, plannedLegacyGainIntegralProof,
  type LegacyGainIntegralProof } from './UnpaidOrderGainIntegralProof';

type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;

export const UNPAID_GAIN_EDIT_POLICY = 'purchase-gift-then-quantity-last-residue-v1' as const;
const MAX_POINTS = 9_999_999_999;
const invalid = () => new ValidateException('待付款订单赠送积分或行级财务凭据不一致，请刷新核对');

export interface UnpaidOrderGainIntegralEditInput {
  operationId: string;
  gainIntegral: number;
}
export interface UnpaidOrderGainIntegralEditLine {
  rowId: number;
  cartId: string;
  beforeCartInfo: string;
  afterCartInfo: string;
  beforeGainIntegral: number;
  afterGainIntegral: number;
}
export interface UnpaidOrderGainIntegralEditEvidence {
  version: 'supplier-unpaid-gain-edit-v1';
  operation_id: string;
  policy: typeof UNPAID_GAIN_EDIT_POLICY;
  weight_basis: 'purchase-gift' | 'quantity';
  before_total: number;
  after_total: number;
  changed: boolean;
  source_format: 'checkout' | 'legacy-php';
  source: { order_id: number; buyer_id: number; supplier_id: number };
  before_state_sha256: string;
  after_state_sha256: string;
  lines: Array<{
    row_id: number;
    cart_id: string;
    product_id: number;
    quantity: number;
    is_gift: 0 | 1;
    weight: number;
    before_gain_integral: number;
    after_gain_integral: number;
    before_sha256: string;
    after_sha256: string;
    before_origin_hash: string;
    after_origin_hash: string;
  }>;
}
export interface UnpaidOrderGainIntegralEditPlan {
  gainIntegral: string;
  lines: UnpaidOrderGainIntegralEditLine[];
  evidence: UnpaidOrderGainIntegralEditEvidence;
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw invalid();
  return value;
}
function whole(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid();
  if (!/^(?:0|[1-9]\d{0,9})(?:\.00)?$/.test(String(value))) throw invalid();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_POINTS) throw invalid();
  return result;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function parse(value: string | null): Record<string, unknown> {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > 65_536) throw invalid();
  try { return object(JSON.parse(value)); } catch { throw invalid(); }
}
function purchaseWeight(info: Record<string, unknown>, quantity: number): number {
  const give = object(info.product).giveIntegral;
  if ((typeof give !== 'string' && typeof give !== 'number')
    || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(String(give))) throw invalid();
  const [integer, fraction = ''] = String(give).split('.');
  const weight = (BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0'))) * BigInt(quantity) / 100n;
  if (weight > BigInt(MAX_POINTS)) throw invalid();
  return Number(weight);
}
async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A pure financial plan, never Supplier authority or permission to write.
 * The caller holds the original unpaid root and ALL line locks, proves live
 * actor/tenant/lifecycle/payment evidence, and commits these rows, root totals
 * and the immutable operation evidence in the SAME owning transaction.
 *
 * Explicit gain_integral is the existing effective whole-line grant consumed
 * by both financial split and refund readers. Original product.giveIntegral,
 * financial_version and all other purchase facts remain unchanged. The fixed
 * purchase weights make repeated edits independent of an earlier allocation;
 * if every purchase grant was zero, non-gift quantities supply the weights.
 * Integer ratios truncate and the final positive-weight SQL row owns residue.
 */
export async function planUnpaidOrderGainIntegralEdit(
  order: Order, rows: readonly Cart[], input: UnpaidOrderGainIntegralEditInput,
  proof?: LegacyGainIntegralProof | null,
): Promise<UnpaidOrderGainIntegralEditPlan> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.operationId)
    || !Number.isSafeInteger(input.gainIntegral) || input.gainIntegral < 0 || input.gainIntegral > MAX_POINTS
    || order.paid !== 0 || order.status !== 0 || order.pid !== 0 || order.isDel !== 0 || order.isSystemDel !== 0
    || !rows.length || rows.length > 200) throw invalid();
  positive(order.id);
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  if (new Set(sorted.map(row => positive(row.id))).size !== sorted.length
    || sorted.reduce((bytes, row) => bytes + new TextEncoder().encode(row.cartInfo ?? '').length, 0) > 8_388_608) throw invalid();
  const original = sorted.map(row => parse(row.cartInfo));
  const modern = original.every(info => info.financial_version === 'checkout-line-finance-v1');
  const legacy = original.every(info => !Object.hasOwn(info, 'financial_version'));
  if (!modern && !legacy) throw invalid();
  const selection = new Map(sorted.map(row => [row.cartId, row.cartNum]));
  const before = planOrderFinancialSplit(order, sorted, selection,proof);
  if (!before || modern && before.legacyPhpProjection !== null || legacy && before.legacyPhpProjection !== 'original-purchase') throw invalid();
  const beforeTotal = whole(order.gainIntegral), changed = beforeTotal !== input.gainIntegral;
  const normalized = sorted.map(row => {
    const selected = before.carts.get(row.cartId)?.selected;
    if (!selected) throw invalid();
    return parse(selected);
  });
  const giftWeights = sorted.map((row, index) => row.isGift === 1 ? 0 : purchaseWeight(legacy ? normalized[index] : original[index], row.cartNum));
  const weightBasis = giftWeights.some(weight => weight > 0) ? 'purchase-gift' : 'quantity';
  const weights = weightBasis === 'purchase-gift' ? giftWeights : sorted.map(row => row.isGift === 1 ? 0 : row.cartNum);
  const totalWeight = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  const last = weights.reduce((prior, weight, index) => weight > 0 ? index : prior, -1);
  if (!totalWeight || last < 0) throw invalid();
  let remaining = BigInt(input.gainIntegral);
  const lines = sorted.map((row, index): UnpaidOrderGainIntegralEditLine => {
    positive(row.productId);
    const beforeGainIntegral = whole(normalized[index].gain_integral);
    const allocated = !changed ? BigInt(beforeGainIntegral) : weights[index] === 0 ? 0n : index === last ? remaining
      : BigInt(input.gainIntegral) * BigInt(weights[index]) / totalWeight;
    remaining -= allocated;
    const afterGainIntegral = Number(allocated);
    return { rowId: row.id, cartId: row.cartId, beforeCartInfo: row.cartInfo!,
      afterCartInfo: changed ? JSON.stringify({ ...original[index], gain_integral: String(afterGainIntegral),
        ...(legacy ? { [LEGACY_GAIN_EDIT_MARKER]: { version: 'supplier-unpaid-gain-edit-v1', operation_id: input.operationId } } : {}) }) : row.cartInfo!,
      beforeGainIntegral, afterGainIntegral };
  });
  if (remaining !== 0n) throw invalid();
  const gainIntegral = `${input.gainIntegral}.00`;
  const afterRows = sorted.map((row, index) => ({ ...row, cartInfo: lines[index].afterCartInfo }));
  const afterProof = legacy && changed ? plannedLegacyGainIntegralProof(order, afterRows, input.operationId) : proof;
  const after = planOrderFinancialSplit({ ...order, gainIntegral }, afterRows, selection,afterProof);
  if (!after || modern && after.legacyPhpProjection !== null || legacy && after.legacyPhpProjection !== 'original-purchase'
    || after.selected.gainIntegral !== gainIntegral) throw invalid();
  const beforeState = await legacyGainIntegralState(order,sorted), afterState = await legacyGainIntegralState(order,afterRows);
  const evidenceLines = await Promise.all(lines.map(async (line, index) => ({
    row_id: line.rowId, cart_id: line.cartId, product_id: sorted[index].productId,
    quantity: sorted[index].cartNum, is_gift: sorted[index].isGift as 0 | 1, weight: weights[index],
    before_gain_integral: line.beforeGainIntegral, after_gain_integral: line.afterGainIntegral,
    before_sha256: await sha256(line.beforeCartInfo), after_sha256: await sha256(line.afterCartInfo),
    before_origin_hash: await outRequestHash(line.beforeCartInfo), after_origin_hash: await outRequestHash(line.afterCartInfo),
  })));
  return { gainIntegral, lines, evidence: { version: 'supplier-unpaid-gain-edit-v1', operation_id: input.operationId,
    policy: UNPAID_GAIN_EDIT_POLICY, weight_basis: weightBasis, before_total: beforeTotal,
    after_total: input.gainIntegral, changed, source_format: modern ? 'checkout' : 'legacy-php',
    source: { order_id: order.id, buyer_id: order.uid, supplier_id: order.supplierId },
    before_state_sha256: beforeState.hash, after_state_sha256: afterState.hash, lines: evidenceLines } };
}
