import { and, eq, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { wechatUser } from '@/models/schema';
import { offlineOrderPaymentSelection } from '@/models/candidates/offline_order_payment_selection';
import { ApiException, ValidateException } from '@/utils/errors';
import { offlineAmountCents, offlinePayableCents } from './OfflineOrderQuoteService';
import { assertUnpaidOfflineOrder, lockOfflineOrderPayment, type OfflineOrderPaymentContext } from './OfflineOrderPaymentContext';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PAYER = /^[A-Za-z0-9_-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Selection = typeof offlineOrderPaymentSelection.$inferSelect;
/** Trusted server configuration, NEVER a customer DTO. Credential validation
 * and capability switches are handled by the dedicated dispatcher candidate.
 */
export interface OfflineExternalPaymentIdentity {
  provider: 'wechat' | 'alipay';
  profile: 'wechat' | 'routine' | 'alipay';
  appId: string;
  merchantId: string;
}
function wechatShape(channel: string) {
  return channel === 'routine' ? { profile: 'routine' as const, transactionType: 'jsapi' as const }
    : { profile: 'wechat' as const, transactionType: channel === 'wechat' ? 'jsapi' as const : 'h5' as const };
}
function identityMatches(selection: Selection, context: OfflineOrderPaymentContext): boolean {
  if (selection.rail === 'yue') return selection.profile === '' && selection.transactionType === ''
    && selection.appId === '' && selection.merchantId === '' && selection.payerId === '';
  if (!ID.test(selection.appId) || !ID.test(selection.merchantId)) return false;
  if (selection.rail === 'alipay') return selection.profile === 'alipay' && selection.transactionType === 'wap' && selection.payerId === '';
  if (selection.rail !== 'wechat') return false;
  const expected = wechatShape(context.admission.channel);
  return selection.profile === expected.profile && selection.transactionType === expected.transactionType
    && (expected.transactionType === 'jsapi' ? PAYER.test(selection.payerId) : selection.payerId === '');
}
/** Immutable read: do not re-resolve today's payer binding on recovery. */
export async function readOfflinePaymentSelectionTx(tx: DbClient, context: OfflineOrderPaymentContext) {
  const [selection] = await tx.select().from(offlineOrderPaymentSelection)
    .where(eq(offlineOrderPaymentSelection.orderId, context.order.id));
  if (!selection) return undefined;
  const amount = offlineAmountCents(selection.payPrice);
  if (selection.uid !== context.order.uid || selection.orderNo !== context.order.orderId || selection.payPrice !== context.admission.payPrice
    || selection.version !== 'offline-payment-v1' || selection.currency !== 'CNY' || !UUID.test(selection.selectionKey)
    || selection.createdAt < context.admission.createdAt || !identityMatches(selection, context)
    || (selection.rail !== 'yue' && amount > 2_147_483_647n)) throw new ValidateException('线下消费支付路径凭据不一致');
  return selection;
}

export async function insertOfflineWalletSelectionTx(tx: DbClient, context: OfflineOrderPaymentContext, paidAt: number) {
  // The caller owns order/account locks. The deferred database guard also
  // requires the wallet receipt in this same transaction before commit.
  await tx.insert(offlineOrderPaymentSelection).values({ orderId: context.order.id, selectionKey: crypto.randomUUID(),
    uid: context.order.uid, orderNo: context.order.orderId, rail: 'yue', profile: '', transactionType: '',
    appId: '', merchantId: '', payerId: '', payPrice: context.admission.payPrice, createdAt: paidAt });
}

/** Internal pre-dispatch reservation only. No provider call, success claim,
 * channel switch, or release of an uncertain external payment is performed.
 * A replay retains the original payer and must go to query/recovery, not a new
 * provider request. Do not expose the returned internal payer snapshot via HTTP.
 */
export async function selectOfflineOrderExternalPayment(container: Container,
  input: { uid: number; orderNo: string; identity: OfflineExternalPaymentIdentity }) {
  return withTx(container, tx => selectOfflineOrderExternalPaymentTx(tx, input));
}

/** Caller may compose selection + recovery intent + dispatch atomically. */
export async function selectOfflineOrderExternalPaymentTx(tx: DbClient,
  input: { uid: number; orderNo: string; identity: OfflineExternalPaymentIdentity }) {
  const identity = input.identity;
  if (!identity || !['wechat', 'alipay'].includes(identity.provider)
    || typeof identity.appId !== 'string' || typeof identity.merchantId !== 'string' || !ID.test(identity.appId) || !ID.test(identity.merchantId)
    || (identity.provider === 'alipay' ? identity.profile !== 'alipay' : !['wechat', 'routine'].includes(identity.profile))) {
    throw new ValidateException('线下消费支付商户身份无效');
  }
  const context = await lockOfflineOrderPayment(tx, input);
  const prior = await readOfflinePaymentSelectionTx(tx, context);
  if (prior) {
    if (prior.rail !== identity.provider || prior.profile !== identity.profile || prior.appId !== identity.appId || prior.merchantId !== identity.merchantId) {
      throw new ApiException('线下消费已选定其他支付路径，请先核对原支付结果', 409);
    }
    return { selection: prior, replayed: true };
  }
  assertUnpaidOfflineOrder(context.order);
  if (identity.provider === 'alipay' && context.admission.channel === 'routine') throw new ValidateException('小程序渠道不支持支付宝WAP支付');
  const amount = offlinePayableCents(context.admission.payPrice);
  if (amount > 2_147_483_647n) throw new ValidateException('线下消费金额不在外部支付证据范围内');
  let payerId = '';
  const shape = identity.provider === 'alipay' ? { profile: 'alipay' as const, transactionType: 'wap' as const }
    : wechatShape(context.admission.channel);
  if (shape.profile !== identity.profile) throw new ValidateException('线下消费支付配置与原渠道不匹配');
  if (shape.transactionType === 'jsapi') {
    const bindings = await tx.select({ openid: wechatUser.openid }).from(wechatUser)
      .where(and(eq(wechatUser.uid, input.uid), eq(wechatUser.userType, shape.profile), eq(wechatUser.isDel, 0))).limit(2).for('update');
    if (bindings.length !== 1 || !PAYER.test(bindings[0].openid)) throw new ValidateException('当前账号缺少唯一的微信支付身份');
    payerId = bindings[0].openid;
  }
  const [clock] = await tx.execute<{ now: number }>(sql`SELECT floor(extract(epoch FROM statement_timestamp()))::integer AS now`);
  if (clock.now < context.admission.createdAt) throw new ValidateException('线下消费支付时间异常');
  const [selection] = await tx.insert(offlineOrderPaymentSelection).values({ orderId: context.order.id, selectionKey: crypto.randomUUID(),
    uid: input.uid, orderNo: context.order.orderId, rail: identity.provider, profile: shape.profile, transactionType: shape.transactionType,
    appId: identity.appId, merchantId: identity.merchantId, payerId, payPrice: context.admission.payPrice, createdAt: clock.now }).returning();
  if (!selection) throw Error('Offline payment selection insert failed');
  return { selection, replayed: false };
}
