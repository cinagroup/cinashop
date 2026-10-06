import { and, desc, eq, exists, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeBargain, storeCombination, storeOrder, storeOrderCartInfo, storeProduct,
  storeSeckill, systemStore, systemStoreStaff, user, userAddress } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';

const MAX_ID = 2_147_483_647;
const MAX_OFFSET = 10_000;
const MAX_CART_ROWS = 1_000;
const MAX_SNAPSHOT_BYTES = 65_536;

type Query = { page: number; limit: number; offset: number; start?: number; end?: number;
  keyword: string; field: 'all' | 'order_id' | 'uid' | 'real_name' | 'user_phone' | 'title';
  storeId?: number; type?: number };

function positiveId(value: unknown, label: string): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d{0,9}$/.test(String(value))) {
    throw new ValidateException(`${label}无效`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > MAX_ID) throw new ValidateException(`${label}无效`);
  return number;
}

function shanghaiDay(raw: string): number {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(raw);
  if (!match) throw new ValidateException('核销订单日期格式无效');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  const date = new Date(utc);
  if (year < 1970 || year > 2038 || date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new ValidateException('核销订单日期无效');
  }
  const second = Math.floor((utc - 8 * 3_600_000) / 1000);
  if (second < 0 || second > MAX_ID) throw new ValidateException('核销订单日期超出范围');
  return second;
}

function dateBounds(raw: string, now: number): Pick<Query, 'start' | 'end'> {
  if (!raw) return {};
  if (raw === 'lately7' || raw === 'lately30') {
    const days = raw === 'lately7' ? 7 : 30;
    return { start: now - days * 86_400, end: now + 1 };
  }
  const shifted = new Date((now + 8 * 3_600) * 1000);
  const year = shifted.getUTCFullYear(), month = shifted.getUTCMonth() + 1;
  const dayStart = Math.floor(Date.UTC(year, month - 1, shifted.getUTCDate()) / 1000) - 8 * 3_600;
  if (raw === 'today') return { start: dayStart, end: dayStart + 86_400 };
  if (raw === 'yesterday') return { start: dayStart - 86_400, end: dayStart };
  if (raw === 'month') return { start: Math.floor(Date.UTC(year, month - 1, 1) / 1000) - 8 * 3_600,
    end: Math.floor(Date.UTC(year, month, 1) / 1000) - 8 * 3_600 };
  if (raw === 'year') return { start: Math.floor(Date.UTC(year, 0, 1) / 1000) - 8 * 3_600,
    end: Math.floor(Date.UTC(year + 1, 0, 1) / 1000) - 8 * 3_600 };
  const custom = /^(\d{4}\/\d{2}\/\d{2})-(\d{4}\/\d{2}\/\d{2})$/.exec(raw);
  if (!custom) throw new ValidateException('核销订单日期筛选无效');
  const start = shanghaiDay(custom[1]);
  const end = shanghaiDay(custom[2]) + 86_400;
  if (end <= start || end > MAX_ID + 1 || end - start > 366 * 86_400) {
    throw new ValidateException('核销订单日期范围无效');
  }
  return { start, end };
}

function parseQuery(parameters: URLSearchParams, now: number): Query {
  const allowed = new Set(['page', 'limit', 'data', 'real_name', 'field_key', 'store_id', 'type']);
  for (const key of parameters.keys()) {
    if (!allowed.has(key) || parameters.getAll(key).length !== 1) {
      throw new ValidateException('核销订单查询参数未知或重复');
    }
  }
  const page = parameters.has('page') ? positiveId(parameters.get('page'), '页码') : 1;
  const limit = parameters.has('limit') ? positiveId(parameters.get('limit'), '每页数量') : 15;
  const offset = (page - 1) * limit;
  if (limit > 50 || offset > MAX_OFFSET) throw new ValidateException('核销订单分页超出范围');
  const keyword = (parameters.get('real_name') ?? '').trim();
  if ([...keyword].length > 80 || /[\u0000-\u001f\u007f]/u.test(keyword)) {
    throw new ValidateException('核销订单搜索词无效');
  }
  const field = parameters.get('field_key') || 'all';
  if (!['all', 'order_id', 'uid', 'real_name', 'user_phone', 'title'].includes(field)) {
    throw new ValidateException('核销订单搜索字段无效');
  }
  if (field === 'uid' && keyword) positiveId(keyword, '用户UID');
  const rawStore = parameters.get('store_id') || '';
  const storeId = rawStore && rawStore !== '0' ? positiveId(rawStore, '门店ID') : undefined;
  const rawType = parameters.get('type') || '';
  const type = rawType ? Number(rawType) : undefined;
  if (type !== undefined && (![0, 1, 2, 3, 4, 5, 6, 7, 8, 105, 106, 107].includes(type) ||
    String(type) !== rawType)) throw new ValidateException('订单类型无效');
  return { page, limit, offset, keyword, field: field as Query['field'], storeId, type,
    ...dateBounds(parameters.get('data') || '', now) };
}

async function readOnly(tx: DbClient): Promise<void> {
  await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
}

function visible(): SQL {
  return and(eq(storeOrder.paid, 1), eq(storeOrder.status, 2),
    eq(storeOrder.shippingType, 2), inArray(storeOrder.refundStatus, [0, 3]),
    eq(storeOrder.isDel, 0))!;
}

function escapedPattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

function searchCondition(tx: DbClient, query: Query): SQL | undefined {
  if (!query.keyword) return undefined;
  const keyword = query.keyword, pattern = escapedPattern(keyword);
  if (query.field === 'order_id') return eq(storeOrder.orderId, keyword);
  if (query.field === 'uid') return eq(storeOrder.uid, Number(keyword));
  if (query.field === 'real_name') return eq(storeOrder.realName, keyword);
  if (query.field === 'user_phone') return eq(storeOrder.userPhone, keyword);
  const productMatch = exists(tx.select({ id: storeOrderCartInfo.id }).from(storeOrderCartInfo)
    .innerJoin(storeProduct, eq(storeProduct.id, storeOrderCartInfo.productId))
    .where(and(eq(storeOrderCartInfo.oid, storeOrder.id),
      or(ilike(storeProduct.storeName, pattern), ilike(storeProduct.keyword, pattern)))));
  if (query.field === 'title') return productMatch;
  const buyerMatch = exists(tx.select({ uid: user.uid }).from(user)
    .where(and(eq(user.uid, storeOrder.uid), or(ilike(user.nickname, pattern),
      sql`${user.uid}::text ILIKE ${pattern}`, ilike(user.phone, pattern)))));
  const addressMatch = exists(tx.select({ id: userAddress.id }).from(userAddress)
    .where(and(eq(userAddress.uid, storeOrder.uid), or(ilike(userAddress.realName, pattern),
      sql`${userAddress.uid}::text ILIKE ${pattern}`, ilike(userAddress.phone, pattern)))));
  const seckillMatch = exists(tx.select({ id: storeSeckill.id }).from(storeSeckill)
    .where(and(eq(storeSeckill.id, storeOrder.activityId),
      or(ilike(storeSeckill.storeName, pattern), ilike(storeSeckill.info, pattern)))));
  const bargainMatch = exists(tx.select({ id: storeBargain.id }).from(storeBargain)
    .where(and(eq(storeBargain.id, storeOrder.activityId),
      or(ilike(storeBargain.title, pattern), ilike(storeBargain.info, pattern)))));
  const combinationMatch = exists(tx.select({ id: storeCombination.id }).from(storeCombination)
    .where(and(eq(storeCombination.id, storeOrder.activityId),
      or(ilike(storeCombination.storeName, pattern), ilike(storeCombination.info, pattern)))));
  return or(ilike(storeOrder.orderId, pattern), ilike(storeOrder.realName, pattern),
    ilike(storeOrder.userPhone, pattern), buyerMatch, addressMatch, productMatch,
    seckillMatch, bargainMatch, combinationMatch);
}

function conditions(tx: DbClient, query: Query): SQL {
  const parts: SQL[] = [visible()];
  if (query.start !== undefined && query.end !== undefined) {
    parts.push(gte(storeOrder.addTime, query.start), lt(storeOrder.addTime, query.end));
  }
  if (query.storeId !== undefined) parts.push(eq(storeOrder.storeId, query.storeId));
  if (query.type !== undefined) {
    if (query.type <= 8) parts.push(eq(storeOrder.type, query.type));
    else if (query.type === 106) parts.push(eq(storeOrder.shippingType, 4));
    else if (query.type === 107) parts.push(inArray(storeOrder.shippingType, [1, 3]));
  }
  const search = searchCondition(tx, query);
  if (search) parts.push(search);
  return and(...parts)!;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeText(value: unknown, maximum: number): string {
  return typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value) ? value : '';
}

function safeImage(value: unknown): string {
  const text = safeText(value, 2048);
  if (!text || text.includes('\\')) return '';
  if (/^\/(?!\/)/u.test(text)) return text;
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? text : '';
  } catch { return ''; }
}

function price(value: unknown): string | null {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

type CartRow = { id: number; uid: number; oid: number; productId: number;
  cartNum: number; cartInfo: string | null; oversized: boolean };
function goodsItem(row: CartRow, orderUid: number, issues: string[]) {
  if (row.uid !== orderUid || row.oversized || !row.cartInfo || row.cartNum <= 0) {
    issues.push(`商品快照 ${row.id} 无法核对`);
    return null;
  }
  let snapshot: Record<string, unknown> | null;
  try { snapshot = object(JSON.parse(row.cartInfo)); } catch { snapshot = null; }
  const product = object(snapshot?.productInfo ?? snapshot?.product);
  const attr = object(product?.attrInfo ?? snapshot?.sku);
  const capturedId = product?.id;
  if (!snapshot || !product || (capturedId !== undefined && capturedId !== null &&
    Number(capturedId) !== row.productId)) {
    issues.push(`商品快照 ${row.id} 损坏或归属不一致`);
    return null;
  }
  const name = safeText(product.store_name ?? product.storeName ?? product.title, 512);
  const truePrice = price(snapshot.truePrice ?? snapshot.true_price ?? attr?.price ?? product.price);
  if (!name || truePrice === null) issues.push(`商品快照 ${row.id} 缺少名称或价格`);
  return { name, spec: safeText(attr?.suk, 255), image: safeImage(attr?.image ?? product.image),
    true_price: truePrice ?? '0.00', cart_num: row.cartNum };
}

const payNames: Record<string, string> = { weixin: '微信支付', yue: '余额支付',
  offline: '线下支付', alipay: '支付宝', cash: '现金支付', integral: '积分支付' };

/** Bounded, transaction-consistent projection for the old verified writeoff order grid. */
export class AdminWriteoffOrderReadService {
  constructor(private readonly container: Container) {}

  async list(parameters: URLSearchParams, now = Math.floor(Date.now() / 1000)) {
    const query = parseQuery(parameters, now);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const where = conditions(tx, query);
      const [total] = await tx.select({ count: sql<number>`count(*)::int` })
        .from(storeOrder).where(where);
      const orders = await tx.select({ id: storeOrder.id, orderId: storeOrder.orderId,
        uid: storeOrder.uid, spreadUid: storeOrder.spreadUid,
        storeId: storeOrder.storeId, clerkId: storeOrder.clerkId,
        payPrice: storeOrder.payPrice, payType: storeOrder.payType,
        isSystemDel: storeOrder.isSystemDel, refundStatus: storeOrder.refundStatus,
        addTime: storeOrder.addTime, payTime: storeOrder.payTime,
      }).from(storeOrder).where(where)
        .orderBy(desc(storeOrder.addTime), desc(storeOrder.payTime), desc(storeOrder.id))
        .limit(query.limit).offset(query.offset);
      if (!orders.length) return { list: [], count: total.count, page: query.page,
        limit: query.limit, badge: [] as unknown[] };
      const orderIds = orders.map(row => row.id);
      const uids = [...new Set(orders.flatMap(row => [row.uid, row.spreadUid]).filter(id => id > 0))];
      const storeIds = [...new Set(orders.map(row => row.storeId).filter(id => id > 0))];
      const clerkIds = [...new Set(orders.map(row => row.clerkId).filter(id => id > 0))];
      const people = uids.length ? await tx.select({ uid: user.uid, nickname: user.nickname })
        .from(user).where(inArray(user.uid, uids)) : [];
      const stores = storeIds.length ? await tx.select({ id: systemStore.id, name: systemStore.name })
        .from(systemStore).where(inArray(systemStore.id, storeIds)) : [];
      const staff = clerkIds.length ? await tx.select({ id: systemStoreStaff.id,
        uid: systemStoreStaff.uid, storeId: systemStoreStaff.storeId,
        name: systemStoreStaff.staffName }).from(systemStoreStaff)
        .where(inArray(systemStoreStaff.uid, clerkIds)).orderBy(desc(systemStoreStaff.id)).limit(501) : [];
      if (staff.length > 500) throw new ValidateException('核销员关联记录过多');
      const staffStoreIds = [...new Set(staff.map(row => row.storeId).filter(id => id > 0))];
      const staffStores = staffStoreIds.length ? await tx.select({ id: systemStore.id, name: systemStore.name })
        .from(systemStore).where(inArray(systemStore.id, staffStoreIds)) : [];
      const carts = await tx.select({ id: storeOrderCartInfo.id, uid: storeOrderCartInfo.uid,
        oid: storeOrderCartInfo.oid, productId: storeOrderCartInfo.productId,
        cartNum: storeOrderCartInfo.cartNum,
        cartInfo: sql<string | null>`CASE WHEN coalesce(octet_length(${storeOrderCartInfo.cartInfo}),0) <= ${MAX_SNAPSHOT_BYTES}
          THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`,
        oversized: sql<boolean>`coalesce(octet_length(${storeOrderCartInfo.cartInfo}),0) > ${MAX_SNAPSHOT_BYTES}`,
      }).from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.oid, orderIds))
        .orderBy(storeOrderCartInfo.oid, storeOrderCartInfo.id).limit(MAX_CART_ROWS + 1);
      if (carts.length > MAX_CART_ROWS) throw new ValidateException('核销订单商品数量过多，请缩小分页');
      const peopleById = new Map(people.map(row => [row.uid, row.nickname]));
      const storesById = new Map([...stores, ...staffStores].map(row => [row.id, row.name]));
      const staffByUid = new Map<number, (typeof staff)[number]>();
      for (const row of staff) if (!staffByUid.has(row.uid)) staffByUid.set(row.uid, row);
      const cartsByOrder = new Map<number, CartRow[]>();
      for (const cart of carts) cartsByOrder.set(cart.oid, [...(cartsByOrder.get(cart.oid) ?? []), cart]);
      const list = orders.map(row => {
        const issues: string[] = [];
        const cartRows = cartsByOrder.get(row.id) ?? [];
        if (!cartRows.length) issues.push('订单商品快照缺失');
        const goods = cartRows.map(cart => goodsItem(cart, row.uid, issues)).filter(item => item !== null);
        const clerk = staffByUid.get(row.clerkId);
        const spread = peopleById.get(row.spreadUid) ?? '';
        if (!peopleById.has(row.uid)) issues.push('下单用户不存在');
        if (row.storeId > 0 && !storesById.has(row.storeId)) issues.push('核销门店不存在');
        if (row.clerkId > 0 && !clerk) issues.push('核销员不存在');
        return { id: row.id, order_id: row.orderId, uid: row.uid,
          nickname: peopleById.get(row.uid) ?? '',
          spread_nickname: row.uid === row.spreadUid && spread ? `${spread}(自购)` : spread,
          pay_price: row.payPrice, clerk_name: clerk?.name ?? (row.storeId === 0 && row.clerkId === 0 ? '总平台' : ''),
          store_name: storesById.get(clerk?.storeId ?? 0) || storesById.get(row.storeId) || '',
          pay_type_name: payNames[row.payType] ?? '其他支付',
          status_name: row.isSystemDel ? '已删除' : row.refundStatus === 3 ? '部分退款' : '待评价',
          add_time: row.addTime, pay_time: row.payTime, goods, issues };
      });
      return { list, count: total.count, page: query.page, limit: query.limit,
        badge: [] as unknown[] };
    });
  }

  async stores() {
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const rows = await tx.select({ id: systemStore.id, name: systemStore.name })
        .from(systemStore).where(and(eq(systemStore.isDel, 0), eq(systemStore.isShow, 1)))
        .orderBy(desc(systemStore.addTime), desc(systemStore.id)).limit(501);
      if (rows.length > 500) throw new ValidateException('核销门店选项过多');
      return { list: rows };
    });
  }

  async spreadInfo(rawUid: unknown) {
    const uid = positiveId(rawUid, '用户UID');
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const [eligible] = await tx.select({ id: storeOrder.id }).from(storeOrder)
        .where(and(visible(), eq(storeOrder.uid, uid))).limit(1);
      if (!eligible) throw new NotFoundException('核销订单用户不存在');
      const [buyer] = await tx.select({ spreadUid: user.spreadUid }).from(user)
        .where(eq(user.uid, uid)).limit(1);
      if (!buyer?.spreadUid) return { spread: null };
      const [spread] = await tx.select({ uid: user.uid, nickname: user.nickname,
        avatar: user.avatar, nowMoney: user.nowMoney, brokeragePrice: user.brokeragePrice,
        realName: user.realName, phone: user.phone, integral: user.integral,
        mark: user.mark, birthday: user.birthday, lastTime: user.lastTime,
      }).from(user).where(eq(user.uid, buyer.spreadUid)).limit(1);
      return { spread: spread ? { uid: spread.uid, nickname: spread.nickname,
        avatar: safeImage(spread.avatar), now_money: spread.nowMoney,
        brokerage_price: spread.brokeragePrice, real_name: spread.realName,
        phone: spread.phone, integral: spread.integral, mark: spread.mark,
        birthday: spread.birthday, last_time: spread.lastTime } : null };
    });
  }
}
