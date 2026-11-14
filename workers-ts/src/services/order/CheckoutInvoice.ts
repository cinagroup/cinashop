import { refundEntityAcceptedPairSql } from '@/migrations/guestRefundEntityCatalog';
import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, userInvoice, user } from '@/models/schema';
import { AuthException, ApiErrorCode, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { validateBuyerInvoiceDraft } from '../../../../view/common/buyerInvoices';
import { invoiceTitleFields, invoiceTitleRevision, readInvoiceCapabilities } from './InvoiceTitlePolicy';
import { insertOrderInvoiceSnapshot } from './StoreOrderInvoiceService';

export interface CheckoutInvoiceInput { invoiceId?: unknown; invoiceAlias?: unknown; invoiceRevision?: unknown; invoiceRevisionAlias?: unknown }
export const checkoutInvoiceParameters = (body: Record<string, unknown>): CheckoutInvoiceInput => ({ invoiceId: body.invoiceId, invoiceAlias: body.invoice_id, invoiceRevision: body.invoiceRevision, invoiceRevisionAlias: body.invoice_revision });
export interface CheckoutInvoiceActor { uid: number; authVersion: string; expiresAt: number }
const invalid = (message = '发票选择无效，请重新确认') => new ValidateException(message);
const id = (value: unknown): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 2147483647) throw invalid(); return n;
};
export function checkoutInvoiceInput(input: CheckoutInvoiceInput) {
  const selected = id(input.invoiceId !== undefined ? input.invoiceId : input.invoiceAlias !== undefined ? input.invoiceAlias : 0);
  if (input.invoiceId !== undefined && input.invoiceAlias !== undefined && id(input.invoiceId) !== id(input.invoiceAlias)) throw invalid();
  const revision = input.invoiceRevision !== undefined ? input.invoiceRevision : input.invoiceRevisionAlias;
  if (input.invoiceRevision !== undefined && input.invoiceRevisionAlias !== undefined && input.invoiceRevision !== input.invoiceRevisionAlias) throw invalid();
  if (revision !== undefined && (selected === 0 || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) throw invalid();
  return { id: selected, revision: revision as string | undefined };
}
export async function captureCheckoutInvoice(db: DbClient, uid: number, input: CheckoutInvoiceInput) {
  const selected = checkoutInvoiceInput(input); if (!selected.id) return null;
  if (!Number.isInteger(uid) || uid <= 0 || uid > 2147483647) throw invalid('请登录后选择发票抬头');
  const [title] = await db.select().from(userInvoice).where(and(eq(userInvoice.id, selected.id), eq(userInvoice.uid, uid), eq(userInvoice.isDel, 0))).limit(1);
  if (!title) throw invalid('发票抬头不存在或已删除，请重新选择');
  const revision = await invoiceTitleRevision(title), capabilities = await readInvoiceCapabilities(db);
  if (!capabilities.enabled || title.type === 2 && !capabilities.special) throw invalid('当前发票类型暂未开启，请重新选择');
  try { validateBuyerInvoiceDraft({ id: title.id, revision, ...invoiceTitleFields(title), isDefault: title.isDefault === 1 }); }
  catch { throw invalid('发票抬头资料不完整，请先修改抬头'); }
  if (selected.revision !== undefined && revision !== selected.revision) throw invalid('发票抬头已变化，请重新读取并选择');
  return { uid, id: title.id, revision, capabilities };
}
export type CheckoutInvoiceSelection = Awaited<ReturnType<typeof captureCheckoutInvoice>>;

async function invoiceStorage(tx: DbClient) {
  const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock_shared(731611,0) AS locked`);
  if (gate?.locked !== true) throw invalid('开票凭据正在维护，请稍后重新确认');
  const [catalog] = await tx.execute(sql.raw(refundEntityAcceptedPairSql(true)));
  if (!catalog || !['legacy','guest'].includes(String(catalog.profile))) throw invalid('开票凭据存储未完整就绪，请联系管理员');
}
async function noPriorInvoice(tx: DbClient, orderId: number) {
  // The legacy schema has no FK from invoices to orders. A freshly allocated
  // order PK must not adopt an old orphan, including deleted invoice history.
  // Split allocations require the retained source evidence, so the indexed
  // order history probe also covers them without scanning allocation rows.
  const [history] = await tx.execute(sql`SELECT
    EXISTS(SELECT 1 FROM public.store_order_invoice WHERE order_id=${orderId})
    OR EXISTS(SELECT 1 FROM public.store_order_invoice_evidence WHERE order_id=${orderId}) AS blocked`);
  if (history?.blocked !== false) throw invalid('新订单存在历史开票关联，请联系管理员核对');
}

/** Caller has already acquired the existing pricing/configuration fence. NOWAIT
 * prevents a new title lock wait from inverting checkout's inventory/user graph.
 * The selected title stays protected until this same order transaction commits. */
export async function persistCheckoutInvoice(tx: DbClient, selection: NonNullable<CheckoutInvoiceSelection>, order: typeof storeOrder.$inferSelect, now: number) {
  if (Object.hasOwn(tx, '$client')) throw Error('Checkout invoice requires a caller-owned transaction');
  if (order.uid !== selection.uid || order.paid !== 0 || order.pid !== 0 || !/^\d+\.\d{2}$/.test(order.payPrice)
    || BigInt(order.payPrice.replace('.', '')) <= 0n) throw invalid('实付金额为0或订单状态不支持申请发票');
  await invoiceStorage(tx); await noPriorInvoice(tx, order.id);
  let title: typeof userInvoice.$inferSelect | undefined;
  try {
    [title] = await tx.select().from(userInvoice).where(and(eq(userInvoice.id, selection.id), eq(userInvoice.uid, selection.uid), eq(userInvoice.isDel, 0))).limit(1).for('share', { noWait: true });
  } catch (error) {
    let cause: unknown = error;
    for (let n = 0; n < 8 && cause && typeof cause === 'object'; n++) {
      if ('code' in cause && cause.code === '55P03') throw invalid('发票抬头正在更新，请稍后重新确认');
      if (!('cause' in cause) || cause.cause === cause) break; cause = cause.cause;
    }
    throw error;
  }
  if (!title || await invoiceTitleRevision(title) !== selection.revision
    || JSON.stringify(await readInvoiceCapabilities(tx)) !== JSON.stringify(selection.capabilities)) throw invalid('发票资料或开票规则已变化，请重新确认');
  const created = await insertOrderInvoiceSnapshot(tx, order, title, order.payPrice, now);
  // Check the actual captured SQL row, not a reconstructed partial DTO. No
  // private invoice payload crosses this transport; only two scalar booleans.
  const captured = await tx.execute(sql`SELECT e.kind='created' AND e.document_number='' AND e.order_id=i.order_id AND e.uid=i.uid
    AND e.snapshot::jsonb=jsonb_build_object('v',1,'invoice',to_jsonb(i)) AS valid
    FROM public.store_order_invoice i JOIN public.store_order_invoice_evidence e ON e.invoice_id=i.id WHERE i.id=${created.id} AND i.order_id=${order.id} AND i.uid=${selection.uid} AND i.invoice_id=${selection.id}
    AND i.category='order' AND i.is_pay=0 AND i.is_invoice=0 AND i.is_refund=0 AND i.invoice_amount=${order.payPrice}::numeric LIMIT 2`);
  if (captured.length !== 1 || captured[0].valid !== true) throw invalid('发票申请的不可变凭据未完整保存');
  await invoiceStorage(tx);
  return created;
}

/** Undefined is reserved for trusted core fixtures. The public adapter passes
 * an actual admitted UserJWT tuple, or null, never a caller-provided actor. */
export function assertCheckoutInvoiceActor(account: Pick<typeof user.$inferSelect, 'uid' | 'pwd'>, actor: CheckoutInvoiceActor | null | undefined) {
  if (actor === undefined) return;
  if (!actor || actor.uid !== account.uid || !actor.authVersion || !Number.isInteger(actor.expiresAt)
    || actor.expiresAt <= Math.floor(Date.now() / 1000) || ![md5(account.pwd), account.pwd].includes(actor.authVersion)) {
    throw new AuthException('登录状态已变化，请重新登录', ApiErrorCode.ERR_EXPIRED);
  }
}
