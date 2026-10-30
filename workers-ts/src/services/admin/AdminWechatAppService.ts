import { createHmac } from 'node:crypto';
import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { inspectAdminWechatAppOperation, assertAdminWechatAppOperationReady } from '@/migrations/adminWechatAppOperation';
import { ApiException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { acquireAdminAuthorityWriteBarrier, withAdminAuthorityWriteTx, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { loadAdminProfileActor } from './AdminProfileService';
import { authorizeAdminLegacyProductRead, assertAdminLegacyProductReadDeadline } from './AdminLegacyProductReadAuthority';
import { WECHAT_APP_KEYS, parseWechatAppSave, parseWechatAppStoredText,
  wechatAppRequestId, wechatAppRevision, type WechatAppSave, type WechatAppSnapshot, type WechatAppReceipt } from '../../../../view/common/wechatApp';
import { planWechatAppIntents, wechatAppWinningRows } from './AdminWechatAppIntentPlan';
import { WECHAT_APP_INSERT_METADATA } from './AdminWechatAppMetadata';
import { appendNativeAppPaymentAccounts } from '@/services/payment/NativeAppPaymentAuthority';
import { inspectNativeAppPaymentAuthority, assertNativeAppPaymentAuthorityReady } from '@/migrations/nativeAppPaymentAuthority';
const names = [...WECHAT_APP_KEYS];
const columns = { ...getTableColumns(systemConfig), version: sql<string>`xmin::text` };
type Row = typeof systemConfig.$inferSelect & { version: string };
type Snapshot = { rows: Row[]; winners: Map<string, Row>; revision: string };
type ReceiptRow = { operation_id: string; actor_id: number; operation: 'save' | 'resolve'; format_version: number; payload_hash: string; revision: string;
  state: 'committed' | 'not_applied'; result: { revision: string; signature: string }; created_at: string | number };
const conflict = (message: string) => new HttpApiException(message, 409, 409);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const requestId = (value: unknown) => { if (!wechatAppRequestId(value)) throw new ValidateException('原生App配置请求标识须为小写UUIDv4'); return value; };

/** Exact native mobile App author. No secret readback, provider call or generic config writer. */
export class AdminWechatAppService {
  constructor(private readonly container: Container, private readonly env: Env) {}
  private hash(domain: string, value: unknown) {
    if (!this.env.APP_KEY) throw new ServiceUnavailableException('原生App配置签名未就绪');
    return createHmac('sha256', this.env.APP_KEY).update('cinashop.wechat-app.' + domain + '.v1\0' + canonical(value)).digest('hex');
  }
  private async snapshot(tx: DbClient, actor: AdminAuthorityActor): Promise<Snapshot> {
    const rows = await tx.select(columns).from(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, names)))
      .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(65);
    if (rows.length > 64 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1024 * 1024) throw new ServiceUnavailableException('原生App配置超过完整读取容量，请先维护');
    const winners = wechatAppWinningRows(rows);
    return { rows, winners, revision: this.hash('revision', [actor.id, actor.authVersion, actor.expiresAt, rows]) };
  }
  async read(actor: AdminAuthorityActor): Promise<WechatAppSnapshot> {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await authorizeAdminLegacyProductRead(tx, actor, 'wechat_app.view');
      const snapshot = await this.snapshot(tx, actor), issues: WechatAppSnapshot['issues'] = [];
      const fields = Object.fromEntries(WECHAT_APP_KEYS.map(key => {
        const row = snapshot.winners.get(key), text = parseWechatAppStoredText(row?.value);
        if (text === null) issues.push({ key, message: row ? '已存文本无法完整解析；可保留原值或明确替换' : '配置行缺失；可保留缺失状态或明确填写' });
        return [key, { present: !!row, parseable: text !== null }];
      })) as WechatAppSnapshot['fields'];
      const appId = parseWechatAppStoredText(snapshot.winners.get('wechat_app_appid')?.value);
      const secret = parseWechatAppStoredText(snapshot.winners.get('wechat_app_appsecret')?.value);
      const result: WechatAppSnapshot = { settings: { wechat_app_appid: appId }, fields,
        secrets: { wechat_app_appsecret: { present: !!secret } }, revision: snapshot.revision,
        runtime_ready: await inspectAdminWechatAppOperation(tx) && await inspectNativeAppPaymentAuthority(tx), credentials_complete: !!appId && !!secret, issues };
      await assertAdminLegacyProductReadDeadline(tx, actor); return result;
    });
  }
  private signature(row: Omit<ReceiptRow, 'result'>, revision: string) { return this.hash('receipt', [row, revision]); }
  private async receiptRow(tx: DbClient, id: string, actor: AdminAuthorityActor): Promise<ReceiptRow | null> {
    const rows = await tx.execute<ReceiptRow>(sql`SELECT * FROM public.admin_wechat_app_operation WHERE operation_id=${id}::uuid LIMIT 2`);
    if (!rows.length) return null; const row = rows[0], result = row.result;
    if (rows.length !== 1 || row.actor_id !== actor.id) throw conflict('原生App配置请求不属于当前账号');
    const { result: _result, ...facts } = row;
    if (row.format_version !== 1 || !['save', 'resolve'].includes(row.operation) || !['committed', 'not_applied'].includes(row.state)
      || row.operation === 'save' && row.state !== 'committed' || row.operation === 'resolve' && row.state !== 'not_applied'
      || !wechatAppRequestId(row.operation_id) || !wechatAppRevision(row.revision) || !wechatAppRevision(row.payload_hash)
      || !Number.isSafeInteger(Number(row.created_at)) || Number(row.created_at) <= 0 || !result || Object.keys(result).sort().join(',') !== 'revision,signature'
      || !wechatAppRevision(result.revision) || result.signature !== this.signature({ ...facts, created_at: Number(row.created_at) }, result.revision)) throw new ServiceUnavailableException('原生App配置回执不完整，请保留原请求并人工核对');
    return row;
  }
  private dto(row: ReceiptRow, replayed: boolean, cache_status: WechatAppReceipt['cache_status'] = 'not_required'): WechatAppReceipt {
    return { request_id: row.operation_id, actor_id: row.actor_id, state: row.state, revision: row.result.revision, created_at: Number(row.created_at), replayed, cache_status };
  }
  private async append(tx: DbClient, actor: AdminAuthorityActor, id: string, operation: ReceiptRow['operation'], payload: string, revision: string, after: string): Promise<ReceiptRow> {
    const [clock] = await tx.execute<{ now: number }>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
    if (!Number.isSafeInteger(clock?.now) || clock.now <= 0) throw new ServiceUnavailableException('数据库时钟无效');
    const facts: Omit<ReceiptRow, 'result'> = { operation_id: id, actor_id: actor.id, operation, format_version: 1, payload_hash: payload, revision,
      state: operation === 'save' ? 'committed' : 'not_applied', created_at: clock.now };
    const result = { revision: after, signature: this.signature(facts, after) };
    const saved = await tx.execute(sql`INSERT INTO public.admin_wechat_app_operation(operation_id,actor_id,operation,format_version,payload_hash,revision,state,result,created_at)
      VALUES(${id}::uuid,${actor.id},${operation},1,${payload},${revision},${facts.state},${JSON.stringify(result)}::jsonb,${clock.now}) RETURNING operation_id`);
    if (saved.length !== 1 || saved[0].operation_id !== id) throw new ServiceUnavailableException('原生App配置回执未完整保存');
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
    const checked = await this.receiptRow(tx, id, actor); if (!checked || canonical({ ...checked, created_at: Number(checked.created_at) }) !== canonical({ ...facts, result })) throw new ServiceUnavailableException('原生App配置回执回读不一致');
    return checked;
  }
  private async barrier(tx: DbClient) {
    // Same account gate as the final OAuth identity transaction. Never held
    // across provider calls; a rotation and identity publication cannot overlap.
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731664,0) AS locked`);
    if (gate?.locked !== true) throw new ServiceUnavailableException('原生App登录身份正在提交，请稍后重新核对配置');
    await tx.execute(sql`LOCK TABLE ONLY public.system_config IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    const [row] = await tx.execute<{ safe: boolean }>(sql`SELECT c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relowner=o.relowner AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal) AS safe
      FROM pg_class c CROSS JOIN pg_class o WHERE c.oid=to_regclass('public.system_config') AND o.oid=to_regclass('public.admin_wechat_app_operation')`);
    if (row?.safe !== true) throw new ServiceUnavailableException('原生App配置存储目录已变化，请维护后再保存');
  }
  private async invalidate(): Promise<WechatAppReceipt['cache_status']> {
    const results = await Promise.allSettled(names.map(key => Promise.resolve().then(() => this.env.CONFIG_KV.delete('cfg_' + key))));
    return results.every(x => x.status === 'fulfilled') ? 'cleared' : 'pending';
  }
  async save(value: unknown, actor: AdminAuthorityActor): Promise<WechatAppReceipt> {
    let input: WechatAppSave; try { input = parseWechatAppSave(value); } catch (error) { throw new ValidateException((error as Error).message); }
    const payload = this.hash('payload', input);
    let outcome: { row: ReceiptRow; replayed: boolean };
    try { outcome = await withAdminAuthorityWriteTx(this.container, actor, 'wechat_app.manage', async tx => {
      await assertAdminWechatAppOperationReady(tx);
      const prior = await this.receiptRow(tx, input.request_id, actor);
      if (prior) { if (prior.state === 'committed' && prior.payload_hash !== payload) throw conflict('请求标识已用于不同的原生App配置'); return { row: prior, replayed: true }; }
      await assertNativeAppPaymentAuthorityReady(tx, 'admin');
      await this.barrier(tx); const before = await this.snapshot(tx, actor);
      if (before.revision !== input.revision) throw conflict('原生App配置完整来源已变化，请重新读取后确认');
      const plan = planWechatAppIntents(before.rows, input);
      if (plan.appIdValueChanged) await appendNativeAppPaymentAccounts(tx, this.env, {
        appIds: [parseWechatAppStoredText(before.winners.get('wechat_app_appid')?.value),
          input.fields.wechat_app_appid.action === 'replace' ? input.fields.wechat_app_appid.value : null],
        requestId: input.request_id, actorId: actor.id, sourceRevision: before.revision,
      });
      const expected = before.rows.map(row => ({ ...row }));
      for (const { key, winner, raw } of plan.changes) {
        let saved: Row[];
        if (winner) saved = await tx.update(systemConfig).set({ value: raw }).where(and(eq(systemConfig.id, winner.id), eq(systemConfig.isStore, 0), eq(systemConfig.menuName, key), sql`xmin::text=${winner.version}`)).returning(columns);
        else saved = await tx.insert(systemConfig).values({ ...WECHAT_APP_INSERT_METADATA[key], menuName: key, value: raw, isStore: 0 }).returning(columns);
        if (saved.length !== 1 || saved[0].value !== raw || saved[0].menuName !== key || saved[0].isStore !== 0) throw new ServiceUnavailableException('原生App配置写入结果不完整');
        if (winner) {
          const { value: _value, version: _version, ...oldMeta } = winner;
          const { value: _savedValue, version: _savedVersion, ...newMeta } = saved[0];
          if (canonical(oldMeta) !== canonical(newMeta)) throw new ServiceUnavailableException('原生App配置来源元数据被改写');
          expected.splice(expected.findIndex(row => row.id === winner.id), 1);
        } else {
          for (const [field, value] of Object.entries(WECHAT_APP_INSERT_METADATA[key]))
            if (saved[0][field as keyof Row] !== value) throw new ServiceUnavailableException('原生App新增配置元数据不完整');
        }
        expected.push(saved[0]);
      }
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      const after = await this.snapshot(tx, actor), byId = (rows: Row[]) => rows.slice().sort((a, b) => a.id - b.id);
      if (canonical(byId(after.rows)) !== canonical(byId(expected))) throw new ServiceUnavailableException('原生App配置完整回读不一致');
      return { row: await this.append(tx, actor, input.request_id, 'save', payload, input.revision, after.revision), replayed: false };
    }); } catch (error) {
      // SQL errors may contain replacement material. Never expose their cause.
      if (error instanceof ApiException) throw error;
      throw new ServiceUnavailableException('原生App配置未能确认保存，请保留原请求标识并读取回执');
    }
    return this.dto(outcome.row, outcome.replayed, outcome.row.state === 'committed' ? await this.invalidate() : 'not_required');
  }
  private owner<T>(actor: AdminAuthorityActor, write: boolean, work: (tx: DbClient) => Promise<T>) {
    return withTx(this.container, async tx => {
      if (write) await acquireAdminAuthorityWriteBarrier(tx);
      else { await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await tx.execute(sql`SET LOCAL statement_timeout='5s'`); }
      await loadAdminProfileActor(tx, actor); await assertAdminWechatAppOperationReady(tx);
      const result = await work(tx); await assertAdminLegacyProductReadDeadline(tx, actor); return result;
    });
  }
  async receipt(value: unknown, actor: AdminAuthorityActor) {
    const id = requestId(value);
    const row = await this.owner(actor, false, async tx => { const row = await this.receiptRow(tx, id, actor); if (!row) throw new NotFoundException('原生App配置回执不存在'); return row; });
    return this.dto(row, true, row.state === 'committed' ? await this.invalidate() : 'not_required');
  }
  async resolve(value: unknown, body: unknown, actor: AdminAuthorityActor) {
    const id = requestId(value);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || (body as { confirmed?: unknown }).confirmed !== true) throw new ValidateException('请明确确认核对并封存原配置请求');
    const outcome = await this.owner(actor, true, async tx => {
      const prior = await this.receiptRow(tx, id, actor); if (prior) return { row: prior, replayed: true };
      const signature = this.hash('absent', [id, actor.id]);
      return { row: await this.append(tx, actor, id, 'resolve', signature, signature, signature), replayed: false };
    });
    return this.dto(outcome.row, outcome.replayed, outcome.row.state === 'committed' ? await this.invalidate() : 'not_required');
  }
}
