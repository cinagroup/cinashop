import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeCombination, storeProductAttr, storeProductAttrResult, storeProductAttrValue, storeProductDescription } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { activityHash } from './AdminSeckillActivityInput';
import { combinationMoney, COMBINATION_MAX_SKUS } from './AdminCombinationInput';

export const combinationColumns = { ...getTableColumns(storeCombination), version: sql<string>`xmin::text` };
export const combinationSkuColumns = { ...getTableColumns(storeProductAttrValue), version: sql<string>`xmin::text` };
export type CombinationRow = typeof storeCombination.$inferSelect & { version: string };
export type CombinationSkuRow = typeof storeProductAttrValue.$inferSelect & { version?: string };
export function combinationTime(value: Date | null) { return value && Number.isFinite(value.getTime()) ? value.toISOString() : null; }
export function combinationPhase(row: Pick<CombinationRow, 'startTime' | 'stopTime'>, now = Date.now()) {
  if (!combinationTime(row.startTime) || !combinationTime(row.stopTime) || row.startTime! > row.stopTime!) return 'invalid' as const;
  return row.startTime!.getTime() > now ? 'future' as const : row.stopTime!.getTime() < now ? 'ended' as const : 'active' as const;
}
export function combinationIssues(row: CombinationRow) {
  const issues: string[] = [];
  for (const [value, label, maximum] of [[row.storeName, '标题', 256], [row.info, '简介', 255], [row.unitName, '单位', 32]] as const)
    if (!value.trim() || [...value].length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) issues.push(`拼团${label}无效`);
  if (combinationPhase(row) === 'invalid') issues.push('拼团时间配置无效');
  if (![0, 1].includes(row.status) || ![0, 1].includes(row.isShow) || row.status !== row.isShow || ![0, 1].includes(row.isHost) || ![0, 1].includes(row.isSupportRefund)) issues.push('拼团状态配置无效');
  if (!Number.isSafeInteger(row.people) || row.people < 2 || row.people > 500 || !Number.isSafeInteger(row.effectiveTime) || row.effectiveTime < 1 ||
    !Number.isSafeInteger(row.num) || row.num < 1 || !Number.isSafeInteger(row.onceNum) || row.onceNum < 1 || row.onceNum > row.num ||
    !Number.isSafeInteger(row.virtual) || row.virtual < 1 || row.virtual > 100) issues.push('拼团人数、时效或限购配置无效');
  if ([row.stock, row.quota, row.quotaShow, row.sales].some(value => !Number.isSafeInteger(value) || value < 0) || row.quotaShow < row.quota || row.stock < row.quota) issues.push('拼团额度账目无效');
  if (![0, 1, 2].includes(row.type) || (row.type === 2 ? row.relationId <= 0 : row.relationId !== 0)) issues.push('拼团持久所属方无效');
  return issues;
}
export function combinationSkuIssues(row: CombinationSkuRow, base: CombinationSkuRow | undefined, active: CombinationSkuRow[]) {
  const issues: string[] = [];
  if (!base || base.isRetired !== 0) issues.push('缺失有效基础规格');
  if (!row.unique || row.unique !== row.unique.trim() || row.unique.length > 8 || /[\u0000-\u0020\u007f]/u.test(row.unique)) issues.push('活动规格标识无效');
  if (row.suk !== row.suk.trim() || active.filter(value => value.suk === row.suk).length !== 1 || active.filter(value => value.unique === row.unique).length !== 1) issues.push('规格组合或标识重复');
  if (![0, 1].includes(row.isRetired) || [row.stock, row.quota, row.quotaShow, row.sales].some(value => !Number.isSafeInteger(value) || value < 0) || row.quotaShow < row.quota || row.stock < row.quota) issues.push('活动规格额度账目无效');
  try { combinationMoney(row.price); } catch { issues.push('活动规格价格无效'); }
  return issues;
}
export async function combinationRevision(tx: DbClient, row: CombinationRow) {
  const [state] = await tx.execute(sql`SELECT
    (SELECT md5(coalesce(string_agg((to_jsonb(s)||jsonb_build_object('xmin',s.xmin::text))::text,E'\n' ORDER BY s.id),'')) FROM store_product_attr_value s WHERE s.product_id=${row.id} AND s.type=3) AS skus,
    (SELECT md5(coalesce(string_agg((to_jsonb(a)||jsonb_build_object('xmin',a.xmin::text))::text,E'\n' ORDER BY a.id),'')) FROM store_product_attr a WHERE a.product_id=${row.id} AND a.type=3) AS dimensions,
    (SELECT md5(coalesce(string_agg((to_jsonb(r)||jsonb_build_object('xmin',r.xmin::text))::text,E'\n' ORDER BY r.id),'')) FROM store_product_attr_result r WHERE r.product_id=${row.id} AND r.type=3) AS cache,
    (SELECT md5(coalesce(string_agg((to_jsonb(d)||jsonb_build_object('xmin',d.xmin::text))::text,E'\n'),'')) FROM store_product_description d WHERE d.product_id=${row.id} AND d.type=3) AS description`);
  return activityHash({ row, ...state });
}
export async function combinationGraph(tx: DbClient, id: number, locked = false) {
  const query = tx.select(combinationSkuColumns).from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 3)))
    .orderBy(asc(storeProductAttrValue.id)).limit(COMBINATION_MAX_SKUS + 1);
  const skus = await (locked ? query.for('update', { noWait: true }) : query);
  const dimensions = await tx.select().from(storeProductAttr).where(and(eq(storeProductAttr.productId, id), eq(storeProductAttr.type, 3))).orderBy(asc(storeProductAttr.id)).limit(11);
  const snapshots = await tx.select().from(storeProductAttrResult).where(and(eq(storeProductAttrResult.productId, id), eq(storeProductAttrResult.type, 3))).limit(2);
  const descriptions = await tx.select().from(storeProductDescription).where(and(eq(storeProductDescription.productId, id), eq(storeProductDescription.type, 3))).limit(2);
  if (skus.length > COMBINATION_MAX_SKUS || dimensions.length > 10 || snapshots.length > 1 || descriptions.length > 1) throw new ValidateException('历史拼团配置超过完整编辑容量或快照重复，不能截断保存；可关闭或删除');
  return { skus, dimensions, snapshots, description: descriptions[0]?.description ?? '' };
}
export function assertCombinationAccounts(row: CombinationRow, skus: CombinationSkuRow[]) {
  if ([row.quota, row.quotaShow, row.stock, row.sales].some(value => !Number.isSafeInteger(value) || value < 0) ||
    row.quota !== skus.reduce((sum, sku) => sum + sku.quota, 0) || row.quotaShow !== skus.reduce((sum, sku) => sum + sku.quotaShow, 0) ||
    row.stock !== skus.reduce((sum, sku) => sum + sku.stock, 0)) throw new ValidateException('历史拼团主行与规格额度账目不一致，请专项核对');
}
