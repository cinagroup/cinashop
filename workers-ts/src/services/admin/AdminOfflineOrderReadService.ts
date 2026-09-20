import { timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { otherOrder, systemAdmin, user } from '@/models/schema';
import { offlineOrderAdmission } from '@/models/candidates/offline_order_admission';
import { ApiErrorCode, AuthException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { AdminPermissionService } from './AdminPermissionService';
import { readOfflineOrderEvidenceTx } from '@/services/order/OfflineOrderReadService';
import { offlineAmountCents, offlineMoney } from '@/services/order/OfflineOrderQuoteService';

export interface AdminOfflineReadActor { id: number; authVersion: string; expiresAt: number }
const route = '/adminapi/order/scan_list';
export const ADMIN_OFFLINE_READ_VERSION = 'admin-offline-read-v1';
export function adminOfflineId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) throw new ValidateException('消费记录标识无效');
  return Number(value);
}
function query(input: Record<string, string>) {
  if (Object.keys(input).some(k => !['before','limit','order_id','name','uid','from','to','recorded_paid'].includes(k))) throw new ValidateException('请使用新版线下消费查询参数');
  const limit = adminOfflineId(input.limit ?? '20');
  if (limit > 20) throw new ValidateException('每页最多20条消费记录');
  const before = input.before === undefined ? undefined : adminOfflineId(input.before);
  const uid = input.uid === undefined ? undefined : adminOfflineId(input.uid);
  if (input.order_id !== undefined && (!input.order_id || input.order_id.length > 32 || /[\s\u0000-\u001f\u007f]/.test(input.order_id))) throw new ValidateException('请输入完整消费订单号');
  if (input.name !== undefined && (!input.name.trim() || input.name.length > 64 || /[\u0000-\u001f\u007f]/.test(input.name))) throw new ValidateException('用户搜索词无效');
  const from = input.from === undefined ? undefined : adminOfflineId(input.from);
  const to = input.to === undefined ? undefined : adminOfflineId(input.to);
  if ((from === undefined) !== (to === undefined) || (from !== undefined && to !== undefined && from >= to)) throw new ValidateException('请选择有效的完整时间范围');
  if (input.recorded_paid !== undefined && !['0','1'].includes(input.recorded_paid)) throw new ValidateException('原订单支付标记无效');
  return { limit, before, uid, from, to, order_id: input.order_id, name: input.name, recorded_paid: input.recorded_paid };
}

async function snapshot<T>(container: Container, actor: AdminOfflineReadActor, work: (tx: DbClient) => Promise<T>) {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > 2147483647 || !/^[a-f0-9]{32}$/.test(actor.authVersion)
    || !Number.isSafeInteger(actor.expiresAt) || actor.expiresAt <= Math.floor(Date.now()/1000)) throw new AuthException('请重新登录');
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SELECT set_config('statement_timeout',
      LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
    const [admin] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id));
    if (!admin || admin.adminType !== 1 || admin.status !== 1 || admin.isDel !== 0) throw new AuthException('管理员状态已变化', ApiErrorCode.ERR_BANNED);
    if (!timingSafeEqual(new TextEncoder().encode(md5(admin.pwd)), new TextEncoder().encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
    // Re-evaluate roles in this same readonly snapshot; middleware claims are
    // not copied into SQL authority, nor does this impersonate a customer.
    await new AdminPermissionService(createContainerFromDb(tx)).assertAuthorized(admin, 'GET', route);
    const result = await work(tx);
    if (actor.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
    return result;
  });
}

export async function assertAdminOfflineReader(container: Container, actor: AdminOfflineReadActor): Promise<void> {
  await snapshot(container, actor, async () => undefined);
}

function money(value: string) {
  try { return offlineMoney(offlineAmountCents(value, true)); }
  catch (error) { if (!(error instanceof ValidateException)) throw error; return null; }
}
async function project(tx: DbClient, order: typeof otherOrder.$inferSelect, account: typeof user.$inferSelect | null) {
  const raw = money(order.money), amount = money(order.payPrice);
  const savings = raw !== null && amount !== null && offlineAmountCents(raw, true) >= offlineAmountCents(amount, true)
    ? offlineMoney(offlineAmountCents(raw, true) - offlineAmountCents(amount, true)) : null;
  const base = { id: order.id, order_id: order.orderId, uid: order.uid, nickname: account?.nickname ?? '', phone: account?.phone ?? '',
    account_available: !!account && account.status === 1 && account.isDel === 0 && account.deleteTime === null,
    money: raw, pay_price: amount, true_price: savings, add_time: order.addTime, hidden: order.isDel !== 0,
    recorded_paid: order.paid, channel: order.channelType };
  const unverified = (reason: 'MISSING_ADMISSION' | 'ACCOUNT_MISSING' | 'EVIDENCE_MISMATCH') => ({ ...base,
    paid: null, pay_type: null, paid_at: null, state: 'UNVERIFIED' as const, reason });
  const [admission] = await tx.select({ id: offlineOrderAdmission.orderId }).from(offlineOrderAdmission)
    .where(eq(offlineOrderAdmission.orderId, order.id));
  if (!admission) return unverified('MISSING_ADMISSION');
  if (!account) return unverified('ACCOUNT_MISSING');
  try {
    const evidence = await readOfflineOrderEvidenceTx(tx, order.uid, order.orderId, account);
    // Explicit staff DTO. No ticket, payer identity, transaction ID, request
    // key, callback payload, balances, password or payment initiation capability.
    return { ...base, paid: evidence.paid, pay_type: evidence.pay_type, paid_at: 'paid_at' in evidence ? evidence.paid_at : null,
      state: evidence.state === 'READY' || evidence.state === 'RECOVERY_REQUIRED' ? 'PENDING' as const
        : evidence.state === 'UNSELECTED' ? 'UNPAID' as const : evidence.state, reason: null };
  } catch (error) {
    if (!(error instanceof ValidateException) && !(error instanceof NotFoundException)) throw error;
    return unverified('EVIDENCE_MISMATCH');
  }
}

/** Modern scan_list contract: bounded keyset, all type=3 records by default.
 * recorded_paid is only a source filter, NOT a verified collection claim.
 * No unverified aggregate/count is labelled as paid; each returned row checks
 * the same immutable financial evidence as the customer detail in one snapshot. */
export async function listAdminOfflineOrders(container: Container, actor: AdminOfflineReadActor, input: Record<string, string>) {
  const q = query(input);
  return snapshot(container, actor, async tx => {
    const where: SQL[] = [eq(otherOrder.type, 3)];
    if (q.before !== undefined) where.push(lt(otherOrder.id, q.before));
    if (q.uid !== undefined) where.push(eq(otherOrder.uid, q.uid));
    if (q.order_id !== undefined) where.push(eq(otherOrder.orderId, q.order_id));
    if (q.recorded_paid !== undefined) where.push(eq(otherOrder.paid, Number(q.recorded_paid)));
    if (q.from !== undefined && q.to !== undefined) where.push(gte(otherOrder.addTime, q.from), lt(otherOrder.addTime, q.to));
    if (q.name !== undefined) {
      const pattern = `%${q.name.trim().replace(/[\\%_]/g, '\\$&')}%`;
      where.push(or(ilike(user.nickname, pattern), ilike(user.phone, pattern))!);
    }
    const rows = await tx.select({ order: otherOrder, account: user }).from(otherOrder).leftJoin(user, eq(user.uid, otherOrder.uid))
      .where(and(...where)).orderBy(desc(otherOrder.id)).limit(q.limit + 1);
    const list: Awaited<ReturnType<typeof project>>[] = [], deadline = Date.now() + 8000;
    // Cooperative page budget, not a hard whole-transaction timeout. Each SQL
    // statement additionally retains the stricter existing/5s timeout above.
    for (const row of rows.slice(0, q.limit)) {
      if (Date.now() > deadline) throw new ServiceUnavailableException('本页收款核验超时，请缩小范围后重试');
      list.push(await project(tx, row.order, row.account));
    }
    if (Date.now() > deadline) throw new ServiceUnavailableException('本页收款核验超时，请缩小范围后重试');
    return { version: ADMIN_OFFLINE_READ_VERSION, list, limit: q.limit,
      next_cursor: rows.length > q.limit ? String(list.at(-1)!.id) : '' };
  });
}
export async function readAdminOfflineOrder(container: Container, actor: AdminOfflineReadActor, id: number) {
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw new ValidateException('消费记录标识无效');
  return snapshot(container, actor, async tx => {
    const [row] = await tx.select({ order: otherOrder, account: user }).from(otherOrder).leftJoin(user, eq(user.uid, otherOrder.uid))
      .where(and(eq(otherOrder.id, id), eq(otherOrder.type, 3))).limit(1);
    if (!row) throw new NotFoundException('线下消费记录不存在');
    return { version: ADMIN_OFFLINE_READ_VERSION, record: await project(tx, row.order, row.account) };
  });
}
