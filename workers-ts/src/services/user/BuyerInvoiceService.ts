import { and, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import type { Container, DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder, storeOrderCartInfo, storeOrderInvoice, storeOrderRefund, systemConfig, user, userInvoice } from '@/models/schema';
import { AuthException, ApiErrorCode, NotFoundException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { normalizeConfigScalar } from '@/utils/config';
import { signAttachmentReferences } from '@/services/system/AttachmentService';
import { lifecycleTime, withOrderLifecycleSnapshot } from '@/services/order/OrderLifecycleTimeline';
import { buyerInvoiceOrderColumns, StoreOrderInvoiceService } from '@/services/order/StoreOrderInvoiceService';
import { currentInvoiceAmount } from '@/services/order/InvoiceOrderLifecycle';
import { UserFinanceService, type InvoiceTitleMutationPolicy } from './UserFinanceService';
import { buyerInvoiceQuery, buyerInvoiceRevision, validateBuyerInvoiceDraft, type BuyerInvoiceAck, type BuyerInvoiceAction,
  type BuyerInvoiceCapabilities, type BuyerInvoiceFields, type BuyerInvoiceOrder, type BuyerInvoicePage, type BuyerInvoiceQuery,
  type BuyerInvoiceRecord, type BuyerInvoiceTitle } from '../../../../view/common/buyerInvoices';
import { orderDetailId } from '../../../../view/common/orderDetailIdentity';

type Title = typeof userInvoice.$inferSelect;
type Invoice = typeof storeOrderInvoice.$inferSelect;
type Order = typeof storeOrder.$inferSelect;
export interface BuyerInvoiceActor { uid: number; authVersion: string; expiresAt: number }
const invalid = (message = '发票参数无效，请重新读取') => new ValidateException(message);
const stale = () => invalid('发票或订单资料已变化，请刷新后重新选择');
const time = (n: number) => n === 0 ? '' : lifecycleTime(n, false);
const fields = (r: Title | Invoice): BuyerInvoiceFields => ({ headerType: r.headerType as 1 | 2, type: r.type as 1 | 2,
  name: r.name, dutyNumber: r.dutyNumber, drawerPhone: r.drawerPhone, email: r.email,
  tell: r.tell, address: r.address, bank: r.bank, cardNumber: r.cardNumber });
async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export const buyerInvoiceTitleRevision = (row: Title) => digest({ ...fields(row), id: row.id, uid: row.uid, isDefault: row.isDefault, isDel: row.isDel, addTime: row.addTime });
export const buyerInvoiceOrderRevision = (r: Order, amount: string | null) => digest({ id: r.id, uid: r.uid, orderNo: r.orderId,
  pid: r.pid, paid: r.paid, status: r.status, supplierId: r.supplierId, storeId: r.storeId,
  supplierAllocationStatus: r.supplierAllocationStatus, payPrice: r.payPrice, refundPrice: r.refundPrice,
  refundStatus: r.refundStatus, isDel: r.isDel, isSystemDel: r.isSystemDel, amount });

/** Fresh SQL authorization after complete UserJWT/bucket verification by the
 * HTTP caller. This is deliberately not a standalone signature verifier. */
async function actorInDatabase(db: DbClient, actor: BuyerInvoiceActor) {
  if (!Number.isInteger(actor.uid) || actor.uid <= 0 || actor.uid > 2147483647 || !actor.authVersion
    || !Number.isInteger(actor.expiresAt) || actor.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException('登录已过期，请重新登录', ApiErrorCode.ERR_EXPIRED);
  const [row] = await db.select({ pwd: user.pwd, status: user.status, isDel: user.isDel, deleteTime: user.deleteTime }).from(user).where(eq(user.uid, actor.uid)).limit(1);
  if (!row || row.status !== 1 || row.isDel || row.deleteTime !== null || ![md5(row.pwd), row.pwd].includes(actor.authVersion))
    throw new AuthException('登录状态已变化，请重新登录', ApiErrorCode.ERR_EXPIRED);
}
export async function buyerInvoiceCapabilities(db: DbClient): Promise<BuyerInvoiceCapabilities> {
  // Match SystemConfigDao's global scope and deterministic precedence for
  // historical duplicate defaults, with at most two VARCHAR values transported
  // in one SQL snapshot. A store override cannot disable the global buyer API.
  const rows = await db.selectDistinctOn([systemConfig.menuName], { key: systemConfig.menuName, value: systemConfig.value }).from(systemConfig)
    .where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, ['invoice_func_status', 'special_invoice_status'])))
    .orderBy(systemConfig.menuName, desc(systemConfig.sort), desc(systemConfig.id)).limit(2);
  const enabled = (key: string) => {
    const matches = rows.filter(r => r.key === key); if (matches.length !== 1) return false;
    const value = normalizeConfigScalar(matches[0].value); return value === '1';
  };
  const on = enabled('invoice_func_status'); return { enabled: on, special: on && enabled('special_invoice_status') };
}
export async function requireBuyerInvoiceCapability(db: DbClient, type: number) {
  const flags = await buyerInvoiceCapabilities(db);
  if (!flags.enabled) throw invalid('暂未开启开票，请联系管理员');
  if (type === 2 && !flags.special) throw invalid('暂未开启专用发票，请联系管理员');
}
async function writeDeadline(db: DbClient) {
  await db.execute(sql`SELECT set_config('statement_timeout',
    LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true)`);
}
async function titleView(row: Title): Promise<BuyerInvoiceTitle> {
  if (![1, 2].includes(row.type) || ![1, 2].includes(row.headerType) || ![0, 1].includes(row.isDefault)) throw invalid('发票抬头记录异常，请联系商家核对');
  return { ...fields(row), id: row.id, uid: row.uid, revision: await buyerInvoiceTitleRevision(row), isDefault: row.isDefault === 1, addTime: time(row.addTime) };
}
interface Cursor { uid: number; kind: BuyerInvoiceQuery['kind']; id: number; rank: number }
function cursor(value: string | null, uid: number, kind: Cursor['kind']): Cursor | null {
  if (value === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw invalid();
    const row: unknown = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')));
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid(); const r = row as Cursor;
    if (Object.keys(r).length !== 4 || r.uid !== uid || r.kind !== kind || !Number.isInteger(r.id) || r.id <= 0 || r.id > 2147483647
      || !Number.isInteger(r.rank) || r.rank < -2147483648 || r.rank > 2147483647 || (kind === 'titles' && ![0, 1].includes(r.rank))) throw invalid();
    return r;
  } catch { throw invalid('发票分页标识无效，请刷新'); }
}
const nextCursor = (row: Cursor) => btoa(JSON.stringify(row)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function projectProduct(row: { data: string | null; uid: number } | undefined, uid: number): BuyerInvoiceRecord['product'] {
  if (!row?.data || row.uid !== uid) return null;
  let parsed: unknown; try { parsed = JSON.parse(row.data); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const info = parsed as Record<string, unknown>, p = info.product ?? info.productInfo;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null; const item = p as Record<string, unknown>, sku = info.sku ?? item.attrInfo;
  const name = item.storeName ?? item.store_name ?? item.title, suffix = sku && typeof sku === 'object' && !Array.isArray(sku) ? (sku as Record<string, unknown>).suk : '';
  if (typeof name !== 'string' || name.length > 4096 || (suffix !== undefined && typeof suffix !== 'string')) return null;
  const image = sku && typeof sku === 'object' && !Array.isArray(sku) ? (sku as Record<string, unknown>).image ?? item.image : item.image;
  return { name: (name + (suffix ? ' · ' + suffix : '')).slice(0, 4096), image: typeof image === 'string' && image.length <= 4096 && /^(?:https?:\/\/|\/(?!\/))/.test(image) ? image : '' };
}
async function productSummaries(db: DbClient, uid: number, ids: number[]): Promise<Map<number, BuyerInvoiceRecord['product']>> {
  if (!ids.length) return new Map();
  const rows = await db.selectDistinctOn([storeOrderCartInfo.oid], { oid: storeOrderCartInfo.oid, uid: storeOrderCartInfo.uid,
    data: sql<string | null>`CASE WHEN octet_length(${storeOrderCartInfo.cartInfo})<=32768 THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END` })
    .from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.oid, ids)).orderBy(storeOrderCartInfo.oid, storeOrderCartInfo.id).limit(ids.length);
  return new Map(rows.map(row => [row.oid, projectProduct(row, uid)]));
}
async function recordView(invoice: Invoice, order: { id: number; orderId: string; uid: number }, product: BuyerInvoiceRecord['product']): Promise<BuyerInvoiceRecord> {
  if (invoice.uid !== order.uid || invoice.orderId !== order.id || invoice.category !== 'order' || ![-1, 0, 1].includes(invoice.isInvoice)
    || ![1, 2].includes(invoice.type) || ![1, 2].includes(invoice.headerType) || ![0, 1].includes(invoice.isPay) || ![0, 1].includes(invoice.isRefund)) throw invalid('订单发票关联异常，请联系商家核对');
  return { ...fields(invoice), id: invoice.id, uid: invoice.uid, orderId: order.id, orderNo: order.orderId, titleId: invoice.invoiceId,
    state: invoice.isInvoice as -1 | 0 | 1, paid: invoice.isPay === 1, refunded: invoice.isRefund === 1,
    amount: /^0+\.00$/.test(invoice.invoiceAmount) ? null : invoice.invoiceAmount,
    invoiceNumber: invoice.invoiceNumber, remark: invoice.isInvoice === -1 ? invoice.remark : '',
    addTime: time(invoice.addTime), invoiceTime: time(invoice.invoiceTime), product };
}
async function boundedBasis(db: DbClient, order: Order) {
  const cartBytes = sql`coalesce(octet_length(${storeOrderCartInfo.cartInfo}),0)+coalesce(octet_length(${storeOrderCartInfo.promotionsId}),0)`;
  const refundBytes = sql`coalesce(octet_length(${storeOrderRefund.cartInfo}),0)+coalesce(octet_length(${storeOrderRefund.refundImg}),0)+coalesce(octet_length(${storeOrderRefund.refundGoodsImg}),0)`;
  const queries = [sql`SELECT count(*)::integer AS n,coalesce(sum(${cartBytes}),0)::bigint AS bytes,coalesce(max(${cartBytes}),0)::integer AS largest FROM ${storeOrderCartInfo} WHERE oid=${order.id}`,
    sql`SELECT count(*)::integer AS n,coalesce(sum(${refundBytes}),0)::bigint AS bytes,coalesce(max(${refundBytes}),0)::integer AS largest FROM ${storeOrderRefund} WHERE store_order_id=${order.id}`];
  for (const [index, query] of queries.entries()) {
    const [row] = await db.execute(query);
    if (!row || Number(row.n) > (index === 0 ? 200 : 402) || Number(row.bytes) > 2097152 || Number(row.largest) > 65536) throw invalid('开票依据过大，请联系商家核对');
  }
}
async function boundedAmount(db: DbClient, order: Order): Promise<string> {
  await boundedBasis(db, order);
  return currentInvoiceAmount(db, order, true);
}

/** Owner-only client view; legacy/internal invoice services remain authoritative
 * for order locking, current refund generations and immutable title copying. */
export class BuyerInvoiceService {
  private readonly actor: BuyerInvoiceActor;
  constructor(private readonly container: Container, private readonly env: Pick<Env, 'APP_KEY'>,
    actor: BuyerInvoiceActor, private readonly authorize: () => Promise<void>) { this.actor = { ...actor }; }
  private async fresh() { await this.authorize(); await withOrderLifecycleSnapshot(this.container, db => actorInDatabase(db, this.actor)); }
  private async sign(records: BuyerInvoiceRecord[]) {
    const images = await signAttachmentReferences(this.env.APP_KEY, records.map(r => r.product?.image ?? ''));
    for (let i = 0; i < records.length; i++) if (records[i].product) records[i].product!.image = images[i];
  }
  async page(query: BuyerInvoiceQuery): Promise<BuyerInvoicePage> {
    query = buyerInvoiceQuery(query.kind, query.cursor, query.limit); const after = cursor(query.cursor, this.actor.uid, query.kind); await this.fresh();
    const read = async (db: DbClient) => {
      const capabilities = await buyerInvoiceCapabilities(db), uid = this.actor.uid;
      if (query.kind === 'titles') {
        const rows = await db.select().from(userInvoice).where(and(eq(userInvoice.uid, uid), eq(userInvoice.isDel, 0), after ? or(lt(userInvoice.isDefault, after.rank), and(eq(userInvoice.isDefault, after.rank), lt(userInvoice.id, after.id))) : undefined))
          .orderBy(desc(userInvoice.isDefault), desc(userInvoice.id)).limit(query.limit + 1);
        const selected = rows.slice(0, query.limit), last = selected.at(-1);
        return { version: 1 as const, uid, query, capabilities, items: await Promise.all(selected.map(titleView)),
          nextCursor: rows.length > query.limit && last ? nextCursor({ uid, kind: query.kind, id: last.id, rank: last.isDefault }) : null };
      }
      const rows = await db.select({ invoice: storeOrderInvoice, order: { id: storeOrder.id, orderId: storeOrder.orderId, uid: storeOrder.uid } }).from(storeOrderInvoice)
        .innerJoin(storeOrder, eq(storeOrder.id, storeOrderInvoice.orderId))
        .where(and(eq(storeOrderInvoice.uid, uid), eq(storeOrderInvoice.isPay, 1), eq(storeOrderInvoice.isRefund, 0), eq(storeOrderInvoice.isDel, 0), eq(storeOrderInvoice.category, 'order'),
          eq(storeOrder.uid, uid), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0), ne(storeOrder.refundStatus, 2),
          after ? or(lt(storeOrderInvoice.addTime, after.rank), and(eq(storeOrderInvoice.addTime, after.rank), lt(storeOrderInvoice.id, after.id))) : undefined))
        .orderBy(desc(storeOrderInvoice.addTime), desc(storeOrderInvoice.id)).limit(query.limit + 1);
      const selected = rows.slice(0, query.limit), last = selected.at(-1), items: BuyerInvoiceRecord[] = [];
      const products = await productSummaries(db, uid, selected.map(row => row.order.id));
      for (const row of selected) items.push(await recordView(row.invoice, row.order, products.get(row.order.id) ?? null));
      return { version: 1 as const, uid, query, capabilities, items, nextCursor: rows.length > query.limit && last ? nextCursor({ uid, kind: query.kind, id: last.invoice.id, rank: last.invoice.addTime }) : null };
    };
    const result = await withOrderLifecycleSnapshot(this.container, read), version = await digest(result);
    if (query.kind === 'records') await this.sign(result.items as BuyerInvoiceRecord[]);
    await this.fresh();
    if (await digest(await withOrderLifecycleSnapshot(this.container, read)) !== version) throw stale();
    return result;
  }
  async order(reference: string): Promise<BuyerInvoiceOrder> {
    try { reference = orderDetailId(reference); } catch { throw invalid('订单标识无效'); } if (reference.length > 50) throw invalid('订单标识无效'); await this.fresh();
    const read = async (db: DbClient) => {
      const rows = await db.select(buyerInvoiceOrderColumns()).from(storeOrder)
        .where(and(eq(storeOrder.orderId, reference), eq(storeOrder.uid, this.actor.uid), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0))).limit(2);
      if (rows.length !== 1) throw new NotFoundException('订单不存在或不属于当前用户');
      const { readable, ...order } = rows[0]; if (!readable) throw invalid('订单资料过大，请联系商家核对');
      if (![0, 1].includes(order.paid)) throw invalid('订单支付状态异常，请联系商家核对');
      if (order.pid > 0) {
        const [root] = await db.select({ uid: storeOrder.uid, pid: storeOrder.pid, isDel: storeOrder.isDel, isSystemDel: storeOrder.isSystemDel,
          paid: storeOrder.paid, payType: storeOrder.payType, supplierId: storeOrder.supplierId, storeId: storeOrder.storeId, supplierAllocationStatus: storeOrder.supplierAllocationStatus })
          .from(storeOrder).where(eq(storeOrder.id, order.pid)).limit(1);
        if (!root || root.uid !== order.uid || root.pid !== -1 || root.isDel || root.isSystemDel || root.paid !== order.paid || root.payType !== order.payType
          || (root.supplierId !== order.supplierId && !(root.supplierId === 0 && root.supplierAllocationStatus === 2))
          || (root.storeId !== order.storeId && root.supplierAllocationStatus !== 2)) throw invalid('开票订单关联已变化，请刷新后重试');
      }
      const capabilities = await buyerInvoiceCapabilities(db), invoices = await db.select().from(storeOrderInvoice)
        .where(and(inArray(storeOrderInvoice.orderId, order.pid > 0 ? [order.pid, order.id] : [order.id]), eq(storeOrderInvoice.isDel, 0))).limit(3);
      if (invoices.length > 1 || invoices.some(r => r.uid !== this.actor.uid || r.category !== 'order')) throw invalid('订单发票关联异常，请联系商家核对');
      const own = invoices.find(r => r.orderId === order.id), products = own ? await productSummaries(db, this.actor.uid, [order.id]) : new Map();
      const invoice = own ? await recordView(own, order, products.get(order.id) ?? null) : null;
      let amount: string | null = null, reason = '';
      if (invoice) reason = '本订单已有开票记录';
      else if (invoices.length) reason = '原支付主单已有开票记录，请先完成拆单发票归属处理';
      else if (!capabilities.enabled) reason = '暂未开启开票，请联系管理员';
      else if (order.pid < 0) reason = '请从拆分后的履约子单申请发票';
      else if (order.supplierAllocationStatus === 1 || ![0, 1, 2, 3].includes(order.status)) reason = '订单当前状态不能申请发票';
      else { try { amount = await boundedAmount(db, order); } catch (e) { if (!(e instanceof ValidateException)) throw e; reason = e.message; } }
      return { version: 1 as const, uid: this.actor.uid, orderId: order.id, orderNo: order.orderId,
        revision: await buyerInvoiceOrderRevision(order, amount), paid: order.paid === 1, status: order.status, pid: order.pid,
        capabilities, invoice, amount, canApply: !reason, reason };
    };
    const result = await withOrderLifecycleSnapshot(this.container, read), version = await digest(result);
    if (result.invoice) await this.sign([result.invoice]);
    await this.fresh();
    if (await digest(await withOrderLifecycleSnapshot(this.container, read)) !== version) throw stale();
    return result;
  }
  private titlePolicy(id: number, revision: string): InvoiceTitleMutationPolicy {
    if (id) { try { buyerInvoiceRevision(revision); } catch { throw invalid(); } }
    return { prepare: async db => { await writeDeadline(db); await actorInDatabase(db, this.actor); }, check: async db => {
      await actorInDatabase(db, this.actor); if (!id) return;
      const [row] = await db.select().from(userInvoice).where(and(eq(userInvoice.id, id), eq(userInvoice.uid, this.actor.uid), eq(userInvoice.isDel, 0))).limit(1);
      if (!row) throw new NotFoundException('发票抬头不存在'); if (await buyerInvoiceTitleRevision(row) !== revision) throw stale();
    } };
  }
  private async ack(action: BuyerInvoiceAction, id: number): Promise<BuyerInvoiceAck> { await this.fresh(); return { version: 1, uid: this.actor.uid, action, id }; }
  async save(raw: unknown): Promise<BuyerInvoiceAck> {
    let draft; try { draft = validateBuyerInvoiceDraft(raw); } catch (e) { throw invalid((e as Error).message); } await this.fresh();
    const result = await new UserFinanceService(this.container).invoiceSave(this.actor.uid, { ...draft, isDefault: draft.isDefault ? 1 : 0 }, this.titlePolicy(draft.id, draft.revision));
    return this.ack('save', result.id);
  }
  async remove(id: number, revision: string): Promise<BuyerInvoiceAck> { await this.fresh(); await new UserFinanceService(this.container).invoiceDel(this.actor.uid, id, this.titlePolicy(id, revision)); return this.ack('delete', id); }
  async setDefault(id: number, revision: string): Promise<BuyerInvoiceAck> { await this.fresh(); await new UserFinanceService(this.container).setDefault(this.actor.uid, id, this.titlePolicy(id, revision)); return this.ack('default', id); }
  async apply(input: { orderId: number; orderNo: string; revision: string; titleId: number; titleRevision: string }): Promise<BuyerInvoiceAck> {
    try { buyerInvoiceRevision(input.revision); buyerInvoiceRevision(input.titleRevision); orderDetailId(input.orderNo); } catch { throw invalid(); } await this.fresh();
    const result = await new StoreOrderInvoiceService(this.container).makeUp(this.actor.uid, input.orderNo, input.titleId, {
      identity: { id: input.orderId, orderNo: input.orderNo }, prepare: async db => { await writeDeadline(db); await actorInDatabase(db, this.actor); },
      beforeAmount: boundedBasis,
      check: async (db, order, title, amount) => { await actorInDatabase(db, this.actor); await requireBuyerInvoiceCapability(db, title.type);
        try { validateBuyerInvoiceDraft({ ...fields(title), id: title.id, revision: input.titleRevision, isDefault: title.isDefault === 1 }); }
        catch (e) { throw invalid('请先编辑完整的开票抬头：' + (e as Error).message); }
        if (await buyerInvoiceOrderRevision(order, amount) !== input.revision || await buyerInvoiceTitleRevision(title) !== input.titleRevision) throw stale(); },
    }); return this.ack('apply', result.id);
  }
}
