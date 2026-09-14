import { ValidateException } from '@/utils/errors';
import { normalizeOutRequestKey } from '../out/OutIdempotency';

/** Supplied separately by authenticated controllers, never taken from form data. */
export interface ShippingCreationContext { actorId: number; requestKey: unknown }

export function requireShippingCreationContext(context?: ShippingCreationContext) {
  const requestKey = normalizeOutRequestKey(context?.requestKey);
  const actorId = context?.actorId;
  if (typeof actorId !== 'number' || !Number.isSafeInteger(actorId) || actorId <= 0 || actorId > 2_147_483_647) {
    throw new ValidateException('运费创建身份无效');
  }
  return { actorId, requestKey };
}
