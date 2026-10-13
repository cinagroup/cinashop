import { and, asc, desc, eq, getTableColumns, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { qrcode, storeOrder, user } from '@/models/schema';
import { AuthException, ValidateException } from '@/utils/errors';
import { assertActiveAgentSelfService } from './DivisionManagementService';
import { staffInteger, staffRevision, type DivisionStaffActor, type DivisionStaffInviteInput, type DivisionStaffListInput } from './DivisionStaffInput';

/** Shared with existing Admin division role writers; never a financial lock. */
const ROLE_LOCK_NAMESPACE = 1147879249;
const MAX_RELATED_USERS = 5000;
type Account = typeof user.$inferSelect;
const accountColumns = { ...getTableColumns(user), revision: sql<string>`xmin::text` };
type VersionedAccount = Account & { revision: string };
const reset = (now: number) => ({ divisionName: '', divisionType: 0, divisionStatus: 0, divisionId: 0,
  agentId: 0, staffId: 0, divisionPercent: 0, divisionEndTime: 0, divisionChangeTime: now, divisionInvite: 0 });

function liveAccount(row: Account | undefined): asserts row is Account {
  if (!row || row.status !== 1 || row.isDel !== 0 || row.deleteTime !== null) throw new AuthException('用户不存在或已停用，请重新登录');
}
function actorSession(actor: DivisionStaffActor, account: Account | undefined): asserts account is Account {
  staffInteger(actor?.uid, '登录UID');
  if (typeof actor.passwordVersion !== 'string' || !Number.isSafeInteger(actor.expiresAt)
    || actor.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException('登录已失效，请重新登录');
  liveAccount(account);
  if (account.uid !== actor.uid || account.pwd !== actor.passwordVersion) throw new AuthException('登录状态已变化，请重新登录');
}
function activeAgent(row: Account | undefined): asserts row is Account {
  assertActiveAgentSelfService(row);
  if (row.deleteTime !== null || !row.divisionId || row.agentId !== 0 && row.agentId !== row.uid) throw new ValidateException('代理商父级关系无效，请联系平台管理员');
}
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
const roleRevision = (row: Pick<VersionedAccount, 'uid' | 'revision' | 'divisionType' | 'divisionId' | 'agentId' | 'staffId' | 'divisionPercent' | 'divisionStatus' | 'divisionEndTime'>) => digest([row.uid, row.revision, row.divisionType, row.divisionId,
  row.agentId, row.staffId, row.divisionPercent, row.divisionStatus, row.divisionEndTime]);
function day(epoch: number): string {
  const d = new Date((epoch + 8 * 3600) * 1000);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}
async function deadlines(tx: DbClient) {
  await tx.execute(sql`SELECT set_config('statement_timeout',
    LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true)`);
}
function contention(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    if ('code' in cause && ['55P03', '40P01', '57014'].includes(String(cause.code))) throw new ValidateException('员工关系正在更新，请刷新后重试');
    if (!('cause' in cause) || cause.cause === cause) break;
    cause = cause.cause;
  }
  throw error;
}
async function roleKeys(tx: DbClient, ids: number[]) {
  for (const id of [...new Set(ids.filter(id => id > 0))].sort((a, b) => a - b)) {
    const rows = await tx.execute<{ acquired: boolean }>(sql`SELECT pg_try_advisory_xact_lock(${ROLE_LOCK_NAMESPACE}, ${id}) AS acquired`);
    if (rows[0]?.acquired !== true) throw new ValidateException('员工关系正在更新，请刷新后重试');
  }
}
async function lockAccounts(tx: DbClient, ids: number[]): Promise<VersionedAccount[]> {
  const sorted = [...new Set(ids.filter(id => id > 0))].sort((a, b) => a - b);
  return sorted.length ? tx.select(accountColumns).from(user).where(inArray(user.uid, sorted))
    .orderBy(asc(user.uid)).for('update', { noWait: true }) : [];
}
async function account(db: DbClient, uid: number): Promise<VersionedAccount | undefined> {
  return (await db.select(accountColumns).from(user).where(eq(user.uid, uid)).limit(1))[0];
}
/** RETURNING alone cannot expose a later AFTER-trigger edit. Check every real
 * account column again inside this transaction; xmin is only an input revision. */
async function assertStoredAccounts(tx: DbClient, expected: Account[], returned?: Account[]): Promise<Account[]> {
  const keys = Object.keys(getTableColumns(user)) as (keyof Account)[];
  const byId = new Map(expected.map(row => [row.uid, row]));
  const same = (actual: Account[]) => actual.length === expected.length && actual.every(row => {
    const prior = byId.get(row.uid);
    return prior && keys.every(key => JSON.stringify(row[key]) === JSON.stringify(prior[key]));
  }) && new Set(actual.map(row => row.uid)).size === expected.length;
  if (returned && !same(returned)) throw new ValidateException('员工身份写入结果不一致');
  const stored = await tx.select(getTableColumns(user)).from(user).where(inArray(user.uid, expected.map(row => row.uid))).orderBy(asc(user.uid));
  if (!same(stored)) throw new ValidateException('员工身份保存结果不一致');
  return stored;
}
async function inviteTarget(db: DbClient, input: DivisionStaffInviteInput, locked = false) {
  if (input.agentId) return { agentUid: staffInteger(input.agentId, '代理商UID'), codeRevision: '' };
  const code = staffInteger(input.agentCode, '二维码邀请码');
  const query = db.select({ id: qrcode.id, thirdId: qrcode.thirdId, revision: sql<string>`xmin::text` }).from(qrcode)
    .where(and(eq(qrcode.id, code), eq(qrcode.thirdType, 'division_agent'), eq(qrcode.status, 1))).limit(1);
  const rows = locked ? await query.for('share', { noWait: true }) : await query;
  if (!rows[0]) throw new ValidateException('员工二维码邀请码不存在或已失效');
  return { agentUid: staffInteger(rows[0].thirdId, '邀请码代理商UID'), codeRevision: `${rows[0].id}:${rows[0].revision}` };
}
async function inviteRevision(agent: VersionedAccount, input: DivisionStaffInviteInput, codeRevision: string) {
  return digest([input.agentId, input.agentCode, codeRevision, await roleRevision(agent)]);
}

export class DivisionStaffService {
  constructor(private readonly container: Container) {}

  /** One readonly snapshot; final current reads recheck JWT and role withdrawal. */
  async list(actor: DivisionStaffActor, input: DivisionStaffListInput) {
    const result = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await deadlines(tx);
      const agent = await account(tx, actor.uid); actorSession(actor, agent); activeAgent(agent);
      const conditions: SQL[] = [eq(user.agentId, actor.uid), eq(user.divisionType, 3), eq(user.isDel, 0)];
      if (input.keyword) {
        const pattern = `%${input.keyword.replace(/[\\%_]/g, '\\$&')}%`;
        conditions.push(or(ilike(user.nickname, pattern), ilike(user.phone, pattern), sql`${user.uid}::text LIKE ${pattern}`)!);
      }
      if (input.start) conditions.push(gte(user.spreadTime, input.start), lte(user.spreadTime, input.stop));
      const where = and(...conditions)!;
      const rows = await tx.select({ uid: user.uid, avatar: user.avatar, nickname: user.nickname, phone: user.phone,
        spreadUid: user.spreadUid, spreadTime: user.spreadTime, divisionPercent: user.divisionPercent, payCount: user.payCount,
        revision: sql<string>`xmin::text`, divisionType: user.divisionType, divisionId: user.divisionId, agentId: user.agentId,
        staffId: user.staffId, divisionStatus: user.divisionStatus, divisionEndTime: user.divisionEndTime }).from(user).where(where)
        .orderBy(desc(user.spreadTime), desc(user.uid)).limit(input.limit).offset((input.page - 1) * input.limit);
      const [count] = await tx.select({ count: sql<number>`count(*)::int` }).from(user).where(where);
      const [brokerage] = await tx.select({ amount: sql<string>`COALESCE(SUM(${storeOrder.divisionAgentBrokerage}), 0)::text` })
        .from(storeOrder).where(eq(storeOrder.divisionAgentId, actor.uid));
      const ids = rows.map(row => row.uid);
      const orders = ids.length ? await tx.select({ uid: storeOrder.uid, count: sql<number>`count(*)::int`,
        amount: sql<string>`COALESCE(SUM(${storeOrder.payPrice}),0)::text` }).from(storeOrder)
        .where(and(inArray(storeOrder.uid, ids), eq(storeOrder.refundStatus, 0))).groupBy(storeOrder.uid) : [];
      const children = ids.length ? await tx.select({ uid: user.spreadUid, count: sql<number>`count(*)::int` }).from(user)
        .where(and(eq(user.agentId, actor.uid), inArray(user.spreadUid, ids))).groupBy(user.spreadUid) : [];
      const orderMap = new Map(orders.map(row => [row.uid, row])), childMap = new Map(children.map(row => [row.uid, row.count]));
      const list = await Promise.all(rows.map(async row => ({ uid: row.uid, avatar: row.avatar, nickname: row.nickname,
        phone: row.phone, spread_uid: row.spreadUid, spread_time: day(row.spreadTime), division_percent: row.divisionPercent,
        pay_count: row.payCount, childCount: childMap.get(row.uid) ?? 0, orderCount: orderMap.get(row.uid)?.count ?? 0,
        numberCount: orderMap.get(row.uid)?.amount ?? '0', spreadTime: row.spreadTime, divisionPercent: row.divisionPercent,
        payCount: row.payCount, revision: await roleRevision(row) })));
      actorSession(actor, agent); activeAgent(agent);
      return { list, count: count?.count ?? 0, brokerage: brokerage?.amount ?? '0', page: input.page, limit: input.limit,
        agent: { uid: agent.uid, divisionPercent: agent.divisionPercent, divisionEndTime: agent.divisionEndTime } };
    });
    const current = await account(this.container.db, actor.uid); actorSession(actor, current); activeAgent(current);
    return result;
  }

  async preview(actor: DivisionStaffActor, input: DivisionStaffInviteInput) {
    const result = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await deadlines(tx);
      actorSession(actor, await account(tx, actor.uid));
      const target = await inviteTarget(tx, input), agent = await account(tx, target.agentUid); activeAgent(agent);
      if (agent.uid === actor.uid) throw new ValidateException('自己不能推荐自己');
      const self = await account(tx, actor.uid); actorSession(actor, self);
      return { agent: { uid: agent.uid, name: agent.divisionName || agent.nickname, divisionId: agent.divisionId },
        source: input.agentCode ? 'qrcode' : 'legacy_h5', codeId: input.agentCode,
        canBind: self.divisionType === 0, alreadyBound: self.divisionType === 3 && self.agentId === agent.uid,
        revision: await inviteRevision(agent, input, target.codeRevision) };
    });
    actorSession(actor, await account(this.container.db, actor.uid));
    const final = await inviteTarget(this.container.db, input), agent = await account(this.container.db, final.agentUid); activeAgent(agent);
    if (await inviteRevision(agent, input, final.codeRevision) !== result.revision) throw new ValidateException('员工邀请已变化，请重新读取');
    return result;
  }

  async percent(actor: DivisionStaffActor, uidValue: number, percentValue: number, expected?: string): Promise<void> {
    const uid = staffInteger(uidValue, '员工UID'), percent = staffInteger(percentValue, '员工比例', 0, 100);
    staffRevision(expected);
    await this.agentWrite(actor, uid, async (tx, agent, staff) => {
      if (expected && expected !== await roleRevision(staff)) throw new ValidateException('员工关系已变化，请刷新后重新确认');
      if (percent >= agent.divisionPercent) throw new ValidateException('员工比例必须低于代理商比例');
      const values = { divisionPercent: percent, divisionChangeTime: Math.floor(Date.now() / 1000) };
      const changed = await tx.update(user).set(values)
        .where(and(eq(user.uid, uid), eq(user.agentId, actor.uid), eq(user.divisionType, 3))).returning();
      if (changed.length !== 1) throw new ValidateException('员工比例修改结果不一致');
      await assertStoredAccounts(tx, [{ ...staff, ...values }], changed);
    });
  }

  async remove(actor: DivisionStaffActor, uidValue: number, expected?: string): Promise<void> {
    const uid = staffInteger(uidValue, '员工UID'); staffRevision(expected);
    await this.agentWrite(actor, uid, async (tx, _agent, staff) => {
      if (expected && expected !== await roleRevision(staff)) throw new ValidateException('员工关系已变化，请刷新后重新确认');
      // PHP performs both updates. The union explicitly includes a legacy staff
      // whose self staff_id is zero or inconsistent, while preserving agent scope.
      const where = and(eq(user.agentId, actor.uid), or(eq(user.uid, uid), eq(user.staffId, uid)))!;
      const related = await tx.select({ uid: user.uid, type: user.divisionType }).from(user).where(where)
        .orderBy(asc(user.uid)).limit(MAX_RELATED_USERS + 1);
      if (related.length > MAX_RELATED_USERS) throw new ValidateException('员工关联用户超过5000，请由平台分批处理');
      if (related.some(row => row.type === 1 || row.type === 2)) throw new ValidateException('员工关联角色异常，请联系平台管理员');
      const before = await lockAccounts(tx, related.map(row => row.uid));
      if (before.length !== related.length || before.some(row => row.agentId !== actor.uid || row.uid !== uid && row.staffId !== uid)) {
        throw new ValidateException('员工解绑范围已变化，请刷新后重试');
      }
      const expectedIds = new Set(related.map(row => row.uid));
      const values = reset(Math.floor(Date.now() / 1000));
      const changed = await tx.update(user).set(values).where(where).returning();
      if (changed.length !== expectedIds.size || changed.some(row => !expectedIds.delete(row.uid)) || expectedIds.size) {
        throw new ValidateException('员工解绑范围已变化，请刷新后重试');
      }
      await assertStoredAccounts(tx, before.map(row => ({ ...row, ...values })), changed);
    });
  }

  async bind(actor: DivisionStaffActor, input: DivisionStaffInviteInput): Promise<void> {
    staffRevision(input.revision);
    const target = await inviteTarget(this.container.db, input), candidate = await account(this.container.db, target.agentUid);
    activeAgent(candidate);
    if (candidate.uid === actor.uid) throw new ValidateException('自己不能推荐自己');
    try {
      await withTx(this.container, async tx => {
        await deadlines(tx);
        await roleKeys(tx, [actor.uid, candidate.uid, candidate.divisionId]);
        const locked = await lockAccounts(tx, [actor.uid, candidate.uid, candidate.divisionId]);
        const self = locked.find(row => row.uid === actor.uid), agent = locked.find(row => row.uid === candidate.uid);
        actorSession(actor, self); activeAgent(agent);
        if (agent.divisionId !== candidate.divisionId) throw new ValidateException('上级代理商关系已变化，请重新读取');
        const actual = await inviteTarget(tx, input, true);
        if (actual.agentUid !== agent.uid || actual.codeRevision !== target.codeRevision) throw new ValidateException('员工邀请已变化，请重新读取');
        if (input.revision && input.revision !== await inviteRevision(agent, input, actual.codeRevision)) throw new ValidateException('员工邀请已变化，请重新确认');
        if (self.divisionType !== 0) throw new ValidateException('您已经拥有事业部角色，不能重复绑定员工');
        const now = Math.floor(Date.now() / 1000);
        const values = { spreadUid: agent.uid, spreadTime: now, divisionType: 3, divisionStatus: 1,
          divisionId: agent.divisionId, agentId: agent.uid, staffId: actor.uid, divisionEndTime: agent.divisionEndTime,
          divisionChangeTime: now, divisionPercent: 0, divisionInvite: 0, isPromoter: 1 };
        const changed = await tx.update(user).set(values)
          .where(and(eq(user.uid, actor.uid), eq(user.divisionType, 0))).returning();
        if (changed.length !== 1) throw new ValidateException('员工绑定结果不一致');
        const [saved] = await assertStoredAccounts(tx, [{ ...self, ...values }], changed);
        const savedParents = await assertStoredAccounts(tx, locked.filter(row => row.uid !== actor.uid));
        const currentAgent = savedParents.find(row => row.uid === agent.uid);
        actorSession(actor, saved); activeAgent(currentAgent);
      });
    } catch (error) { contention(error); }
  }

  private async agentWrite(actor: DivisionStaffActor, uid: number,
    operation: (tx: DbClient, agent: VersionedAccount, staff: VersionedAccount) => Promise<void>) {
    if (uid === actor.uid) throw new ValidateException('不能把当前代理商作为员工操作');
    const candidate = await account(this.container.db, actor.uid); actorSession(actor, candidate); activeAgent(candidate);
    try {
      await withTx(this.container, async tx => {
        await deadlines(tx);
        await roleKeys(tx, [actor.uid, uid, candidate.divisionId]);
        const rows = await lockAccounts(tx, [actor.uid, uid, candidate.divisionId]);
        const agent = rows.find(row => row.uid === actor.uid), staff = rows.find(row => row.uid === uid);
        actorSession(actor, agent); activeAgent(agent);
        if (agent.divisionId !== candidate.divisionId) throw new ValidateException('代理商父级关系已变化，请刷新');
        if (!staff || staff.divisionType !== 3 || staff.agentId !== actor.uid || staff.isDel !== 0 || staff.deleteTime !== null) {
          throw new ValidateException('员工不存在或不属于当前代理商');
        }
        await operation(tx, agent, staff);
        const savedParents = await assertStoredAccounts(tx, rows.filter(row => row.uid !== uid));
        const current = savedParents.find(row => row.uid === actor.uid);
        actorSession(actor, current); activeAgent(current);
      });
    } catch (error) { contention(error); }
  }
}

// The independent employee-invite adapter reuses precisely the same live
// customer and agent predicates; it never inherits Admin authority.
export { actorSession as assertDivisionStaffActor, activeAgent as assertDivisionStaffAgent };
