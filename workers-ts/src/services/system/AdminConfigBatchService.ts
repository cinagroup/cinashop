import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import type { SystemConfigEnv } from './SystemConfigService';

export const MAX_ADMIN_CONFIG_BODY_BYTES = 128 * 1024;
const MAX_KEYS = 100;

function validText(value: string, limit: number): boolean {
  const characters = Array.from(value);
  return characters.length <= limit && characters.every(character => {
    const point = character.codePointAt(0)!;
    return point !== 0 && !(point >= 0xd800 && point <= 0xdfff);
  });
}

export async function readAdminConfigBatch(request: Request): Promise<unknown> {
  const text = await readBoundedUtf8Text(request, MAX_ADMIN_CONFIG_BODY_BYTES);
  try { return JSON.parse(text); } catch { throw new ValidateException('配置请求必须是JSON对象'); }
}

/** Flat string values only. Validation finishes before any DB/KV mutation. */
export function normalizeAdminConfigBatch(input: unknown): Array<[string, string]> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidateException('配置请求必须是JSON对象');
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_KEYS) throw new ValidateException('每次最多保存100项配置');
  return entries.map(([key, value]) => {
    // CONFIG_KV uses the cfg_ prefix; its 512-byte key limit is independent
    // of PostgreSQL varchar(255)'s Unicode character limit.
    if (!key || key.trim() !== key || !validText(key, 255) || new TextEncoder().encode(`cfg_${key}`).byteLength > 512) {
      throw new ValidateException('配置键名无效');
    }
    if (typeof value !== 'string' || !validText(value, 5000)) {
      throw new ValidateException('配置值必须是最多5000字符的有效字符串');
    }
    return [key, value];
  });
}

/** Existing authenticated compatibility endpoint only; does not re-enable the
 * generic frontend editor or grant permissions. Domain-specific APIs stay preferred.
 * The table fence also guards missing keys and duplicate-priority changes made
 * by other writers, not just callers sharing an advisory-lock convention.
 */
export class AdminConfigBatchService {
  constructor(private readonly container: Container, private readonly env: SystemConfigEnv) {}

  async save(input: unknown): Promise<void> {
    const entries = normalizeAdminConfigBatch(input);
    if (!entries.length) return;
    const submitted = sql.join(entries.map(([key, value]) => sql`(${key}::text, ${value}::text)`), sql`, `);
    await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
      await tx.execute(sql`SELECT
        set_config('lock_timeout', '2s', true),
        set_config('statement_timeout', '5s', true),
        set_config('idle_in_transaction_session_timeout', '5s', true)`);
      // First business lock; no order/product/rights locks or external I/O held.
      // Checkout readers may finish, but another writer must not change winners.
      await tx.execute(sql`LOCK TABLE ${systemConfig} IN SHARE ROW EXCLUSIVE MODE`);
      await tx.execute(sql`
        WITH submitted(menu_name, value) AS (VALUES ${submitted}),
        winners AS (
          SELECT DISTINCT ON (stored.menu_name) stored.id, submitted.value
          FROM ${systemConfig} AS stored JOIN submitted ON submitted.menu_name = stored.menu_name
          WHERE stored.is_store = 0
          ORDER BY stored.menu_name, stored.sort DESC, stored.id DESC
        )
        UPDATE ${systemConfig} AS stored SET value = winners.value
        FROM winners WHERE stored.id = winners.id
      `);
      await tx.execute(sql`
        WITH submitted(menu_name, value) AS (VALUES ${submitted})
        INSERT INTO ${systemConfig} (menu_name, value, info, is_store, type, input_type)
        SELECT submitted.menu_name, submitted.value, submitted.menu_name, 0, 'text', 'input'
        FROM submitted WHERE NOT EXISTS (
          SELECT 1 FROM ${systemConfig} AS stored
          WHERE stored.is_store = 0 AND stored.menu_name = submitted.menu_name
        )
      `);
      // Return at most MAX_KEYS rows, even when historical duplicates are large.
      const rows = await tx.selectDistinctOn([systemConfig.menuName], { menuName: systemConfig.menuName, value: systemConfig.value })
        .from(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, entries.map(([key]) => key))))
        .orderBy(systemConfig.menuName, desc(systemConfig.sort), desc(systemConfig.id));
      const actual = new Map(rows.map(row => [row.menuName, row.value]));
      if (entries.some(([key, value]) => actual.get(key) !== value)) throw new Error('配置回读不一致');
    });
    // SQL is committed before any KV call. Await every invalidation, and never
    // describe a cache failure as a rolled-back database save or echo values.
    const results = await Promise.allSettled(entries.map(([key]) => this.env.CONFIG_KV.delete(`cfg_${key}`)));
    if (results.some(result => result.status === 'rejected')) {
      throw new ValidateException('配置已保存，但缓存清理失败，请重试保存');
    }
  }
}
