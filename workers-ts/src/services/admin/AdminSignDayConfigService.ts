import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemGroup, systemGroupData, systemLog } from '@/models/schema';
import { readThemeSnapshot } from '@/services/content/ThemeReadService';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { signDayId, signDayMutationCanonical, signDayPayloadHash, signDayRequestId, signDaySha256,
  type SignDayCanonicalMutation, type SignDayOperation } from './AdminSignDayConfigInput';

const GROUP_NAME = 'sign_day_num';
const JOURNAL_TYPE = 'sign_day_config';
const LOCK_NAMESPACE = 731_698;
const LOCK_KEY = 1;
const MAX_ROWS = 7;
const MAX_HISTORICAL_READ = 100;
const groupColumns = { ...getTableColumns(systemGroup), version: sql<string>`xmin::text` };
const dataColumns = { ...getTableColumns(systemGroupData), version: sql<string>`xmin::text` };
type GroupRow = typeof systemGroup.$inferSelect & { version: string };
type DataRow = typeof systemGroupData.$inferSelect & { version: string };
type Receipt = { operation: SignDayOperation; id: number; request_id: string; payload_hash: string };

const groupFields = JSON.stringify([
  { name: '第几天', title: 'day', type: 'input', param: '' },
  { name: '获取积分', title: 'sign_num', type: 'input', param: '' },
]);
const receiptPath = (requestId: string) => `/marketing/sign-day-config/request/${requestId}`;

async function deadlines(tx: DbClient) {
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
}

async function groupAndRows(tx: DbClient) {
  const groups = await tx.select(groupColumns).from(systemGroup).where(eq(systemGroup.configName, GROUP_NAME)).limit(2);
  if (groups.length > 1) throw new ValidateException('签到配置组重复，请先修复');
  const group = groups[0];
  const rows = group ? await tx.select(dataColumns).from(systemGroupData).where(eq(systemGroupData.gid, group.id))
    .orderBy(desc(systemGroupData.sort), desc(systemGroupData.id)).limit(MAX_HISTORICAL_READ + 1) : [];
  if (rows.length > MAX_HISTORICAL_READ) throw new ValidateException('历史签到配置超过100条，请先由维护人员清理异常数据');
  return { group, rows };
}

async function collectionRevision(group: GroupRow | undefined, rows: DataRow[]) {
  return signDaySha256({ group_name: GROUP_NAME, group: group ?? null,
    rows: [...rows].sort((a, b) => a.id - b.id) });
}

async function rowRevision(group: GroupRow, row: DataRow) {
  return signDaySha256({ group_name: GROUP_NAME, group, row });
}

function valueObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const decoded: unknown = JSON.parse(raw);
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded as Record<string, unknown> : null;
  } catch { return null; }
}

function nestedValue(source: Record<string, unknown> | null, key: string): unknown {
  const field = source?.[key];
  return field && typeof field === 'object' && !Array.isArray(field) ? (field as Record<string, unknown>).value : undefined;
}

function decode(row: DataRow) {
  const source = valueObject(row.value);
  const dayRaw = nestedValue(source, 'day');
  const pointsRaw = nestedValue(source, 'sign_num');
  const day = typeof dayRaw === 'string' && !!dayRaw.trim() && [...dayRaw].length <= 64
    && !/[\u0000-\u001f\u007f]/u.test(dayRaw) ? dayRaw : null;
  const signNum = typeof pointsRaw === 'string' && /^[1-9]\d*$/.test(pointsRaw)
    ? Number(pointsRaw) : typeof pointsRaw === 'number' ? pointsRaw : NaN;
  const sign_num = Number.isSafeInteger(signNum) && signNum >= 1 && signNum <= 2_147_483_647 ? signNum : null;
  const issues: string[] = [];
  if (!source) issues.push('配置值不是JSON对象');
  if (day === null) issues.push('签到天数文案无效');
  if (sign_num === null) issues.push('签到积分无效');
  if (!Number.isSafeInteger(row.sort) || row.sort < 0) issues.push('排序无效');
  if (row.status !== 0 && row.status !== 1) issues.push('显示状态无效');
  return { day, sign_num, issues };
}

async function project(group: GroupRow, row: DataRow) {
  return { id: row.id, gid: row.gid, ...decode(row), sort: row.sort, status: row.status,
    add_time: row.addTime, revision: await rowRevision(group, row) };
}

function savedValue(existing: string | null, day: string, signNum: number): string {
  // Unknown historical keys and unknown properties inside the two known fields
  // survive a normal edit. Unparseable legacy JSON has no recoverable keys.
  const source = valueObject(existing) ?? {};
  const field = (key: string, value: string): Record<string, unknown> => {
    const old = source[key];
    return { ...(old && typeof old === 'object' && !Array.isArray(old) ? old : {}), type: 'input', value };
  };
  return JSON.stringify({ ...source, day: field('day', day), sign_num: field('sign_num', String(signNum)) });
}

function journalReceipt(action: string, requestId: string): Receipt | null {
  const match = /^(create|update|status|delete);id=([1-9]\d{0,9});payload=([a-f0-9]{64})$/.exec(action);
  if (!match) return null;
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id) || id > 2_147_483_647) return null;
  return { operation: match[1] as SignDayOperation, id, request_id: requestId, payload_hash: match[3] };
}

async function theme(tx: DbClient): Promise<{ theme: number | null; theme_issue: string | null }> {
  const snapshot = await readThemeSnapshot(tx);
  const messages = { theme_missing: '签到主题未配置', theme_duplicate: '签到主题存在重复模板',
    theme_identity_invalid: '签到主题模板身份异常', theme_status_invalid: '签到主题值无效' };
  return { theme: snapshot.status, theme_issue: snapshot.issues.length ? messages[snapshot.issues[0]] : null };
}

/** Dedicated legacy sign_day_num editor. This data is visual configuration;
 * actual sign rewards are governed by sign_mode/sign_give_point/reward rows. */
export class AdminSignDayConfigService {
  constructor(private readonly container: Container) {}

  async list() {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await deadlines(tx);
      const { group, rows } = await groupAndRows(tx);
      return { group_present: !!group, list: group ? await Promise.all(rows.map(row => project(group, row))) : [],
        count: rows.length, revision: await collectionRevision(group, rows), ...(await theme(tx)) };
    });
  }

  async detail(value: unknown) {
    const id = signDayId(value);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await deadlines(tx);
      const { group, rows } = await groupAndRows(tx);
      const row = rows.find(item => item.id === id);
      if (!group || !row) throw new NotFoundException('签到天数条目不存在');
      return { info: await project(group, row) };
    });
  }

  async receipt(value: unknown, actor: { id: number }): Promise<Receipt> {
    const requestId = signDayRequestId(value);
    signDayId(actor?.id);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await deadlines(tx);
      const rows = await tx.select({ action: systemLog.action }).from(systemLog)
        .where(and(eq(systemLog.type, JOURNAL_TYPE), eq(systemLog.path, receiptPath(requestId)), eq(systemLog.adminId, actor.id)))
        .limit(2);
      if (!rows.length) throw new NotFoundException('签到天数操作回执不存在');
      const result = rows.length === 1 ? journalReceipt(rows[0].action, requestId) : null;
      if (!result) throw new ValidateException('签到天数操作回执异常，无法确认结果');
      return result;
    });
  }

  async mutate(operation: SignDayOperation, idValue: unknown, raw: Record<string, unknown>, actor: { id: number }): Promise<Receipt> {
    signDayId(actor?.id);
    const id = operation === 'create' ? 0 : signDayId(idValue);
    const { request_id, canonical } = signDayMutationCanonical(operation, id, raw);
    const payload_hash = await signDayPayloadHash(canonical);
    const statusValue = operation === 'status'
      ? (canonical as Extract<SignDayCanonicalMutation, { operation: 'status' }>).status : undefined;
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
      await deadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${LOCK_KEY})`);
      const journal = await tx.select({ action: systemLog.action, adminId: systemLog.adminId }).from(systemLog)
        .where(and(eq(systemLog.type, JOURNAL_TYPE), eq(systemLog.path, receiptPath(request_id))))
        .orderBy(desc(systemLog.id)).limit(2);
      if (journal.length) {
        const previous = journal.length === 1 ? journalReceipt(journal[0].action, request_id) : null;
        if (!previous || journal[0].adminId !== actor.id || previous.operation !== operation
          || previous.payload_hash !== payload_hash || (id && previous.id !== id)) {
          throw new ValidateException('请求标识已用于其他签到天数操作');
        }
        return previous;
      }
      // Lock order: request namespace -> the one fixed group row (when it
      // exists) or its unique config_name insertion -> data table. FOR SHARE
      // requires only SELECT plus UPDATE(id), without table-wide group UPDATE.
      // The data-table lock also serializes legacy writers that never acquire
      // our advisory lock, so the seven-row cap cannot race their INSERTs.
      const lockedGroups = await tx.select(groupColumns).from(systemGroup)
        .where(eq(systemGroup.configName, GROUP_NAME)).limit(2).for('share');
      if (lockedGroups.length > 1) throw new ValidateException('签到配置组重复，请先修复');
      const existingGroup = lockedGroups[0];
      let insertedGroup: GroupRow | undefined;
      if (!existingGroup) {
        if (operation !== 'create') throw new NotFoundException('签到天数条目不存在');
        if (canonical.revision !== await collectionRevision(undefined, [])) {
          throw new ValidateException('签到天数列表已变化，请刷新后重试');
        }
        [insertedGroup] = await tx.insert(systemGroup).values({ cateId: 1, name: '签到天数配置', info: '签到天数配置',
          configName: GROUP_NAME, fields: groupFields }).onConflictDoNothing({ target: systemGroup.configName })
          .returning(groupColumns);
        if (!insertedGroup) throw new ValidateException('签到配置组已由其他事务创建，请刷新后重试');
      }
      await tx.execute(sql`LOCK TABLE ${systemGroupData} IN SHARE ROW EXCLUSIVE MODE`);
      const { group, rows } = await groupAndRows(tx);
      if (!group || group.id !== (existingGroup ?? insertedGroup)!.id) {
        throw new ValidateException('签到配置组已变化，请刷新后重试');
      }
      if (operation === 'create') {
        if (insertedGroup ? rows.length !== 0 : canonical.revision !== await collectionRevision(group, rows)) {
          throw new ValidateException('签到天数列表已变化，请刷新后重试');
        }
        if (rows.length >= MAX_ROWS) throw new ValidateException('签到天数配置最多7条（含隐藏），请先删除其他条目');
      } else {
        const row = rows.find(item => item.id === id);
        if (!row) throw new NotFoundException('签到天数条目不存在');
        if (canonical.revision !== await rowRevision(group, row)) throw new ValidateException('签到天数条目已更新，请刷新后重试');
        if (operation === 'status' && statusValue === 1 && decode(row).issues.length) {
          throw new ValidateException('历史签到天数配置无效，请编辑修复后显示');
        }
      }
      let resultId = id;
      if (operation === 'create' || operation === 'update') {
        const fields = canonical as Extract<SignDayCanonicalMutation, { operation: 'create' | 'update' }>;
        const prior = operation === 'update' ? rows.find(item => item.id === id) : undefined;
        const values = { value: savedValue(prior?.value ?? null, fields.day, fields.sign_num), sort: fields.sort, status: fields.status };
        if (operation === 'create') {
          const [created] = await tx.insert(systemGroupData).values({ ...values, gid: group!.id,
            addTime: Math.floor(Date.now() / 1000) }).returning({ id: systemGroupData.id });
          resultId = created.id;
        } else {
          await tx.update(systemGroupData).set(values).where(and(eq(systemGroupData.id, id), eq(systemGroupData.gid, group!.id)));
        }
      } else if (operation === 'status') {
        await tx.update(systemGroupData).set({ status: statusValue! })
          .where(and(eq(systemGroupData.id, id), eq(systemGroupData.gid, group!.id)));
      } else {
        await tx.delete(systemGroupData).where(and(eq(systemGroupData.id, id), eq(systemGroupData.gid, group!.id)));
      }
      const receipt: Receipt = { operation, id: resultId, request_id, payload_hash };
      await tx.insert(systemLog).values({ adminId: actor.id, type: JOURNAL_TYPE, path: receiptPath(request_id),
        page: 'sign_day_num', method: operation === 'create' ? 'POST' : operation === 'delete' ? 'DELETE'
          : operation === 'status' ? 'PATCH' : 'PUT',
        action: `${operation};id=${resultId};payload=${payload_hash}`, addTime: Math.floor(Date.now() / 1000) });
      return receipt;
    });
  }
}
