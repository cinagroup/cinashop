import { and, asc, desc, eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { shippingTemplates, storeBargain } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

type Shipping = Pick<typeof storeBargain.$inferSelect, 'deliveryType' | 'freight' | 'postage' | 'tempId'>;
type Owner = { type: number; relationId: number; productType: number };
export const bargainShippingFields = (row: Shipping): Shipping => ({
  deliveryType: row.deliveryType, freight: row.freight, postage: row.postage, tempId: row.tempId,
});
const fail = (): never => { throw new ValidateException('砍价配送配置或原值无效'); };
function fields(value: unknown, expected = false): Shipping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (typeof row.deliveryType !== 'string' || row.deliveryType.length > 10 ||
      (!expected && !/^[123](?:,[123]){0,2}$/.test(row.deliveryType)) ||
      (!expected && new Set(row.deliveryType.split(',')).size !== row.deliveryType.split(',').length) ||
      typeof row.freight !== 'number' || !Number.isInteger(row.freight) || row.freight < 1 || row.freight > 3 ||
      typeof row.postage !== 'string' || !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(row.postage) ||
      typeof row.tempId !== 'number' || !Number.isSafeInteger(row.tempId) || row.tempId < 0 || row.tempId > 2_147_483_647) return fail();
  const [whole, fraction = ''] = row.postage.split('.');
  return { deliveryType: expected ? row.deliveryType : row.deliveryType.split(',').sort().join(','),
    freight: row.freight, postage: `${whole}.${fraction.padEnd(2, '0')}`, tempId: row.tempId };
}
export function parseBargainShipping(value: unknown): { values: Shipping; expected?: Shipping } | undefined {
  if (value === undefined) return undefined;
  const values = fields(value), original = (value as Record<string, unknown>).expected;
  return { values, ...(original === undefined ? {} : { expected: fields(original, true) }) };
}
function templateScope(owner: Owner) {
  // Shipping owners use the same 0=platform, 1=store, 2=supplier contract as products.
  // Unknown/corrupt owners must not fall back to another tenant's templates.
  if (![0, 1, 2].includes(owner.type) || !Number.isSafeInteger(owner.relationId) ||
      (owner.type === 0 ? owner.relationId !== 0 : owner.relationId <= 0)) return fail();
  return and(eq(shippingTemplates.ownerType, owner.type), eq(shippingTemplates.relationId, owner.relationId),
    eq(shippingTemplates.isDel, 0), eq(shippingTemplates.status, 1));
}
export async function readBargainShippingTemplates(tx: DbClient, owner: Owner) {
  if ([1, 2, 3].includes(owner.productType)) return [];
  const rows = await tx.select({ id: shippingTemplates.id, name: shippingTemplates.name }).from(shippingTemplates)
    .where(templateScope(owner)).orderBy(desc(shippingTemplates.sort), asc(shippingTemplates.id)).limit(501);
  if (rows.length > 500) throw new ValidateException('可用运费模板超过500项，请先整理');
  return rows;
}

/** Called after the activity NO KEY UPDATE and source SHARE locks. Template
 * SHARE must fail fast, never introduce a reverse-order wait with its editor.
 * Omission preserves historical rules; only deliberate edits require originals.
 */
export async function prepareBargainShipping(tx: DbClient, input: ReturnType<typeof parseBargainShipping>,
  current: Shipping | undefined, owner: Owner): Promise<Partial<Shipping>> {
  if (!input) return {};
  if (current && (!input.expected || Object.entries(bargainShippingFields(current)).some(
    ([key, value]) => input.expected![key as keyof Shipping] !== value))) {
    throw new ValidateException('砍价配送或运费规则已变化，请刷新后重试');
  }
  const values = { ...input.values };
  if (owner.productType !== 0) values.deliveryType = '2';
  if ([1, 2, 3].includes(owner.productType)) return { ...values, freight: 2, postage: '0.00', tempId: 0 };
  if (values.freight === 1) return { ...values, postage: '0.00', tempId: 0 };
  if (values.freight === 2) {
    if (values.postage === '0.00') throw new ValidateException('请设置大于零的运费金额');
    return { ...values, tempId: 0 };
  }
  if (!values.tempId) throw new ValidateException('请选择运费模板');
  try {
    const [template] = await tx.select({ id: shippingTemplates.id }).from(shippingTemplates)
      .where(and(eq(shippingTemplates.id, values.tempId), templateScope(owner))).limit(1).for('share', { noWait: true });
    if (!template) throw new ValidateException('运费模板不可用或不属于商品所属方');
  } catch (error) {
    let cause: unknown = error;
    while (cause && typeof cause === 'object' && 'cause' in cause && cause.cause) cause = cause.cause;
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === '55P03') {
      throw new ValidateException('运费模板正在更新，请稍后重试');
    }
    throw error;
  }
  return { ...values, postage: '0.00' };
}
