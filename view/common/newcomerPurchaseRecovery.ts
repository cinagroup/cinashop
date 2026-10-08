/** A local fence for type-7 direct-buy writes. It is not a server receipt. */
export interface NewcomerPurchaseRecovery {
  version: 1;
  actor: number;
  activityId: number;
  productId: number;
  activityUnique: string;
  requestKey: string;
  state: 'unknown' | 'acknowledged';
  cartId: number | null;
}

const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;

export function newcomerRecoveryKey(uid: number): string {
  if (!id(uid)) throw new Error('购买账号无效');
  return `cinashop_newcomer_purchase_v1_${uid}`;
}

export function parseNewcomerRecovery(raw: unknown, uid: number): NewcomerPurchaseRecovery {
  if (!id(uid) || typeof raw !== 'string' || raw.length > 2048) throw new Error('新人购买恢复资料异常');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('新人购买恢复资料异常'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('新人购买恢复资料异常');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'activityId,activityUnique,actor,cartId,productId,requestKey,state,version'
    || row.version !== 1 || row.actor !== uid || !id(row.activityId) || !id(row.productId)
    || typeof row.activityUnique !== 'string' || !row.activityUnique || row.activityUnique.length > 255
    || typeof row.requestKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(row.requestKey)
    || !['unknown', 'acknowledged'].includes(String(row.state))
    || (row.state === 'unknown' ? row.cartId !== null : !id(row.cartId))) throw new Error('新人购买恢复资料异常');
  return row as unknown as NewcomerPurchaseRecovery;
}

export function sameNewcomerIntent(a: NewcomerPurchaseRecovery, b: NewcomerPurchaseRecovery): boolean {
  return a.actor === b.actor && a.requestKey === b.requestKey && a.activityId === b.activityId && a.productId === b.productId
    && a.activityUnique === b.activityUnique;
}
