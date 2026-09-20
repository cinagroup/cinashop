import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { normalizeConfigScalar } from '@/utils/config';

/** Bounded, current global configuration. No KV read/backfill, credentials or
 * arbitrary caller-selected keys. Same precedence as SystemConfigDao. */
export async function readOfflinePaymentConfig(db: DbClient): Promise<Readonly<Record<string, string>>> {
  const rows = await db.execute<{ menu_name: string; value: string }>(sql`
    SELECT DISTINCT ON (menu_name) menu_name,
      CASE WHEN octet_length(value)<=2048 THEN value ELSE '[oversized-config]' END AS value
    FROM ${systemConfig} WHERE is_store=0 AND menu_name IN
      ('ali_pay_status','pay_weixin_open','balance_func_status','yue_pay_status','site_name',
       'wechat_appid','routine_appId','pay_weixin_mchid','pay_weixin_serial_no','site_url')
    ORDER BY menu_name,sort DESC,id DESC`);
  return Object.freeze(Object.fromEntries(rows.map(row => [row.menu_name, normalizeConfigScalar(row.value)])));
}
