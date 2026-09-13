import { getTableColumns, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { formatLegacyShippingRuleGroups } from '../supplier/SupplierShippingTemplateService';

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
export async function readAdminShippingSnapshot(tx: DbClient, id: number) {
  const rows = await tx.execute(sql`SELECT jsonb_build_object(
    'template',(SELECT ${rowJson(shippingTemplates)} FROM ${shippingTemplates} WHERE id=${id} AND is_del=0),
    'regions',COALESCE((SELECT jsonb_agg(${rowJson(shippingTemplatesRegion)} ORDER BY id) FROM
      (SELECT * FROM ${shippingTemplatesRegion} WHERE template_id=${id} ORDER BY id LIMIT 1001) AS shipping_templates_region),'[]'::jsonb),
    'free',COALESCE((SELECT jsonb_agg(${rowJson(shippingTemplatesFree)} ORDER BY id) FROM
      (SELECT * FROM ${shippingTemplatesFree} WHERE temp_id=${id} ORDER BY id LIMIT 1001) AS shipping_templates_free),'[]'::jsonb),
    'noDelivery',COALESCE((SELECT jsonb_agg(${rowJson(shippingTemplatesNoDelivery)} ORDER BY id) FROM
      (SELECT * FROM ${shippingTemplatesNoDelivery} WHERE temp_id=${id} ORDER BY id LIMIT 1001) AS shipping_templates_no_delivery),'[]'::jsonb)
    ) AS snapshot`);
  const snapshot = Array.from(rows)[0]?.snapshot as Snapshot | undefined;
  if (!snapshot?.template) throw new ValidateException('运费模板不存在或已删除');
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
  const state = await readAdminShippingSnapshot(tx, id);
  if (state.revision !== expected) throw new ValidateException('模板已被其他操作修改，请保留输入并重新打开模板后核对');
  return state.snapshot;
}
function groups(rows: Parameters<typeof formatLegacyShippingRuleGroups>[0], kind: 'region' | 'free' | 'no_delivery') {
  // A group must be homogeneous. The historical formatter takes its last row;
  // silently choosing that row would erase inconsistent stored facts on save.
  const seen = new Map<string, string>();
  for (const row of rows) {
    if (!row.value && row.cityId === 0 && row.provinceId === 0 && kind === 'region') row.value = '[0]';
    let path: unknown;
    try { path = JSON.parse(row.value); } catch { throw new ValidateException('模板地区路径缺失或损坏，请先核对原始规则'); }
    if (!Array.isArray(path) || !path.length || path.length > 4 || path.some(p => !Number.isSafeInteger(p) || p < 0)
      || new Set(path).size !== path.length || path.at(-1) !== row.cityId || path[0] !== row.provinceId
      || (path.includes(0) && !(kind === 'region' && path.length === 1))) throw new ValidateException('模板地区路径与地区ID不一致，请先核对原始规则');
    const key = row.uniqid || `legacy-${row.id}`;
    const fields = JSON.stringify(kind === 'region' ? [row.first, row.firstPrice, row.continue, row.continuePrice, row.billingGroup]
      : kind === 'free' ? [row.number, row.price, row.billingGroup] : []);
    if (seen.has(key) && seen.get(key) !== fields) throw new ValidateException('同组模板计量或费率不一致，请先核对原始规则');
    seen.set(key, fields);
  }
  if (seen.size > 100) throw new ValidateException('模板规则超过100组，不能编辑不完整规则');
  return formatLegacyShippingRuleGroups(rows, kind);
}
export async function detailAdminShippingTemplate(container: Container, id: number) {
  return withTx(container, async tx => {
    await boundShippingTransaction(tx);
    const { snapshot: s, revision } = await readAdminShippingSnapshot(tx, id);
    return { revision, formData: { id, name: s.template.name, type: s.template.type, status: s.template.status,
      sort: s.template.sort, appoint: s.template.appoint, no_delivery: s.template.noDelivery },
      region_info: groups(s.regions.map(r => ({ ...r, cityId: r.regionId })), 'region'),
      appoint_info: groups(s.free.map(r => ({ ...r })), 'free'),
      no_delivery_info: groups(s.noDelivery.map(r => ({ ...r })), 'no_delivery') };
  });
}
