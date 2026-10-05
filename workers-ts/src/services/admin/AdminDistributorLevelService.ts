import { and, asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { agentLevel, agentLevelTask, agentLevelTaskRecord, systemAttachment, systemConfig, systemLog } from '@/models/schema';
import { AGENT_TASK_TYPES } from '@/services/agent/AgentLevelTaskService';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { parseLevelActivationJson } from './AdminLevelActivationInput';
import { DISTRIBUTOR_CATALOG_LOCK_NAMESPACE, DistributorLevelRejected, DistributorLevelStaleVersion, distributorCanonical, distributorHash, distributorId,
  distributorImage, distributorLevelValues, distributorRequestId, distributorTaskValues, parseDistributorQuery,
  type DistributorLevelValues, type DistributorOperation, type DistributorQuery, type DistributorReceipt,
  type DistributorResource, type DistributorTaskValues } from './AdminDistributorLevelInput';

const MAX_CATALOG_ROWS = 100000;
const CONFIG_KEYS = ['store_brokerage_ratio', 'store_brokerage_two', 'brokerage_func_status'] as const;
const JOURNAL_TYPE = 'distributor_catalog';
const receiptPath = (nonce: string) => `/agent/distributor-catalog/request/${nonce}`;
const levelColumns = { ...getTableColumns(agentLevel), version: sql<string>`xmin::text` };
const taskColumns = { ...getTableColumns(agentLevelTask), version: sql<string>`xmin::text` };
const configColumns = { ...getTableColumns(systemConfig), version: sql<string>`xmin::text` };
type Level = typeof agentLevel.$inferSelect & { version: string };
type Task = typeof agentLevelTask.$inferSelect & { version: string };
type Config = typeof systemConfig.$inferSelect & { version: string };
type Catalog = { levels: Level[]; tasks: Task[]; settings: Config[]; revision: string };
export interface DistributorConfigDto { one_ratio: string | null; two_ratio: string | null; enabled: boolean | null }
export interface DistributorLevelDto {
  id: number; name: string; grade: number; image: string; color: string; one_brokerage: number; two_brokerage: number;
  status: number; is_del: number; add_time: number; task_count: number; one_brokerage_ratio: string | null;
  two_brokerage_ratio: string | null; revision: string; image_preview: string; issues: string[];
}
export interface DistributorTaskDto {
  id: number; level_id: number; name: string; type: number; number: number; desc: string; is_must: number; sort: number;
  status: number; is_del: number; add_time: number; type_name: string; completed: boolean; revision: string; issues: string[];
}
export async function distributorDeadlines(tx: DbClient) {
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
}
async function catalog(tx: DbClient): Promise<Catalog> {
  const levels = await tx.select(levelColumns).from(agentLevel).orderBy(asc(agentLevel.id)).limit(MAX_CATALOG_ROWS + 1);
  const tasks = await tx.select(taskColumns).from(agentLevelTask).orderBy(asc(agentLevelTask.id)).limit(MAX_CATALOG_ROWS + 1);
  const settings = await tx.select(configColumns).from(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...CONFIG_KEYS])))
    .orderBy(asc(systemConfig.sort), asc(systemConfig.id)).limit(1001);
  if (levels.length + tasks.length > MAX_CATALOG_ROWS || settings.length > 1000) throw new ValidateException('分销目录超过完整版本容量，请维护归档后重试');
  return { levels, tasks, settings, revision: await distributorHash({ levels, tasks, settings }) };
}
function scalar(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try { return parseLevelActivationJson(raw); } catch { return raw; }
}
function ratio(raw: unknown): string | null {
  if (!['number', 'string'].includes(typeof raw) || !/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/.test(String(raw))) return null;
  const [whole, fractional = ''] = String(raw).split('.'), amount = BigInt(whole) * 100n + BigInt(fractional.padEnd(2, '0'));
  if (amount > 10000n) return null;
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}
export function distributorCommissionRatio(base: string | null, uplift: number): string | null {
  if (base === null || !Number.isInteger(uplift) || uplift < 0 || uplift > 1000) return null;
  const cents = BigInt(base.replace('.', '')), result = cents * BigInt(100 + uplift) / 100n;
  return `${result / 100n}.${String(result % 100n).padStart(2, '0')}`;
}
function config(c: Catalog): { config: DistributorConfigDto; issues: string[] } {
  const winners = CONFIG_KEYS.map(key => c.settings.filter(row => row.menuName === key).at(-1));
  const one_ratio = ratio(scalar(winners[0]?.value)), two_ratio = ratio(scalar(winners[1]?.value)), enabledValue = scalar(winners[2]?.value);
  const enabled = enabledValue === 1 || enabledValue === '1' ? true : enabledValue === 0 || enabledValue === '0' ? false : null;
  return { config: { one_ratio, two_ratio, enabled }, issues: CONFIG_KEYS.flatMap((key, i) =>
    !winners[i] ? [`config_missing:${key}`] : [one_ratio, two_ratio, enabled][i] === null ? [`config_invalid:${key}`] : []) };
}
function levelValues(row: typeof agentLevel.$inferSelect): DistributorLevelValues {
  return distributorLevelValues({ name: row.name, grade: row.grade, image: row.image, color: row.color,
    one_brokerage: row.oneBrokerage, two_brokerage: row.twoBrokerage, status: row.status });
}
function taskValues(row: typeof agentLevelTask.$inferSelect): DistributorTaskValues {
  return distributorTaskValues({ level_id: row.levelId, name: row.name, type: row.type, number: row.number, desc: row.desc, sort: row.sort, status: row.status });
}
type GraphLevel = Pick<typeof agentLevel.$inferSelect, 'id' | 'grade' | 'status' | 'isDel'>;
type GraphTask = Pick<typeof agentLevelTask.$inferSelect, 'id' | 'levelId' | 'type' | 'number' | 'status' | 'isDel'>;
/** Whole active parent graph, matching the legacy active parent + active task filter. is_must does not introduce OR semantics. */
export function distributorGraphIssues(levels: readonly GraphLevel[], tasks: readonly GraphTask[]): string[] {
  const issues = new Set<string>(), live = levels.filter(row => row.isDel === 0), active = new Map(live.filter(row => row.status === 1).map(row => [row.id, row]));
  const grades = new Set<number>(), parentIds = new Set(live.map(row => row.id)), types = new Set<string>();
  for (const row of live) {
    if (!Number.isInteger(row.grade) || row.grade <= 0 || row.grade > 32767) issues.add(`invalid_grade:${row.id}`);
    if (grades.has(row.grade)) issues.add(`duplicate_grade:${row.grade}`); grades.add(row.grade);
  }
  const liveTasks = tasks.filter(row => row.isDel === 0);
  for (const task of liveTasks) {
    if (!parentIds.has(task.levelId)) issues.add(`orphan_task:${task.id}`);
    const key = `${task.levelId}:${task.type}`;
    if (types.has(key)) issues.add(`duplicate_type:${key}`); types.add(key);
  }
  const effective = liveTasks.filter(row => row.status === 1 && active.has(row.levelId)).sort((a, b) => a.type - b.type || active.get(a.levelId)!.grade - active.get(b.levelId)!.grade || a.id - b.id);
  const maxima = new Map<number, { grade: number; maximum: number; priorMaximum: number }>();
  for (const task of effective) {
    if (![1, 2, 3, 4, 5].includes(task.type) || !Number.isInteger(task.number) || task.number <= 0) issues.add(`invalid_active_task:${task.id}`);
    const grade = active.get(task.levelId)!.grade, previous = maxima.get(task.type);
    const priorMaximum = previous ? grade === previous.grade ? previous.priorMaximum : previous.maximum : -Infinity;
    if (priorMaximum >= task.number) issues.add(`non_monotonic_type:${task.type}`);
    maxima.set(task.type, { grade, maximum: Math.max(previous?.maximum ?? -Infinity, task.number), priorMaximum });
  }
  return [...issues].sort();
}
function requireGraph(c: Pick<Catalog, 'levels' | 'tasks'>) {
  if (distributorGraphIssues(c.levels, c.tasks).length) throw new ValidateException('分销目录存在重复等级、任务类型或非递增任务要求，请先隐藏或修复相关记录');
}
function parent(c: Catalog, id: number) {
  const row = c.levels.find(row => row.id === id && row.isDel === 0); if (!row) throw new NotFoundException('分销等级不存在');
  return { id: row.id, name: row.name, grade: row.grade, status: row.status, revision: c.revision };
}
function matching(row: { name: string; status: number; isDel: number }, query: DistributorQuery) {
  return row.isDel === 0 && (query.status === undefined || row.status === query.status) && row.name.toLocaleLowerCase().includes(query.keyword.toLocaleLowerCase());
}
async function completed(tx: DbClient, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await tx.selectDistinct({ id: agentLevelTaskRecord.taskId }).from(agentLevelTaskRecord).where(inArray(agentLevelTaskRecord.taskId, ids));
  return new Set(rows.map(row => row.id));
}
function receiptFrom(action: string, nonce: string): DistributorReceipt | null {
  const match = /^(level|task):(create|update|status|delete);id=([1-9]\d*);payload=([a-f0-9]{64})$/.exec(action);
  if (!match || Number(match[3]) > 2147483647) return null;
  return { operation: `${match[1]}:${match[2]}` as DistributorOperation, id: Number(match[3]), request_id: nonce, payload_hash: match[4] };
}
export class AdminDistributorLevelService {
  constructor(private readonly container: Container, private readonly env: Pick<Env, 'APP_KEY'>) {}
  private async read<T>(fn: (tx: DbClient, c: Catalog) => Promise<T>) {
    return withTx(this.container, async tx => { await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await distributorDeadlines(tx); return fn(tx, await catalog(tx)); });
  }
  private async levelDtos(tx: DbClient, c: Catalog, rows: Level[]): Promise<DistributorLevelDto[]> {
    const { config: bases } = config(c);
    const images = rows.map(row => { try { return distributorImage(row.image); } catch { return ''; } });
    const previews = await publicProductPictures(tx, images.map(image => ({ image, type: 0, relationId: 0 })));
    return rows.map((row, i) => {
      const issues: string[] = []; try { levelValues(row); } catch { issues.push('invalid_legacy_level'); }
      if (!previews[i]) issues.push('image_unavailable');
      if (c.levels.some(peer => peer.id !== row.id && peer.isDel === 0 && peer.grade === row.grade)) issues.push('duplicate_grade');
      return { id: row.id, name: row.name, grade: row.grade, image: row.image, color: row.color, one_brokerage: row.oneBrokerage,
        two_brokerage: row.twoBrokerage, status: row.status, is_del: row.isDel, add_time: row.addTime,
        task_count: c.tasks.filter(task => task.levelId === row.id && task.isDel === 0).length,
        one_brokerage_ratio: distributorCommissionRatio(bases.one_ratio, row.oneBrokerage), two_brokerage_ratio: distributorCommissionRatio(bases.two_ratio, row.twoBrokerage),
        revision: c.revision, image_preview: previews[i], issues };
    });
  }
  private async render(rows: DistributorLevelDto[]) {
    const previews = await renderProductPictures(this.env.APP_KEY, rows.map(row => row.image_preview));
    return rows.map((row, i) => ({ ...row, image_preview: previews[i] }));
  }
  private async taskDtos(tx: DbClient, c: Catalog, rows: Task[]): Promise<DistributorTaskDto[]> {
    const evidence = await completed(tx, rows.map(row => row.id));
    return rows.map(row => {
      const issues: string[] = []; try { taskValues(row); } catch { issues.push('invalid_legacy_task'); }
      if (row.isMust !== 0) issues.push('legacy_is_must');
      if (c.tasks.some(peer => peer.id !== row.id && peer.isDel === 0 && peer.levelId === row.levelId && peer.type === row.type)) issues.push('duplicate_type');
      return { id: row.id, level_id: row.levelId, name: row.name, type: row.type, number: row.number, desc: row.desc, is_must: row.isMust,
        sort: row.sort, status: row.status, is_del: row.isDel, add_time: row.addTime,
        type_name: AGENT_TASK_TYPES.find(type => type.type === row.type)?.name ?? '未知历史类型', completed: evidence.has(row.id), revision: c.revision, issues };
    });
  }
  async levelsList(value: DistributorQuery | URLSearchParams | Record<string, unknown>) {
    const query = 'offset' in value ? value as DistributorQuery : parseDistributorQuery(value);
    const result = await this.read(async (tx, c) => {
      const rows = c.levels.filter(row => matching(row, query)).sort((a, b) => a.grade - b.grade || b.id - a.id);
      return { list: await this.levelDtos(tx, c, rows.slice(query.offset, query.offset + query.limit)), count: rows.length, page: query.page, limit: query.limit,
        revision: c.revision, ...config(c), issues: [...config(c).issues, ...distributorGraphIssues(c.levels, c.tasks)] };
    });
    return { ...result, list: await this.render(result.list) };
  }
  async levelsDetail(value: unknown) {
    const id = distributorId(value), result = await this.read(async (tx, c) => {
      const row = c.levels.find(row => row.id === id && row.isDel === 0); if (!row) throw new NotFoundException('分销等级不存在');
      return { info: (await this.levelDtos(tx, c, [row]))[0], ...config(c) };
    });
    return { ...result, info: (await this.render([result.info]))[0] };
  }
  async tasksList(value: DistributorQuery | URLSearchParams | Record<string, unknown>) {
    const query = 'offset' in value ? value as DistributorQuery : parseDistributorQuery(value, true);
    return this.read(async (tx, c) => {
      const selected = parent(c, query.level_id!), rows = c.tasks.filter(row => row.levelId === selected.id && matching(row, query)).sort((a, b) => b.sort - a.sort || b.id - a.id);
      return { parent: selected, list: await this.taskDtos(tx, c, rows.slice(query.offset, query.offset + query.limit)), count: rows.length,
        page: query.page, limit: query.limit, revision: c.revision, task_types: AGENT_TASK_TYPES, issues: distributorGraphIssues(c.levels, c.tasks) };
    });
  }
  async tasksDetail(value: unknown) {
    const id = distributorId(value);
    return this.read(async (tx, c) => {
      const row = c.tasks.find(row => row.id === id && row.isDel === 0); if (!row) throw new NotFoundException('分销等级任务不存在');
      return { info: (await this.taskDtos(tx, c, [row]))[0], parent: parent(c, row.levelId), task_types: AGENT_TASK_TYPES, issues: distributorGraphIssues(c.levels, c.tasks) };
    });
  }
  async tasksParents(value: DistributorQuery | URLSearchParams | Record<string, unknown>) {
    const query = 'offset' in value ? value as DistributorQuery : parseDistributorQuery(value);
    return this.read(async (_tx, c) => {
      const rows = c.levels.filter(row => matching(row, query)).sort((a, b) => a.grade - b.grade || a.id - b.id);
      return { list: rows.slice(query.offset, query.offset + query.limit).map(row => parent(c, row.id)), count: rows.length,
        page: query.page, limit: query.limit, revision: c.revision, issues: distributorGraphIssues(c.levels, c.tasks) };
    });
  }
  async receipt(resource: DistributorResource, value: unknown, actor: { id: number }): Promise<DistributorReceipt> {
    const nonce = distributorRequestId(value), actorId = distributorId(actor?.id);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await distributorDeadlines(tx);
      const rows = await tx.select({ action: systemLog.action }).from(systemLog).where(and(eq(systemLog.type, JOURNAL_TYPE), eq(systemLog.path, receiptPath(nonce)), eq(systemLog.adminId, actorId))).limit(2);
      if (!rows.length) throw new NotFoundException('分销操作回执不存在');
      const result = rows.length === 1 ? receiptFrom(rows[0].action, nonce) : null;
      if (!result) throw new ValidateException('分销回执异常，无法确认结果');
      if (!result.operation.startsWith(`${resource}:`)) throw new NotFoundException('此分销资源的回执不存在');
      return result;
    });
  }
  async mutate(operation: DistributorOperation, value: unknown, raw: unknown, actor: { id: number }): Promise<DistributorReceipt> {
    const actorId = distributorId(actor?.id), { request_id, canonical } = distributorCanonical(operation, value, raw), payload_hash = await distributorHash(canonical);
    const [resource, action] = operation.split(':');
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`); await distributorDeadlines(tx);
      // Runtime legacy/raw catalogue writers take this fence in BEFORE STATEMENT
      // triggers. Do not add a conflicting table lock after taking this fence.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${DISTRIBUTOR_CATALOG_LOCK_NAMESPACE},0)`);
      const journals = await tx.select({ action: systemLog.action, actor: systemLog.adminId }).from(systemLog)
        .where(and(eq(systemLog.type, JOURNAL_TYPE), eq(systemLog.path, receiptPath(request_id)))).limit(2);
      if (journals.length) {
        const previous = journals.length === 1 ? receiptFrom(journals[0].action, request_id) : null;
        if (!previous || journals[0].actor !== actorId || previous.operation !== operation || previous.payload_hash !== payload_hash
          || (canonical.id !== 0 && previous.id !== canonical.id)) throw new ValidateException('请求标识已用于其他分销操作');
        return previous;
      }
      const c = await catalog(tx);
      // This is the only deterministic stale proof, before business DML.
      // withTx awaits rollback before the controller emits HTTP 409.
      if (canonical.revision !== c.revision) throw new DistributorLevelStaleVersion(operation, request_id, payload_hash);
      const currentLevel = resource === 'level' ? c.levels.find(row => row.id === canonical.id && row.isDel === 0) : undefined;
      const currentTask = resource === 'task' ? c.tasks.find(row => row.id === canonical.id && row.isDel === 0) : undefined;
      if (action !== 'create' && !(currentLevel || currentTask)) throw new NotFoundException('分销等级或任务不存在');
      if (currentLevel) await tx.select({ id: agentLevel.id }).from(agentLevel).where(eq(agentLevel.id, currentLevel.id)).for('update');
      if (currentTask) {
        const hasParent = c.levels.some(row => row.id === currentTask.levelId && row.isDel === 0);
        // A confirmed orphan may only be retired. Updating/hiding it still
        // requires its actual undeleted parent; no reassignment is invented.
        if (!hasParent && action !== 'delete') parent(c, currentTask.levelId);
        if (hasParent) await tx.select({ id: agentLevel.id }).from(agentLevel).where(eq(agentLevel.id, currentTask.levelId)).for('update');
        await tx.select({ id: agentLevelTask.id }).from(agentLevelTask).where(eq(agentLevelTask.id, currentTask.id)).for('update');
      }
      const levelInput = resource === 'level' && 'values' in canonical ? canonical.values as DistributorLevelValues : undefined;
      const taskInput = resource === 'task' && 'values' in canonical ? canonical.values as DistributorTaskValues : undefined;
      const status = 'status' in canonical ? canonical.status : levelInput?.status ?? taskInput?.status;
      // This bounded preparation phase is the only rejected-intent proof.
      // No successful journal existed, CAS matched, and no business DML has
      // executed. SQL/NotFound errors and the later write phase never become
      // this proof, even when their transaction ultimately rolls back.
      try {
        if (resource === 'level' && (levelInput || status === 1)) {
          const values = levelInput ?? levelValues(currentLevel!);
          if (c.levels.some(row => row.id !== canonical.id && row.isDel === 0 && row.grade === values.grade)) throw new ValidateException('该分销等级已存在');
          const id = canonical.id || -1;
          const projected = { ...(currentLevel ?? { id, isDel: 0 }), grade: values.grade, status: status ?? values.status } as Level;
          if (action === 'create' || values.grade !== currentLevel?.grade || status === 1) requireGraph({ levels: [...c.levels.filter(row => row.id !== id), projected], tasks: c.tasks });
          await this.validateImage(tx, values.image);
        }
        if (resource === 'task') {
          if (taskInput && currentTask && taskInput.level_id !== currentTask.levelId) throw new ValidateException('不能移动已存在任务的所属等级');
          if (taskInput || status === 1) {
            const values = taskInput ?? taskValues(currentTask!); parent(c, values.level_id);
            if (currentTask && (currentTask.type !== values.type || currentTask.number !== values.number) && (await completed(tx, [currentTask.id])).has(currentTask.id)) throw new ValidateException('已有用户完成该任务，不能修改任务类型或要求');
            if (c.tasks.some(row => row.id !== canonical.id && row.isDel === 0 && row.levelId === values.level_id && row.type === values.type)) throw new ValidateException('该等级已存在此类型任务');
            const id = canonical.id || -1;
            const projected = { ...(currentTask ?? { id, isDel: 0 }), levelId: values.level_id, type: values.type, number: values.number, status: status ?? values.status } as Task;
            if (action === 'create' || status === 1 || (currentTask && (currentTask.type !== values.type || currentTask.number !== values.number))) requireGraph({ levels: c.levels, tasks: [...c.tasks.filter(row => row.id !== id), projected] });
          }
        }
      } catch (error) {
        if (error instanceof ValidateException && error.constructor === ValidateException) throw new DistributorLevelRejected(error.message, operation, request_id, payload_hash);
        throw error;
      }
      let resultId = canonical.id;
      if (resource === 'level') {
        if (action === 'create' || action === 'update') {
          const v = levelInput!, values = { name: v.name, grade: v.grade, image: v.image, color: v.color, oneBrokerage: v.one_brokerage, twoBrokerage: v.two_brokerage, status: v.status };
          if (action === 'create') { const [created] = await tx.insert(agentLevel).values({ ...values, addTime: Math.floor(Date.now() / 1000) }).returning({ id: agentLevel.id }); resultId = created.id; }
          else await tx.update(agentLevel).set(values).where(eq(agentLevel.id, canonical.id));
        } else if (action === 'status') await tx.update(agentLevel).set({ status: status! }).where(eq(agentLevel.id, canonical.id));
        else {
          await tx.update(agentLevel).set({ isDel: 1 }).where(eq(agentLevel.id, canonical.id));
          await tx.update(agentLevelTask).set({ isDel: 1 }).where(and(eq(agentLevelTask.levelId, canonical.id), eq(agentLevelTask.isDel, 0)));
        }
      } else {
        if (action === 'create' || action === 'update') {
          const v = taskInput!, values = { name: v.name, type: v.type, number: v.number, desc: v.desc, sort: v.sort, status: v.status };
          if (action === 'create') { const [created] = await tx.insert(agentLevelTask).values({ ...values, levelId: v.level_id, isMust: 0, addTime: Math.floor(Date.now() / 1000) }).returning({ id: agentLevelTask.id }); resultId = created.id; }
          else await tx.update(agentLevelTask).set(values).where(eq(agentLevelTask.id, canonical.id));
        } else if (action === 'status') await tx.update(agentLevelTask).set({ status: status! }).where(eq(agentLevelTask.id, canonical.id));
        else await tx.update(agentLevelTask).set({ isDel: 1 }).where(eq(agentLevelTask.id, canonical.id));
      }
      await tx.insert(systemLog).values({ adminId: actorId, type: JOURNAL_TYPE, path: receiptPath(request_id), page: 'agent_level_catalog',
        method: action === 'create' ? 'POST' : action === 'delete' ? 'DELETE' : action === 'status' ? 'PATCH' : 'PUT',
        action: `${operation};id=${resultId};payload=${payload_hash}`, addTime: Math.floor(Date.now() / 1000) });
      return { operation, id: resultId, request_id, payload_hash };
    });
  }
  private async validateImage(tx: DbClient, image: string) {
    const id = parseCanonicalAttachmentId(image);
    if (id !== null) await tx.select({ id: systemAttachment.attId }).from(systemAttachment).where(eq(systemAttachment.attId, id)).for('share');
    const [valid] = await publicProductPictures(tx, [{ image, type: 0, relationId: 0 }]);
    if (valid !== image) throw new ValidateException('等级背景图不可用或不属于平台');
  }
}
