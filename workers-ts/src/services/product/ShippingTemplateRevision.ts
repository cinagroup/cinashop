import { getTableColumns, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DbClient } from '@/lib/di';
import { shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';

function rowJson(table: PgTable) {
  return sql`jsonb_build_object(${sql.join(Object.entries(getTableColumns(table)).flatMap(([key, column]) => [
    sql`${key}::text`, column.dataType === 'string' ? sql`${column}::text` : sql`${column}`,
  ]), sql`, `)})`;
}
interface Snapshot {
  template: typeof shippingTemplates.$inferSelect;
  regions: Array<typeof shippingTemplatesRegion.$inferSelect>;
  free: Array<typeof shippingTemplatesFree.$inferSelect>;
  noDelivery: Array<typeof shippingTemplatesNoDelivery.$inferSelect>;
}
export async function boundShippingTransaction(tx: DbClient) {
  await tx.execute(sql.raw(`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
}
/** Single-statement bounded raw snapshot; also read AFTER the writer owns the parent lock.
 * Fingerprint includes all four tables and ownership, not merely timestamps or a client baseline alone.
 * It is a conflict detector, not a secret or authorization token. */
export async function readShippingEditorSnapshot(tx: DbClient, id: number, supplierId?: number) {
  const ownerScope = supplierId === undefined ? sql`true` : sql`${shippingTemplates.ownerType}=2 AND ${shippingTemplates.relationId}=${supplierId}`;
  const rows = await tx.execute(sql`SELECT jsonb_build_object(
    'template',(SELECT ${rowJson(shippingTemplates)} FROM ${shippingTemplates} WHERE id=${id} AND is_del=0 AND ${ownerScope}),
    'regions',COALESCE((SELECT jsonb_agg(${rowJson(shippingTemplatesRegion)} ORDER BY id) FROM
      (SELECT * FROM ${shippingTemplatesRegion} WHERE template_id=${id} ORDER BY id LIMIT 1001) AS shipping_templates_region),'[]'::jsonb),
    'free',COALESCE((SELECT jsonb_agg(${rowJson(shippingTemplatesFree)} ORDER BY id) FROM
      (SELECT * FROM ${shippingTemplatesFree} WHERE temp_id=${id} ORDER BY id LIMIT 1001) AS shipping_templates_free),'[]'::jsonb),
    'noDelivery',COALESCE((SELECT jsonb_agg(${rowJson(shippingTemplatesNoDelivery)} ORDER BY id) FROM
      (SELECT * FROM ${shippingTemplatesNoDelivery} WHERE temp_id=${id} ORDER BY id LIMIT 1001) AS shipping_templates_no_delivery),'[]'::jsonb)
    ) AS snapshot`);
  const snapshot = Array.from(rows)[0]?.snapshot as Snapshot | undefined;
  if (!snapshot?.template) {
    if (supplierId !== undefined) throw new NotFoundException('运费模板不存在或不属于当前供应商');
    throw new ValidateException('运费模板不存在或已删除');
  }
  if ([snapshot.regions, snapshot.free, snapshot.noDelivery].some(r => !Array.isArray(r) || r.length > 1000)) {
    throw new ValidateException('模板规则超过1000条，不能读取或覆盖不完整规则');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshot)));
  const revision = 'shipping-v1:' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return { snapshot, revision };
}
export function requireShippingRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^shipping-v1:[a-f0-9]{64}$/.test(value)) {
    throw new ValidateException('编辑版本缺失或无效，请重新打开模板后保存');
  }
  return value;
}
export async function assertShippingRevision(tx: DbClient, id: number, expected: string) {
  const state = await readShippingEditorSnapshot(tx, id);
  if (state.revision !== expected) throw new ValidateException('模板已被其他操作修改，请保留输入并重新打开模板后核对');
  return state.snapshot;
}
