import { sql, type SQL } from 'drizzle-orm';
import type { Env, ProductVideoGcMessage, ProductVideoCleanupMessage, SupplierVideoCleanupMessage } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { assertProductVideoGcReady } from '@/migrations/productVideoGc';
import { assertProductVideoGcAttachmentIndexReady } from '@/migrations/productVideoGcAttachmentIndex';
import { assertProductVideoUploadReady } from '@/migrations/adminProductVideoUpload';
import { assertSupplierVideoUploadReady } from '@/migrations/supplierProductVideoUpload';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';

export const PRODUCT_VIDEO_GC_PAGE_SIZE = 80;
export const PRODUCT_VIDEO_GC_LEASE_SECONDS = 120;
export const PRODUCT_VIDEO_GC_CYCLE_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Scope = ProductVideoGcMessage['scope'];
type State = { scope: Scope; cursor: string | null; maximum: string | null; cycle: number;
  lease_token: string | null; lease_until: number; last_completed_at: number; updated_at: number };
type Source = { upload_id: string; state: 'active' | 'committed' | 'cancelled'; expires_at: number };
const projection = sql`scope,cursor::text,maximum::text,cycle,lease_token::text,lease_until,last_completed_at,updated_at`;
const unavailable = () => new ServiceUnavailableException('商品视频清理租约或持久游标已变化，请重试');
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 2_147_483_647;
function validate(state: State | undefined, scope: Scope): State {
  if (!state || Object.keys(state).length !== 8 || state.scope !== scope ||
    ![state.cycle, state.lease_until, state.last_completed_at, state.updated_at].every(integer) ||
    [state.cursor, state.maximum, state.lease_token].some(id => id !== null && !UUID.test(id)) ||
    state.cursor !== null && (state.maximum === null || state.cursor > state.maximum) ||
    (state.lease_token === null) !== (state.lease_until === 0)) throw unavailable();
  return state;
}
function same(a: State, b: State) {
  return (Object.keys(a) as Array<keyof State>).every(key => a[key] === b[key]);
}
function table(scope: Scope) {
  return sql.raw(scope === 'admin' ? 'public.admin_product_video_upload_v1' : 'public.supplier_product_video_upload_v1');
}
export function isProductVideoGcMessage(value: unknown): value is ProductVideoGcMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && row.action === 'dispatchProductVideoCleanup' &&
    (row.scope === 'admin' || row.scope === 'supplier');
}
/** The root carries no caller-selected cursor, key, owner or cutoff. */
export function productVideoGcRoot(scope: Scope): ProductVideoGcMessage {
  return { action: 'dispatchProductVideoCleanup', scope };
}
/** Bound the UUID window before filtering terminal/expired eligibility. This
 * exact statement is also used by genuine PG16 default-planner EXPLAIN tests. */
export function productVideoGcWindow(scope: Scope, cursor: string | null, maximum: string): SQL {
  return sql`SELECT source.upload_id::text AS upload_id,source.state,source.expires_at FROM ONLY ${table(scope)} AS source
    WHERE ${cursor === null ? sql`TRUE` : sql`source.upload_id>${cursor}::uuid`} AND source.upload_id<=${maximum}::uuid
    ORDER BY source.upload_id ASC LIMIT ${PRODUCT_VIDEO_GC_PAGE_SIZE}`;
}
async function budgets(tx: DbClient) {
  await tx.execute(sql`SELECT
    pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    pg_catalog.set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),500)::text || 'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`);
}
async function clock(tx: DbClient) {
  const [row] = await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
  if (!integer(row?.now) || row.now <= 0 || row.now > 2_147_483_647 - PRODUCT_VIDEO_GC_LEASE_SECONDS) throw unavailable();
  return row.now;
}
async function ready(tx: DbClient, scope: Scope) {
  await assertProductVideoGcReady(tx);
  await assertProductVideoGcAttachmentIndexReady(tx);
  // The other scope may be uninstalled; its absence must not block this one.
  if (scope === 'admin') await assertProductVideoUploadReady(tx); else await assertSupplierVideoUploadReady(tx);
}
async function read(tx: DbClient, scope: Scope): Promise<State> {
  const [row] = await tx.execute(sql`SELECT ${projection} FROM public.product_video_gc_state_v1 WHERE scope=${scope} FOR UPDATE NOWAIT`);
  return validate(row as State | undefined, scope);
}
async function update(tx: DbClient, before: State, after: State): Promise<State> {
  validate(after, before.scope);
  const [row] = await tx.execute(sql`UPDATE public.product_video_gc_state_v1 SET cursor=${after.cursor}::uuid,
    maximum=${after.maximum}::uuid,cycle=${after.cycle},lease_token=${after.lease_token}::uuid,
    lease_until=${after.lease_until},last_completed_at=${after.last_completed_at},updated_at=${after.updated_at}
    WHERE scope=${before.scope} AND lease_token IS NOT DISTINCT FROM ${before.lease_token}::uuid
    AND cursor IS NOT DISTINCT FROM ${before.cursor}::uuid AND maximum IS NOT DISTINCT FROM ${before.maximum}::uuid
    AND cycle=${before.cycle} AND lease_until=${before.lease_until} AND last_completed_at=${before.last_completed_at}
    AND updated_at=${before.updated_at} RETURNING ${projection}`);
  if (!row || !same(validate(row as State, before.scope), after) || !same(await read(tx, before.scope), after)) throw unavailable();
  return after;
}

/** Durable, independently leased traversals. Queue acceptance is outside SQL;
 * cursor advancement happens only after acceptance. Unknown outcomes can repeat
 * existing per-upload cleanup, whose durable owner/reference checks remain the
 * sole authority to delete objects. Terminal roots are revisited every cycle so
 * even a very late provider write or lost pre/post/DLQ message can converge. */
export class ProductVideoGcService {
  constructor(private readonly container: Container, private readonly env: Env) {}

  private transaction<T>(scope: Scope, run: (tx: DbClient) => Promise<T>) {
    return withTx(this.container, async tx => {
      await budgets(tx);
      await tx.execute(sql`LOCK TABLE ONLY public.product_video_gc_state_v1 IN ROW EXCLUSIVE MODE NOWAIT`);
      await ready(tx, scope);
      return run(tx);
    });
  }

  private async release(expected: State) {
    await this.transaction(expected.scope, async tx => {
      const current = await read(tx, expected.scope);
      // A newer token or confirmed ACK is never rewound by an older worker.
      if (!same(current, expected)) return;
      const now = await clock(tx);
      await update(tx, current, { ...current, lease_token: null, lease_until: 0, updated_at: Math.max(now, current.updated_at) });
    });
  }

  async dispatch(message: ProductVideoGcMessage): Promise<{ status: 'busy' | 'throttled' | 'advanced' | 'completed'; examined: number; enqueued: number }> {
    if (!isProductVideoGcMessage(message)) throw new ValidateException('商品视频清理派发消息无效');
    const scope = message.scope;
    const claim = await this.transaction(scope, async tx => {
      const current = await read(tx, scope), now = await clock(tx);
      if (current.lease_token !== null && current.lease_until > now) return 'busy' as const;
      if (current.maximum === null && current.last_completed_at > 0 && now < current.last_completed_at + PRODUCT_VIDEO_GC_CYCLE_SECONDS) return 'throttled' as const;
      if (current.cycle >= 2_147_483_647) throw unavailable();
      return update(tx, current, { ...current, lease_token: crypto.randomUUID(),
        lease_until: now + PRODUCT_VIDEO_GC_LEASE_SECONDS, updated_at: Math.max(now, current.updated_at) });
    });
    if (typeof claim === 'string') return { status: claim, examined: 0, enqueued: 0 };
    let owned = claim;
    try {
      const plan = await withTx(this.container, async tx => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        await budgets(tx); await ready(tx, scope); const now = await clock(tx);
        // SELECT ORDER BY DESC LIMIT 1 uses the UUID primary key; PG16 has no MAX(uuid).
        const maximum = owned.maximum ?? (await tx.execute(sql`SELECT upload_id::text AS id FROM ONLY ${table(scope)} ORDER BY upload_id DESC LIMIT 1`))[0]?.id as string | undefined;
        if (maximum === undefined) return { maximum: null, rows: [] as Source[], due: [] as Source[], done: true };
        if (!UUID.test(maximum)) throw unavailable();
        const exists = await tx.execute(sql`SELECT upload_id FROM ONLY ${table(scope)} WHERE upload_id=${maximum}::uuid LIMIT 1`);
        if (exists.length !== 1) throw unavailable();
        const rows = await tx.execute(productVideoGcWindow(scope, owned.cursor, maximum)) as unknown as Source[];
        let previous = owned.cursor;
        for (const row of rows) {
          if (!UUID.test(row.upload_id) || previous !== null && row.upload_id <= previous || row.upload_id > maximum ||
            !['active','committed','cancelled'].includes(row.state) || !integer(row.expires_at)) throw unavailable();
          previous = row.upload_id;
        }
        const done = previous === maximum;
        if (rows.length < PRODUCT_VIDEO_GC_PAGE_SIZE && !done) throw unavailable();
        return { maximum, rows, due: rows.filter(row => row.state !== 'active' || row.expires_at <= now), done };
      });
      if (owned.maximum === null && plan.maximum !== null) {
        const expected = owned;
        owned = await this.transaction(scope, async tx => {
          const current = await read(tx, scope), now = await clock(tx);
          if (!same(current, expected) || now >= current.lease_until) throw unavailable();
          return update(tx, current, { ...current, maximum: plan.maximum, updated_at: Math.max(now, current.updated_at) });
        });
      }
      const messages: Array<ProductVideoCleanupMessage | SupplierVideoCleanupMessage> = plan.due.map(row => ({
        action: scope === 'admin' ? 'cleanupProductVideoUpload' : 'cleanupSupplierVideoUpload', uploadId: row.upload_id,
      }));
      if (messages.length) await this.env.ORDER_QUEUE.sendBatch(messages.map(body => ({ body, contentType: 'json' as const })));
      const expected = owned;
      await this.transaction(scope, async tx => {
        const current = await read(tx, scope), now = await clock(tx);
        if (!same(current, expected) || now >= current.lease_until) throw unavailable();
        await update(tx, current, { ...current, cursor: plan.done ? null : plan.rows.at(-1)!.upload_id,
          maximum: plan.done ? null : plan.maximum, cycle: current.cycle + Number(plan.done),
          last_completed_at: plan.done ? Math.max(now, current.last_completed_at) : current.last_completed_at,
          lease_token: null, lease_until: 0, updated_at: Math.max(now, current.updated_at) });
      });
      // If this continuation is lost, the next cron resumes the durable cursor.
      if (!plan.done) await this.env.ORDER_QUEUE.send(productVideoGcRoot(scope), { contentType: 'json' });
      return { status: plan.done ? 'completed' : 'advanced', examined: plan.rows.length, enqueued: messages.length };
    } catch (error) {
      // Preserve the first error if SQL is unavailable. Expiry recovers a lease
      // even when release cannot be confirmed; no false successful empty page.
      try { await this.release(owned); } catch { /* durable lease expires */ }
      throw error;
    }
  }
}
