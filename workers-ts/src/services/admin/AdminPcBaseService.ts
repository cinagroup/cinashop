import { createHmac } from 'node:crypto';
import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { acquireAdminAuthorityMenuLock } from '@/migrations/adminAuthorityOperation';
import { assertAdminPcBaseOperationReady } from '@/migrations/adminPcBaseOperation';
import { reviewedAdminWechatRoutineConfigGuardOid } from '@/migrations/adminWechatRoutineConfigCompatibility';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { readPcBaseImageReferences, assertPcBaseImageReplacements, renderPcBaseImages } from '@/services/pc/PcBaseAssetPolicy';
import { ApiException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { acquireAdminAuthorityWriteBarrier, adminAuthorityWriteError, assertAdminAuthoritySession,
  loadAdminAuthorityLiveActor, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { loadAdminProfileActor } from './AdminProfileService';
import { authorizeAdminLegacyProductRead, assertAdminLegacyProductReadDeadline } from './AdminLegacyProductReadAuthority';
import { parseLevelActivationJson } from './AdminLevelActivationInput';
import { createPcBasePlanningSnapshot, planPcBaseIntentSave, releasePcBasePlanningSnapshot } from './AdminPcBaseIntentPlan';
import { PC_BASE_INSERT_METADATA } from './AdminPcBaseMetadata';
import { PC_BASE_KEYS, normalizePcBaseReplacement, pcBaseRequestId, pcBaseRevision,
  type PcBaseKey, type PcBaseValues, type PcBaseSnapshot, type PcBaseReceipt } from '../../../../view/common/pcBase';
import { parsePcBaseIntentSave, type PcBaseIntentSave } from '../../../../view/common/pcBaseIntent';

const columns = { ...getTableColumns(systemConfig), version: sql<string>`xmin::text` };
type Row = typeof systemConfig.$inferSelect & { version: string };
type Snapshot = { rows: Row[]; winners: Map<PcBaseKey, Row>; revision: string };
type ReceiptRow = { operation_id: string; actor_id: number; operation: 'save' | 'resolve'; format_version: number;
  payload_hash: string; revision: string; state: 'committed' | 'not_applied';
  result: { revision: string; signature: string }; created_at: string | number };
const conflict = (message: string) => new HttpApiException(message, 409, 409);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const requestId = (value: unknown) => {
  if (!pcBaseRequestId(value)) throw new ValidateException('PC配置请求标识须为小写UUIDv4');
  return value;
};
const metadata = (row: Row) => { const { value: _value, version: _version, ...result } = row; return result; };
const byId = (rows: Row[]) => rows.slice().sort((a, b) => a.id - b.id);

/** Exact thirteen-field PC author. Raw bytes never leave a server snapshot.
 * Keep is zero system_config DML, including absent rows and invalid history.
 * No website-login credentials, environment secrets, provider calls, generic
 * config writer or request-time receipt installation is involved. */
export class AdminPcBaseService {
  constructor(private readonly container: Container, private readonly env: Env) {}

  private hash(domain: string, value: unknown) {
    if (!this.env.APP_KEY) throw new ServiceUnavailableException('PC配置签名未就绪');
    return createHmac('sha256', this.env.APP_KEY).update('cinashop.pc-base.' + domain + '.v1\0' + canonical(value)).digest('hex');
  }
  private async snapshot(tx: DbClient, actor: AdminAuthorityActor): Promise<Snapshot> {
    const rows = await tx.select(columns).from(systemConfig)
      .where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...PC_BASE_KEYS])))
      .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(65);
    if (rows.length > 64 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1024 * 1024) {
      throw new ServiceUnavailableException('PC配置超过完整读取容量，请先维护；不能截断历史行');
    }
    const winners = new Map<PcBaseKey, Row>();
    for (const row of rows) if (!winners.has(row.menuName as PcBaseKey)) winners.set(row.menuName as PcBaseKey, row);
    return { rows, winners, revision: this.hash('revision', [actor.id, actor.authVersion, actor.expiresAt, rows]) };
  }
  /** Only display decoding. A PHP JSON string containing an exact decimal is
   * projected as its numeric form-field value. Text whitespace is preserved;
   * malformed JSON, missing fields and malformed tables receive no defaults.
   * This decoder is never invoked for a kept value in the write path. */
  private decoded(key: PcBaseKey, raw: string): unknown {
    const value = parseLevelActivationJson(raw);
    if (['bast_number', 'first_number', 'product_phone_buy_url', 'links_open'].includes(key)
      && typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value)) return Number(value);
    return value;
  }
  private imageReferences(key: PcBaseKey, value: PcBaseValues[PcBaseKey]): string[] {
    if (key === 'pc_logo') return [value as string];
    if (key === 'filing_list') return (value as PcBaseValues['filing_list']).map(row => row.icon);
    return [];
  }
  /** The PC policy preserves safe stable HTTP and checks actual platform
   * attachment scope/raster/key/MIME for canonical references. Replacement
   * locks the actual selected rows; rendering is a separate read-only action.
   * No preserved raw history is ever passed to this method by save. */
  private async images(tx: DbClient, references: readonly string[]): Promise<string[]> {
    const result = await readPcBaseImageReferences(tx, references);
    if (result.length !== references.length) throw new ServiceUnavailableException('PC图片完整校验结果不一致');
    return result;
  }
  private async projection(tx: DbClient, snapshot: Snapshot): Promise<Omit<PcBaseSnapshot, 'runtime_ready'>> {
    const settings = {} as PcBaseSnapshot['settings'], fields = {} as PcBaseSnapshot['fields'];
    const issues: PcBaseSnapshot['issues'] = [], asset_previews: Record<string, string> = {};
    for (const key of PC_BASE_KEYS) {
      const row = snapshot.winners.get(key);
      settings[key] = null;
      fields[key] = { present: !!row, parseable: false, redacted: false };
      if (!row) { issues.push({ key, code: 'missing', message: '配置缺失；保留不会创建默认行，可明确替换' }); continue; }
      if (snapshot.rows.filter(item => item.menuName === key).length > 1) {
        issues.push({ key, code: 'duplicate', message: '存在历史重复行；仅排序、ID最高的来源行可明确替换，其余行保留' });
      }
      const expectedMetadata = PC_BASE_INSERT_METADATA[key];
      if (Object.entries(expectedMetadata).some(([name, expected]) => (row as unknown as Record<string, unknown>)[name] !== expected)) {
        issues.push({ key, code: 'metadata', message: '历史来源元数据与固定定义不同；保留原元数据，明确替换仅修改值' });
      }
      let decoded: unknown;
      try { decoded = this.decoded(key, row.value); fields[key].parseable = true; }
      catch { fields[key].redacted = true; issues.push({ key, code: 'invalid', message: '已存内容不是可安全读取的JSON；原始值可保留，未回显' }); continue; }
      try {
        const value = normalizePcBaseReplacement(key, decoded), references = this.imageReferences(key, value);
        const allowed = await this.images(tx, references);
        if (allowed.some((reference, index) => reference !== references[index])) throw Error('unavailable platform image');
        Object.assign(settings, { [key]: value });
        // Sign only independently authorized canonical references. Stored
        // tickets never reach this point; public values are not re-signed.
        const tokens = [...new Set(allowed.filter(reference => parseCanonicalAttachmentId(reference) !== null))];
        const rendered = tokens.length ? await renderPcBaseImages(this.env.APP_KEY, tokens) : [];
        const previews = new Map(tokens.map((reference, index) => [reference, rendered[index] ?? '']));
        allowed.forEach((reference, index) => { asset_previews[key === 'pc_logo' ? key : `${key}.${index}.icon`] = previews.get(reference) ?? reference; });
      } catch {
        settings[key] = null; fields[key].redacted = true;
        issues.push({ key, code: 'invalid', message: '已存内容或图片不能安全显示；可保留原值并编辑其他字段，原始值未回显' });
      }
    }
    return { settings, fields, revision: snapshot.revision, issues, asset_previews };
  }
  async read(actor: AdminAuthorityActor): Promise<PcBaseSnapshot> {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await authorizeAdminLegacyProductRead(tx, actor, 'pc_base.view');
      const snapshot = await this.snapshot(tx, actor), result = await this.projection(tx, snapshot);
      let runtime_ready = false;
      try { await assertAdminPcBaseOperationReady(tx); runtime_ready = true; }
      catch (error) { if (!(error instanceof ServiceUnavailableException)) throw error; }
      await assertAdminLegacyProductReadDeadline(tx, actor);
      return { ...result, runtime_ready };
    });
  }

  private signature(row: Omit<ReceiptRow, 'result'>, revision: string) { return this.hash('receipt', [row, revision]); }
  private async receiptRow(tx: DbClient, id: string, actor: AdminAuthorityActor): Promise<ReceiptRow | null> {
    const rows = await tx.execute<ReceiptRow>(sql`SELECT * FROM public.admin_pc_base_operation WHERE operation_id=${id}::uuid LIMIT 2`);
    if (!rows.length) return null;
    const row = rows[0], result = row.result;
    if (rows.length !== 1 || row.actor_id !== actor.id) throw conflict('PC配置请求不属于当前账号');
    const { result: _result, ...facts } = row;
    if (row.format_version !== 1 || !['save', 'resolve'].includes(row.operation) || !['committed', 'not_applied'].includes(row.state)
      || row.operation === 'save' && row.state !== 'committed' || row.operation === 'resolve' && row.state !== 'not_applied'
      || !pcBaseRequestId(row.operation_id) || !pcBaseRevision(row.revision) || !pcBaseRevision(row.payload_hash)
      || !Number.isSafeInteger(Number(row.created_at)) || Number(row.created_at) <= 0 || !result || Object.keys(result).sort().join(',') !== 'revision,signature'
      || !pcBaseRevision(result.revision) || result.signature !== this.signature({ ...facts, created_at: Number(row.created_at) }, result.revision)) {
      throw new ServiceUnavailableException('PC配置回执不完整，请保留原请求并人工核对');
    }
    return row;
  }
  private dto(row: ReceiptRow, replayed: boolean, cache_status: PcBaseReceipt['cache_status'] = 'not_required'): PcBaseReceipt {
    return { request_id: row.operation_id, actor_id: row.actor_id, state: row.state,
      revision: row.result.revision, created_at: Number(row.created_at), replayed, cache_status };
  }
  private async append(tx: DbClient, actor: AdminAuthorityActor, id: string, operation: ReceiptRow['operation'],
    payload: string, revision: string, after: string): Promise<ReceiptRow> {
    const [clock] = await tx.execute<{ now: number }>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
    if (!Number.isSafeInteger(clock?.now) || clock.now <= 0) throw new ServiceUnavailableException('数据库时钟无效');
    const facts: Omit<ReceiptRow, 'result'> = { operation_id: id, actor_id: actor.id, operation, format_version: 1,
      payload_hash: payload, revision, state: operation === 'save' ? 'committed' : 'not_applied', created_at: clock.now };
    const result = { revision: after, signature: this.signature(facts, after) };
    const saved = await tx.execute(sql`INSERT INTO public.admin_pc_base_operation(operation_id,actor_id,operation,format_version,payload_hash,revision,state,result,created_at)
      VALUES(${id}::uuid,${actor.id},${operation},1,${payload},${revision},${facts.state},${JSON.stringify(result)}::jsonb,${clock.now}) RETURNING operation_id`);
    if (saved.length !== 1 || saved[0].operation_id !== id) throw new ServiceUnavailableException('PC配置回执未完整保存');
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
    const checked = await this.receiptRow(tx, id, actor);
    if (!checked || canonical({ ...checked, created_at: Number(checked.created_at) }) !== canonical({ ...facts, result })) {
      throw new ServiceUnavailableException('PC配置回执回读不一致');
    }
    return checked;
  }
  private async barrier(tx: DbClient) {
    // PC has no OAuth account authority. The staff/menu fences were acquired
    // first; this physical relation lock also fences missing keys and raw DML.
    await tx.execute(sql`LOCK TABLE ONLY public.system_config IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    const routineGuardOid = await reviewedAdminWechatRoutineConfigGuardOid(tx);
    const [row] = await tx.execute<{ safe: boolean }>(sql`SELECT c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relowner=o.relowner AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal
        AND tgfoid IS DISTINCT FROM ${routineGuardOid}::oid) AS safe
      FROM pg_catalog.pg_class c CROSS JOIN pg_catalog.pg_class o
      WHERE c.oid=to_regclass('public.system_config') AND o.oid=to_regclass('public.admin_pc_base_operation')`);
    if (row?.safe !== true) throw new ServiceUnavailableException('PC配置存储目录已变化，请维护后再保存');
  }
  private async invalidate(): Promise<PcBaseReceipt['cache_status']> {
    const results = await Promise.allSettled(PC_BASE_KEYS.map(key => Promise.resolve().then(() => this.env.CONFIG_KV.delete('cfg_' + key))));
    return results.every(result => result.status === 'fulfilled') ? 'cleared' : 'pending';
  }
  private failure(error: unknown): never {
    try { adminAuthorityWriteError(error); }
    catch (mapped) {
      if (mapped instanceof ApiException) throw mapped;
      // Database errors can contain replacement/raw historical material.
      // Never retain their cause or publish them in the HTTP error message.
      throw new ServiceUnavailableException('PC配置未能确认保存，请保留原请求标识并读取回执');
    }
  }
  async save(value: unknown, actor: AdminAuthorityActor): Promise<PcBaseReceipt> {
    let input: PcBaseIntentSave;
    try { input = parsePcBaseIntentSave(value); } catch (error) { throw new ValidateException((error as Error).message); }
    assertAdminAuthoritySession(actor);
    const payload = this.hash('payload', input);
    let outcome: { row: ReceiptRow; replayed: boolean };
    try {
      outcome = await withTx(this.container, async tx => {
        // Mature staff -> menu order is essential: a role/menu edit cannot
        // invalidate the fresh exact1361+315 assignment before this commit.
        await acquireAdminAuthorityWriteBarrier(tx);
        await acquireAdminAuthorityMenuLock(tx);
        await loadAdminAuthorityLiveActor(tx, actor, 'pc_base.manage');
        await assertAdminPcBaseOperationReady(tx);
        const prior = await this.receiptRow(tx, input.request_id, actor);
        let result: { row: ReceiptRow; replayed: boolean };
        if (prior) {
          if (prior.state === 'committed' && prior.payload_hash !== payload) throw conflict('请求标识已用于不同的PC配置');
          result = { row: prior, replayed: true };
        } else {
          await this.barrier(tx);
          const before = await this.snapshot(tx, actor);
          if (before.revision !== input.revision) throw conflict('PC配置或来源元数据已变化，请重新读取后确认');
          const raw = Object.fromEntries(PC_BASE_KEYS.map(key => [key, before.winners.get(key)?.value ?? null])) as Record<PcBaseKey, string | null>;
          const handle = createPcBasePlanningSnapshot(before.revision, raw);
          try {
            const plan = planPcBaseIntentSave(input, handle), expected = before.rows.map(row => ({ ...row }));
            // Batch all explicit replacement media before any config DML:
            // lock canonical IDs in one global order across both image fields.
            const references = PC_BASE_KEYS.flatMap(key => {
              const field = input.fields[key];
              return field.action === 'replace' ? this.imageReferences(key, field.value) : [];
            });
            const allowed = await assertPcBaseImageReplacements(tx, references);
            if (allowed.length !== references.length || allowed.some((reference, index) => reference !== references[index])) {
              throw new ValidateException('请选择当前平台图库中的有效PC图片');
            }
            // Only explicit replacement entries exist in writes. Kept raw
            // values, including missing rows and bad JSON/tickets, are neither
            // decoded nor normalized nor checked for rendering permission.
            for (const write of plan.writes) {
              const key = write.key, intent = input.fields[key];
              if (intent.action !== 'replace') throw new ServiceUnavailableException('PC配置意图计划不一致');
              const winner = before.winners.get(key), raw = write.serialized_value;
              if (winner?.value === raw) continue;
              let saved: Row[];
              if (winner) {
                saved = await tx.update(systemConfig).set({ value: raw }).where(and(eq(systemConfig.id, winner.id),
                  eq(systemConfig.isStore, 0), eq(systemConfig.menuName, key), sql`xmin::text=${winner.version}`)).returning(columns);
              } else {
                saved = await tx.insert(systemConfig).values({ ...PC_BASE_INSERT_METADATA[key], menuName: key, value: raw, isStore: 0 }).returning(columns);
              }
              const current = saved[0];
              if (saved.length !== 1 || !current || current.value !== raw || current.menuName !== key || current.isStore !== 0
                || !Number.isSafeInteger(current.id) || current.id <= 0 || !/^[1-9]\d*$/u.test(current.version)) {
                throw new ServiceUnavailableException('PC配置写入结果不完整');
              }
              if (winner) {
                if (canonical(metadata(winner)) !== canonical(metadata(current))) throw new ServiceUnavailableException('PC配置来源元数据被改写');
                expected.splice(expected.findIndex(row => row.id === winner.id), 1);
              } else {
                const { id: _id, menuName: _name, isStore: _store, ...actual } = metadata(current);
                if (canonical(actual) !== canonical(PC_BASE_INSERT_METADATA[key])) throw new ServiceUnavailableException('PC配置缺行元数据与固定来源不一致');
              }
              expected.push(current);
            }
            await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
            const after = await this.snapshot(tx, actor);
            if (canonical(byId(after.rows)) !== canonical(byId(expected))) throw new ServiceUnavailableException('PC配置完整回读不一致');
            result = { row: await this.append(tx, actor, input.request_id, 'save', payload, input.revision, after.revision), replayed: false };
          } finally { releasePcBasePlanningSnapshot(handle); }
        }
        // Keep all fences through append, final fresh live permission and the
        // DB-clock deadline; withTx commits this same connection afterwards.
        await loadAdminAuthorityLiveActor(tx, actor, 'pc_base.manage');
        await assertAdminLegacyProductReadDeadline(tx, actor);
        return result;
      });
    } catch (error) { return this.failure(error); }
    return this.dto(outcome.row, outcome.replayed, outcome.row.state === 'committed' ? await this.invalidate() : 'not_required');
  }
  private async owner<T>(actor: AdminAuthorityActor, write: boolean, work: (tx: DbClient) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try {
      return await withTx(this.container, async tx => {
        if (write) await acquireAdminAuthorityWriteBarrier(tx);
        else {
          await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
          await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
        }
        // Recovery survives loss of the domain grant, but never logout,
        // disablement, password/session change or another actor's UUID.
        await loadAdminProfileActor(tx, actor);
        await assertAdminPcBaseOperationReady(tx);
        const result = await work(tx);
        if (write) await loadAdminProfileActor(tx, actor);
        await assertAdminLegacyProductReadDeadline(tx, actor);
        return result;
      });
    } catch (error) { return this.failure(error); }
  }
  async receipt(value: unknown, actor: AdminAuthorityActor): Promise<PcBaseReceipt> {
    const id = requestId(value);
    const row = await this.owner(actor, false, async tx => {
      const row = await this.receiptRow(tx, id, actor);
      if (!row) throw new NotFoundException('PC配置回执不存在');
      return row;
    });
    return this.dto(row, true, row.state === 'committed' ? await this.invalidate() : 'not_required');
  }
  async resolve(value: unknown, body: unknown, actor: AdminAuthorityActor): Promise<PcBaseReceipt> {
    const id = requestId(value);
    if (!body || typeof body !== 'object' || Array.isArray(body) || ![Object.prototype, null].includes(Object.getPrototypeOf(body))
      || Reflect.ownKeys(body).length !== 1 || !Object.hasOwn(body, 'confirmed')) throw new ValidateException('请明确确认核对并封存原PC配置请求');
    const descriptor = Object.getOwnPropertyDescriptor(body, 'confirmed');
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || descriptor.value !== true) throw new ValidateException('请明确确认核对并封存原PC配置请求');
    const outcome = await this.owner(actor, true, async tx => {
      const prior = await this.receiptRow(tx, id, actor);
      if (prior) return { row: prior, replayed: true };
      const signature = this.hash('absent', [id, actor.id]);
      return { row: await this.append(tx, actor, id, 'resolve', signature, signature, signature), replayed: false };
    });
    return this.dto(outcome.row, outcome.replayed, outcome.row.state === 'committed' ? await this.invalidate() : 'not_required');
  }
}
