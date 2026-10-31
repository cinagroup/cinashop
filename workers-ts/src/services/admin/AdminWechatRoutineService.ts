import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { acquireAdminAuthorityMenuLock, inspectAdminAuthorityMenuLock, inspectAdminAuthorityOperation } from '@/migrations/adminAuthorityOperation';
import { assertAdminWechatRoutineOperationReady } from '@/migrations/adminWechatRoutineOperation';
import { ADMIN_WECHAT_ROUTINE_SOURCE_SQL } from '@/migrations/adminWechatRoutineWriteCapability';
import { inspectAdminWechatRoutineWriteCatalog } from '@/migrations/adminWechatRoutineWriteCatalog';
import { ApiException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { acquireAdminAuthorityWriteBarrier, adminAuthorityWriteError, assertAdminAuthoritySession,
  loadAdminAuthorityLiveActor, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { loadAdminProfileActor } from './AdminProfileService';
import { authorizeAdminLegacyProductRead, assertAdminLegacyProductReadDeadline } from './AdminLegacyProductReadAuthority';
import { wechatRoutineWinningRows } from './AdminWechatRoutineIntentPlan';
import { parseWechatRoutinePrivateReceipt, wechatRoutineActorBinding, wechatRoutineReceiptDto,
  wechatRoutineSourceRevision, wechatRoutineSqlFields, type WechatRoutinePrivateReceipt } from './AdminWechatRoutineWriteProtocol';
import { WECHAT_ROUTINE_KEYS, parseWechatRoutineSave, parseWechatRoutineStoredText, parseWechatRoutineStoredRadio,
  wechatRoutineRequestId, wechatRoutineRevision, type WechatRoutineReceipt, type WechatRoutineSave,
  type WechatRoutineSnapshot } from '../../../../view/common/wechatRoutine';

type SourceRow = { id: number; menu_name: string; is_store: number; sort: number; value: string | null; version: string };
type Source = { rows: SourceRow[]; source: string; binding: string; revision: string };
const conflict = (message: string) => new HttpApiException(message, 409, 409);
const requestId = (value: unknown): string => {
  if (!wechatRoutineRequestId(value)) throw new ValidateException('小程序配置请求标识须为小写UUIDv4');
  return value;
};

/** Five-key authenticated author. The caller transaction owns live authority,
 * keyed CAS and expiry; the commissioned SQL capability alone owns writes and
 * immutable evidence. Account adoption/switching still requires its separate
 * ownership maintenance and is refused by SQL until that is commissioned. */
export class AdminWechatRoutineService {
  constructor(private readonly container: Container, private readonly env: Env) {}

  private async source(tx: DbClient, actor: AdminAuthorityActor): Promise<Source> {
    // Hash PostgreSQL's exact jsonb text, including all metadata and xmin, with
    // the same expression as the SQL author. Never hash a JS reserialization.
    // The count guard precedes full aggregation: an oversized history is never
    // truncated into an apparently complete source or a public revision.
    const [row] = await tx.execute<{ rows: SourceRow[] | null; source: string | null; bytes: number | null }>(sql`
      WITH source AS MATERIALIZED (
        SELECT CASE WHEN (SELECT count(*) FROM (SELECT id FROM public.system_config WHERE is_store=0
          AND menu_name IN (${sql.join(WECHAT_ROUTINE_KEYS.map(key => sql`${key}`), sql`, `)}) LIMIT 65) bounded)<=64
          THEN (${sql.raw(ADMIN_WECHAT_ROUTINE_SOURCE_SQL)}) ELSE NULL END AS rows)
      SELECT rows,encode(sha256(convert_to(rows::text,'UTF8')),'hex') AS source,
        octet_length(rows::text) AS bytes FROM source`);
    if (!row || !Array.isArray(row.rows) || row.rows.length > 64 || !Number.isSafeInteger(row.bytes)
      || row.bytes! > 1048576 || !wechatRoutineRevision(row.source)) {
      throw new ServiceUnavailableException('小程序配置超过完整读取容量，请维护后再继续');
    }
    // Validate identity/selection without discarding any raw source metadata.
    try { wechatRoutineWinningRows(row.rows.map(item => ({ id: item.id, menuName: item.menu_name,
      isStore: item.is_store, sort: item.sort, value: item.value, version: item.version }))); }
    catch { throw new ServiceUnavailableException('小程序配置完整来源不匹配'); }
    const binding = wechatRoutineActorBinding(this.env, actor);
    return { rows: row.rows, source: row.source, binding,
      revision: wechatRoutineSourceRevision(this.env, binding, row.source) };
  }

  async loadSnapshot(actor: AdminAuthorityActor): Promise<WechatRoutineSnapshot> {
    try { return await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await authorizeAdminLegacyProductRead(tx, actor, 'wechat_routine.view');
      const source = await this.source(tx, actor);
      const winners = new Map<string, SourceRow>();
      for (const row of source.rows) if (!winners.has(row.menu_name)) winners.set(row.menu_name, row);
      const issues: WechatRoutineSnapshot['issues'] = [];
      const decoded = Object.fromEntries(WECHAT_ROUTINE_KEYS.map(key => {
        const row = winners.get(key), value = key === 'routine_contact_type' || key === 'store_user_avatar'
          ? parseWechatRoutineStoredRadio(row?.value) : parseWechatRoutineStoredText(row?.value);
        if (value === null) issues.push({ key, message: row
          ? '已存内容无法完整解析；可保留原值或明确替换' : '配置行缺失；保留不会创建默认行' });
        if (source.rows.filter(item => item.menu_name === key).length > 1)
          issues.push({ key, message: '存在历史重复行；仅最高排序与ID的来源行可明确替换，其余行保留' });
        return [key, { present: !!row, parseable: value !== null, value }];
      })) as Record<typeof WECHAT_ROUTINE_KEYS[number], { present: boolean; parseable: boolean; value: string | 0 | 1 | null }>;
      // Catalog readiness establishes only this author. It does not establish
      // account ownership, provider registration or payment/shipping readiness.
      const catalog = await inspectAdminWechatRoutineWriteCatalog(tx);
      let runtimeReady = false;
      if (catalog.ready && catalog.binding) {
        const [identity] = await tx.execute<{ ready: boolean; maintenance: string }>(sql`SELECT
          has_function_privilege(current_user,to_regprocedure('public.admin_authority_menu_lock_v1()'),'EXECUTE')
          AND current_user=session_user AND current_user=${catalog.binding.admin}::name
          AND r.oid=${catalog.binding.adminOid}::oid AS ready,
          pg_get_userbyid(c.relowner) AS maintenance FROM pg_roles r CROSS JOIN pg_class c
          WHERE r.rolname=current_user AND c.oid=to_regclass('public.admin_wechat_routine_operation')`);
        if (identity?.ready === true) {
          const names = { maintenance: identity.maintenance, admin: catalog.binding.admin };
          runtimeReady = await inspectAdminAuthorityOperation(tx, names) && await inspectAdminAuthorityMenuLock(tx, names);
        }
      }
      const result: WechatRoutineSnapshot = {
        settings: { routine_appId: decoded.routine_appId.value as string | null,
          routine_name: decoded.routine_name.value as string | null,
          routine_contact_type: decoded.routine_contact_type.value as 0 | 1 | null,
          store_user_avatar: decoded.store_user_avatar.value as 0 | 1 | null },
        fields: Object.fromEntries(WECHAT_ROUTINE_KEYS.map(key => [key, {
          present: decoded[key].present, parseable: decoded[key].parseable }])) as WechatRoutineSnapshot['fields'],
        secrets: { routine_appsecret: { present: typeof decoded.routine_appsecret.value === 'string'
          && decoded.routine_appsecret.value.trim().length > 0 } }, revision: source.revision,
        // This is an intermediate author: old-account payment/shipping and
        // ownership maintenance are still incomplete. Storage readiness alone
        // must not enable a UI's whole five-key/runtime readiness switch.
        storage_ready: runtimeReady, runtime_ready: false, credentials_complete: typeof decoded.routine_appId.value === 'string'
          && decoded.routine_appId.value.trim().length > 0 && typeof decoded.routine_appsecret.value === 'string'
          && decoded.routine_appsecret.value.trim().length > 0, issues,
      };
      await assertAdminLegacyProductReadDeadline(tx, actor);
      return result;
    }); } catch (error) { return this.failure(error); }
  }

  private checkedReceipt(value: unknown, actor: AdminAuthorityActor): WechatRoutinePrivateReceipt {
    const row = parseWechatRoutinePrivateReceipt(value);
    if (row.actor_id !== actor.id) throw conflict('小程序配置请求不属于当前账号');
    if (row.revision !== wechatRoutineSourceRevision(this.env, row.result.actor_binding, row.result.before_source))
      throw new ServiceUnavailableException('小程序配置回执签名或原始来源不完整');
    return row;
  }
  private async prior(tx: DbClient, actor: AdminAuthorityActor, id: string): Promise<WechatRoutinePrivateReceipt | null> {
    const rows = await tx.execute(sql`SELECT * FROM public.admin_wechat_routine_operation WHERE operation_id=${id}::uuid LIMIT 2`);
    if (!rows.length) return null;
    if (rows.length !== 1) throw new ServiceUnavailableException('小程序配置回执身份不完整');
    return this.checkedReceipt(rows[0], actor);
  }
  private async invoke(tx: DbClient, actor: AdminAuthorityActor, id: string, operation: 'save' | 'resolve',
    revision: string, source: string, binding: string, input?: WechatRoutineSave) {
    // Drizzle's transaction has no postgres.js json() helper. Explicit text
    // typing followed by one jsonb parse avoids driver type inference and
    // preserves JSON string escapes (including NUL and backslash) exactly.
    const fields = input ? sql`${JSON.stringify(wechatRoutineSqlFields(input))}::text::jsonb` : sql`NULL::jsonb`;
    const rows = await tx.execute<{ evidence: unknown }>(sql`
      SELECT public.cinashop_admin_wechat_routine_write_v1(${id}::uuid,${actor.id}::integer,
        ${operation}::text,${revision}::text,${source}::text,${binding}::text,${fields}) AS evidence`);
    const evidence = rows[0]?.evidence;
    if (rows.length !== 1 || !evidence || typeof evidence !== 'object'
      || typeof (evidence as { replayed?: unknown }).replayed !== 'boolean')
      throw new ServiceUnavailableException('小程序配置写入回执不完整');
    return { row: this.checkedReceipt(evidence, actor), replayed: (evidence as { replayed: boolean }).replayed };
  }

  async saveConfig(actor: AdminAuthorityActor, value: unknown): Promise<WechatRoutineReceipt> {
    let input: WechatRoutineSave;
    try { input = parseWechatRoutineSave(value); } catch (error) { throw new ValidateException((error as Error).message); }
    assertAdminAuthoritySession(actor);
    let outcome: { row: WechatRoutinePrivateReceipt; replayed: boolean };
    try { outcome = await withTx(this.container, async tx => {
      await acquireAdminAuthorityWriteBarrier(tx);
      await acquireAdminAuthorityMenuLock(tx);
      await loadAdminAuthorityLiveActor(tx, actor, 'wechat_routine.manage');
      await assertAdminWechatRoutineOperationReady(tx);
      const prior = await this.prior(tx, actor, input.request_id);
      let result: typeof outcome;
      if (prior) {
        // A new JWT for the same live UID may recover the original operation.
        // The SQL payload comparison still uses the submitted revision/fields.
        result = await this.invoke(tx, actor, input.request_id, 'save', input.revision,
          prior.result.before_source, prior.result.actor_binding, input);
      } else {
        const before = await this.source(tx, actor);
        if (input.revision !== before.revision) throw conflict('小程序配置完整来源或会话已变化，请重新读取后确认');
        result = await this.invoke(tx, actor, input.request_id, 'save', input.revision, before.source, before.binding, input);
      }
      await loadAdminAuthorityLiveActor(tx, actor, 'wechat_routine.manage');
      await assertAdminLegacyProductReadDeadline(tx, actor);
      return result;
    }); } catch (error) { return this.failure(error); }
    return this.dto(outcome, actor);
  }

  private async owner<T>(actor: AdminAuthorityActor, write: boolean, work: (tx: DbClient) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try { return await withTx(this.container, async tx => {
      if (write) await acquireAdminAuthorityWriteBarrier(tx);
      else {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      }
      await loadAdminProfileActor(tx, actor);
      await assertAdminWechatRoutineOperationReady(tx);
      const result = await work(tx);
      await loadAdminProfileActor(tx, actor);
      await assertAdminLegacyProductReadDeadline(tx, actor);
      return result;
    }); } catch (error) { return this.failure(error); }
  }
  async receiptConfig(actor: AdminAuthorityActor, value: unknown): Promise<WechatRoutineReceipt> {
    const id = requestId(value);
    const row = await this.owner(actor, false, async tx => {
      const row = await this.prior(tx, actor, id);
      if (!row) throw new NotFoundException('小程序配置回执不存在');
      return row;
    });
    return this.dto({ row, replayed: true }, actor);
  }
  async resolveConfig(actor: AdminAuthorityActor, value: unknown): Promise<WechatRoutineReceipt> {
    const id = requestId(value);
    const outcome = await this.owner(actor, true, async tx => {
      const prior = await this.prior(tx, actor, id);
      const before = prior ? { revision: prior.revision, source: prior.result.before_source, binding: prior.result.actor_binding }
        : await this.source(tx, actor);
      return this.invoke(tx, actor, id, 'resolve', before.revision, before.source, before.binding);
    });
    return this.dto(outcome, actor);
  }
  private async dto(outcome: { row: WechatRoutinePrivateReceipt; replayed: boolean }, actor: AdminAuthorityActor) {
    let cache: WechatRoutineReceipt['cache_status'] = 'not_required';
    if (outcome.row.state === 'committed' && outcome.row.result.changed_keys.length) {
      const results = await Promise.allSettled(outcome.row.result.changed_keys.map(key =>
        Promise.resolve().then(() => this.env.CONFIG_KV.delete('cfg_' + key))));
      cache = results.every(result => result.status === 'fulfilled') ? 'cleared' : 'pending';
    }
    return wechatRoutineReceiptDto(outcome.row, actor.id, this.env, outcome.replayed, cache);
  }
  private failure(error: unknown): never {
    try { adminAuthorityWriteError(error); } catch (mapped) {
      // Readiness exceptions can retain SQL/catalog errors as a cause. Drop
      // them before they reach middleware logging or the public HTTP envelope.
      if (mapped instanceof ServiceUnavailableException)
        throw new ServiceUnavailableException('小程序配置操作未能确认，请保留请求标识并核对回执');
      if (mapped instanceof ApiException) throw mapped;
      throw new ServiceUnavailableException('小程序配置操作未能确认，请保留请求标识并核对回执');
    }
  }
}
