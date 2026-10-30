import { createHmac } from 'node:crypto';
import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { inspectAdminWechatBaseOperation, assertAdminWechatBaseOperationReady } from '@/migrations/adminWechatBaseOperation';
import { normalizeConfigScalar } from '@/utils/config';
import { ApiException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { publicHotwordAuthorImages, renderHotwordAuthorImages } from '@/services/product/HotwordAuthorAssetPolicy';
import { followImportedImageUrl } from '@/services/wechat/WechatFollowPosterService';
import { validateWechatCallbackSecret } from '@/services/wechat/WechatCallbackCrypto';
import { acquireAdminAuthorityWriteBarrier, withAdminAuthorityWriteTx, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { loadAdminProfileActor } from './AdminProfileService';
import { authorizeAdminLegacyProductRead, assertAdminLegacyProductReadDeadline } from './AdminLegacyProductReadAuthority';
import { WECHAT_BASE_CALLBACK_AUTHORITY_KEY, WECHAT_BASE_KEYS, WECHAT_BASE_PUBLIC_KEYS, WECHAT_BASE_SECRET_KEYS, parseWechatBaseSave,
  normalizeWechatBaseValues, validWechatBaseSecret, wechatBaseRequestId, wechatBaseRevision,
  type WechatBaseSave, type WechatBaseSnapshot, type WechatBaseReceipt, type WechatBaseValues } from '../../../../view/common/wechatBase';

const names = [...WECHAT_BASE_KEYS, WECHAT_BASE_CALLBACK_AUTHORITY_KEY, 'site_url', 'api'];
const columns = { ...getTableColumns(systemConfig), version: sql<string>`xmin::text` };
type Row = typeof systemConfig.$inferSelect & { version: string };
type Snapshot = { rows: Row[]; winners: Map<string, Row>; revision: string };
type ReceiptRow = { operation_id: string; actor_id: number; operation: 'save' | 'resolve'; format_version: number; payload_hash: string; revision: string;
  state: 'committed' | 'not_applied'; result: { revision: string; signature: string }; created_at: string | number };
const conflict = (message: string) => new HttpApiException(message, 409, 409);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const requestId = (value: unknown) => { if (!wechatBaseRequestId(value)) throw new ValidateException('公众号配置请求标识须为小写UUIDv4'); return value; };

/** Nine exact fixed-PHP fields. No arbitrary config writer, provider request,
 * secret readback or secret-bearing journal/audit row is exposed. */
export class AdminWechatBaseService {
  constructor(private readonly container: Container, private readonly env: Env) {}
  private hash(domain: string, value: unknown) {
    if (!this.env.APP_KEY) throw new ServiceUnavailableException('公众号配置签名未就绪');
    return createHmac('sha256', this.env.APP_KEY).update('cinashop.wechat-base.' + domain + '.v1\0' + canonical(value)).digest('hex');
  }
  private async snapshot(tx: DbClient, actor: AdminAuthorityActor): Promise<Snapshot> {
    const rows = await tx.select(columns).from(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, names)))
      .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(65);
    if (rows.length > 64) throw new ServiceUnavailableException('公众号配置重复行超过完整读取容量，请先维护');
    const winners = new Map<string, Row>(); for (const row of rows) if (!winners.has(row.menuName)) winners.set(row.menuName, row);
    return { rows, winners, revision: this.hash('revision', [actor.id, actor.authVersion, actor.expiresAt, rows]) };
  }
  private text(snapshot: Snapshot, key: string) { return normalizeConfigScalar(snapshot.winners.get(key)?.value); }
  private callback(snapshot: Snapshot): WechatBaseSnapshot['callback'] {
    const token = this.env.WECHAT_OFFICIAL_CALLBACK_TOKEN ?? '', aes = this.env.WECHAT_OFFICIAL_CALLBACK_AES_KEY ?? '';
    const tokenPresent = token.length > 0, aesPresent = aes.length > 0;
    const database_enabled = snapshot.winners.get(WECHAT_BASE_CALLBACK_AUTHORITY_KEY)?.value === 'database';
    const appId = this.text(snapshot, 'wechat_appid'), rawMode = this.text(snapshot, 'wechat_encode');
    const mode = /^(?:0|1|2)$/u.test(rawMode) ? Number(rawMode) as 0 | 1 | 2 : null;
    let ready = !!appId && appId.length <= 64;
    const authority = tokenPresent || aesPresent ? 'deployment' : database_enabled ? 'database' : 'disabled';
    if (authority === 'deployment') {
      try { validateWechatCallbackSecret(token, aes); if (!token.trim()) ready = false; } catch { ready = false; }
    } else if (authority === 'database') ready = ready && mode !== null && validWechatBaseSecret('wechat_token', this.text(snapshot, 'wechat_token'))
      && (mode === 0 || validWechatBaseSecret('wechat_encodingaeskey', this.text(snapshot, 'wechat_encodingaeskey')));
    else ready = false;
    return { database_enabled, authority, ready, mode: authority === 'deployment' ? 2 as const : authority === 'database' ? mode : null,
      deployment_token_present: tokenPresent, deployment_aes_present: aesPresent };
  }
  private async image(tx: DbClient, reference: string, lock = false): Promise<string> {
    if (!reference) return '';
    if (reference.startsWith('/api/assets/')) {
      if (parseCanonicalAttachmentId(reference) === null || (await publicHotwordAuthorImages(tx, [reference], lock))[0] !== reference) throw new ValidateException('请选择当前平台图库中的有效二维码图片');
      return (await renderHotwordAuthorImages(this.env.APP_KEY, [reference]))[0] ?? '';
    }
    return followImportedImageUrl(reference, this.env);
  }
  async read(actor: AdminAuthorityActor): Promise<WechatBaseSnapshot> {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await authorizeAdminLegacyProductRead(tx, actor, 'wechat_base.view');
      const snapshot = await this.snapshot(tx, actor), issues: WechatBaseSnapshot['issues'] = [];
      const settings = {} as WechatBaseSnapshot['settings'], raw_public_values = {} as WechatBaseSnapshot['raw_public_values'];
      const fallback: WechatBaseValues = { wechat_appid: '', wechat_encode: 0, share_qrcode: 0, spread_share_forever: 0, wechat_qrcode: '', create_wechat_user: 0 };
      for (const key of WECHAT_BASE_PUBLIC_KEYS) {
        const row = snapshot.winners.get(key); raw_public_values[key] = row?.value ?? null;
        try {
          if (!row) throw Error('配置缺失，请明确填写或选择');
          const text = this.text(snapshot, key), value = ['wechat_encode', 'share_qrcode', 'spread_share_forever', 'create_wechat_user'].includes(key) ? (/^[0-2]$/u.test(text) ? Number(text) : null) : text;
          (settings as Record<string, unknown>)[key] = normalizeWechatBaseValues({ ...fallback, [key]: value })[key];
        } catch (error) { (settings as Record<string, unknown>)[key] = null; issues.push({ key, message: (error as Error).message }); }
      }
      const secrets = {} as WechatBaseSnapshot['secrets'];
      for (const key of WECHAT_BASE_SECRET_KEYS) { const text = this.text(snapshot, key); secrets[key] = { present: !!text, valid: validWechatBaseSecret(key, text) };
        if (text && !secrets[key].valid) issues.push({ key, message: '已存密钥格式异常；可保留原值或明确替换，原值不回显' }); }
      let preview = ''; try { preview = await this.image(tx, this.text(snapshot, 'wechat_qrcode')); }
      catch { issues.push({ key: 'wechat_qrcode', message: '已存二维码暂不能安全预览；原始引用保留，换图须通过当前图库或已配置图片域名验证' }); }
      let api: string | null = null;
      try { const origin = new URL(this.text(snapshot, 'site_url')); if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.hash || origin.search || origin.pathname !== '/') throw Error(); api = origin.origin + '/api/wechat/serve'; }
      catch { issues.push({ key: 'api', message: '站点URL未配置为完整站点来源，暂不能生成回调地址' }); }
      const result: WechatBaseSnapshot = { settings, raw_public_values, secrets, revision: snapshot.revision, runtime_ready: await inspectAdminWechatBaseOperation(tx), api,
        callback: this.callback(snapshot), asset_previews: { wechat_qrcode: preview }, issues };
      await assertAdminLegacyProductReadDeadline(tx, actor); return result;
    });
  }
  private signature(row: Omit<ReceiptRow, 'result'>, revision: string) { return this.hash('receipt', [row, revision]); }
  private async receiptRow(tx: DbClient, id: string, actor: AdminAuthorityActor): Promise<ReceiptRow | null> {
    const rows = await tx.execute<ReceiptRow>(sql`SELECT * FROM public.admin_wechat_base_operation WHERE operation_id=${id}::uuid LIMIT 2`);
    if (!rows.length) return null; const row = rows[0], result = row.result;
    if (rows.length !== 1 || row.actor_id !== actor.id) throw conflict('公众号配置请求不属于当前账号');
    const { result: _result, ...facts } = row;
    if (row.format_version !== 1 || !['save', 'resolve'].includes(row.operation) || !['committed', 'not_applied'].includes(row.state)
      || row.operation === 'save' && row.state !== 'committed' || row.operation === 'resolve' && row.state !== 'not_applied'
      || !wechatBaseRequestId(row.operation_id) || !wechatBaseRevision(row.revision) || !wechatBaseRevision(row.payload_hash)
      || !Number.isSafeInteger(Number(row.created_at)) || Number(row.created_at) <= 0 || !result || Object.keys(result).sort().join(',') !== 'revision,signature'
      || !wechatBaseRevision(result.revision) || result.signature !== this.signature({ ...facts, created_at: Number(row.created_at) }, result.revision)) throw new ServiceUnavailableException('公众号配置回执不完整，请保留原请求并人工核对');
    return row;
  }
  private dto(row: ReceiptRow, replayed: boolean, cache_status: WechatBaseReceipt['cache_status'] = 'not_required'): WechatBaseReceipt {
    return { request_id: row.operation_id, actor_id: row.actor_id, state: row.state, revision: row.result.revision, created_at: Number(row.created_at), replayed, cache_status };
  }
  private async append(tx: DbClient, actor: AdminAuthorityActor, id: string, operation: ReceiptRow['operation'], payload: string, revision: string, after: string): Promise<ReceiptRow> {
    const [clock] = await tx.execute<{ now: number }>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
    if (!Number.isSafeInteger(clock?.now) || clock.now <= 0) throw new ServiceUnavailableException('数据库时钟无效');
    const facts: Omit<ReceiptRow, 'result'> = { operation_id: id, actor_id: actor.id, operation, format_version: 1, payload_hash: payload, revision,
      state: operation === 'save' ? 'committed' : 'not_applied', created_at: clock.now };
    const result = { revision: after, signature: this.signature(facts, after) };
    const saved = await tx.execute(sql`INSERT INTO public.admin_wechat_base_operation(operation_id,actor_id,operation,format_version,payload_hash,revision,state,result,created_at)
      VALUES(${id}::uuid,${actor.id},${operation},1,${payload},${revision},${facts.state},${JSON.stringify(result)}::jsonb,${clock.now}) RETURNING operation_id`);
    if (saved.length !== 1 || saved[0].operation_id !== id) throw new ServiceUnavailableException('公众号配置回执未完整保存');
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
    const checked = await this.receiptRow(tx, id, actor); if (!checked || canonical({ ...checked, created_at: Number(checked.created_at) }) !== canonical({ ...facts, result })) throw new ServiceUnavailableException('公众号配置回执回读不一致');
    return checked;
  }
  private async barrier(tx: DbClient) {
    // Coordinate this bounded credential writer with permanent-QR publication.
    // Restricted App has SELECT only on configuration; no table-lock or DML
    // capability is added. Maintenance SQL remains a separately reviewed path.
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731659,0) AS locked`);
    if (gate?.locked !== true) throw new ServiceUnavailableException('公众号二维码结果正在提交，请稍后重新核对配置');
    await tx.execute(sql`LOCK TABLE ONLY public.system_config IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    const [row] = await tx.execute<{ safe: boolean }>(sql`SELECT c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relowner=o.relowner AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal) AS safe
      FROM pg_class c CROSS JOIN pg_class o WHERE c.oid=to_regclass('public.system_config') AND o.oid=to_regclass('public.admin_wechat_base_operation')`);
    if (row?.safe !== true) throw new ServiceUnavailableException('公众号配置存储目录已变化，请维护后再保存');
  }
  private async invalidate(): Promise<WechatBaseReceipt['cache_status']> {
    const results = await Promise.allSettled([...WECHAT_BASE_KEYS, WECHAT_BASE_CALLBACK_AUTHORITY_KEY].map(key => Promise.resolve().then(() => this.env.CONFIG_KV.delete('cfg_' + key))));
    return results.every(x => x.status === 'fulfilled') ? 'cleared' : 'pending';
  }
  async save(value: unknown, actor: AdminAuthorityActor): Promise<WechatBaseReceipt> {
    let input: WechatBaseSave; try { input = parseWechatBaseSave(value); } catch (error) { throw new ValidateException((error as Error).message); }
    const payload = this.hash('payload', input);
    let outcome: { row: ReceiptRow; replayed: boolean };
    try { outcome = await withAdminAuthorityWriteTx(this.container, actor, 'wechat_base.manage', async tx => {
      await assertAdminWechatBaseOperationReady(tx);
      const prior = await this.receiptRow(tx, input.request_id, actor);
      if (prior) { if (prior.state === 'committed' && prior.payload_hash !== payload) throw conflict('请求标识已用于不同的公众号配置'); return { row: prior, replayed: true }; }
      await this.barrier(tx); const before = await this.snapshot(tx, actor);
      if (before.revision !== input.revision) throw conflict('公众号配置或来源元数据已变化，请重新读取后确认');
      if (input.settings.wechat_appid !== this.text(before, 'wechat_appid')) {
        // Legacy permanent tickets carry no generating AppID. Retain their
        // history and deny implicit adoption by a different official account.
        // Provisioners hold the shared account advisory gate while publishing.
        await tx.execute(sql`LOCK TABLE ONLY public.qrcode IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
        const history = await tx.execute(sql`SELECT id FROM public.qrcode WHERE third_type IN ('reply','wechatqrcode')
          AND (COALESCE(ticket,'')<>'' OR COALESCE(url,'')<>'') LIMIT 1`);
        if (history.length) throw conflict('存在尚未绑定所属公众号的永久二维码历史，暂不能切换AppID；请先完成二维码账号迁移');
      }
      const next = new Map<string, string>(WECHAT_BASE_PUBLIC_KEYS.map(key => [key, String(input.settings[key])]));
      for (const key of WECHAT_BASE_SECRET_KEYS) { const intent = input.secrets[key]; if (intent.action !== 'keep') next.set(key, intent.action === 'clear' ? '' : intent.value); }
      next.set(WECHAT_BASE_CALLBACK_AUTHORITY_KEY, input.database_callback ? 'database' : 'deployment');
      const get = (key: string) => next.has(key) ? next.get(key)! : this.text(before, key);
      if (input.database_callback && (!/^wx[A-Za-z0-9]{16}$/u.test(get('wechat_appid')) || !validWechatBaseSecret('wechat_token', get('wechat_token'))
        || input.settings.wechat_encode !== 0 && !validWechatBaseSecret('wechat_encodingaeskey', get('wechat_encodingaeskey')))) throw new ValidateException('启用数据库回调前，请配置有效AppID、Token及所选模式所需的EncodingAESKey');
      if (input.settings.wechat_qrcode !== this.text(before, 'wechat_qrcode')) await this.image(tx, input.settings.wechat_qrcode, true);
      const expected = before.rows.map(row => ({ ...row }));
      for (const [key, value] of next) {
        const winner = before.winners.get(key);
        const raw = key === WECHAT_BASE_CALLBACK_AUTHORITY_KEY ? value : JSON.stringify(value);
        const secretChanged = (WECHAT_BASE_SECRET_KEYS as readonly string[]).includes(key);
        if (winner && (secretChanged || key === WECHAT_BASE_CALLBACK_AUTHORITY_KEY ? winner.value === raw : normalizeConfigScalar(winner.value) === value)) continue;
        let saved: Row[];
        if (winner) saved = await tx.update(systemConfig).set({ value: raw }).where(and(eq(systemConfig.id, winner.id), eq(systemConfig.isStore, 0), eq(systemConfig.menuName, key), sql`xmin::text=${winner.version}`)).returning(columns);
        else saved = await tx.insert(systemConfig).values({ menuName: key, value: raw, isStore: 0, configTabId: 2, type: key === 'wechat_qrcode' ? 'upload' : 'text', inputType: 'input', info: key, status: 1 }).returning(columns);
        if (saved.length !== 1 || saved[0].value !== raw || saved[0].menuName !== key || saved[0].isStore !== 0) throw new ServiceUnavailableException('公众号配置写入结果不完整');
        if (winner) { const { value: _value, version: _version, ...oldMeta } = winner, { value: _savedValue, version: _savedVersion, ...newMeta } = saved[0]; if (canonical(oldMeta) !== canonical(newMeta)) throw new ServiceUnavailableException('公众号配置来源元数据被改写'); expected.splice(expected.findIndex(row => row.id === winner.id), 1); }
        expected.push(saved[0]);
      }
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      const after = await this.snapshot(tx, actor); const byId = (rows: Row[]) => rows.slice().sort((a, b) => a.id - b.id);
      if (canonical(byId(after.rows)) !== canonical(byId(expected))) throw new ServiceUnavailableException('公众号配置完整回读不一致');
      return { row: await this.append(tx, actor, input.request_id, 'save', payload, input.revision, after.revision), replayed: false };
    }); } catch (error) {
      // A database driver error can carry SQL parameters, including replacement
      // credentials. Never attach it as a cause or let the HTTP logger see it.
      if (error instanceof ApiException) throw error;
      throw new ServiceUnavailableException('公众号配置未能确认保存，请保留原请求标识并读取回执');
    }
    return this.dto(outcome.row, outcome.replayed, outcome.row.state === 'committed' ? await this.invalidate() : 'not_required');
  }
  private owner<T>(actor: AdminAuthorityActor, write: boolean, work: (tx: DbClient) => Promise<T>) {
    return withTx(this.container, async tx => {
      if (write) await acquireAdminAuthorityWriteBarrier(tx);
      else { await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await tx.execute(sql`SET LOCAL statement_timeout='5s'`); }
      await loadAdminProfileActor(tx, actor); await assertAdminWechatBaseOperationReady(tx);
      const result = await work(tx); await assertAdminLegacyProductReadDeadline(tx, actor); return result;
    });
  }
  async receipt(value: unknown, actor: AdminAuthorityActor) {
    const id = requestId(value);
    const row = await this.owner(actor, false, async tx => { const row = await this.receiptRow(tx, id, actor); if (!row) throw new NotFoundException('公众号配置回执不存在'); return row; });
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
