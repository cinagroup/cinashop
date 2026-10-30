import { and, asc, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemConfig, systemConfigTab, systemLog } from '@/models/schema';
import { HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { acquireAdminAuthorityWriteBarrier, assertAdminAuthoritySession, loadAdminAuthorityLiveActor, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { authorizeAdminLegacyProductRead, assertAdminLegacyProductReadDeadline } from './AdminLegacyProductReadAuthority';
import { SystemMetadataService } from '@/services/system/SystemMetadataService';
import { CONFIG_CLASS_HASH, ConfigClassNotApplied, configClassBody, configClassCanonical, configClassHash, configClassInteger, configClassQuery, configClassRequestId, configClassValues,
  type ConfigClassOperation, type ConfigClassReceipt, type ConfigClassRow } from './AdminConfigClassInput';

export const CONFIG_CLASS_LOCK_NAMESPACE = 731622;
export const CONFIG_CLASS_LOG_TYPE = 'config_class_author';
const CAPACITY = 5000;
const columns = { ...getTableColumns(systemConfigTab), version: sql<string>`xmin::text` };
type Stored = typeof systemConfigTab.$inferSelect & { version: string };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const method = (op: ConfigClassOperation) => op === 'create' ? 'POST' : op === 'delete' ? 'DELETE' : 'PUT';
const path = (request: string) => `config_class/request/${request}`;
function project(row: Stored): ConfigClassRow {
  return { id: row.id, is_store: row.isStore, pid: row.pid, title: row.title, eng_title: row.engTitle,
    status: row.status, info: row.info, icon: row.icon, type: row.type, sort: row.sort };
}
function ordered(rows: ConfigClassRow[]) { return [...rows].sort((a, b) => b.sort - a.sort || a.id - b.id); }
function databaseError(error: unknown): never {
  let cause: unknown = error;
  for (let i = 0; i < 6 && cause && typeof cause === 'object'; i++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw new HttpApiException('配置分类或权限正在更新，请重新读取', 409, 409);
    if (['42501', '57014'].includes(code)) throw new ServiceUnavailableException('配置分类运行权限未就绪或操作超时');
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

/** Configuration navigation metadata only. No system_config value is read or
 * written. Existing SystemMetadataService form contracts remain independent. */
export class AdminConfigClassService {
  constructor(private readonly container: Container) {}
  private async transaction<T>(actor: AdminAuthorityActor, write: boolean, work: (tx: DbClient) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try { return await withTx(this.container, async tx => {
      if (write) {
        await acquireAdminAuthorityWriteBarrier(tx);
        await loadAdminAuthorityLiveActor(tx, actor, 'config.manage');
      } else {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
        await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
        await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
        await authorizeAdminLegacyProductRead(tx, actor, 'config.view');
      }
      const result = await work(tx);
      await assertAdminLegacyProductReadDeadline(tx, actor);
      if (write) await loadAdminAuthorityLiveActor(tx, actor, 'config.manage');
      return result;
    }); } catch (error) { return databaseError(error); }
  }
  private async source(tx: DbClient) {
    const rows = await tx.select(columns).from(systemConfigTab).orderBy(desc(systemConfigTab.sort), asc(systemConfigTab.id)).limit(CAPACITY + 1);
    if (rows.length > CAPACITY) throw new ServiceUnavailableException('配置分类超过5000项，不能截断目录');
    return { rows, list: rows.map(project), revision: configClassHash({ domain: 'config-class-v1', rows: [...rows].sort((a, b) => a.id - b.id) }) };
  }
  catalog(query: URLSearchParams, actor: AdminAuthorityActor) {
    configClassQuery(query, []);
    return this.transaction(actor, false, async tx => { const s = await this.source(tx); return { list: s.list, count: s.list.length, revision: s.revision }; });
  }
  detail(idValue: unknown, query: URLSearchParams, actor: AdminAuthorityActor) {
    configClassQuery(query, []); const id = configClassInteger(idValue, '配置分类ID');
    return this.transaction(actor, false, async tx => { const s = await this.source(tx), info = s.list.find(row => row.id === id); if (!info) throw new NotFoundException('配置分类不存在'); return { info, revision: s.revision }; });
  }
  list(query: URLSearchParams, actor: AdminAuthorityActor) {
    const q = configClassQuery(query, ['page', 'limit', 'status', 'is_store', 'title']);
    if (q.title !== undefined && ([...q.title].length > 255 || /[\u0000-\u001f\u007f]/u.test(q.title))) throw new ValidateException('分类查询名称无效');
    // This existing read method does not open a transaction. Reuse its exact
    // ILIKE, SQL pagination, ordering and post-page tree semantics on this tx.
    return this.transaction(actor, false, tx => new SystemMetadataService(createContainerFromDb(tx)).configTabList(q));
  }
  form(idValue: unknown, query: URLSearchParams, actor: AdminAuthorityActor) {
    const q = configClassQuery(query, ['is_store']), id = configClassInteger(idValue, '配置分类ID', true);
    const scope = q.is_store === undefined || q.is_store === '' ? null : configClassInteger(q.is_store, '配置类型', true, 1);
    return this.transaction(actor, false, async tx => {
      const s = await this.source(tx), row = id ? s.list.find(item => item.id === id) : undefined;
      if (id && !row) throw new NotFoundException('配置分类不存在');
      const isStore = row?.is_store ?? scope ?? 0;
      const options = s.list.filter(item => item.is_store === isStore).map(item => ({ value: item.id, label: item.title, pid: item.pid }));
      // The complete flat catalogue remains available for historical repairs.
      // The legacy nested form rejects bad/deep graphs explicitly; it must not
      // recurse, drop nodes or overflow JSON serialization on a 5000-node chain.
      const byId = new Map(options.map(item => [item.value, item])), depth = new Map<number, number>([[0, 0]]);
      for (const item of options) {
        let current = item.value; const trail: number[] = [], seen = new Set<number>();
        while (!depth.has(current)) {
          if (seen.has(current)) throw new ServiceUnavailableException('父级目录存在循环，动态表单不能截断，请读取完整目录修复');
          seen.add(current); const node = byId.get(current);
          if (!node) throw new ServiceUnavailableException('父级目录缺失或跨范围，动态表单不能截断，请读取完整目录修复');
          trail.push(current); current = node.pid;
        }
        let value = depth.get(current)!;
        for (let i = trail.length - 1; i >= 0; i--) {
          value++; if (value > 128) throw new ServiceUnavailableException('父级目录超过128层，动态表单不能截断，请读取完整平面目录');
          depth.set(trail[i], value);
        }
      }
      const descendants = new Set<number>(id ? [id] : []); let changed = true;
      while (changed) { changed = false; for (const item of s.list) if (descendants.has(item.pid) && !descendants.has(item.id)) { descendants.add(item.id); changed = true; } }
      const valid = options.filter(item => !descendants.has(item.value));
      type ParentOption = { value: number; label: string; children: ParentOption[] };
      const nodes = new Map<number, ParentOption>(valid.map(item => [item.value, { value: item.value, label: item.label, children: [] }]));
      const roots: ParentOption[] = [];
      for (const item of valid) { const option = nodes.get(item.value)!, parent = nodes.get(item.pid); if (parent) parent.children.push(option); else roots.push(option); }
      return { title: id ? '编辑配置分类' : '添加配置分类', action: `setting/config_class${id ? `/${id}` : ''}`, method: id ? 'PUT' : 'POST', status: true,
        rules: [
          { type: 'radio', field: 'is_store', title: '类型', value: isStore, options: [{ value: 0, label: '总后台' }, { value: 1, label: '门店后台' }] },
          { type: 'cascader', field: 'pid', title: '父级分类', value: [row?.pid ?? 0], props: { changeOnSelect: true }, data: [{ value: 0, label: '顶级按钮' }, ...roots] },
          { type: 'input', field: 'title', title: '分类名称', value: row?.title ?? '' },
          { type: 'input', field: 'eng_title', title: '分类字段英文', value: row?.eng_title ?? '' },
          { type: 'input', field: 'icon', title: '图标', value: row?.icon ?? '', props: { maxlength: 30 } },
          { type: 'radio', field: 'type', title: '类型', value: row?.type ?? 0, options: [{ value: 0, label: '系统' }, { value: 3, label: '其它' }] },
          { type: 'radio', field: 'status', title: '状态', value: row?.status ?? 1, options: [{ value: 1, label: '显示' }, { value: 2, label: '隐藏' }] },
          { type: 'inputNumber', field: 'sort', title: '排序', value: row?.sort ?? 0, props: { min: 0 } },
        ] };
    });
  }
  private parsedReceipt(row: typeof systemLog.$inferSelect, request: string | null): ConfigClassReceipt {
    let value: unknown; try { value = JSON.parse(row.action); } catch { throw new ServiceUnavailableException('配置分类回执格式异常'); }
    if (!Array.isArray(value) || value.length !== 4 || !['create', 'update', 'status', 'delete'].includes(value[0]) || !Number.isSafeInteger(value[1]) || value[1] < 1 || value[1] > 2147483647 || typeof value[2] !== 'string' || !CONFIG_CLASS_HASH.test(value[2]) || typeof value[3] !== 'string' || !CONFIG_CLASS_HASH.test(value[3]) || row.page !== CONFIG_CLASS_LOG_TYPE || row.method !== method(value[0]) || row.storeId !== 0 || row.merchantId !== 0) throw new ServiceUnavailableException('配置分类回执内容异常');
    return { operation: value[0], request_id: request, actor_id: row.adminId, id: value[1], payload_hash: value[2], revision: value[3], verified: true };
  }
  receipt(value: unknown, query: URLSearchParams, actor: AdminAuthorityActor) {
    configClassQuery(query, []); const request = configClassRequestId(value);
    return this.transaction(actor, false, async tx => {
      const rows = await tx.select().from(systemLog).where(and(eq(systemLog.type, CONFIG_CLASS_LOG_TYPE), eq(systemLog.path, path(request)), eq(systemLog.adminId, actor.id))).limit(2);
      if (!rows.length) throw new NotFoundException('配置分类请求回执不存在');
      if (rows.length !== 1) throw new ServiceUnavailableException('配置分类请求回执重复');
      return this.parsedReceipt(rows[0], request);
    });
  }
  mutate(operation: ConfigClassOperation, idValue: unknown, input: unknown, actor: AdminAuthorityActor, statusValue?: unknown) {
    const id = operation === 'create' ? 0 : configClassInteger(idValue, '配置分类ID'), { body, intent } = configClassBody(input, operation, id);
    const status = operation === 'status' ? configClassInteger(statusValue, '显示状态', true, 1) : null;
    if (status !== null && body.status !== undefined && configClassInteger(body.status, '正文显示状态', true, 1) !== status) throw new ValidateException('路径和正文显示状态不一致');
    let rejection: { error: Error; status: 400 | 409; payloadHash: string } | null = null;
    return this.transaction(actor, true, async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CONFIG_CLASS_LOCK_NAMESPACE},0)`);
      // The table fence also protects references inserted by existing config
      // writers which do not participate in this metadata advisory namespace.
      await tx.execute(sql`LOCK TABLE ${systemConfigTab} IN SHARE ROW EXCLUSIVE MODE`);
      await tx.execute(sql`LOCK TABLE ${systemConfig} IN SHARE ROW EXCLUSIVE MODE`);
      const before = await this.source(tx), prior = id ? before.list.find(row => row.id === id) : undefined;
      // Replaying a delete must work after its row has disappeared. Readonly
      // historical info is carried in new author requests and hashes identically.
      const values = operation === 'create' || operation === 'update' ? configClassValues(body, intent.request_id && operation === 'update' ? { info: configClassInteger(body.info, '历史显示元数据', true, 255) } as ConfigClassRow : prior, !intent.request_id) : null;
      const payloadHash = configClassHash(configClassCanonical(operation, id, intent, values, status));
      const refuse = (error: Error): never => {
        if (intent.request_id) rejection = { error, status: error instanceof HttpApiException && error.httpStatus === 409 ? 409 : 400, payloadHash };
        throw error;
      };
      if (intent.request_id) {
        const journals = await tx.select().from(systemLog).where(and(eq(systemLog.type, CONFIG_CLASS_LOG_TYPE), eq(systemLog.path, path(intent.request_id)))).limit(2);
        if (journals.length) {
          const previous = journals.length === 1 ? this.parsedReceipt(journals[0], intent.request_id) : null;
          if (!previous || previous.actor_id !== actor.id || previous.operation !== operation || operation !== 'create' && previous.id !== id || previous.payload_hash !== payloadHash) throw new HttpApiException('请求标识已用于其他配置分类操作', 409, 409);
          return previous;
        }
      }
      if (intent.expected_revision !== null && intent.expected_revision !== before.revision) refuse(new HttpApiException('配置分类版本已变化，请重新读取并确认', 409, 409));
      if (id && !prior) refuse(new NotFoundException('配置分类不存在'));
      if (values && prior && values.info !== prior.info) refuse(new ValidateException('历史显示元数据不可修改'));
      if (values && intent.request_id) {
        if (![1, 2].includes(values.status) && (!prior || values.status !== prior.status)) refuse(new ValidateException('新状态须为原PHP表单选项1或2，历史值只能原样保留'));
        if (![0, 3].includes(values.type) && (!prior || values.type !== prior.type)) refuse(new ValidateException('新类型须为原PHP表单选项0或3，历史值只能原样保留'));
      }
      if (values) {
        const sameScope = before.list.filter(row => row.is_store === values.is_store), byId = new Map(sameScope.map(row => [row.id, row]));
        if (values.pid && !byId.has(values.pid)) refuse(new ValidateException('父级配置分类不存在或不在同一范围'));
        let parent = values.pid; const seen = new Set<number>();
        while (parent) { if (parent === id || seen.has(parent)) refuse(new ValidateException('配置分类层级形成循环')); seen.add(parent); const p = byId.get(parent); if (!p) refuse(new ValidateException('父级配置分类链缺失或跨范围')); parent = p!.pid; }
        if (sameScope.some(row => row.id !== id && row.eng_title === values.eng_title)) refuse(new ValidateException('该分类字段已经存在'));
      }
      const referenced = async () => (await tx.select({ id: systemConfig.id }).from(systemConfig).where(eq(systemConfig.configTabId, id)).limit(1)).length > 0;
      const hasChildren = !!id && before.list.some(row => row.pid === id);
      if (operation === 'delete' && (hasChildren || await referenced())) refuse(new ValidateException('配置分类仍有下级分类或配置项，不能删除'));
      if (values && prior && values.is_store !== prior.is_store && (hasChildren || await referenced())) refuse(new ValidateException('已有子类或配置引用，不能变更配置分类范围'));
      let savedId = id;
      if (values) {
        const data = { isStore: values.is_store, pid: values.pid, title: values.title, engTitle: values.eng_title, status: values.status, icon: values.icon, type: values.type, sort: values.sort };
        if (operation === 'create') {
          if (before.list.length >= CAPACITY) refuse(new HttpApiException('配置分类达到5000项容量，请编辑现有分类或删除无引用分类后再添加', 409, 409));
          const [row] = await tx.insert(systemConfigTab).values({ ...data, info: 0 }).returning({ id: systemConfigTab.id });
          if (!row || !Number.isSafeInteger(row.id) || row.id <= 0) throw Error('配置分类新增回执不完整'); savedId = row.id;
        } else await tx.update(systemConfigTab).set(data).where(eq(systemConfigTab.id, id));
      } else if (operation === 'status') await tx.update(systemConfigTab).set({ status: status! }).where(eq(systemConfigTab.id, id));
      else await tx.delete(systemConfigTab).where(eq(systemConfigTab.id, id));
      const after = await this.source(tx), expected = before.list.filter(row => operation !== 'delete' || row.id !== id).map(row => row.id === id && values ? { id, ...values } : row.id === id && status !== null ? { ...row, status } : row);
      if (operation === 'create') expected.push({ id: savedId, ...values! });
      if (!same(ordered(expected), after.list)) throw Error('配置分类写入后的完整回读不一致');
      const logPath = intent.request_id ? path(intent.request_id) : `config_class/legacy/${crypto.randomUUID()}`;
      const action = JSON.stringify([operation, savedId, payloadHash, after.revision]);
      const logs = await tx.insert(systemLog).values({ adminId: actor.id, type: CONFIG_CLASS_LOG_TYPE, path: logPath, page: CONFIG_CLASS_LOG_TYPE, method: method(operation), action, addTime: Math.floor(Date.now() / 1000) }).returning();
      if (logs.length !== 1 || logs[0].id <= 0 || logs[0].adminId !== actor.id || logs[0].action !== action || logs[0].path !== logPath || logs[0].type !== CONFIG_CLASS_LOG_TYPE) throw Error('配置分类审计回执不完整');
      return this.parsedReceipt(logs[0], intent.request_id);
    }).catch(error => {
      // A transport/commit/rollback error is never a negative receipt. Only the
      // exact business refusal propagated after a completed rollback qualifies.
      if (rejection && error === rejection.error && intent.request_id) throw new ConfigClassNotApplied(error.message, rejection.status, {
        code: 'CONFIG_CLASS_NOT_APPLIED', operation, id, request_id: intent.request_id, payload_hash: rejection.payloadHash,
      });
      throw error;
    });
  }
}
