import { eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeBargain } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

export type BargainShippingQuote = Pick<typeof storeBargain.$inferSelect,
  'productId' | 'deliveryType' | 'freight' | 'postage' | 'tempId'>;

/** PHP cart admission: shippingType=1 covers express(1) and store delivery(3),
 * while shippingType=2 means pickup. Empty historical methods are unrestricted;
 * they do not inherit the base product. Non-logistics types keep their separate
 * ManualVirtualDeliveryPolicy contract even when PHP stores delivery_type=2.
 */
export function assertBargainShippingMethod(quote: BargainShippingQuote, productType: number, shippingType: number): void {
  if ([1, 2, 3].includes(productType)) return;
  if (!quote.deliveryType) return;
  if (quote.deliveryType.length > 10 || !/^[123](?:,[123])*$/.test(quote.deliveryType)) {
    throw new ValidateException('砍价配送配置无效，请联系管理员');
  }
  const methods = quote.deliveryType.split(',');
  const allowed = shippingType === 2 ? methods.includes('2') : methods.includes('1') || methods.includes('3');
  if (!allowed) throw new ValidateException('砍价活动不支持所选配送方式，请重新选择');
}

/** Caller already owns the activity NO KEY UPDATE boundary. Re-read after any
 * wait, before claiming carts; no extra resource/lock or external I/O is added.
 * Do not silently reprice freight after the initial quote. Unrelated metadata
 * and inventory changes are handled by their existing contracts, not this one.
 */
export async function assertBargainShippingQuote(tx: DbClient, activityId: number,
  quoted: BargainShippingQuote | null, productType: number, shippingType: number): Promise<void> {
  if (!quoted) throw new ValidateException('砍价配送报价缺失，请刷新后重试');
  const [current] = await tx.select({ productId: storeBargain.productId, deliveryType: storeBargain.deliveryType,
    freight: storeBargain.freight, postage: storeBargain.postage, tempId: storeBargain.tempId })
    .from(storeBargain).where(eq(storeBargain.id, activityId)).limit(1);
  if (!current || current.productId !== quoted.productId || current.deliveryType !== quoted.deliveryType ||
    current.freight !== quoted.freight || current.postage !== quoted.postage || current.tempId !== quoted.tempId) {
    throw new ValidateException('砍价配送或运费规则已变化，请刷新后重试');
  }
  assertBargainShippingMethod(current, productType, shippingType);
}
