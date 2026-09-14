import { sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { shippingTemplates, shippingTemplatesRegion } from '@/models/schema';
import { HttpApiException, ValidateException } from '@/utils/errors';
import { normalizeOutRequestKey, outRequestHash } from '../out/OutIdempotency';
import { boundShippingTemplateTransaction } from '../order/ShippingTemplateSnapshot';
import { cityAuthority, normalizeSupplierShippingTemplateInput, replaceRules } from './ShippingTemplateRules';
import { parseFlatAdminShippingInput, shippingInputRecord } from './FlatShippingTemplateInput';

/** These values must come from fresh authenticated middleware, never the body.
 * Actor IDs are stable database IDs, not session tokens, so recovery survives login.
 * HTTP callers require keys; deployment still requires the migration + UI rollout.
 */
export interface ShippingCreationActor { ownerType: 0 | 2; relationId: number; actorId: number }
export interface ShippingCreationReceipt {
  version: 'shipping-create-v1'; requestKey: string; requestHash: string; id: number;
}
const LOCK_NAMESPACE = 731_605;
function scope(value: ShippingCreationActor): ShippingCreationActor {
  if (!value || ![0, 2].includes(value.ownerType) || !Number.isSafeInteger(value.relationId)
    || value.relationId < 0 || value.relationId > 2_147_483_647
    || (value.ownerType === 0 ? value.relationId !== 0 : value.relationId === 0)
    || !Number.isSafeInteger(value.actorId) || value.actorId <= 0 || value.actorId > 2_147_483_647) {
    throw new ValidateException('运费创建身份无效');
  }
  return { ownerType: value.ownerType, relationId: value.relationId, actorId: value.actorId };
}
async function lock(tx: DbClient, actor: ShippingCreationActor, key: string) {
  await boundShippingTemplateTransaction(tx);
  // Hidden replay rows must fail, not look absent and authorize another create.
  await tx.execute(sql`SET LOCAL row_security = off`);
  const hash = await outRequestHash([actor.ownerType, actor.relationId, actor.actorId, key]);
  const lockId = Number.parseInt(hash.slice(0, 8), 16) | 0;
  // Collisions only serialize unrelated operations; the full SQL PK is authoritative.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int, ${lockId}::int)`);
}
async function read(tx: DbClient, actor: ShippingCreationActor, key: string): Promise<ShippingCreationReceipt | null> {
  const rows = await tx.select({ id: sql<number>`template_id`, requestHash: sql<string>`request_hash` })
    .from(sql`shipping_template_create_replay`)
    .where(sql`owner_type=${actor.ownerType} AND relation_id=${actor.relationId} AND actor_id=${actor.actorId} AND request_key=${key}::uuid`)
    .limit(2);
  if (!rows.length) return null;
  const row = rows[0];
  if (rows.length !== 1 || !Number.isSafeInteger(row.id) || row.id <= 0 || row.id > 2_147_483_647
    || typeof row.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.requestHash)) {
    throw new HttpApiException('运费创建回执异常，不能确认结果', 503, 503);
  }
  return { version: 'shipping-create-v1', requestKey: key, requestHash: row.requestHash, id: row.id };
}

/** Atomically persist the parent, all three rule families and its durable receipt.
 * Replay is checked before mutable city/template data: a later edit, retirement,
 * deletion or city change must not turn a committed creation into a new one.
 * The returned ID proves creation, not continued access to a current template.
 * No cache, retry, post-response write or external call is part of the protocol.
 */
export async function createShippingTemplateOnce(container: Container, identity: ShippingCreationActor,
  requestKey: unknown, raw: Record<string, unknown>): Promise<ShippingCreationReceipt & { replayed: boolean }> {
  const actor = scope(identity), key = normalizeOutRequestKey(requestKey);
  const input = normalizeSupplierShippingTemplateInput(raw);
  const status = actor.ownerType === 2 ? 1 : raw.status ?? 1;
  if (status !== 0 && status !== 1) throw new ValidateException('运费模板状态无效');
  // Hash only server-normalized persisted input, excluding client identity/IDs.
  // Normalization has copied the bounded arrays before the first await.
  const hash = await outRequestHash({ version: 'shipping-create-v1', input, status });
  return commitCreation(container, actor, key, hash, async tx => {
    const cities = await cityAuthority(tx, input);
    const now = Math.floor(Date.now() / 1000);
    const [created] = await tx.insert(shippingTemplates).values({ ownerType: actor.ownerType,
      relationId: actor.relationId, name: input.name, type: input.billingType, appoint: input.appoint,
      noDelivery: input.noDelivery, sort: input.sort, status, isDel: 0, addTime: now }).returning({ id: shippingTemplates.id });
    if (!created || !Number.isSafeInteger(created.id) || created.id <= 0) throw new Error('运费模板创建失败');
    await replaceRules(tx, created.id, input, cities, now);
    return created.id;
  });
}

/** Preserve legacy flat creation, including name-only/default fields and empty
 * regions. Flat and grouped formats share the SAME receipt key scope, but hash
 * distinct persisted representations. Switching formats cannot mint another ID.
 * This is not an edit API and does not accept supplier ownership.
 */
export async function createFlatShippingTemplateOnce(container: Container, identity: ShippingCreationActor,
  requestKey: unknown, raw: unknown): Promise<ShippingCreationReceipt & { replayed: boolean }> {
  const actor = scope(identity), key = normalizeOutRequestKey(requestKey);
  if (actor.ownerType !== 0) throw new ValidateException('旧扁平模板创建仅支持平台身份');
  const body = shippingInputRecord(raw);
  if (['region_info', 'appoint_info', 'no_delivery_info'].some(field => field in body)) {
    throw new ValidateException('分组模板不能通过旧扁平创建入口提交');
  }
  const parsed = parseFlatAdminShippingInput(body);
  if (parsed.id !== 0 || !parsed.fields.name) throw new ValidateException('创建接口不能编辑已有模板');
  const input = { name: parsed.fields.name, type: parsed.fields.type ?? 1, sort: parsed.fields.sort ?? 0,
    status: parsed.fields.status ?? 1, regions: parsed.regions ?? [] };
  // Defaults and decimals are normalized before hashing, and no caller-owned
  // objects survive the first await. Preserve legacy region names, not city paths.
  const hash = await outRequestHash({ version: 'shipping-create-v1', format: 'legacy-flat-v1', input });
  return commitCreation(container, actor, key, hash, async tx => {
    const now = Math.floor(Date.now() / 1000);
    const [created] = await tx.insert(shippingTemplates).values({ name: input.name, type: input.type,
      sort: input.sort, status: input.status, ownerType: 0, relationId: 0, appoint: 0, noDelivery: 0,
      isDel: 0, addTime: now }).returning({ id: shippingTemplates.id });
    if (!created || !Number.isSafeInteger(created.id) || created.id <= 0) throw new Error('运费模板创建失败');
    if (input.regions.length) await tx.insert(shippingTemplatesRegion).values(
      input.regions.map(row => ({ ...row, templateId: created.id, billingGroup: input.type, addTime: now })),
    );
    return created.id;
  });
}

/** Private transaction boundary; callers cannot provide an alternate lock or ledger. */
async function commitCreation(container: Container, actor: ShippingCreationActor, key: string,
  hash: string, create: (tx: DbClient) => Promise<number>): Promise<ShippingCreationReceipt & { replayed: boolean }> {
  return withTx(container, async tx => {
    await lock(tx, actor, key);
    const prior = await read(tx, actor, key);
    if (prior) {
      if (prior.requestHash !== hash) throw new HttpApiException('该创建请求已用于不同内容，请先核对原始结果', 409, 409);
      return { ...prior, replayed: true };
    }
    // Keep the supplier's existing serialization boundary. Global order is
    // receipt key -> supplier -> newly inserted parent. Editors never lock receipts.
    if (actor.ownerType === 2) await tx.execute(sql`SELECT pg_advisory_xact_lock(731604, ${actor.relationId}::int)`);
    const id = await create(tx);
    await tx.execute(sql`INSERT INTO shipping_template_create_replay(owner_type,relation_id,actor_id,request_key,request_hash,template_id)
      VALUES (${actor.ownerType},${actor.relationId},${actor.actorId},${key}::uuid,${hash},${id})`);
    const receipt = await read(tx, actor, key);
    if (!receipt || receipt.id !== id || receipt.requestHash !== hash) throw new Error('运费模板创建回执写入失败');
    return { ...receipt, replayed: false };
  });
}

/** A missing receipt is NOT permission to use a new key: an in-flight sender
 * can start after this transaction. Retry creation only with the original key
 * and payload. Lookup serializes with an already-running create and never writes.
 */
export async function findShippingCreationReceipt(container: Container, identity: ShippingCreationActor,
  requestKey: unknown): Promise<ShippingCreationReceipt | null> {
  const actor = scope(identity), key = normalizeOutRequestKey(requestKey);
  return withTx(container, async tx => { await lock(tx, actor, key); return read(tx, actor, key); });
}
