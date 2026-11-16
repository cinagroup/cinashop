import type { IntentStorage } from './checkoutIntent';
import { ordinaryRecoveryKey, parseOrdinaryRecovery } from './categoryCatalog';

export interface ProductCouponBuyIntent {
  version: 1; uid: number; attempt: string; productId: number; unique: string; quantity: number;
  issueId: number; title: string; phase: 'cart-unknown' | 'cart-ready' | 'claim-unknown' | 'ready';
  cartId: number | null; ownedId: number | null; claimAttempt: string | null;
  evidence: 'none' | 'directory' | 'grant' | 'receipt'; decision: 'apply' | 'declined';
}
export const productCouponBuyKey = (uid: number) => `cinashop_product_coupon_buy_v1_${uid}`;
export const productCouponBuyAttempt = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{1,16}:[0-9]{1,12}:[a-f0-9]{16}$/u.test(value);
const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const fields = 'attempt,cartId,claimAttempt,decision,evidence,issueId,ownedId,phase,productId,quantity,title,uid,unique,version';
const invalid = () => Error('原领券购买资料不可读取，请返回原商品核对，当前不会重复提交');

export function decodeProductCouponBuyIntent(raw: unknown, uid: number): ProductCouponBuyIntent {
  if (typeof raw !== 'string' || raw.length > 4096 || !id(uid)) throw invalid();
  let row: ProductCouponBuyIntent;
  try { row = JSON.parse(raw); } catch { throw invalid(); }
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== fields
    || row.version !== 1 || row.uid !== uid || !productCouponBuyAttempt(row.attempt) || !id(row.productId) || !id(row.issueId)
    || typeof row.unique !== 'string' || !row.unique.length || row.unique.length > 16 || /[\u0000-\u001f\u007f]/u.test(row.unique)
    || !Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 32767
    || typeof row.title !== 'string' || [...row.title].length > 255 || /[\u0000-\u001f\u007f]/u.test(row.title)
    || !['cart-unknown', 'cart-ready', 'claim-unknown', 'ready'].includes(row.phase)
    || !['none', 'directory', 'grant', 'receipt'].includes(row.evidence) || !['apply', 'declined'].includes(row.decision)
    || (row.cartId !== null && !id(row.cartId)) || (row.ownedId !== null && !id(row.ownedId))
    || (row.claimAttempt !== null && (typeof row.claimAttempt !== 'string' || !/^\d{1,16}:\d{1,12}$/u.test(row.claimAttempt)))
    || (row.phase === 'cart-unknown' ? row.cartId !== null : row.cartId === null)
    || (row.phase === 'claim-unknown' && (row.claimAttempt === null || row.evidence !== 'none'))
    || (row.phase === 'ready' && (row.evidence === 'none' || row.evidence === 'grant' && row.ownedId === null))
    || (row.phase !== 'ready' && row.ownedId !== null)
    || (['grant', 'receipt'].includes(row.evidence) && (row.phase !== 'ready' || row.claimAttempt === null))
    || (row.evidence === 'directory' && row.claimAttempt !== null)
    || (row.decision === 'declined' && row.phase !== 'ready')) throw invalid();
  return row;
}

/** A durable sidecar to the existing ordinary cart journal. No token or stored
 * session epoch is authority: every consumer revalidates the original cart and
 * coupon using the current account's requests. */
export class ProductCouponBuyJournal {
  constructor(private readonly storage: IntentStorage) {}
  read(uid: number) {
    const raw = this.storage.get(productCouponBuyKey(uid));
    return raw === undefined || raw === null || raw === '' ? null : decodeProductCouponBuyIntent(raw, uid);
  }
  assertCurrent(intent: ProductCouponBuyIntent) {
    const live = this.read(intent.uid);
    if (!live || JSON.stringify(live) !== JSON.stringify(intent)) throw Error('原领券购买记录已变化，请重新读取');
    return live;
  }
  private save(intent: ProductCouponBuyIntent) {
    const raw = JSON.stringify(intent); decodeProductCouponBuyIntent(raw, intent.uid);
    this.storage.set(productCouponBuyKey(intent.uid), raw);
    if (this.storage.get(productCouponBuyKey(intent.uid)) !== raw) throw Error('购买恢复资料未能保存，当前不会提交新请求');
    return decodeProductCouponBuyIntent(raw, intent.uid);
  }
  begin(intent: ProductCouponBuyIntent) {
    if (this.read(intent.uid)) throw Error('请先核对本账号原领券购买记录');
    if (intent.phase !== 'cart-unknown' || intent.claimAttempt !== null || intent.decision !== 'apply') throw invalid();
    return this.save(intent);
  }
  update(intent: ProductCouponBuyIntent, changes: Partial<Pick<ProductCouponBuyIntent, 'phase' | 'cartId' | 'ownedId' | 'claimAttempt' | 'evidence' | 'decision'>>) {
    this.assertCurrent(intent);
    return this.save({ ...intent, ...changes });
  }
  clear(intent: ProductCouponBuyIntent) {
    this.assertCurrent(intent);
    this.storage.remove(productCouponBuyKey(intent.uid));
    if (this.read(intent.uid)) throw Error('原领券购买记录暂未清理，请重试查看订单');
  }
  /** Only after a known order result AND successful navigation. Never remove an
   * unrelated cart or an unknown write while cleaning this completed attempt. */
  completed(intent: ProductCouponBuyIntent, cartIds: readonly number[]) {
    this.assertCurrent(intent);
    if (intent.phase !== 'ready' || cartIds.length !== 1 || cartIds[0] !== intent.cartId) throw invalid();
    const raw = this.storage.get(ordinaryRecoveryKey(intent.uid));
    if (raw !== undefined && raw !== null && raw !== '') {
      const ordinary = parseOrdinaryRecovery(raw, intent.uid);
      if (ordinary.state === 'acknowledged' && ordinary.mode === 'buy' && ordinary.cartId === intent.cartId
        && ordinary.productId === intent.productId && ordinary.unique === intent.unique && ordinary.quantity === intent.quantity) {
        this.storage.remove(ordinaryRecoveryKey(intent.uid));
        if (this.storage.get(ordinaryRecoveryKey(intent.uid))) throw Error('原购买记录暂未清理，请重试查看订单');
      }
    }
    this.clear(intent);
  }
}
