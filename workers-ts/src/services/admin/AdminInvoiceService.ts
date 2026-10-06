import { and, asc, count, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderInvoice, storeOrderStatus, user } from '@/models/schema';
import { assertUnissuedInvoiceHistory } from '@/services/order/InvoiceIssuanceEvidence';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { assertInvoiceWriteEvidence, invoiceWriteAmount, lockSingleOrderInvoice } from '@/services/order/InvoiceWriteGuard';
import { NotFoundException, ValidateException } from '@/utils/errors';

type Invoice = typeof storeOrderInvoice.$inferSelect;
type Order = typeof storeOrder.$inferSelect;
type Joined = { invoice: Invoice; order: Order | null; invoiceVersion: string; orderVersion: string | null };
type Query = { page: number; limit: number; offset: number; status?: number | 'refunded' | 'pending'; start?: number; end?: number;
  field: 'all' | 'order_number' | 'uid' | 'real_name' | 'user_phone' | 'invoice_name' | 'drawer_phone'; keyword: string };
type ProcessInput = { isInvoice: -1 | 0 | 1; invoiceNumber: string; remark: string; revision: string; requestId: string };

const MAX_ID = 2_147_483_647;
const REQUEST_TYPE = 'admin_invoice_process';
const MAX_ORDER_CART_ROWS = 200;
const MAX_CART_SNAPSHOT_BYTES = 65_536;
const MAX_ORDER_SNAPSHOT_BYTES = 524_288;

function snapshotRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('订单商品快照格式异常');
  return value as Record<string, unknown>;
}

function snapshotText(value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || [...value].length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ValidateException('订单商品快照字段异常');
  }
  return value;
}

function snapshotMoney(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,10}(?:\.\d{1,6})?$/.test(text)) {
    throw new ValidateException('订单商品金额快照异常');
  }
  return text;
}

function centsFromSnapshot(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

function orderCartItem(row: { id: number; productId: number; cartId: string; cartNum: number; cartInfo: string | null }) {
  if (row.cartNum <= 0 || !row.cartInfo) throw new ValidateException('订单商品行缺失或数量异常');
  let parsed: unknown;
  try { parsed = JSON.parse(row.cartInfo); } catch { throw new ValidateException('订单商品快照无法读取'); }
  const snapshot = snapshotRecord(parsed);
  if (!snapshot) throw new ValidateException('订单商品快照无法读取');
  const product = snapshotRecord(snapshot.productInfo ?? snapshot.product);
  const sku = snapshotRecord(snapshot.sku ?? product?.attrInfo);
  const snapshotProductId = product?.id;
  const capturedProductId = snapshotProductId === undefined || snapshotProductId === null ? null
    : typeof snapshotProductId === 'number' && Number.isSafeInteger(snapshotProductId) && snapshotProductId >= 0
      ? snapshotProductId
      : typeof snapshotProductId === 'string' && /^(0|[1-9]\d{0,9})$/.test(snapshotProductId)
        ? Number(snapshotProductId) : NaN;
  if (Number.isNaN(capturedProductId) || (capturedProductId !== null && capturedProductId > MAX_ID)
    || (capturedProductId !== null && row.productId > 0 && capturedProductId > 0
      && capturedProductId !== row.productId)) {
    throw new ValidateException('订单商品快照与商品行不一致');
  }
  const productId = row.productId > 0 ? row.productId : capturedProductId && capturedProductId > 0 ? capturedProductId : null;
  const image = snapshotText(product?.image, 2048) ?? '';
  const price = snapshotMoney(sku?.price ?? product?.price);
  const vipUnit = snapshotMoney(snapshot.vip_truePrice ?? snapshot.vipTruePrice);
  // PHP tidyOrder multiplied the per-unit member discount by the cart quantity
  // with a scale of two, then summed the resulting line amounts.
  const vipCents = vipUnit === null ? null : centsFromSnapshot(vipUnit) * BigInt(row.cartNum) / 10_000n;
  return { item: { id: row.id, product_id: productId,
    product_name: snapshotText(product?.store_name ?? product?.storeName ?? product?.title, 512) ?? '商品快照缺少名称',
    category_name: snapshotText(snapshot.class_name ?? product?.class_name, 256),
    sku: snapshotText(sku?.suk, 255) ?? '默认', unit_price: price,
    quantity: row.cartNum, image: /^(https?:\/\/|\/(?!\/))/u.test(image) ? image : '' },
    vipCents };
}

function id(value: unknown, label = '发票申请ID'): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d{0,9}$/.test(String(value))) throw new ValidateException(`${label}无效`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > MAX_ID) throw new ValidateException(`${label}无效`);
  return result;
}

function shanghaiTime(value: string, label: string): { seconds: number; precision: 'day' | 'minute' } {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(value);
  if (!match) throw new ValidateException(`${label}须为YYYY-MM-DD HH:mm`);
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(utc);
  if (year < 1970 || year > 2100 || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute) {
    throw new ValidateException(`${label}无效`);
  }
  return { seconds: Math.floor((utc - 8 * 3600_000) / 1000), precision: match[4] === undefined ? 'day' : 'minute' };
}

function parseQuery(parameters: URLSearchParams): Query {
  const allowed = new Set(['page', 'limit', 'start_time', 'end_time', 'field', 'keyword', 'status']);
  for (const key of parameters.keys()) if (!allowed.has(key) || parameters.getAll(key).length !== 1) throw new ValidateException('发票查询参数未知或重复');
  const page = parameters.has('page') ? id(parameters.get('page'), '页码') : 1;
  const limit = parameters.has('limit') ? id(parameters.get('limit'), '每页条数') : 10;
  const offset = (page - 1) * limit;
  if (limit > 100 || offset > 10_000) throw new ValidateException('发票分页超出范围');
  const field = parameters.get('field') || 'all';
  if (!['all', 'order_number', 'uid', 'real_name', 'user_phone', 'invoice_name', 'drawer_phone'].includes(field)) throw new ValidateException('发票搜索字段无效');
  const keyword = (parameters.get('keyword') || '').trim();
  if ([...keyword].length > 100 || /[\u0000-\u001f\u007f]/u.test(keyword)) throw new ValidateException('发票搜索词无效');
  if (field === 'uid' && keyword && !/^[1-9]\d{0,9}$/.test(keyword)) throw new ValidateException('UID须为正整数');
  const rawStatus = parameters.get('status') || 'all';
  if (!['all', '-1', '0', '1', 'pending', 'refunded'].includes(rawStatus)) throw new ValidateException('开票状态无效');
  const rawStart = parameters.get('start_time'), rawEnd = parameters.get('end_time');
  if (Boolean(rawStart) !== Boolean(rawEnd)) throw new ValidateException('创建时间须成对填写');
  const first = rawStart ? shanghaiTime(rawStart, '开始日期') : undefined;
  const last = rawEnd ? shanghaiTime(rawEnd, '结束日期') : undefined;
  if (first && last && first.precision !== last.precision) throw new ValidateException('创建时间须使用相同精度');
  const start = first?.seconds;
  const end = last ? last.seconds + (last.precision === 'day' ? 86_400 : 60) : undefined;
  if (start !== undefined && end !== undefined && (end <= start || end - start > 366 * 86_400)) throw new ValidateException('创建时间范围须在366天内');
  return { page, limit, offset, status: rawStatus === 'all' ? undefined
    : rawStatus === 'pending' || rawStatus === 'refunded' ? rawStatus : Number(rawStatus), start, end,
    field: field as Query['field'], keyword };
}

function processInput(body: Record<string, unknown>): ProcessInput {
  const fields = new Set(['is_invoice', 'invoice_number', 'remark', 'revision', 'request_id']);
  if (Object.keys(body).some(key => !fields.has(key))) throw new ValidateException('不支持的发票处理字段；金额只能由订单计算');
  if (body.is_invoice !== -1 && body.is_invoice !== 0 && body.is_invoice !== 1) throw new ValidateException('开票状态必须是-1、0或1');
  if (typeof body.invoice_number !== 'string' || body.invoice_number.length > 50 || /[\u0000-\u001f\u007f]/.test(body.invoice_number)) throw new ValidateException('开票号无效');
  const invoiceNumber = body.invoice_number.trim();
  if (body.is_invoice === 1 && !invoiceNumber) throw new ValidateException('请填写开票号');
  if (body.is_invoice !== 1 && invoiceNumber) throw new ValidateException('非已开票状态须清空开票号');
  if (typeof body.remark !== 'string' || [...body.remark].length > 255 || /[\u0000-\u001f\u007f]/.test(body.remark)) throw new ValidateException('开票备注无效');
  if (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) throw new ValidateException('发票版本无效，请刷新');
  if (typeof body.request_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.request_id)) throw new ValidateException('请求标识必须为UUID');
  return { isInvoice: body.is_invoice, invoiceNumber, remark: body.remark, revision: body.revision, requestId: body.request_id };
}

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function shownOrder(order: Order | null) {
  return order ? { id: order.id, order_number: order.orderId, pay_price: order.payPrice,
    paid: order.paid, refund_status: order.refundStatus, status: order.status, pid: order.pid,
    add_time: order.addTime, real_name: order.realName, user_phone: order.userPhone } : null;
}

async function revision(row: Joined): Promise<string> {
  // xmin prevents a clear-and-restore update from reopening a stale form.
  return digest({ invoice: row.invoice, invoiceVersion: row.invoiceVersion,
    order: row.order, orderVersion: row.orderVersion });
}

async function project(tx: DbClient, row: Joined) {
  const invoice = row.invoice, order = row.order;
  const issues: string[] = [];
  let expectedAmount: string | null = null;
  const ready = await invoiceEvidenceReady(tx);
  if (!ready) issues.push('发票历史保护未安装或采集触发器未启用');
  if (!order) issues.push('关联订单不存在');
  else {
    if (order.isDel || order.isSystemDel) issues.push('关联订单已删除');
    if (order.uid !== invoice.uid || invoice.category !== 'order') issues.push('发票与订单归属或类别不一致');
    if (order.pid > 0) {
      const [root] = await tx.select({ id: storeOrder.id, pid: storeOrder.pid, uid: storeOrder.uid,
        paid: storeOrder.paid, payType: storeOrder.payType, storeId: storeOrder.storeId,
        supplierId: storeOrder.supplierId, supplierAllocationStatus: storeOrder.supplierAllocationStatus,
        isDel: storeOrder.isDel, isSystemDel: storeOrder.isSystemDel })
        .from(storeOrder).where(eq(storeOrder.id, order.pid)).limit(1);
      if (!root || root.pid !== -1 || root.uid !== order.uid || root.paid !== order.paid || root.payType !== order.payType
        || root.isDel || root.isSystemDel
        || (root.supplierId !== order.supplierId && !(root.supplierId === 0 && root.supplierAllocationStatus === 2))
        || (root.storeId !== order.storeId && root.supplierAllocationStatus !== 2)) issues.push('拆单发票归属待核对');
    }
    if (!issues.length) {
      try { expectedAmount = await invoiceWriteAmount(tx, order, true); }
      catch (error) { if (!(error instanceof ValidateException)) throw error; issues.push(error.message); }
    }
    if (expectedAmount !== null) {
      if (invoice.invoiceAmount === '0.00' && expectedAmount !== '0.00' && [-1, 0].includes(invoice.isInvoice)
        && invoice.invoiceNumber === '' && invoice.isRefund === 0 && invoice.isPay === order.paid) {
        if (!ready) issues.push('旧0.00申请须人工核验');
        else try { await assertUnissuedInvoiceHistory(tx, order, invoice); }
        catch (error) { if (!(error instanceof ValidateException)) throw error; issues.push(error.message); }
      } else {
        try { assertInvoiceWriteEvidence(order, invoice, expectedAmount); }
        catch (error) { issues.push(error instanceof Error ? error.message : '发票金额证据无效'); }
      }
    }
    if (invoice.isInvoice === 1 && order.paid !== 1) issues.push('未支付订单不能标记已开票');
    const siblings = await tx.select({ id: storeOrderInvoice.id }).from(storeOrderInvoice)
      .where(and(inArray(storeOrderInvoice.orderId, order.pid > 0 ? [order.pid, order.id] : [order.id]), eq(storeOrderInvoice.isDel, 0)))
      .orderBy(asc(storeOrderInvoice.id)).limit(3);
    if (siblings.length !== 1 || siblings[0].id !== invoice.id) issues.push('支付主单或子单存在重复/错属发票申请');
  }
  if (invoice.isPay !== 1 || invoice.isDel !== 0 || invoice.isRefund !== 0) issues.push('申请未付款、已删除或已退款');
  if (![-1, 0, 1].includes(invoice.isInvoice)) issues.push('历史开票状态异常');
  if (invoice.isInvoice === 1 && !/^\d{8,20}$/.test(invoice.invoiceNumber)) issues.push('历史开票号格式异常，须明确修正');
  const blocking = issues.filter(issue => !issue.startsWith('历史开票号格式异常'));
  return { id: invoice.id, order_db_id: invoice.orderId, order_number: order?.orderId ?? null,
    template_id: invoice.invoiceId, uid: invoice.uid, category: invoice.category,
    is_invoice: invoice.isInvoice, invoice_number: invoice.invoiceNumber, invoice_amount: invoice.invoiceAmount,
    expected_amount: expectedAmount, remark: invoice.remark, invoice_time: invoice.invoiceTime,
    is_pay: invoice.isPay, is_refund: invoice.isRefund, is_del: invoice.isDel, add_time: invoice.addTime,
    header_type: invoice.headerType, type: invoice.type, name: invoice.name, duty_number: invoice.dutyNumber,
    drawer_phone: invoice.drawerPhone, email: invoice.email, tell: invoice.tell, address: invoice.address,
    bank: invoice.bank, card_number: invoice.cardNumber, order: shownOrder(order),
    revision: await revision(row), issues: [...new Set(issues)], can_process: blocking.length === 0 };
}

async function readOne(tx: DbClient, invoiceId: number): Promise<Joined> {
  const [row] = await tx.select({ invoice: storeOrderInvoice, order: storeOrder,
    invoiceVersion: sql<string>`${storeOrderInvoice}.xmin::text`,
    orderVersion: sql<string | null>`${storeOrder}.xmin::text` })
    .from(storeOrderInvoice).leftJoin(storeOrder, eq(storeOrder.id, storeOrderInvoice.orderId))
    .where(eq(storeOrderInvoice.id, invoiceId)).limit(1);
  if (!row || row.invoice.isDel !== 0) throw new NotFoundException('发票申请不存在');
  return row;
}

async function deadlines(tx: DbClient): Promise<void> {
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
}

async function invoiceEvidenceReady(tx: DbClient): Promise<boolean> {
  const [row] = await tx.select({ ready: sql<boolean>`to_regclass('store_order_invoice_evidence') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('store_order_invoice')
      AND tgname='soi_capture_evidence' AND tgenabled IN ('O','A'))` })
    .from(sql`(values (1)) as invoice_evidence_probe(n)`);
  return row.ready;
}

async function priorReceipt(tx: DbClient, invoiceId: number, input: ProcessInput, actorId: number, requestHash: string) {
  // The UUID lock in process() makes this global check serial across orders,
  // including after an invoice row is physically deleted. A nonempty receipt
  // always wins over the mutable row; no attempted reapplication follows it.
  const records = await tx.select({ oid: storeOrderStatus.oid, message: storeOrderStatus.changeMessage })
    .from(storeOrderStatus).where(and(eq(storeOrderStatus.changeType, REQUEST_TYPE),
      ilike(storeOrderStatus.changeMessage, `%"r":"${input.requestId}"%`)))
    .orderBy(desc(storeOrderStatus.id)).limit(3);
  if (!records.length) return null;
  if (records.length !== 1) throw new ValidateException('发票操作请求标识存在重复回执，请核对');
  let receipt: Record<string, unknown>;
  try { receipt = JSON.parse(records[0].message) as Record<string, unknown>; }
  catch { throw new ValidateException('发票操作回执损坏，请核对'); }
  if (receipt.v !== 1 || receipt.i !== invoiceId || receipt.o !== records[0].oid || receipt.r !== input.requestId
    || receipt.a !== actorId || receipt.h !== requestHash || ![-1, 0, 1].includes(Number(receipt.s))
    || !Number.isSafeInteger(receipt.u) || Number(receipt.u) <= 0
    || typeof receipt.z !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.z)) {
    throw new ValidateException('请求标识已用于不同发票操作或回执损坏');
  }
  const [current] = await tx.select({ id: storeOrderInvoice.id, isDel: storeOrderInvoice.isDel,
    orderId: storeOrderInvoice.orderId, uid: storeOrderInvoice.uid, category: storeOrderInvoice.category })
    .from(storeOrderInvoice).where(eq(storeOrderInvoice.id, invoiceId)).limit(1);
  if (current && current.isDel === 0 && current.orderId === receipt.o && current.uid === receipt.u
    && current.category === 'order') {
    const view = await project(tx, await readOne(tx, invoiceId));
    return { ...view, committed: true, request_id: input.requestId, idempotent: true,
      receipt_is_invoice: receipt.s, superseded: view.revision !== receipt.z };
  }
  return { id: invoiceId, order_db_id: records[0].oid, order_number: null, template_id: null,
    is_invoice: receipt.s, revision: receipt.z, committed: true, request_id: input.requestId,
    idempotent: true, archived: true, receipt_is_invoice: receipt.s, superseded: false };
}

/** Platform Admin only. Supplier and Kefu routes must use their own ownership scope. */
export class AdminInvoiceService {
  constructor(private readonly container: Container) {}

  async list(parameters: URLSearchParams) {
    const query = parseQuery(parameters);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await deadlines(tx);
      const conditions: SQL[] = [eq(storeOrderInvoice.isPay, 1), eq(storeOrderInvoice.isDel, 0)];
      if (query.status === 'refunded') conditions.push(eq(storeOrderInvoice.isRefund, 1));
      else if (query.status === 'pending') conditions.push(eq(storeOrderInvoice.isInvoice, 0), eq(storeOrderInvoice.invoiceTime, 0), eq(storeOrderInvoice.isRefund, 0));
      else if (query.status !== undefined) {
        conditions.push(eq(storeOrderInvoice.isInvoice, query.status));
        if (query.status === 1) conditions.push(eq(storeOrderInvoice.isRefund, 0));
      }
      if (query.start !== undefined && query.end !== undefined) conditions.push(gte(storeOrderInvoice.addTime, query.start), lt(storeOrderInvoice.addTime, query.end));
      if (query.keyword) {
        const escaped = `%${query.keyword.replace(/[\\%_]/g, '\\$&')}%`;
        const search = query.field === 'order_number' ? ilike(storeOrder.orderId, escaped)
          : query.field === 'uid' ? eq(storeOrderInvoice.uid, id(query.keyword, 'UID'))
          : query.field === 'real_name' ? eq(storeOrder.realName, query.keyword)
          : query.field === 'user_phone' ? eq(storeOrder.userPhone, query.keyword)
          : query.field === 'invoice_name' ? ilike(storeOrderInvoice.name, escaped)
          : query.field === 'drawer_phone' ? ilike(storeOrderInvoice.drawerPhone, escaped)
          : or(ilike(storeOrder.orderId, escaped), ilike(storeOrder.realName, escaped),
            ilike(storeOrder.userPhone, escaped), ilike(storeOrderInvoice.name, escaped),
            ilike(storeOrderInvoice.drawerPhone, escaped),
            /^[1-9]\d{0,9}$/.test(query.keyword) ? eq(storeOrderInvoice.uid, Number(query.keyword)) : undefined);
        if (search) conditions.push(search);
      }
      const predicate = and(...conditions);
      const [total] = await tx.select({ count: count() }).from(storeOrderInvoice)
        .leftJoin(storeOrder, eq(storeOrder.id, storeOrderInvoice.orderId)).where(predicate);
      const rows = await tx.select({ invoice: storeOrderInvoice, order: storeOrder,
        invoiceVersion: sql<string>`${storeOrderInvoice}.xmin::text`,
        orderVersion: sql<string | null>`${storeOrder}.xmin::text` })
        .from(storeOrderInvoice).leftJoin(storeOrder, eq(storeOrder.id, storeOrderInvoice.orderId))
        .where(predicate).orderBy(desc(storeOrderInvoice.addTime), desc(storeOrderInvoice.id))
        .limit(query.limit).offset(query.offset);
      const list = [];
      for (const row of rows) list.push(await project(tx, row));
      return { list, count: total.count, page: query.page, limit: query.limit };
    });
  }

  async detail(invoiceIdInput: unknown) {
    const invoiceId = id(invoiceIdInput);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await deadlines(tx);
      return project(tx, await readOne(tx, invoiceId));
    });
  }

  /** The legacy invoice page's order dialog, bound to a paid invoice request.
   * This is deliberately not an alias of the generic order.detail capability. */
  async orderInfo(invoiceIdInput: unknown) {
    const invoiceId = id(invoiceIdInput);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await deadlines(tx);
      const [invoice] = await tx.select({ id: storeOrderInvoice.id, uid: storeOrderInvoice.uid,
        orderId: storeOrderInvoice.orderId, category: storeOrderInvoice.category,
        isPay: storeOrderInvoice.isPay, isDel: storeOrderInvoice.isDel })
        .from(storeOrderInvoice).where(eq(storeOrderInvoice.id, invoiceId)).limit(1);
      if (!invoice || invoice.isDel !== 0) throw new NotFoundException('发票申请不存在');
      if (invoice.category !== 'order' || invoice.isPay !== 1 || invoice.uid <= 0 || invoice.orderId <= 0) {
        throw new ValidateException('发票申请未付款或关联异常，不能读取订单信息');
      }
      const [order] = await tx.select({ id: storeOrder.id, orderId: storeOrder.orderId,
        uid: storeOrder.uid, pid: storeOrder.pid, paid: storeOrder.paid,
        payType: storeOrder.payType, supplierId: storeOrder.supplierId,
        supplierAllocationStatus: storeOrder.supplierAllocationStatus, storeId: storeOrder.storeId,
        isDel: storeOrder.isDel, isSystemDel: storeOrder.isSystemDel,
        status: storeOrder.status, refundStatus: storeOrder.refundStatus,
        totalNum: storeOrder.totalNum, totalPrice: storeOrder.totalPrice,
        payPostage: storeOrder.payPostage, couponPrice: storeOrder.couponPrice,
        deductionPrice: storeOrder.deductionPrice, payPrice: storeOrder.payPrice,
        addTime: storeOrder.addTime, mark: storeOrder.mark,
        realName: storeOrder.realName, userPhone: storeOrder.userPhone,
        userAddress: storeOrder.userAddress })
        .from(storeOrder).where(eq(storeOrder.id, invoice.orderId)).limit(1);
      if (!order || order.uid !== invoice.uid || order.paid !== 1 || order.isDel || order.isSystemDel || order.pid < 0) {
        throw new ValidateException('发票与已付款订单归属不一致，不能读取订单信息');
      }
      if (order.pid > 0) {
        const [root] = await tx.select({ id: storeOrder.id, pid: storeOrder.pid,
          uid: storeOrder.uid, paid: storeOrder.paid, payType: storeOrder.payType,
          supplierId: storeOrder.supplierId, supplierAllocationStatus: storeOrder.supplierAllocationStatus,
          storeId: storeOrder.storeId, isDel: storeOrder.isDel, isSystemDel: storeOrder.isSystemDel })
          .from(storeOrder).where(eq(storeOrder.id, order.pid)).limit(1);
        if (!root || root.pid !== -1 || root.uid !== order.uid || root.paid !== order.paid
          || root.payType !== order.payType || root.isDel || root.isSystemDel
          || (root.supplierId !== order.supplierId && !(root.supplierId === 0 && root.supplierAllocationStatus === 2))
          || (root.storeId !== order.storeId && root.supplierAllocationStatus !== 2)) {
          throw new ValidateException('拆单发票归属待核对，不能读取订单信息');
        }
      }
      const siblings = await tx.select({ id: storeOrderInvoice.id }).from(storeOrderInvoice)
        .where(and(inArray(storeOrderInvoice.orderId, order.pid > 0 ? [order.pid, order.id] : [order.id]),
          eq(storeOrderInvoice.isDel, 0))).orderBy(asc(storeOrderInvoice.id)).limit(3);
      if (siblings.length !== 1 || siblings[0].id !== invoiceId) {
        throw new ValidateException('订单存在重复或错属发票申请，不能读取订单信息');
      }
      const [buyer] = await tx.select({ uid: user.uid, nickname: user.nickname, spreadUid: user.spreadUid })
        .from(user).where(eq(user.uid, order.uid)).limit(1);
      if (!buyer) throw new ValidateException('关联用户不存在，不能读取完整订单信息');
      const [promoter] = buyer.spreadUid > 0 ? await tx.select({ nickname: user.nickname })
        .from(user).where(eq(user.uid, buyer.spreadUid)).limit(1) : [];
      const cartHeaders = await tx.select({ id: storeOrderCartInfo.id,
        uid: storeOrderCartInfo.uid, oid: storeOrderCartInfo.oid,
        cartId: storeOrderCartInfo.cartId, cartNum: storeOrderCartInfo.cartNum,
        productId: storeOrderCartInfo.productId,
        bytes: sql<number>`COALESCE(octet_length(${storeOrderCartInfo.cartInfo}),0)` })
        .from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id))
        .orderBy(asc(storeOrderCartInfo.id)).limit(MAX_ORDER_CART_ROWS + 1);
      if (cartHeaders.length > MAX_ORDER_CART_ROWS || (order.totalNum > 0 && cartHeaders.length === 0)
        || cartHeaders.some(row => row.uid !== order.uid || row.oid !== order.id
          || row.bytes <= 0 || row.bytes > MAX_CART_SNAPSHOT_BYTES)
        || cartHeaders.reduce((total, row) => total + row.bytes, 0) > MAX_ORDER_SNAPSHOT_BYTES) {
        throw new ValidateException('订单商品明细不一致或过大，不能读取完整订单信息');
      }
      const snapshots = cartHeaders.length ? await tx.select({ id: storeOrderCartInfo.id,
        cartInfo: storeOrderCartInfo.cartInfo }).from(storeOrderCartInfo)
        .where(and(eq(storeOrderCartInfo.oid, order.id),
          inArray(storeOrderCartInfo.id, cartHeaders.map(row => row.id))))
        .orderBy(asc(storeOrderCartInfo.id)) : [];
      if (snapshots.length !== cartHeaders.length || snapshots.some((row, index) => row.id !== cartHeaders[index].id)) {
        throw new ValidateException('订单商品明细已变化，不能读取完整订单信息');
      }
      const projected = snapshots.map((row, index) => orderCartItem({ ...cartHeaders[index], cartInfo: row.cartInfo }));
      const memberDiscount = projected.some(row => row.vipCents === null) ? null
        : projected.reduce((total, row) => total + (row.vipCents ?? 0n), 0n);
      if (memberDiscount !== null && memberDiscount > 999_999_999_999n) {
        throw new ValidateException('订单会员优惠快照超出金额边界');
      }
      return { invoice_id: invoiceId,
        order: { id: order.id, order_number: order.orderId, uid: order.uid, pid: order.pid,
          status: order.status, refund_status: order.refundStatus,
          total_num: order.totalNum, total_price: order.totalPrice,
          pay_postage: order.payPostage, coupon_price: order.couponPrice,
          vip_true_price: memberDiscount === null ? null
            : `${memberDiscount / 100n}.${(memberDiscount % 100n).toString().padStart(2, '0')}`,
          deduction_price: order.deductionPrice, pay_price: order.payPrice,
          add_time: order.addTime, pay_type: order.payType, mark: order.mark,
          real_name: order.realName, user_phone: order.userPhone, user_address: order.userAddress },
        user: { nickname: buyer.nickname, spread_name: promoter?.nickname ?? '' },
        cart_items: projected.map(row => row.item) };
    });
  }

  async process(invoiceIdInput: unknown, body: Record<string, unknown>, actorId: number) {
    const invoiceId = id(invoiceIdInput), input = processInput(body);
    if (!Number.isSafeInteger(actorId) || actorId <= 0) throw new ValidateException('管理员身份无效');
    const requestHash = await digest({ invoice_id: invoiceId, input, actor_id: actorId });
    return withTx(this.container, async tx => {
      await deadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(731700, hashtext(${input.requestId}))`);
      if (!await invoiceEvidenceReady(tx)) throw new ValidateException('发票历史保护未就绪，禁止处理');
      const earlier = await priorReceipt(tx, invoiceId, input, actorId, requestHash);
      if (earlier) return earlier;
      // Resolve ID without locking first. The root settlement lock is always first.
      const [reference] = await tx.select({ id: storeOrderInvoice.id, orderId: storeOrderInvoice.orderId,
        uid: storeOrderInvoice.uid, category: storeOrderInvoice.category })
        .from(storeOrderInvoice).where(eq(storeOrderInvoice.id, invoiceId)).limit(1);
      if (!reference) throw new NotFoundException('发票申请不存在');
      const [initial] = await tx.select({ id: storeOrder.id, pid: storeOrder.pid, uid: storeOrder.uid,
        orderId: storeOrder.orderId }).from(storeOrder).where(eq(storeOrder.id, reference.orderId)).limit(1);
      if (!initial) throw new ValidateException('关联订单不存在，禁止处理发票');
      const rootId = initial.pid > 0 ? initial.pid : initial.id;
      await lockOrderSettlement(tx, rootId);
      const [root] = await tx.select().from(storeOrder).where(eq(storeOrder.id, rootId)).limit(1).for('update');
      if (rootId !== initial.id) await lockOrderSettlement(tx, initial.id);
      const [order] = rootId === initial.id ? [root] : await tx.select().from(storeOrder)
        .where(eq(storeOrder.id, initial.id)).limit(1).for('update');
      if (!root || !order || order.uid !== initial.uid || order.orderId !== initial.orderId || order.pid !== initial.pid
        || root.uid !== order.uid || order.isDel || order.isSystemDel || root.isDel || root.isSystemDel
        || (order.pid > 0 && (root.pid !== -1 || order.paid !== root.paid || order.payType !== root.payType))
        || (root.supplierId !== order.supplierId && !(root.supplierId === 0 && root.supplierAllocationStatus === 2))
        || (root.storeId !== order.storeId && root.supplierAllocationStatus !== 2)) {
        throw new ValidateException('开票订单关联已变化，请刷新后重试');
      }
      const raced = await priorReceipt(tx, invoiceId, input, actorId, requestHash);
      if (raced) return raced;
      const amount = await invoiceWriteAmount(tx, order);
      const invoice = await lockSingleOrderInvoice(tx, order);
      if (invoice.id !== invoiceId || invoice.uid !== reference.uid || invoice.category !== reference.category) {
        throw new ValidateException('发票申请ID与关联订单已变化，请刷新后重试');
      }
      const needsAmountRepair = invoice.invoiceAmount === '0.00' && amount !== '0.00'
        && [-1, 0].includes(invoice.isInvoice) && invoice.invoiceNumber === ''
        && invoice.isRefund === 0 && invoice.isPay === order.paid;
      if (needsAmountRepair) await assertUnissuedInvoiceHistory(tx, order, invoice);
      assertInvoiceWriteEvidence(order, needsAmountRepair ? { ...invoice, invoiceAmount: amount } : invoice, amount);
      if (invoice.isPay !== 1) throw new ValidateException('未支付的发票申请不能在后台处理');
      if (input.isInvoice === 1 && order.paid !== 1) throw new ValidateException('未支付订单不能标记已开票');
      const current = await readOne(tx, invoiceId);
      if (input.revision !== await revision(current)) throw new ValidateException('发票申请或订单已变化，请刷新后重试');
      const unchanged = invoice.isInvoice === input.isInvoice && invoice.invoiceNumber === input.invoiceNumber && invoice.remark === input.remark;
      if (!unchanged && input.isInvoice === 1 && !/^\d{8,20}$/.test(input.invoiceNumber)) throw new ValidateException('开票号须为8至20位数字');
      if (!unchanged || needsAmountRepair) {
        const updated = await tx.update(storeOrderInvoice).set({ isInvoice: input.isInvoice,
          invoiceNumber: input.invoiceNumber, remark: input.remark,
          ...(needsAmountRepair ? { invoiceAmount: amount } : {}),
          invoiceTime: unchanged ? invoice.invoiceTime : Math.floor(Date.now() / 1000) })
          .where(and(eq(storeOrderInvoice.id, invoiceId), eq(storeOrderInvoice.orderId, order.id),
            eq(storeOrderInvoice.uid, order.uid), eq(storeOrderInvoice.category, 'order'), eq(storeOrderInvoice.isDel, 0)))
          .returning({ id: storeOrderInvoice.id });
        if (updated.length !== 1) throw new ValidateException('发票申请已变化，请刷新后重试');
      }
      const result = await project(tx, await readOne(tx, invoiceId));
      const message = JSON.stringify({ v: 1, i: invoiceId, o: order.id, u: order.uid, r: input.requestId,
        a: actorId, h: requestHash, s: input.isInvoice, z: result.revision });
      if (message.length > 256) throw new ValidateException('发票操作审计超出边界');
      await tx.insert(storeOrderStatus).values({ oid: order.id, changeType: REQUEST_TYPE,
        changeMessage: message, changeTime: Math.floor(Date.now() / 1000) });
      return { ...result, committed: true, request_id: input.requestId, idempotent: unchanged && !needsAmountRepair };
    });
  }
}
