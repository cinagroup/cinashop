import { and, asc, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeActivity, storeProduct, storeProductAttrValue, storeProductCategory, storeProductLabel, storeProductRelation, storeSeckill, storeSeckillTime, systemSupplier } from '@/models/schema';
import { publicSeckillTimePictures } from '@/services/activity/SeckillTimeAssetPolicy';
import { seckillSlotIds, seckillSlotMinutes } from '@/services/activity/SeckillScheduleService';
import { ValidateException } from '@/utils/errors';
import { activityDateText, activityHash, activityMoney, SECKILL_ACTIVITY_MAX_PICKER_OPTIONS, SECKILL_ACTIVITY_MAX_PRODUCTS, SECKILL_ACTIVITY_MAX_TOTAL_SKUS } from './AdminSeckillActivityInput';

export const parentColumns = { ...getTableColumns(storeActivity), version: sql<string>`xmin::text` };
export const childColumns = { ...getTableColumns(storeSeckill), version: sql<string>`xmin::text` };
export const skuColumns = { ...getTableColumns(storeProductAttrValue), version: sql<string>`xmin::text` };
export type ParentRow = typeof storeActivity.$inferSelect & { version: string };
export type ChildRow = typeof storeSeckill.$inferSelect & { version: string };
export type SkuRow = typeof storeProductAttrValue.$inferSelect & { version?: string };
export type SourceRow = typeof storeProduct.$inferSelect;

export async function activityCategories(tx: DbClient) {
  const rows = await tx.select().from(storeProductCategory).where(and(eq(storeProductCategory.type, 0), eq(storeProductCategory.relationId, 0)))
    .orderBy(desc(storeProductCategory.sort), desc(storeProductCategory.id)).limit(SECKILL_ACTIVITY_MAX_PICKER_OPTIONS + 1);
  if (rows.length > SECKILL_ACTIVITY_MAX_PICKER_OPTIONS) throw new ValidateException('平台分类超过5000项，不能截断选项');
  const byId = new Map(rows.map(row => [row.id, row])), verified = new Set<number>();
  if (byId.size !== rows.length) throw new ValidateException('平台分类标识重复');
  for (const row of rows) {
    const chain = new Set<number>(); let cursor: typeof row | undefined = row;
    while (cursor && !verified.has(cursor.id)) {
      if (cursor.id <= 0 || cursor.pid < 0 || chain.has(cursor.id)) throw new ValidateException('平台分类树循环或标识无效');
      chain.add(cursor.id);
      if (cursor.pid && !byId.has(cursor.pid)) throw new ValidateException('平台分类缺失父节点');
      cursor = cursor.pid ? byId.get(cursor.pid) : undefined;
    }
    for (const id of chain) verified.add(id);
  }
  const children = new Map<number, typeof rows>();
  for (const row of rows) children.set(row.pid, [...(children.get(row.pid) ?? []), row]);
  const selectable = new Set<number>(), pending = [...(children.get(0) ?? [])];
  while (pending.length) {
    const row = pending.pop()!;
    if (row.isShow !== 1) continue;
    selectable.add(row.id); pending.push(...(children.get(row.id) ?? []));
  }
  return { rows, children, selectable, options: rows.filter(row => selectable.has(row.id)).map(row => ({ id: row.id, pid: row.pid, cate_name: row.cateName })) };
}
export async function activityLabels(tx: DbClient) {
  // PHP all_label includes hidden and disabled platform labels in Admin search.
  const rows = await tx.select().from(storeProductLabel).where(and(eq(storeProductLabel.type, 0), eq(storeProductLabel.relationId, 0)))
    .orderBy(desc(storeProductLabel.sort), desc(storeProductLabel.id)).limit(SECKILL_ACTIVITY_MAX_PICKER_OPTIONS + 1);
  if (rows.length > SECKILL_ACTIVITY_MAX_PICKER_OPTIONS) throw new ValidateException('平台标签超过5000项，不能截断选项');
  return rows.map(row => ({ id: row.id, label_name: row.labelName, status: row.status, is_show: row.isShow }));
}
export async function activityCandidateFilters(tx: DbClient, query: { categoryId: number; labelId: number }) {
  let categoryIds: number[] = [];
  if (query.categoryId) {
    const catalog = await activityCategories(tx);
    if (!catalog.selectable.has(query.categoryId)) throw new ValidateException('商品分类不存在或不可选');
    const pending = [query.categoryId];
    while (pending.length) { const id = pending.pop()!; categoryIds.push(id); pending.push(...(catalog.children.get(id) ?? []).map(row => row.id)); }
  }
  if (query.labelId && !(await activityLabels(tx)).some(row => row.id === query.labelId)) throw new ValidateException('商品标签不存在或非平台标签');
  return and(categoryIds.length ? sql`EXISTS (SELECT 1 FROM ${storeProductRelation} r WHERE r.product_id=${storeProduct.id} AND r.type=1 AND r.relation_id IN (${sql.join(categoryIds.map(id => sql`${id}`), sql`, `)}))` : undefined,
    query.labelId ? sql`EXISTS (SELECT 1 FROM ${storeProductRelation} r WHERE r.product_id=${storeProduct.id} AND r.type=3 AND r.relation_id=${query.labelId})` : undefined);
}
export async function activityProductMetadata(tx: DbClient, sources: SourceRow[]) {
  if (!sources.length) return new Map<number, { product_type: number; category_name: string }>();
  const links = await tx.select({ productId: storeProductRelation.productId, id: storeProductRelation.relationId }).from(storeProductRelation)
    .where(and(inArray(storeProductRelation.productId, sources.map(row => row.id)), eq(storeProductRelation.type, 1))).limit(10001);
  if (links.length > 10000) throw new ValidateException('商品分类关联超过完整展示容量');
  const idsFor = (source: SourceRow) => [...new Set([...links.filter(row => row.productId === source.id).map(row => row.id),
    ...source.cateId.split(',').filter(token => /^[1-9]\d{0,9}$/.test(token.trim())).map(token => Number(token.trim()))])].filter(id => id > 0 && id <= 2147483647);
  const ids = [...new Set(sources.flatMap(idsFor))];
  const categories = ids.length ? await tx.select().from(storeProductCategory).where(inArray(storeProductCategory.id, ids)).orderBy(asc(storeProductCategory.id)) : [];
  return new Map(sources.map(source => [source.id, { product_type: source.productType,
    category_name: idsFor(source).map(id => {
      const category = categories.find(row => row.id === id && ((row.type === 0 && row.relationId === 0) || (source.type === 2 && row.type === 2 && row.relationId === source.relationId)));
      return category?.cateName ?? `未知分类#${id}`;
    }).join(', ') }]));
}

export function sourceIssues(row: SourceRow | undefined) {
  if (!row) return ['基础商品不存在'];
  const issues: string[] = [];
  if (row.isDel !== 0 || row.isVerify !== 1) issues.push('基础商品已删除或未通过审核');
  if (row.isVipProduct !== 0 || row.isPresaleProduct !== 0) issues.push('基础商品为会员专享或预售商品');
  if (![0, 1, 2].includes(row.type) || (row.type === 2 ? row.relationId <= 0 : row.relationId !== 0)) issues.push('基础商品所属方配置无效');
  if (!Number.isSafeInteger(row.stock) || row.stock < 0) issues.push('基础商品库存无效');
  return issues;
}
export async function sourceOwnerIssues(tx: DbClient, row: SourceRow | undefined, locked = false) {
  const issues = sourceIssues(row);
  if (row?.type === 2 && row.relationId > 0) {
    const query = tx.select({ id: systemSupplier.id, isShow: systemSupplier.isShow, isDel: systemSupplier.isDel })
      .from(systemSupplier).where(eq(systemSupplier.id, row.relationId)).limit(1);
    const [supplier] = await (locked ? query.for('share', { noWait: true }) : query);
    if (!supplier || supplier.isShow !== 1 || supplier.isDel !== 0) issues.push('供应商不存在、已停用或已删除');
  }
  return issues;
}
export function parentIssues(row: ParentRow) {
  const issues: string[] = [];
  if (!row.name.trim() || [...row.name].length > 128 || /[\u0000-\u001f\u007f]/u.test(row.name)) issues.push('活动名称无效');
  if (!activityDateText(row.startDay) || !activityDateText(row.endDay) || row.startDay > row.endDay) issues.push('活动日期无效');
  if (row.status !== 0 && row.status !== 1) issues.push('活动状态无效');
  if (!Number.isSafeInteger(row.num) || !Number.isSafeInteger(row.onceNum) || !row.num || !row.onceNum || row.num < 0 || row.onceNum < 0 || row.onceNum > row.num) issues.push('活动限购配置无效');
  try { seckillSlotIds(row.timeId); } catch { issues.push('活动场次配置无效'); }
  return issues;
}
export function parentPhase(row: ParentRow, now = Date.now()) {
  if (!activityDateText(row.startDay) || !activityDateText(row.endDay) || row.startDay > row.endDay) return 'invalid' as const;
  return now < row.startDay * 1000 ? 'future' as const : now >= row.endDay * 1000 + 86400000 ? 'ended' as const : 'active' as const;
}
export async function activityRevision(tx: DbClient, parent: ParentRow) {
  // Includes all child and SKU identities and xmin, even for over-cap legacy
  // parents. The SQL deadline bounds work; no truncated graph can authorize a write.
  const [state] = await tx.execute(sql`SELECT
    (SELECT md5(coalesce(string_agg((to_jsonb(c) || jsonb_build_object('xmin',c.xmin::text))::text,E'\n' ORDER BY c.id),''))
      FROM store_seckill c WHERE c.activity_id=${parent.id}) AS children,
    (SELECT md5(coalesce(string_agg((to_jsonb(s) || jsonb_build_object('xmin',s.xmin::text))::text,E'\n' ORDER BY s.id),''))
      FROM store_product_attr_value s JOIN store_seckill c ON c.id=s.product_id
      WHERE c.activity_id=${parent.id} AND s.type=1) AS skus`);
  return activityHash({ parent, children: state.children, skus: state.skus });
}
export async function activityGraph(tx: DbClient, parentId: number, locked = false) {
  const childQuery = tx.select(childColumns).from(storeSeckill).where(eq(storeSeckill.activityId, parentId))
    .orderBy(asc(storeSeckill.id)).limit(SECKILL_ACTIVITY_MAX_PRODUCTS + 1);
  const children = await (locked ? childQuery.for('update') : childQuery);
  if (children.length > SECKILL_ACTIVITY_MAX_PRODUCTS) throw new ValidateException('历史关联商品超过100项，无法完整编辑；可先关闭或归档');
  const ids = children.map(row => row.id);
  const skuQuery = ids.length ? tx.select(skuColumns).from(storeProductAttrValue).where(and(inArray(storeProductAttrValue.productId, ids), eq(storeProductAttrValue.type, 1)))
    .orderBy(asc(storeProductAttrValue.id)).limit(SECKILL_ACTIVITY_MAX_TOTAL_SKUS + 1) : null;
  const skus = skuQuery ? await skuQuery : [];
  if (skus.length > SECKILL_ACTIVITY_MAX_TOTAL_SKUS || children.some(child => skus.filter(row => row.productId === child.id).length > 500)) throw new ValidateException('历史关联规格超过完整编辑容量，无法截断保存；可先关闭或归档');
  return { children, skus };
}
export async function activitySlots(tx: DbClient, ids: number[], locked = false) {
  if (!ids.length) return [];
  const query = tx.select().from(storeSeckillTime).where(inArray(storeSeckillTime.id, ids)).orderBy(asc(storeSeckillTime.id));
  return locked ? query.for('share') : query;
}
export function slotView(row: typeof storeSeckillTime.$inferSelect) {
  let start = row.startTime, end = row.endTime, valid = row.status === 0 || row.status === 1;
  try {
    const from = seckillSlotMinutes(start), to = seckillSlotMinutes(end, true); if (from >= to) throw Error();
    start = `${String(Math.floor(from / 60)).padStart(2, '0')}:${String(from % 60).padStart(2, '0')}`;
    end = `${String(Math.floor(to / 60)).padStart(2, '0')}:${String(to % 60).padStart(2, '0')}`;
  } catch { valid = false; }
  return { id: row.id, title: row.title ?? '', start_time: start, end_time: end, status: row.status === 1 ? 1 : 0, valid };
}
export function skuIssues(row: SkuRow, base: SkuRow | undefined, activeRows: SkuRow[]) {
  const issues: string[] = [];
  if (!base || base.isRetired !== 0 || base.suk !== row.suk) issues.push('基础规格缺失、已退役或无法匹配');
  if (!row.unique || row.unique !== row.unique.trim() || row.unique.length > 8 || /[\u0000-\u0020\u007f]/u.test(row.unique)) issues.push('活动规格标识无效');
  if (row.suk !== row.suk.trim() || activeRows.filter(sku => sku.suk === row.suk).length !== 1 || activeRows.filter(sku => sku.unique === row.unique).length !== 1) issues.push('活动规格组合或标识重复');
  if ([row.stock, row.quota, row.quotaShow, row.sales].some(value => !Number.isSafeInteger(value) || value < 0) || row.quotaShow < row.quota || row.stock < row.quota) issues.push('活动规格额度账目无效');
  try { activityMoney(row.price); } catch { issues.push('活动规格价格无效'); }
  return issues;
}
export async function parentSummary(tx: DbClient, row: ParentRow) {
  const issues = parentIssues(row); let ids: number[] = [];
  try { ids = seckillSlotIds(row.timeId); } catch { /* Report raw legacy data below. */ }
  const slots = await activitySlots(tx, ids), times = slots.map(slotView);
  if (ids.some(id => !slots.some(slot => slot.id === id))) issues.push('存在缺失的场次');
  if (times.some(time => !time.valid)) issues.push('关联场次配置损坏');
  const picture = row.image ? (await publicSeckillTimePictures(tx, [row.image]))[0] : '';
  if (row.image && (!picture || [...picture].length > 128)) issues.push('活动氛围图无效');
  const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeSeckill)
    .where(and(eq(storeSeckill.activityId, row.id), eq(storeSeckill.isShow, 1), eq(storeSeckill.isDel, 0)));
  return { id: row.id, name: row.name, start_day: activityDateText(row.startDay), end_day: activityDateText(row.endDay), time_ids: ids,
    time_list: times, num: row.num ?? 0, once_num: row.onceNum ?? 0, image: picture, status: row.status === 1 ? 1 : 0,
    phase: parentPhase(row), product_count: count.count, add_time: row.addTime, valid: !issues.length, issues,
    revision: await activityRevision(tx, row), raw: { start_day: row.startDay, end_day: row.endDay, time_id: row.timeId,
      status: row.status, once_num: row.onceNum, num: row.num, image: row.image,
      applicable_type: row.applicableType, applicable_store_id: row.applicableStoreId } };
}
