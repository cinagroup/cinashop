import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrderOutbox, systemLog, type StoreOrderOutbox } from '@/models/schema';
import { getRedis, type RedisEnv } from '@/utils/cache';

export const PRODUCT_RECYCLE_EFFECTS_EVENT = 'product.recycle.effects';
export interface ProductRecycleEffectsPayload { productId: number; auditId: number; affectedProductIds: number[] }
/** Match PHP cache.stores.redis prefix / CACHE_TAG_PREFIX. The configured
 * Upstash database must contain the legacy Redis cache being retired. */
export interface ProductRecycleEffectsEnvironment extends RedisEnv { REDIS_PREFIX?: string; CACHE_TAG_PREFIX?: string }
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
function canonical(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, ordered(value)])) : item;
  return JSON.stringify(ordered(value));
}
export function parseProductRecycleEffectsPayload(value: unknown): ProductRecycleEffectsPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Recycle effects payload invalid');
  const row = value as Record<string, unknown>, ids = row.affectedProductIds;
  if (Object.keys(row).length !== 3 || !positive(row.productId) || !positive(row.auditId) || !Array.isArray(ids)
    || !ids.length || ids.length > 10000 || ids.some((id, index) => !positive(id) || index > 0 && id <= ids[index - 1])
    || !ids.includes(row.productId)) throw Error('Recycle effects payload invalid');
  return { productId: row.productId, auditId: row.auditId, affectedProductIds: [...ids] };
}

/** Members are already physical keys (TagSet.append -> getCacheKey).
 * Validate BOTH complete sets before deleting anything: Lua errors do not roll
 * back earlier Redis writes. No KEYS/SCAN, no unbounded SMEMBERS and no flush. */
export const PRODUCT_RECYCLE_TAG_CLEAR_LUA = String.raw`
local total = 0
for i = 1, 2 do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= 'set' then return redis.error_reply('Product cache tag type invalid') end
  total = total + redis.call('SCARD', KEYS[i])
  if total > 10000 then return redis.error_reply('Product cache tag capacity exceeded') end
end
local members = {}
for i = 1, 2 do
  local rows = redis.call('SMEMBERS', KEYS[i])
  for _, key in ipairs(rows) do
    if string.len(key) > 2048 or string.sub(key, 1, string.len(ARGV[i])) ~= ARGV[i] then
      return redis.error_reply('Product cache tag member invalid')
    end
    table.insert(members, key)
  end
end
local deleted = 0
for first = 1, #members, 256 do
  local batch = {}
  for j = first, math.min(first + 255, #members) do table.insert(batch, members[j]) end
  deleted = deleted + redis.call('DEL', unpack(batch))
end
redis.call('DEL', KEYS[1], KEYS[2])
return deleted
`;
export function productRecycleTagKeys(env: Pick<ProductRecycleEffectsEnvironment, 'REDIS_PREFIX' | 'CACHE_TAG_PREFIX'>): { keys: string[]; prefixes: string[] } {
  const prefix = env.REDIS_PREFIX ?? '', tagPrefix = env.CACHE_TAG_PREFIX ?? '';
  if ([prefix, tagPrefix].some(value => typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value))) throw Error('Product cache prefix invalid');
  return { keys: [`${prefix}${tagPrefix}CRMEB:19ebc6b9c156e99ca987fba0feabe5f9`, `${prefix}${tagPrefix}CRMEB:87e6f0d8c14295287d6239d77f69c1fb`],
    prefixes: [`${prefix}mc:store_product:tag`, `${prefix}mc:store_product_attr:tag`] };
}
export async function clearProductRecycleTags(env: ProductRecycleEffectsEnvironment): Promise<void> {
  const { keys, prefixes } = productRecycleTagKeys(env);
  if (!env.UPSTASH_REDIS_URL || !env.UPSTASH_REDIS_TOKEN) throw Error('Product cache binding unavailable');
  const redis = getRedis(env);
  if (!redis) throw Error('Product cache binding unavailable');
  const receipt: unknown = await redis.eval(PRODUCT_RECYCLE_TAG_CLEAR_LUA, keys, prefixes);
  if (typeof receipt !== 'number' || !Number.isSafeInteger(receipt) || receipt < 0 || receipt > 10000) throw Error('Product cache tag clear receipt invalid');
}

export async function enqueueProductRecycleEffects(tx: DbClient, input: ProductRecycleEffectsPayload, now: number): Promise<StoreOrderOutbox> {
  const payload = parseProductRecycleEffectsPayload(input);
  if (!Number.isSafeInteger(now) || now < 0 || now > 2_147_483_647) throw Error('Recycle effects clock invalid');
  const eventKey = `${PRODUCT_RECYCLE_EFFECTS_EVENT}:${payload.productId}:${randomUUID()}`;
  const rows = await tx.insert(storeOrderOutbox).values({ eventKey, aggregateType: 'product', aggregateId: payload.productId,
    eventType: PRODUCT_RECYCLE_EFFECTS_EVENT, payload, status: 'PENDING', availableTime: now, addTime: now, updateTime: now }).returning();
  const row = rows[0], expected = { eventKey, aggregateType: 'product', aggregateId: payload.productId, eventType: PRODUCT_RECYCLE_EFFECTS_EVENT,
    payload, status: 'PENDING', dispatchCount: 0, attemptCount: 0, replayCount: 0, availableTime: now, leaseUntil: 0, leaseToken: '',
    lastError: '', enqueuedTime: 0, processedTime: 0, addTime: now, updateTime: now };
  const matches = (value: StoreOrderOutbox | undefined) => !!value && positive(value.id) && Object.keys(value).length === Object.keys(expected).length + 1
    && Object.entries(expected).every(([key, wanted]) => canonical(value[key as keyof typeof expected]) === canonical(wanted));
  if (rows.length !== 1 || !matches(row)) throw Error('Recycle effects intent full receipt inconsistent');
  const [readBack] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, row.id)).limit(1);
  if (!matches(readBack)) throw Error('Recycle effects intent full readback inconsistent');
  return row;
}
/** Source plaintext proves global product/SKU cache tags. Encrypted get.config
 * listener remains unverified; do not fabricate inventory or withdrawal frames. */
export async function deliverProductRecycleEffects(container: Container, env: ProductRecycleEffectsEnvironment, event: StoreOrderOutbox): Promise<void> {
  const payload = parseProductRecycleEffectsPayload(event.payload);
  if (event.eventType !== PRODUCT_RECYCLE_EFFECTS_EVENT || event.aggregateType !== 'product' || event.aggregateId !== payload.productId
    || !new RegExp(`^product\\.recycle\\.effects:${payload.productId}:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`).test(event.eventKey)) throw Error('Recycle effects event identity invalid');
  await withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    const rows = await tx.select().from(systemLog).where(eq(systemLog.id, payload.auditId)).limit(1), audit = rows[0];
    if (!audit || audit.type !== 'product_recycle' || audit.method !== 'DELETE' || audit.path !== `product/product/${payload.productId}`) throw Error('Recycle effects business source invalid');
    let action: unknown; try { action = JSON.parse(audit.action); } catch { throw Error('Recycle effects audit action invalid'); }
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw Error('Recycle effects audit identity invalid');
    const row = action as Record<string, unknown>;
    if (Object.keys(row).length !== 3 || !['recycle', 'restore'].includes(String(row.operation)) || row.productId !== payload.productId
      || canonical(row.affectedProductIds) !== canonical(payload.affectedProductIds)) throw Error('Recycle effects audit identity invalid');
  });
  await clearProductRecycleTags(env);
}
