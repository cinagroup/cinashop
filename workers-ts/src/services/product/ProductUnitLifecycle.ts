import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { HttpApiException } from '@/utils/errors';

/** Unit names are historical free text, not foreign keys. Catalog mutations
 * and both product editors take this fence before their other business locks;
 * a deletion/rename therefore checks every already committed live reference.
 * A later product may still use the same free text after the catalog changes. */
export async function lockProductUnitLifecycle(tx: DbClient): Promise<void> {
  // Keep a caller's stricter bound; zero means unbounded, not zero wait.
  await tx.execute(sql`SELECT pg_catalog.set_config('lock_timeout',
    LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'), 0), 2000)::text || 'ms', true)`);
  try { await tx.execute(sql`SELECT pg_advisory_xact_lock(731611, 0)`); }
  catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 6 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && ['55P03', '40P01', '40001'].includes(String(cause.code))) {
        throw Object.assign(new HttpApiException('单位或商品正在更新，请刷新后重试', 409, 409), { cause: error });
      }
      cause = 'cause' in cause ? cause.cause : undefined;
    }
    throw error;
  }
}
