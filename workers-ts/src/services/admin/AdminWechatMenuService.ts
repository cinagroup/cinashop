import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { assertAdminWechatMenuOperationReady, inspectAdminWechatMenuOperation } from '@/migrations/adminWechatMenuOperation';
import { authorizeAdminLegacyProductRead, assertAdminLegacyProductReadDeadline } from './AdminLegacyProductReadAuthority';
import { assertAdminAuthoritySession, withAdminAuthorityWriteTx, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { normalizeConfigScalar } from '@/utils/config';
import { OfficialAccountMenuProvider } from '@/services/wechat/OfficialAccountMenuProvider';
import { HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { normalizeWechatMenu, wechatMenuCanonical, wechatMenuProviderButtons, type WechatMenuButton } from '../../../../view/common/wechatMenu';

type Actor = AdminAuthorityActor;
type State = 'admitted' | 'accepted' | 'accepted_unstored' | 'rejected' | 'not_dispatched' | 'observed_match';
type CacheDocument = { present: boolean; result: string | null; expire_time: number; add_time: number };
type Operation = { operation_id: string; phase: number; actor_id: number; resolver_id: number; app_id: string;
  account_stamp: string; request_hash: string; base_revision: string; button: WechatMenuButton[];
  state: State; provider_code: number | null; created_at: string | number; prior_cache: CacheDocument };
type Snapshot = { config: { appId: string; secret: string }; accountStamp: string; cache: CacheDocument; cacheHash: string; revision: string };
const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const conflict = (msg: string) => new HttpApiException(msg, 409, 409);
export function wechatMenuOperationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidateException('菜单发布操作须使用小写UUIDv4');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('菜单请求须为对象');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ValidateException('菜单请求包含未知字段');
}
function author(value: unknown, empty = false) {
  try { return normalizeWechatMenu(value, empty); } catch (error) { throw new ValidateException((error as Error).message); }
}
function history(document: CacheDocument): { menus: WechatMenuButton[] | null; issues: string[] } {
  if (!document.present) return { menus: [], issues: [] };
  try { return { menus: normalizeWechatMenu(JSON.parse(document.result ?? ''), true), issues: [] }; }
  catch (error) { return { menus: null, issues: ['本地历史菜单无法完整编辑：' + (error as Error).message] }; }
}
function dto(start: Operation, final?: Operation) {
  return { operation_id: start.operation_id, actor_id: start.actor_id, resolver_id: final?.resolver_id ?? start.resolver_id,
    app_id: start.app_id, state: final?.state ?? 'unknown', provider_code: final?.provider_code ?? null,
    created_at: Number(start.created_at), local_saved: final?.state === 'accepted' || final?.state === 'observed_match' };
}

/** Remote calls never run inside a SQL transaction. Admission precedes dispatch;
 * immutable final facts and the legacy projection commit together. An absent
 * final fact is uncertainty, never permission to resend an admitted request. */
export class AdminWechatMenuService {
  constructor(private readonly container: Container, private readonly signingKey: string,
    private readonly provider = new OfficialAccountMenuProvider()) {}
  private hash(domain: string, value: unknown): string {
    if (!this.signingKey) throw new ServiceUnavailableException('公众号菜单签名未配置');
    return createHmac('sha256', this.signingKey).update('cinashop.wechat-menu.' + domain + '.v1\0' + wechatMenuCanonical(value)).digest('hex');
  }
  private async snapshot(tx: DbClient, actor: Actor): Promise<Snapshot> {
    // Fresh DB facts: never SystemConfigService's KV or the shared token cache.
    const rows = await tx.execute<{ id: number; menu_name: string; value: string; sort: number; status: number }>(sql`SELECT id,menu_name,value,sort,status
      FROM public.system_config WHERE is_store=0 AND menu_name IN ('wechat_appid','wechat_appsecret') ORDER BY sort DESC,id DESC LIMIT 65`);
    if (rows.length > 64) throw new ServiceUnavailableException('公众号配置重复过多，请维护后重试');
    const scalar = (key: string) => normalizeConfigScalar(rows.find(row => row.menu_name === key)?.value ?? '').trim();
    const config = { appId: scalar('wechat_appid'), secret: scalar('wechat_appsecret') };
    const accountStamp = this.hash('account', rows);
    const cached = await tx.execute<{ result: string | null; expire_time: number; add_time: number; bytes: number }>(sql`SELECT result,expire_time,add_time,
      octet_length(coalesce(result,'')) AS bytes FROM public.cache WHERE key='wechat_menus' LIMIT 2`);
    if (cached.length > 1 || cached[0] && cached[0].bytes > 65536) throw new ServiceUnavailableException('历史菜单文档过大或身份不唯一，须先人工维护');
    const row = cached[0], cache: CacheDocument = row ? { present: true, result: row.result, expire_time: row.expire_time, add_time: row.add_time }
      : { present: false, result: null, expire_time: 0, add_time: 0 };
    // PHP GET deliberately ignores expiry; an expired/malformed value is not []
    const cacheHash = this.hash('cache', cache);
    return { config, accountStamp, cache, cacheHash,
      revision: this.hash('revision', [actor.id, actor.authVersion, actor.expiresAt, accountStamp, cacheHash]) };
  }
  private configured(snapshot: Snapshot) {
    if (!/^wx[a-zA-Z0-9]{16}$/u.test(snapshot.config.appId) || !snapshot.config.secret || snapshot.config.secret.length > 256
      || /[\u0000-\u0020\u007f]/u.test(snapshot.config.secret)) throw new ValidateException('请先配置有效的公众号 AppID 和 AppSecret');
  }
  private async accountLock(tx: DbClient, appId: string) {
    const key = Number.parseInt(this.hash('account-lock', appId).slice(0, 8), 16) | 0;
    const [lock] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(731657,${key}::integer) AS locked`);
    if (!lock?.locked) throw conflict('公众号菜单正在处理，请稍后核对');
  }
  private async configurationBarrier(tx: DbClient) {
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='1s'`);
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
    // Also protects missing-key insertion and App writers of the shared cache.
    // These short barriers end before every network request.
    await tx.execute(sql`LOCK TABLE ONLY public.system_config IN SHARE MODE NOWAIT`);
    await tx.execute(sql`LOCK TABLE ONLY public.cache IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    const [catalog] = await tx.execute<{ safe: boolean }>(sql`SELECT c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND c.relowner=o.relowner
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal) AS safe
      FROM pg_catalog.pg_class c CROSS JOIN pg_catalog.pg_class o
      WHERE c.oid=to_regclass('public.cache') AND o.oid=to_regclass('public.admin_wechat_menu_operation')`);
    if (catalog?.safe !== true) throw new ServiceUnavailableException('历史菜单缓存目录已变化，请人工维护后再发布');
  }
  private admissionHash(row: Operation) {
    return this.hash('admission', [row.operation_id, row.phase, row.actor_id, row.resolver_id, row.app_id, row.account_stamp,
      row.base_revision, row.button, row.state, row.provider_code, Number(row.created_at), row.prior_cache]);
  }
  private outcomeHash(start: Operation, row: Operation) {
    return this.hash('outcome', [start.request_hash, row.operation_id, row.phase, row.actor_id, row.resolver_id, row.app_id,
      row.account_stamp, row.base_revision, row.button, row.state, row.provider_code, Number(row.created_at), row.prior_cache]);
  }
  private async operation(tx: DbClient, id: string): Promise<{ start: Operation; final?: Operation } | null> {
    const rows = await tx.execute<Operation>(sql`SELECT * FROM public.admin_wechat_menu_operation WHERE operation_id=${id}::uuid ORDER BY phase LIMIT 3`);
    if (!rows.length) return null;
    const start = rows[0], final = rows[1];
    const valid = (row: Operation) => UUID.test(row.operation_id) && row.actor_id > 0 && row.resolver_id > 0 && Number.isSafeInteger(Number(row.created_at)) && Number(row.created_at) > 0
      && SHA.test(row.account_stamp) && SHA.test(row.request_hash) && SHA.test(row.base_revision);
    if (rows.length > 2 || start.phase !== 0 || start.state !== 'admitted' || start.provider_code !== null || start.actor_id !== start.resolver_id || !valid(start) || this.admissionHash(start) !== start.request_hash
      || final && (final.phase !== 1 || !valid(final) || this.outcomeHash(start, final) !== final.request_hash || final.state === 'admitted'
        || Number(final.created_at) < Number(start.created_at)
        || wechatMenuCanonical(final.button) !== wechatMenuCanonical(start.button) || wechatMenuCanonical(final.prior_cache) !== wechatMenuCanonical(start.prior_cache)
        || final.app_id !== start.app_id || final.account_stamp !== start.account_stamp || final.base_revision !== start.base_revision || final.actor_id !== start.actor_id)) {
      throw new ServiceUnavailableException('公众号菜单发布记录不完整，请人工核对');
    }
    author(start.button);
    return { start, final };
  }
  private async unresolved(tx: DbClient, appId: string): Promise<Operation | null> {
    const rows = await tx.execute<{ operation_id: string }>(sql`SELECT a.operation_id FROM public.admin_wechat_menu_operation a
      WHERE a.app_id=${appId} AND a.phase=0 AND NOT EXISTS(SELECT 1 FROM public.admin_wechat_menu_operation f
        WHERE f.operation_id=a.operation_id AND f.phase=1) ORDER BY a.created_at,a.operation_id LIMIT 2`);
    if (rows.length > 1) throw new ServiceUnavailableException('公众号存在多条未决发布，请人工核对');
    return rows[0] ? (await this.operation(tx, rows[0].operation_id))!.start : null;
  }
  private async append(tx: DbClient, row: Operation): Promise<void> {
    const saved = await tx.execute<Operation>(sql`INSERT INTO public.admin_wechat_menu_operation(operation_id,phase,actor_id,resolver_id,app_id,account_stamp,request_hash,
      base_revision,button,state,provider_code,created_at,prior_cache) VALUES(${row.operation_id}::uuid,${row.phase},${row.actor_id},${row.resolver_id},${row.app_id},
      ${row.account_stamp},${row.request_hash},${row.base_revision},${JSON.stringify(row.button)}::jsonb,${row.state},${row.provider_code},${row.created_at},${JSON.stringify(row.prior_cache)}::jsonb) RETURNING *`);
    const same = (actual: Operation) => wechatMenuCanonical({ ...actual, created_at: Number(actual.created_at) }) === wechatMenuCanonical({ ...row, created_at: Number(row.created_at) });
    if (saved.length !== 1 || !same(saved[0])) throw new ServiceUnavailableException('菜单发布记录写入结果不一致');
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
    const checked = await this.operation(tx, row.operation_id), actual = row.phase === 0 ? checked?.start : checked?.final;
    if (!actual || !same(actual)) throw new ServiceUnavailableException('菜单发布记录回读不一致');
  }
  private async saveCache(tx: DbClient, button: WechatMenuButton[]) {
    const result = JSON.stringify(button), now = Math.floor(Date.now() / 1000);
    const saved = await tx.execute<{ key: string; result: string; expire_time: number; add_time: number }>(sql`INSERT INTO public.cache(key,result,expire_time,add_time)
      VALUES('wechat_menus',${result},0,${now}) ON CONFLICT(key) DO UPDATE SET result=excluded.result,expire_time=0,add_time=excluded.add_time RETURNING *`);
    const same = (row: typeof saved[number]) => row.key === 'wechat_menus' && row.result === result && row.expire_time === 0 && row.add_time === now;
    if (saved.length !== 1 || !same(saved[0])) throw new ServiceUnavailableException('本地菜单写入结果不一致');
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
    const checked = await tx.execute<typeof saved[number]>(sql`SELECT * FROM public.cache WHERE key='wechat_menus' LIMIT 2`);
    if (checked.length !== 1 || !same(checked[0])) throw new ServiceUnavailableException('本地菜单回读不一致');
  }
  async read(actor: Actor) {
    assertAdminAuthoritySession(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await authorizeAdminLegacyProductRead(tx, actor, 'wechat_menu.view');
      const snapshot = await this.snapshot(tx, actor), parsed = history(snapshot.cache), ready = await inspectAdminWechatMenuOperation(tx);
      const pending = ready && snapshot.config.appId ? await this.unresolved(tx, snapshot.config.appId) : null;
      const result = { ...parsed, raw: snapshot.cache.result, present: snapshot.cache.present, expired: snapshot.cache.expire_time > 0 && snapshot.cache.expire_time < Date.now() / 1000,
        revision: snapshot.revision, app_id: snapshot.config.appId, configured: /^wx[a-zA-Z0-9]{16}$/u.test(snapshot.config.appId) && !!snapshot.config.secret,
        runtime_ready: ready, pending: pending ? dto(pending) : null };
      await assertAdminLegacyProductReadDeadline(tx, actor);
      return result;
    });
  }
  async receipt(value: unknown, actor: Actor) {
    const id = wechatMenuOperationId(value);
    return withAdminAuthorityWriteTx(this.container, actor, 'wechat_menu.manage', async tx => {
      await assertAdminWechatMenuOperationReady(tx);
      const record = await this.operation(tx, id);
      if (!record) throw new NotFoundException('菜单发布记录不存在');
      return dto(record.start, record.final);
    });
  }
  /** Fence an absent original UUID before discarding its client journal. The
   * same authority barrier serializes this with every publisher admission.
   * Existing admissions are only read: this cannot cancel a remote request. */
  async resolveMissing(value: unknown, body: unknown, actor: Actor) {
    const id = wechatMenuOperationId(value), input = object(body);
    fields(input, ['operation_id', 'revision', 'button', 'replace_history', 'confirmed']);
    const button = author(input.button);
    if (input.operation_id !== id || input.confirmed !== true || typeof input.revision !== 'string' || !SHA.test(input.revision)
      || input.replace_history !== undefined && typeof input.replace_history !== 'boolean') throw new ValidateException('请保留完整原发布标识、版本与内容，再明确核对');
    const revision = input.revision;
    return withAdminAuthorityWriteTx(this.container, actor, 'wechat_menu.manage', async tx => {
      await assertAdminWechatMenuOperationReady(tx);
      const prior = await this.operation(tx, id);
      if (prior) {
        if (prior.start.actor_id !== actor.id || prior.start.base_revision !== revision || wechatMenuCanonical(prior.start.button) !== wechatMenuCanonical(button)) throw conflict('原操作标识与待核对内容不一致');
        return dto(prior.start, prior.final);
      }
      // No current revision match or valid provider credentials are needed to
      // prevent a never-admitted UUID from sending later. There is no cache DML.
      await tx.execute(sql`LOCK TABLE ONLY public.system_config, ONLY public.cache IN SHARE MODE NOWAIT`);
      const snapshot = await this.snapshot(tx, actor);
      const appId = /^wx[a-zA-Z0-9]{16}$/u.test(snapshot.config.appId) ? snapshot.config.appId : '';
      await this.accountLock(tx, appId);
      const start: Operation = { operation_id: id, phase: 0, actor_id: actor.id, resolver_id: actor.id, app_id: appId,
        account_stamp: snapshot.accountStamp, base_revision: revision, button, state: 'admitted', provider_code: null,
        prior_cache: snapshot.cache, created_at: Math.floor(Date.now() / 1000), request_hash: '' };
      start.request_hash = this.admissionHash(start);
      await this.append(tx, start);
      const final: Operation = { ...start, phase: 1, state: 'not_dispatched' };
      final.request_hash = this.outcomeHash(start, final);
      await this.append(tx, final);
      return dto(start, final);
    });
  }
  async publish(value: unknown, actor: Actor) {
    const input = object(value); fields(input, ['operation_id', 'revision', 'button', 'replace_history', 'confirmed']);
    const id = wechatMenuOperationId(input.operation_id), button = author(input.button);
    if (input.confirmed !== true || typeof input.revision !== 'string' || !SHA.test(input.revision)
      || input.replace_history !== undefined && typeof input.replace_history !== 'boolean') throw new ValidateException('请先读取当前菜单并明确确认发布');
    const revision = input.revision;
    const admitted = await withAdminAuthorityWriteTx(this.container, actor, 'wechat_menu.manage', async tx => {
      await assertAdminWechatMenuOperationReady(tx);
      await this.configurationBarrier(tx);
      const snapshot = await this.snapshot(tx, actor); this.configured(snapshot);
      await this.accountLock(tx, snapshot.config.appId);
      const prior = await this.operation(tx, id);
      if (prior) {
        if (prior.start.actor_id !== actor.id || revision !== prior.start.base_revision || wechatMenuCanonical(prior.start.button) !== wechatMenuCanonical(button)) throw conflict('操作标识已用于其他发布内容');
        return { ...prior, snapshot, replayed: true };
      }
      if (revision !== snapshot.revision) throw conflict('公众号配置或本地菜单已变化，请重新读取后发布');
      if (history(snapshot.cache).issues.length && input.replace_history !== true) throw conflict('历史菜单不能完整编辑；须先核对原文并确认整体替换');
      const unresolved = await this.unresolved(tx, snapshot.config.appId);
      if (unresolved) throw conflict('存在结果待核对的发布，请先核对操作 ' + unresolved.operation_id);
      const start: Operation = { operation_id: id, phase: 0, actor_id: actor.id, resolver_id: actor.id, app_id: snapshot.config.appId,
        account_stamp: snapshot.accountStamp, base_revision: revision, button, state: 'admitted', provider_code: null,
        prior_cache: snapshot.cache, created_at: Math.floor(Date.now() / 1000), request_hash: '' };
      start.request_hash = this.admissionHash(start);
      await this.append(tx, start);
      return { start, final: undefined, snapshot, replayed: false };
    });
    if (admitted.replayed) return { ...dto(admitted.start, admitted.final), replayed: true };
    const start = admitted.start;
    let dispatched = false;
    let result: { outcome: 'accepted' | 'rejected' | 'unknown'; code?: number };
    try {
      result = await this.provider.create(admitted.snapshot.config, wechatMenuProviderButtons(button), async () => {
        await withAdminAuthorityWriteTx(this.container, actor, 'wechat_menu.manage', async tx => {
          await assertAdminWechatMenuOperationReady(tx); await this.configurationBarrier(tx); await this.accountLock(tx, start.app_id);
          const current = await this.snapshot(tx, actor), record = await this.operation(tx, id);
          if (!record || record.final || current.accountStamp !== start.account_stamp || current.cacheHash !== this.hash('cache', start.prior_cache)) throw conflict('公众号配置、菜单或发布状态已变化，未发出发布');
        });
        dispatched = true;
      });
    } catch {
      // Only the provider's before-POST boundary can distinguish safe no-dispatch.
      result = { outcome: dispatched ? 'unknown' : 'rejected' };
    }
    if (result.outcome === 'unknown') return { ...dto(start), replayed: false };
    try {
      const final = await withTx(this.container, async tx => {
        await assertAdminWechatMenuOperationReady(tx); await this.configurationBarrier(tx); await this.accountLock(tx, start.app_id);
        const record = await this.operation(tx, id);
        if (!record || record.final) throw conflict('菜单发布状态已变化，请读取原发布记录');
        let state: State = result.outcome === 'accepted' ? 'accepted' : dispatched ? 'rejected' : 'not_dispatched';
        const current = await this.snapshot(tx, actor);
        if (state === 'accepted') {
          if (current.accountStamp !== start.account_stamp || current.cacheHash !== this.hash('cache', start.prior_cache)) state = 'accepted_unstored';
          else await this.saveCache(tx, button);
        }
        const final: Operation = { ...start, phase: 1, state, provider_code: result.code ?? null, created_at: Math.floor(Date.now() / 1000) };
        final.request_hash = this.outcomeHash(start, final);
        await this.append(tx, final); return final;
      });
      return { ...dto(start, final), replayed: false };
    } catch { return { ...dto(start), replayed: false }; }
  }
  async legacyPublish(value: unknown, actor: Actor, operationId: string) {
    const input = object(value); fields(input, ['button']);
    const current = await this.read(actor);
    const original = await withAdminAuthorityWriteTx(this.container, actor, 'wechat_menu.manage', async tx => {
      await assertAdminWechatMenuOperationReady(tx);
      const prior = await this.operation(tx, wechatMenuOperationId(operationId));
      return prior?.start.base_revision;
    });
    const result = await this.publish({ operation_id: operationId, revision: original ?? current.revision, button: input.button, confirmed: true }, actor);
    // The old caller treats every status=200 as published. Preserve that truth
    // condition; uncertain/rejected/unprojected writes must be visible failures.
    if (result.state === 'unknown' || result.state === 'accepted_unstored') throw new ServiceUnavailableException('公众号菜单发布须人工核对，操作标识：' + result.operation_id);
    if (result.state !== 'accepted' && result.state !== 'observed_match') throw new ValidateException('公众号菜单未发布，请检查微信权限与内容；操作标识：' + result.operation_id);
    return result;
  }
  /** Observation is deliberately separate from resolution: a matching remote
   * menu does not prove which request created it. No failed observation clears
   * a pending request or fabricates an empty menu. */
  async observe(value: unknown, actor: Actor) {
    const id = wechatMenuOperationId(value);
    const prepared = await withAdminAuthorityWriteTx(this.container, actor, 'wechat_menu.manage', async tx => {
      await assertAdminWechatMenuOperationReady(tx);
      const record = await this.operation(tx, id);
      if (!record) throw new NotFoundException('菜单发布记录不存在');
      const snapshot = await this.snapshot(tx, actor); this.configured(snapshot);
      if (snapshot.accountStamp !== record.start.account_stamp) throw conflict('公众号凭据已变化，请在微信后台人工核对原账号');
      return { record, snapshot };
    });
    const result = await this.provider.read(prepared.snapshot.config, async () => {
      await withAdminAuthorityWriteTx(this.container, actor, 'wechat_menu.manage', async tx => {
        const current = await this.snapshot(tx, actor);
        if (current.accountStamp !== prepared.record.start.account_stamp) throw conflict('公众号凭据已变化');
      });
    });
    if (result.outcome !== 'read') return { receipt: dto(prepared.record.start, prepared.record.final), observed: false, provider_code: result.code ?? null };
    let matches = false;
    try { matches = wechatMenuCanonical(wechatMenuProviderButtons(normalizeWechatMenu(result.button, true))) === wechatMenuCanonical(wechatMenuProviderButtons(prepared.record.start.button)); } catch { /* preserve unsupported remote payload */ }
    return { receipt: dto(prepared.record.start, prepared.record.final), observed: true, remote_button: result.button, matches,
      observation: this.hash('observation', [actor.id, actor.authVersion, actor.expiresAt, id, prepared.snapshot.accountStamp, result.button]) };
  }
  /** An explicit human reconciliation, not a retry and not an attribution of
   * the previous remote write. Re-read the provider, verify the signed exact
   * observation, and preserve the distinct observed_match audit outcome. */
  async confirmObservation(value: unknown, body: unknown, actor: Actor) {
    const id = wechatMenuOperationId(value), input = object(body); fields(input, ['observation', 'confirmed']);
    if (input.confirmed !== true || typeof input.observation !== 'string' || !SHA.test(input.observation)) throw new ValidateException('请先读取线上菜单并明确确认匹配');
    const observed = await this.observe(id, actor);
    if (!observed.observed || !observed.matches || observed.observation !== input.observation) throw conflict('线上菜单未匹配或观察已变化，请重新核对');
    return withAdminAuthorityWriteTx(this.container, actor, 'wechat_menu.manage', async tx => {
      await assertAdminWechatMenuOperationReady(tx); await this.configurationBarrier(tx);
      const record = await this.operation(tx, id);
      if (!record) throw new NotFoundException('菜单发布记录不存在');
      if (record.final) return dto(record.start, record.final);
      if (Date.now() / 1000 < Number(record.start.created_at) + 30) throw conflict('原发布仍可能正在处理，请30秒后重新核对');
      await this.accountLock(tx, record.start.app_id);
      const current = await this.snapshot(tx, actor);
      if (current.accountStamp !== record.start.account_stamp || current.cacheHash !== this.hash('cache', record.start.prior_cache)) throw conflict('本地菜单或账号已变化，请保留原发布记录并人工核对');
      // Both explicit observations refer to this same credential revision.
      if (observed.observation !== this.hash('observation', [actor.id, actor.authVersion, actor.expiresAt, id, current.accountStamp, observed.remote_button])) throw conflict('公众号观察已失效');
      await this.saveCache(tx, record.start.button);
      const final: Operation = { ...record.start, phase: 1, state: 'observed_match', resolver_id: actor.id, provider_code: null, created_at: Math.floor(Date.now() / 1000) };
      final.request_hash = this.outcomeHash(record.start, final);
      await this.append(tx, final); return dto(record.start, final);
    });
  }
}
