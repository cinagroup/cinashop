import { createHmac } from 'node:crypto';
import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { inspectAdminWechatOpenOperation, assertAdminWechatOpenOperationReady } from '@/migrations/adminWechatOpenOperation';
import { reviewedAdminWechatRoutineConfigGuardOid } from '@/migrations/adminWechatRoutineConfigCompatibility';
import { normalizeConfigScalar } from '@/utils/config';
import { ApiException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { acquireAdminAuthorityWriteBarrier, withAdminAuthorityWriteTx, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { loadAdminProfileActor } from './AdminProfileService';
import { authorizeAdminLegacyProductRead, assertAdminLegacyProductReadDeadline } from './AdminLegacyProductReadAuthority';
import { WECHAT_OPEN_AUTHORITY_KEY, WECHAT_OPEN_KEYS, parseWechatOpenSave, validWechatOpenAppId, validWechatOpenSecret,
  wechatOpenRequestId, wechatOpenRevision, type WechatOpenSave, type WechatOpenSnapshot, type WechatOpenReceipt } from '../../../../view/common/wechatOpen';
const names = [...WECHAT_OPEN_KEYS, WECHAT_OPEN_AUTHORITY_KEY];
const columns = { ...getTableColumns(systemConfig), version: sql<string>`xmin::text` };
type Row = typeof systemConfig.$inferSelect & { version: string };
type Snapshot = { rows: Row[]; winners: Map<string, Row>; revision: string };
type ReceiptRow = { operation_id: string; actor_id: number; operation: 'save' | 'resolve'; format_version: number; payload_hash: string; revision: string;
  state: 'committed' | 'not_applied'; result: { revision: string; signature: string }; created_at: string | number };
const conflict = (message: string) => new HttpApiException(message, 409, 409);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const requestId = (value: unknown) => { if (!wechatOpenRequestId(value)) throw new ValidateException('开放平台配置请求标识须为小写UUIDv4'); return value; };

/** Exact wxopen author. No secret readback, provider call or generic config writer. */
export class AdminWechatOpenService {
  constructor(private readonly container: Container, private readonly env: Env) {}
  private hash(domain: string, value: unknown) {
    if (!this.env.APP_KEY) throw new ServiceUnavailableException('开放平台配置签名未就绪');
    return createHmac('sha256', this.env.APP_KEY).update('cinashop.wechat-open.' + domain + '.v1\0' + canonical(value)).digest('hex');
  }
  private async snapshot(tx: DbClient, actor: AdminAuthorityActor): Promise<Snapshot> {
    const rows = await tx.select(columns).from(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, names)))
      .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(65);
    if (rows.length > 64 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1024 * 1024) throw new ServiceUnavailableException('开放平台配置超过完整读取容量，请先维护');
    const winners = new Map<string, Row>(); for (const row of rows) if (!winners.has(row.menuName)) winners.set(row.menuName, row);
    return { rows, winners, revision: this.hash('revision', [actor.id, actor.authVersion, actor.expiresAt, rows, this.env.WECHAT_OPEN_APP_SECRET ?? '']) };
  }
  private text(snapshot: Snapshot, key: string) { return normalizeConfigScalar(snapshot.winners.get(key)?.value); }
  private credentials(snapshot: Snapshot): WechatOpenSnapshot['credentials'] {
    const deployed = this.env.WECHAT_OPEN_APP_SECRET ?? '', deployment_secret_present = deployed.length > 0;
    const database_enabled = snapshot.winners.get(WECHAT_OPEN_AUTHORITY_KEY)?.value === 'database';
    const authority = deployment_secret_present ? 'deployment' : database_enabled ? 'database' : 'disabled';
    const secret = authority === 'deployment' ? deployed : this.text(snapshot, 'wechat_open_app_secret');
    return { database_enabled, authority, deployment_secret_present,
      ready: authority !== 'disabled' && validWechatOpenAppId(this.text(snapshot, 'wechat_open_app_id')) && validWechatOpenSecret(secret) };
  }
  async read(actor: AdminAuthorityActor): Promise<WechatOpenSnapshot> {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await authorizeAdminLegacyProductRead(tx, actor, 'wechat_open.view');
      const snapshot = await this.snapshot(tx, actor), issues: WechatOpenSnapshot['issues'] = [];
      const appId = this.text(snapshot, 'wechat_open_app_id'), raw = snapshot.winners.get('wechat_open_app_id')?.value ?? null;
      const valid = raw !== null && (appId === '' || validWechatOpenAppId(appId));
      if (!valid) issues.push({ key: 'wechat_open_app_id', message: raw === null ? '网站应用AppID缺失，请明确填写或留空' : '已存网站应用AppID格式异常，请核对原值后重新填写' });
      const secret = this.text(snapshot, 'wechat_open_app_secret'), secretState = { present: !!secret, valid: validWechatOpenSecret(secret) };
      if (secretState.present && !secretState.valid) issues.push({ key: 'wechat_open_app_secret', message: '已存密钥格式异常；可保留原值或明确替换，原值不回显' });
      const result: WechatOpenSnapshot = { settings: { wechat_open_app_id: valid ? appId : null }, raw_public_values: { wechat_open_app_id: raw },
        secrets: { wechat_open_app_secret: secretState }, revision: snapshot.revision, runtime_ready: await inspectAdminWechatOpenOperation(tx), credentials: this.credentials(snapshot), issues };
      await assertAdminLegacyProductReadDeadline(tx, actor); return result;
    });
  }
  private signature(row: Omit<ReceiptRow, 'result'>, revision: string) { return this.hash('receipt', [row, revision]); }
  private async receiptRow(tx: DbClient, id: string, actor: AdminAuthorityActor): Promise<ReceiptRow | null> {
    const rows = await tx.execute<ReceiptRow>(sql`SELECT * FROM public.admin_wechat_open_operation WHERE operation_id=${id}::uuid LIMIT 2`);
    if (!rows.length) return null; const row = rows[0], result = row.result;
    if (rows.length !== 1 || row.actor_id !== actor.id) throw conflict('开放平台配置请求不属于当前账号');
    const { result: _result, ...facts } = row;
    if (row.format_version !== 1 || !['save', 'resolve'].includes(row.operation) || !['committed', 'not_applied'].includes(row.state)
      || row.operation === 'save' && row.state !== 'committed' || row.operation === 'resolve' && row.state !== 'not_applied'
      || !wechatOpenRequestId(row.operation_id) || !wechatOpenRevision(row.revision) || !wechatOpenRevision(row.payload_hash)
      || !Number.isSafeInteger(Number(row.created_at)) || Number(row.created_at) <= 0 || !result || Object.keys(result).sort().join(',') !== 'revision,signature'
      || !wechatOpenRevision(result.revision) || result.signature !== this.signature({ ...facts, created_at: Number(row.created_at) }, result.revision)) throw new ServiceUnavailableException('开放平台配置回执不完整，请保留原请求并人工核对');
    return row;
  }
  private dto(row: ReceiptRow, replayed: boolean, cache_status: WechatOpenReceipt['cache_status'] = 'not_required'): WechatOpenReceipt {
    return { request_id: row.operation_id, actor_id: row.actor_id, state: row.state, revision: row.result.revision, created_at: Number(row.created_at), replayed, cache_status };
  }
  private async append(tx: DbClient, actor: AdminAuthorityActor, id: string, operation: ReceiptRow['operation'], payload: string, revision: string, after: string): Promise<ReceiptRow> {
    const [clock] = await tx.execute<{ now: number }>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
    if (!Number.isSafeInteger(clock?.now) || clock.now <= 0) throw new ServiceUnavailableException('数据库时钟无效');
    const facts: Omit<ReceiptRow, 'result'> = { operation_id: id, actor_id: actor.id, operation, format_version: 1, payload_hash: payload, revision,
      state: operation === 'save' ? 'committed' : 'not_applied', created_at: clock.now };
    const result = { revision: after, signature: this.signature(facts, after) };
    const saved = await tx.execute(sql`INSERT INTO public.admin_wechat_open_operation(operation_id,actor_id,operation,format_version,payload_hash,revision,state,result,created_at)
      VALUES(${id}::uuid,${actor.id},${operation},1,${payload},${revision},${facts.state},${JSON.stringify(result)}::jsonb,${clock.now}) RETURNING operation_id`);
    if (saved.length !== 1 || saved[0].operation_id !== id) throw new ServiceUnavailableException('开放平台配置回执未完整保存');
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
    const checked = await this.receiptRow(tx, id, actor); if (!checked || canonical({ ...checked, created_at: Number(checked.created_at) }) !== canonical({ ...facts, result })) throw new ServiceUnavailableException('开放平台配置回执回读不一致');
    return checked;
  }
  private async barrier(tx: DbClient) {
    // Same account gate as the final OAuth identity transaction. Never held
    // across provider calls; a rotation and identity publication cannot overlap.
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731661,0) AS locked`);
    if (gate?.locked !== true) throw new ServiceUnavailableException('开放平台登录身份正在提交，请稍后重新核对配置');
    await tx.execute(sql`LOCK TABLE ONLY public.system_config IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    const routineGuardOid = await reviewedAdminWechatRoutineConfigGuardOid(tx);
    const [row] = await tx.execute<{ safe: boolean }>(sql`SELECT c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relowner=o.relowner AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal
        AND tgfoid IS DISTINCT FROM ${routineGuardOid}::oid) AS safe
      FROM pg_class c CROSS JOIN pg_class o WHERE c.oid=to_regclass('public.system_config') AND o.oid=to_regclass('public.admin_wechat_open_operation')`);
    if (row?.safe !== true) throw new ServiceUnavailableException('开放平台配置存储目录已变化，请维护后再保存');
  }
  private async invalidate(): Promise<WechatOpenReceipt['cache_status']> {
    const results = await Promise.allSettled(names.map(key => Promise.resolve().then(() => this.env.CONFIG_KV.delete('cfg_' + key))));
    return results.every(x => x.status === 'fulfilled') ? 'cleared' : 'pending';
  }
  async save(value: unknown, actor: AdminAuthorityActor): Promise<WechatOpenReceipt> {
    let input: WechatOpenSave; try { input = parseWechatOpenSave(value); } catch (error) { throw new ValidateException((error as Error).message); }
    const payload = this.hash('payload', input);
    let outcome: { row: ReceiptRow; replayed: boolean };
    try { outcome = await withAdminAuthorityWriteTx(this.container, actor, 'wechat_open.manage', async tx => {
      await assertAdminWechatOpenOperationReady(tx);
      const prior = await this.receiptRow(tx, input.request_id, actor);
      if (prior) { if (prior.state === 'committed' && prior.payload_hash !== payload) throw conflict('请求标识已用于不同的开放平台配置'); return { row: prior, replayed: true }; }
      await this.barrier(tx); const before = await this.snapshot(tx, actor);
      if (before.revision !== input.revision) throw conflict('开放平台配置或凭据来源已变化，请重新读取后确认');
      if ((this.env.WECHAT_OPEN_APP_SECRET ?? '').length > 0 && input.settings.wechat_open_app_id !== this.text(before, 'wechat_open_app_id')) throw conflict('部署密钥仍在生效，暂不能单独切换AppID；请先维护部署密钥，再启用完整数据库凭据');
      const next = new Map<string, string>([['wechat_open_app_id', input.settings.wechat_open_app_id]]);
      const intent = input.secrets.wechat_open_app_secret;
      if (input.database_credentials && input.settings.wechat_open_app_id !== this.text(before, 'wechat_open_app_id') && intent.action !== 'replace') throw new ValidateException('切换启用中的网站应用AppID时，请明确替换新应用的AppSecret');
      if (intent.action !== 'keep') next.set('wechat_open_app_secret', intent.action === 'clear' ? '' : intent.value);
      next.set(WECHAT_OPEN_AUTHORITY_KEY, input.database_credentials ? 'database' : 'deployment');
      const secret = next.has('wechat_open_app_secret') ? next.get('wechat_open_app_secret')! : this.text(before, 'wechat_open_app_secret');
      if (input.database_credentials && (!validWechatOpenAppId(input.settings.wechat_open_app_id) || !validWechatOpenSecret(secret))) throw new ValidateException('启用数据库凭据前，请配置完整有效的网站应用AppID和AppSecret');
      const expected = before.rows.map(row => ({ ...row }));
      for (const [key, value] of next) {
        const winner = before.winners.get(key), raw = key === WECHAT_OPEN_AUTHORITY_KEY ? value : JSON.stringify(value);
        if (winner && (key === 'wechat_open_app_secret' || key === WECHAT_OPEN_AUTHORITY_KEY ? winner.value === raw : normalizeConfigScalar(winner.value) === value)) continue;
        let saved: Row[];
        if (winner) saved = await tx.update(systemConfig).set({ value: raw }).where(and(eq(systemConfig.id, winner.id), eq(systemConfig.isStore, 0), eq(systemConfig.menuName, key), sql`xmin::text=${winner.version}`)).returning(columns);
        else saved = await tx.insert(systemConfig).values({ menuName: key, value: raw, isStore: 0, configTabId: 74, type: 'text', inputType: 'input', info: key, status: 1 }).returning(columns);
        if (saved.length !== 1 || saved[0].value !== raw || saved[0].menuName !== key || saved[0].isStore !== 0) throw new ServiceUnavailableException('开放平台配置写入结果不完整');
        if (winner) { const { value: _value, version: _version, ...oldMeta } = winner, { value: _savedValue, version: _savedVersion, ...newMeta } = saved[0]; if (canonical(oldMeta) !== canonical(newMeta)) throw new ServiceUnavailableException('开放平台配置来源元数据被改写'); expected.splice(expected.findIndex(row => row.id === winner.id), 1); }
        expected.push(saved[0]);
      }
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      const after = await this.snapshot(tx, actor), byId = (rows: Row[]) => rows.slice().sort((a, b) => a.id - b.id);
      if (canonical(byId(after.rows)) !== canonical(byId(expected))) throw new ServiceUnavailableException('开放平台配置完整回读不一致');
      return { row: await this.append(tx, actor, input.request_id, 'save', payload, input.revision, after.revision), replayed: false };
    }); } catch (error) {
      // SQL errors may contain replacement material. Never expose their cause.
      if (error instanceof ApiException) throw error;
      throw new ServiceUnavailableException('开放平台配置未能确认保存，请保留原请求标识并读取回执');
    }
    return this.dto(outcome.row, outcome.replayed, outcome.row.state === 'committed' ? await this.invalidate() : 'not_required');
  }
  private owner<T>(actor: AdminAuthorityActor, write: boolean, work: (tx: DbClient) => Promise<T>) {
    return withTx(this.container, async tx => {
      if (write) await acquireAdminAuthorityWriteBarrier(tx);
      else { await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await tx.execute(sql`SET LOCAL statement_timeout='5s'`); }
      await loadAdminProfileActor(tx, actor); await assertAdminWechatOpenOperationReady(tx);
      const result = await work(tx); await assertAdminLegacyProductReadDeadline(tx, actor); return result;
    });
  }
  async receipt(value: unknown, actor: AdminAuthorityActor) {
    const id = requestId(value);
    const row = await this.owner(actor, false, async tx => { const row = await this.receiptRow(tx, id, actor); if (!row) throw new NotFoundException('开放平台配置回执不存在'); return row; });
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
