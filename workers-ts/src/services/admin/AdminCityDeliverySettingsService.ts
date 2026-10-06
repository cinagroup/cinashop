import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { cityDeliveryCallbackEvent, cityDeliveryCallbackOutbox, cityDeliveryReconciliationCase, storeDeliveryOrder, systemConfig, systemLog } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { CITY_DELIVERY_CREDENTIAL_KEYS, CITY_DELIVERY_FLAG_KEYS, CITY_DELIVERY_INTENT_ACTIVE_QUOTA, CITY_DELIVERY_INTENT_TTL_SECONDS,
  type CityDeliveryCredentialActions, type CityDeliveryFlags, type CityDeliveryPreparedIntent, type CityDeliveryPrepareInput, type CityDeliverySettingsReceipt } from '../../../../view/common/cityDeliverySettings';
import { CityDeliverySecretCodec, cityCipherReady } from '@/services/delivery/CityDeliverySecretCodec';
import { CITY_DELIVERY_INTENT_PART_TYPE, CITY_DELIVERY_INTENT_TYPE, CITY_DELIVERY_RECEIPT_TYPE, CITY_DELIVERY_SETTINGS_LOCK_NAMESPACE,
  CityDeliverySettingsResolver, cityCredentialAad, citySettingsDeadlines, lockCityConfigForMutation, readCityDeliverySettingsInTx, type CityDeliverySettingsEnv } from '@/services/delivery/CityDeliverySettingsResolver';
import { cityActions, cityCanonical, cityConfirmInput, cityPrepareInput, citySettingsRequestId, CityDeliverySettingsRejected, CityDeliverySettingsStaleVersion } from './AdminCityDeliverySettingsInput';

export const CITY_DELIVERY_INTENT_MAX_PARTS = 32;
export const CITY_DELIVERY_INTENT_CHUNK_CHARACTERS = 200;
const intentPath = (uuid: string) => `/config/city-delivery/intent/${uuid}`;
const receiptPath = (uuid: string) => `/config/city-delivery/request/${uuid}`;
const NOW_MAX = 2147483647;
type ReceiptRecord = { receipt: CityDeliverySettingsReceipt; expires: number };
function actorId(actor: { id: number }) { if (!actor || !Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > NOW_MAX) throw new ValidateException('管理员身份无效'); return actor.id; }
function now() { const value = Math.floor(Date.now() / 1000); if (value <= 0 || value > NOW_MAX - CITY_DELIVERY_INTENT_TTL_SECONDS) throw Error('city_delivery_clock_invalid'); return value; }
function flagsCode(flags: CityDeliveryFlags) { return CITY_DELIVERY_FLAG_KEYS.map(key => flags[key]).join(''); }
function actionsCode(actions: CityDeliveryCredentialActions) { return CITY_DELIVERY_CREDENTIAL_KEYS.map(key => ({ keep: 'k', replace: 'r', clear: 'c' })[actions[key]]).join(''); }
function metadata(input: CityDeliveryPrepareInput, payload_hash: string): CityDeliverySettingsReceipt {
  return { version: 1, operation: 'update', request_id: input.request_id, client_nonce: input.client_nonce, revision: input.revision, payload_hash, flags: input.flags, actions: cityActions(input) };
}
function receiptAction(receipt: CityDeliverySettingsReceipt, expires: number) { return `v1;n=${receipt.client_nonce};h=${receipt.payload_hash};r=${receipt.revision};f=${flagsCode(receipt.flags)};a=${actionsCode(receipt.actions)};e=${expires}`; }
function parseReceipt(action: string, request_id: string): ReceiptRecord | null {
  const match = /^v1;n=([0-9a-f-]{36});h=([a-f0-9]{64});r=([a-f0-9]{64});f=([01]{4});a=([krc]{6});e=([1-9]\d{0,9})$/.exec(action);
  if (!match || Number(match[6]) > NOW_MAX) return null;
  try { citySettingsRequestId(match[1]); } catch { return null; }
  return { receipt: { version: 1, operation: 'update', request_id, client_nonce: match[1], payload_hash: match[2], revision: match[3],
    flags: Object.fromEntries(CITY_DELIVERY_FLAG_KEYS.map((key, index) => [key, Number(match[4][index])])) as CityDeliveryFlags,
    actions: Object.fromEntries(CITY_DELIVERY_CREDENTIAL_KEYS.map((key, index) => [key, ({ k: 'keep', r: 'replace', c: 'clear' } as const)[match[5][index] as 'k' | 'r' | 'c']])) as CityDeliveryCredentialActions }, expires: Number(match[6]) };
}
async function journal(tx: DbClient, uuid: string, actor: number): Promise<ReceiptRecord | null> {
  const rows = await tx.select({ action: systemLog.action, actor: systemLog.adminId }).from(systemLog)
    .where(and(eq(systemLog.type, CITY_DELIVERY_RECEIPT_TYPE), eq(systemLog.path, receiptPath(uuid)))).limit(2);
  if (!rows.length) return null;
  const result = rows.length === 1 && rows[0].actor === actor ? parseReceipt(rows[0].action, uuid) : null;
  if (!result) throw new ValidateException('请求标识已使用或配送回执异常');
  return result;
}
const intentAad = (actor: number, uuid: string, nonce: string, digest: string) => `city-delivery-intent:v1:${actor}:${uuid}:${nonce}:${digest}`;
async function intentDigest(codec: CityDeliverySecretCodec, actor: number, input: CityDeliveryPrepareInput) {
  return codec.digest(JSON.stringify({ actor, request_id: input.request_id, client_nonce: input.client_nonce, canonical: cityCanonical(input) }));
}
async function loadIntent(tx: DbClient, uuid: string, actor: number, env: CityDeliverySettingsEnv) {
  const rows = await tx.select({ actor: systemLog.adminId, type: systemLog.type, method: systemLog.method, action: systemLog.action }).from(systemLog)
    .where(and(eq(systemLog.path, intentPath(uuid)), inArray(systemLog.type, [CITY_DELIVERY_INTENT_TYPE, CITY_DELIVERY_INTENT_PART_TYPE]))).limit(CITY_DELIVERY_INTENT_MAX_PARTS + 2);
  if (!rows.length) throw new NotFoundException('准备意图不存在');
  if (rows.some(row => row.actor !== actor)) throw new ValidateException('准备意图不属于当前管理员或数据异常');
  const manifests = rows.filter(row => row.type === CITY_DELIVERY_INTENT_TYPE), parts = rows.filter(row => row.type === CITY_DELIVERY_INTENT_PART_TYPE);
  if (manifests.length !== 1 || manifests[0].method !== 'PREPARE') throw new ValidateException('准备意图数据异常');
  const match = /^v1;n=([0-9a-f-]{36});h=([a-f0-9]{64});p=([1-9]\d?);e=([1-9]\d{0,9})$/.exec(manifests[0].action);
  if (!match || Number(match[3]) > CITY_DELIVERY_INTENT_MAX_PARTS || Number(match[4]) > NOW_MAX || parts.length !== Number(match[3])) throw new ValidateException('准备意图数据异常');
  try { citySettingsRequestId(match[1]); } catch { throw new ValidateException('准备意图数据异常'); }
  const ordered = new Map<number, string>();
  for (const part of parts) {
    if (!/^\d{2}$/.test(part.method) || !part.action || part.action.length > CITY_DELIVERY_INTENT_CHUNK_CHARACTERS) throw new ValidateException('准备意图分片异常');
    const index = Number(part.method);
    if (index >= parts.length || ordered.has(index)) throw new ValidateException('准备意图分片异常');
    ordered.set(index, part.action);
  }
  const codec = new CityDeliverySecretCodec(env), sealed = [...Array(parts.length)].map((_, index) => ordered.get(index)).join('');
  let input: CityDeliveryPrepareInput;
  try {
    const decoded: unknown = JSON.parse(await codec.open(sealed, intentAad(actor, uuid, match[1], match[2])));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw Error('invalid');
    const envelope = decoded as Record<string, unknown>;
    if (Object.keys(envelope).length !== 2 || envelope.expires_at !== Number(match[4])) throw Error('invalid');
    input = cityPrepareInput(envelope.input);
  }
  catch { throw new ValidateException('准备意图无法安全恢复'); }
  if (input.request_id !== uuid || input.client_nonce !== match[1] || await intentDigest(codec, actor, input) !== match[2]) throw new ValidateException('准备意图认证不一致');
  return { input, digest: match[2], expires: Number(match[4]), receipt: metadata(input, match[2]) };
}
function prepared(receipt: CityDeliverySettingsReceipt, expires: number, state: CityDeliveryPreparedIntent['state'], applied: boolean): CityDeliveryPreparedIntent {
  return { ...receipt, intent_id: receipt.request_id, expires_at: expires, state, receipt: applied ? receipt : null };
}
function matchReceipt(receipt: CityDeliverySettingsReceipt, nonce: string, digest: string) { if (receipt.client_nonce !== nonce || receipt.payload_hash !== digest) throw new ValidateException('请求标识已用于其他配送意图'); }
function reject(input: CityDeliveryPrepareInput, digest: string, message: string): never { throw new CityDeliverySettingsRejected(message, input.request_id, input.client_nonce, digest); }
function validateEffective(input: CityDeliveryPrepareInput, digest: string, current: Awaited<ReturnType<typeof readCityDeliverySettingsInTx>>) {
  if (!current.snapshot.editable) reject(input, digest, '配送配置键存在身份异常，不能自动覆盖');
  const next = { ...current.values };
  for (const key of CITY_DELIVERY_CREDENTIAL_KEYS) { const action = input.credentials[key]; if (action.action === 'replace') next[key] = action.value; else if (action.action === 'clear') next[key] = ''; }
  const flags = input.flags, readiness = current.snapshot.readiness;
  if (flags.city_delivery_status && flags.dada_delivery_status && (!next.dada_app_key || !next.dada_app_sercret || !next.dada_source_id || !readiness.dada_client_id || !readiness.dada_callback_token)) reject(input, digest, '启用达达配送前须配置完整凭据和部署回调认证');
  if (flags.city_delivery_status && flags.uu_delivery_status && (!next.uupt_appkey || !next.uupt_app_id || !next.uupt_open_id || !readiness.uu_callback_token || !readiness.uu_timestamp_unit)) reject(input, digest, '启用UU配送前须配置完整凭据和已核实的部署协议');
  return next;
}
/** No provider calls. The table order is config -> delivery -> event -> outbox
 * -> reconciliation; receive uses config SHARE before inserting event/outbox. */
async function assertCredentialRotationSafe(tx: DbClient, providers: readonly ('dada' | 'uu')[], input: CityDeliveryPrepareInput, digest: string) {
  if (!providers.length) return;
  await tx.execute(sql`LOCK TABLE ${storeDeliveryOrder}, ${cityDeliveryCallbackEvent}, ${cityDeliveryCallbackOutbox}, ${cityDeliveryReconciliationCase} IN SHARE ROW EXCLUSIVE MODE`);
  const stationTypes = providers.map(provider => provider === 'dada' ? 1 : 2);
  const attempts = await tx.select({ id: storeDeliveryOrder.id }).from(storeDeliveryOrder)
    .where(and(inArray(storeDeliveryOrder.stationType, stationTypes), notInArray(storeDeliveryOrder.status, [-1, 4, 6, 10, 1000]))).limit(1);
  const events = await tx.select({ id: cityDeliveryCallbackEvent.id }).from(cityDeliveryCallbackEvent)
    .where(and(inArray(cityDeliveryCallbackEvent.provider, [...providers]), notInArray(cityDeliveryCallbackEvent.status, ['APPLIED', 'APPLIED_NOOP', 'SUPERSEDED', 'IGNORED']))).limit(1);
  const outboxes = await tx.select({ id: cityDeliveryCallbackOutbox.id }).from(cityDeliveryCallbackOutbox)
    .innerJoin(cityDeliveryCallbackEvent, eq(cityDeliveryCallbackEvent.id, cityDeliveryCallbackOutbox.eventId))
    .where(and(inArray(cityDeliveryCallbackEvent.provider, [...providers]), sql`${cityDeliveryCallbackOutbox.status} <> 'COMPLETED'`)).limit(1);
  const reconciliation = await tx.select({ id: cityDeliveryReconciliationCase.id }).from(cityDeliveryReconciliationCase)
    .where(and(inArray(cityDeliveryReconciliationCase.provider, [...providers]), sql`${cityDeliveryReconciliationCase.status} <> 'RESOLVED'`)).limit(1);
  if (attempts.length || events.length || outboxes.length || reconciliation.length) reject(input, digest, '该配送平台存在在途订单或未决事件，不能更换或清除凭据');
}

export class AdminCityDeliverySettingsService {
  constructor(private readonly container: Container, private readonly env: CityDeliverySettingsEnv) {}
  read() { return new CityDeliverySettingsResolver(this.container, this.env).read(); }
  async receipt(value: unknown, actor: { id: number }) {
    const uuid = citySettingsRequestId(value), id = actorId(actor);
    return withTx(this.container, async tx => { await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await citySettingsDeadlines(tx);
      const result = await journal(tx, uuid, id); if (!result) throw new NotFoundException('配送操作回执不存在'); return result.receipt; });
  }
  async intent(value: unknown, actor: { id: number }): Promise<CityDeliveryPreparedIntent> {
    const uuid = citySettingsRequestId(value), id = actorId(actor);
    return withTx(this.container, async tx => { await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`); await citySettingsDeadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CITY_DELIVERY_SETTINGS_LOCK_NAMESPACE},0)`);
      const applied = await journal(tx, uuid, id); if (applied) return prepared(applied.receipt, applied.expires, 'applied', true);
      const stored = await loadIntent(tx, uuid, id, this.env); return prepared(stored.receipt, stored.expires, now() >= stored.expires ? 'expired' : 'prepared', false); });
  }
  async prepare(value: unknown, actor: { id: number }): Promise<CityDeliveryPreparedIntent> {
    const input = cityPrepareInput(value), id = actorId(actor);
    if (!cityCipherReady(this.env)) throw new ValidateException('专用配送加密密钥未配置');
    const codec = new CityDeliverySecretCodec(this.env), digest = await intentDigest(codec, id, input);
    return withTx(this.container, async tx => { await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`); await citySettingsDeadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CITY_DELIVERY_SETTINGS_LOCK_NAMESPACE},0)`);
      const applied = await journal(tx, input.request_id, id);
      if (applied) { matchReceipt(applied.receipt, input.client_nonce, digest); return prepared(applied.receipt, applied.expires, 'applied', true); }
      const prior = await tx.select({ id: systemLog.id }).from(systemLog).where(and(eq(systemLog.path, intentPath(input.request_id)), inArray(systemLog.type, [CITY_DELIVERY_INTENT_TYPE, CITY_DELIVERY_INTENT_PART_TYPE]))).limit(1);
      if (prior.length) { const stored = await loadIntent(tx, input.request_id, id, this.env); matchReceipt(stored.receipt, input.client_nonce, digest); return prepared(stored.receipt, stored.expires, now() >= stored.expires ? 'expired' : 'prepared', false); }
      await lockCityConfigForMutation(tx);
      const current = await readCityDeliverySettingsInTx(tx, this.env);
      if (current.snapshot.revision !== input.revision) throw new CityDeliverySettingsStaleVersion(input.request_id, input.client_nonce, digest);
      validateEffective(input, digest, current);
      const clock = now(), active = await tx.execute(sql`SELECT l.id FROM ${systemLog} l WHERE l.type=${CITY_DELIVERY_INTENT_TYPE} AND l.admin_id=${id}
        AND l.add_time>${clock - CITY_DELIVERY_INTENT_TTL_SECONDS} AND NOT EXISTS (SELECT 1 FROM ${systemLog} r WHERE r.type=${CITY_DELIVERY_RECEIPT_TYPE}
          AND r.path=replace(l.path,'/intent/','/request/') AND r.admin_id=${id}) LIMIT ${CITY_DELIVERY_INTENT_ACTIVE_QUOTA}`);
      if (active.length >= CITY_DELIVERY_INTENT_ACTIVE_QUOTA) reject(input, digest, '未确认准备意图过多，请核对或等待已有意图过期');
      const expires = clock + CITY_DELIVERY_INTENT_TTL_SECONDS;
      const sealed = await codec.seal(JSON.stringify({ expires_at: expires, input }), intentAad(id, input.request_id, input.client_nonce, digest));
      const chunks = sealed.match(new RegExp(`.{1,${CITY_DELIVERY_INTENT_CHUNK_CHARACTERS}}`, 'g'))!;
      if (chunks.length > CITY_DELIVERY_INTENT_MAX_PARTS) throw Error('city_delivery_intent_capacity');
      await tx.insert(systemLog).values([{ adminId: id, type: CITY_DELIVERY_INTENT_TYPE, path: intentPath(input.request_id), method: 'PREPARE', action: `v1;n=${input.client_nonce};h=${digest};p=${chunks.length};e=${expires}`, addTime: clock },
        ...chunks.map((action, index) => ({ adminId: id, type: CITY_DELIVERY_INTENT_PART_TYPE, path: intentPath(input.request_id), method: String(index).padStart(2, '0'), action, addTime: clock }))]);
      return prepared(metadata(input, digest), expires, 'prepared', false);
    });
  }
  async confirm(value: unknown, actor: { id: number }): Promise<CityDeliverySettingsReceipt> {
    const input = cityConfirmInput(value), id = actorId(actor);
    return withTx(this.container, async tx => { await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`); await citySettingsDeadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CITY_DELIVERY_SETTINGS_LOCK_NAMESPACE},0)`);
      const applied = await journal(tx, input.request_id, id);
      if (applied) { matchReceipt(applied.receipt, input.client_nonce, input.payload_hash); return applied.receipt; }
      const stored = await loadIntent(tx, input.request_id, id, this.env); matchReceipt(stored.receipt, input.client_nonce, input.payload_hash);
      await lockCityConfigForMutation(tx);
      if (now() >= stored.expires) reject(stored.input, stored.digest, '准备意图已过期且未应用，请重新读取后创建新意图');
      const current = await readCityDeliverySettingsInTx(tx, this.env);
      if (current.snapshot.revision !== stored.input.revision) throw new CityDeliverySettingsStaleVersion(input.request_id, input.client_nonce, input.payload_hash);
      const next = validateEffective(stored.input, stored.digest, current), changed = CITY_DELIVERY_CREDENTIAL_KEYS.filter(key => stored.input.credentials[key].action !== 'keep' && (next[key] !== current.values[key] || current.snapshot.credentials[key].source === 'invalid'));
      const providers = [...new Set(changed.map(key => key.startsWith('dada_') ? 'dada' as const : 'uu' as const))];
      await assertCredentialRotationSafe(tx, providers, stored.input, stored.digest);
      // Recheck wall time after waits; expiry is always before any effective DML.
      if (now() >= stored.expires) reject(stored.input, stored.digest, '准备意图已过期且未应用，请重新读取后创建新意图');
      const codec = new CityDeliverySecretCodec(this.env), writes: Array<[string, string]> = CITY_DELIVERY_FLAG_KEYS.map(key => [key, String(stored.input.flags[key])]);
      for (const key of CITY_DELIVERY_CREDENTIAL_KEYS) { const action = stored.input.credentials[key]; if (action.action === 'keep') continue;
        const payload = action.action === 'replace' ? { version: 1, state: 'value', value: action.value } : { version: 1, state: 'cleared' };
        writes.push([key, await codec.seal(JSON.stringify(payload), cityCredentialAad(key))]); }
      for (const [key, value] of writes) { const winner = current.winners.get(key);
        if (winner) await tx.update(systemConfig).set({ value }).where(eq(systemConfig.id, winner.id));
        else await tx.insert(systemConfig).values({ menuName: key, isStore: 0, value, info: key, type: 'text', inputType: 'input' }); }
      await tx.insert(systemLog).values({ adminId: id, type: CITY_DELIVERY_RECEIPT_TYPE, path: receiptPath(input.request_id), page: CITY_DELIVERY_RECEIPT_TYPE, method: 'POST', action: receiptAction(stored.receipt, stored.expires), addTime: now() });
      return stored.receipt;
    });
  }
}
