import { and, asc, desc, eq, getTableColumns, ilike, inArray, or, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeActivity, storeProduct, storeProductAttr, storeProductAttrResult, storeProductAttrValue,
  storeProductDescription, storeProductSkuRetirementLog, storeSeckill, storeSeckillTime, systemLog } from '@/models/schema';
import { acquireSeckillTimeReferenceLock } from '@/migrations/seckillTimeReferenceLock';
import { publicSeckillTimePictures, renderSeckillTimePictures } from '@/services/activity/SeckillTimeAssetPolicy';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { seckillSlotIds } from '@/services/activity/SeckillScheduleService';
import { PRODUCT_SKU_IDENTITY_LOCK_KEY, PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE } from '@/services/product/ProductSkuIdentity';
import { lockShippingTemplateBindings } from '@/services/product/ShippingTemplateLifecycleService';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { activityFlag, activityHash, activityId, activityInteger, activityListQuery, activityWhitelist,
  parseActivityInput, SECKILL_ACTIVITY_MAX_PRODUCTS, SECKILL_ACTIVITY_MAX_SKUS, SECKILL_ACTIVITY_MAX_TOTAL_SKUS,
  type ActivityInput, type ActivityProductInput, type SeckillActivityOperation } from './AdminSeckillActivityInput';
import { activityCandidateFilters, activityCategories, activityGraph, activityLabels, activityProductMetadata, activityRevision, activitySlots, parentColumns, parentIssues, parentSummary,
  skuIssues, slotView, sourceOwnerIssues, type ChildRow, type ParentRow, type SkuRow, type SourceRow } from './AdminSeckillActivityData';

const LOCK_NAMESPACE = 731_646;
const sourcePredicate = and(eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1), eq(storeProduct.isVipProduct, 0), eq(storeProduct.isPresaleProduct, 0));
const sourceColumns = { ...getTableColumns(storeProduct) };
const method = (operation: SeckillActivityOperation) => operation === 'create' ? 'POST' : operation === 'delete' ? 'DELETE' : 'PUT';
async function deadlines(tx: DbClient) {
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
}
async function failFast<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('商品或规格正在变化，请刷新后重试');
      if (!('cause' in cause) || cause.cause === cause) break; cause = cause.cause;
    }
    throw error;
  }
}
function quota(row: SkuRow, total: number) {
  for (const value of [row.quota, row.quotaShow, row.stock, row.sales]) activityInteger(value, '历史规格额度');
  const consumed = row.quotaShow - row.quota, delta = total - row.quotaShow;
  if (consumed < 0 || row.stock < row.quota || total < consumed) throw new ValidateException('配置总额度不能小于已消耗额度，历史账目须一致');
  const stock = activityInteger(row.stock + delta, '活动库存');
  activityInteger(stock + consumed, '取消或退款后库存');
  activityInteger(row.sales + total - consumed, '新增购买后销量');
  return { quotaShow: total, quota: activityInteger(total - consumed, '剩余额度'), stock };
}
const minimum = (values: string[]) => values.reduce((left, right) => Number(right) < Number(left) ? right : left);
function assertChildAccounts(child: ChildRow, rows: SkuRow[]) {
  if ([child.quota, child.quotaShow, child.stock, child.sales].some(value => !Number.isSafeInteger(value) || value < 0) ||
    child.quota !== rows.reduce((sum, row) => sum + row.quota, 0) || child.quotaShow !== rows.reduce((sum, row) => sum + row.quotaShow, 0) ||
    child.stock !== rows.reduce((sum, row) => sum + row.stock, 0)) throw new ValidateException('历史子商品与规格额度账目不一致，请专项核对');
  activityInteger(child.stock + child.quotaShow - child.quota, '取消或退款后聚合库存');
}

/** Parent schedule management. All writes fence parent then child relations
 * before row locks, preventing append/reparent phantoms and matching buyers.
 * Source/SKU secondary locks never wait while holding their opposite inventory
 * side. No maintenance connection, implicit grants or physical identity rebuild. */
export class AdminSeckillActivityService {
  constructor(private readonly container: Container, private readonly appKey?: string) {}
  private async read<T>(run: (tx: DbClient) => Promise<T>) {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await deadlines(tx); return run(tx);
    });
  }
  private async preview<T extends { image: string }>(rows: T[]) {
    const signed = await renderSeckillTimePictures(this.appKey, rows.map(row => row.image));
    return rows.map((row, index) => ({ ...row, image_preview: signed[index] ?? '' }));
  }
  private async skuPreviews<T extends { skus: Array<{ image: string }> }>(products: T[]) {
    const signed = await renderProductPictures(this.appKey, products.flatMap(product => product.skus.map(row => row.image)));
    let index = 0;
    return products.map(product => ({ ...product, skus: product.skus.map(row => ({ ...row, image_preview: signed[index++] ?? '' })) })) as
      Array<T & { skus: Array<T['skus'][number] & { image_preview: string }> }>;
  }
  async list(parameters: URLSearchParams) {
    const query = activityListQuery(parameters), now = Math.floor(Date.now() / 1000);
    const badDates = sql`(${storeActivity.startDay} <= 0 OR ${storeActivity.endDay} < ${storeActivity.startDay}
      OR (${storeActivity.startDay}::bigint+28800)%86400<>0 OR (${storeActivity.endDay}::bigint+28800)%86400<>0)`;
    const phase = query.phase === 'invalid' ? badDates : query.phase === 'future' ? sql`NOT ${badDates} AND ${storeActivity.startDay}>${now}`
      : query.phase === 'ended' ? sql`NOT ${badDates} AND ${storeActivity.endDay}::bigint+86400<=${now}`
        : query.phase === 'active' ? sql`NOT ${badDates} AND ${storeActivity.startDay}<=${now} AND ${storeActivity.endDay}::bigint+86400>${now}` : undefined;
    const keyword = query.keyword ? or(ilike(storeActivity.name, `%${query.keyword.replace(/[\\%_]/g, '\\$&')}%`),
      /^[1-9]\d{0,9}$/.test(query.keyword) && Number(query.keyword) <= 2147483647 ? eq(storeActivity.id, Number(query.keyword)) : undefined) : undefined;
    const predicate = and(eq(storeActivity.type, 1), eq(storeActivity.isDel, 0), keyword, phase,
      query.status === 'all' ? undefined : eq(storeActivity.status, Number(query.status)));
    const result = await this.read(async tx => {
      const rows = await tx.select(parentColumns).from(storeActivity).where(predicate).orderBy(asc(storeActivity.startTime), desc(storeActivity.id)).limit(query.limit).offset(query.offset);
      const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeActivity).where(predicate);
      return { list: await Promise.all(rows.map(row => parentSummary(tx, row))), count: count.count, page: query.page, limit: query.limit };
    });
    return { ...result, list: await this.preview(result.list) };
  }
  async options() {
    return this.read(async tx => {
      const rows = await tx.select().from(storeSeckillTime).orderBy(asc(storeSeckillTime.id)).limit(1001);
      if (rows.length > 1000) throw new ValidateException('场次选项超过1000项，请先整理场次；不能截断保存');
      return { times: rows.map(slotView), max_slots: 64, max_products: SECKILL_ACTIVITY_MAX_PRODUCTS,
        max_skus: SECKILL_ACTIVITY_MAX_SKUS, max_total_skus: SECKILL_ACTIVITY_MAX_TOTAL_SKUS,
        categories: (await activityCategories(tx)).options, labels: await activityLabels(tx), max_categories: 5000, max_labels: 5000 };
    });
  }
  async candidates(parameters: URLSearchParams) {
    const query = activityListQuery(parameters, true);
    const result = await this.read(async tx => {
      const predicate = and(sourcePredicate, await activityCandidateFilters(tx, query), query.keyword ? or(ilike(storeProduct.storeName, `%${query.keyword.replace(/[\\%_]/g, '\\$&')}%`),
        /^[1-9]\d{0,9}$/.test(query.keyword) && Number(query.keyword) <= 2147483647 ? eq(storeProduct.id, Number(query.keyword)) : undefined) : undefined);
      const rows = await tx.select(sourceColumns).from(storeProduct).where(predicate).orderBy(desc(storeProduct.id)).limit(query.limit).offset(query.offset);
      const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeProduct).where(predicate);
      const pictures = await publicProductPictures(tx, rows), metadata = await activityProductMetadata(tx, rows);
      const list = await Promise.all(rows.map(async (row, index) => { const issues = await sourceOwnerIssues(tx, row);
        return { product_id: row.id, store_name: row.storeName, image: pictures[index], stock: row.stock, ...metadata.get(row.id), valid: !issues.length, issues }; }));
      return { list, count: count.count, page: query.page, limit: query.limit };
    });
    return { ...result, list: await this.preview(result.list) };
  }
  async source(value: unknown) {
    const id = activityId(value, '基础商品ID');
    const result = await this.read(async tx => {
      const [source] = await tx.select().from(storeProduct).where(eq(storeProduct.id, id)).limit(1);
      if (!source) throw new NotFoundException('基础商品不存在');
      const rows = await tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0)))
        .orderBy(asc(storeProductAttrValue.id)).limit(501);
      if (rows.length > 500) throw new ValidateException('基础规格超过500项，不能截断选择');
      const issues = await sourceOwnerIssues(tx, source);
      const pictures = await publicProductPictures(tx, [source, ...rows.map(row => ({ image: row.image, type: source.type, relationId: source.relationId }))]);
      const metadata = await activityProductMetadata(tx, [source]);
      return { product_id: id, child_id: null, store_name: source.storeName, image: pictures[0], status: 1 as const, stock: source.stock,
        ...metadata.get(id), valid: !issues.length, issues, skus: rows.map((row, index) => {
          const skuErrors = skuIssues({ ...row, quota: 0, quotaShow: 0 }, row, rows);
          return { id: null, base_sku_id: row.id, base_unique: row.unique, unique: '', suk: row.suk, price: row.price, cost: row.cost, ot_price: row.otPrice,
            image: pictures[index + 1],
            quota: 0, quota_show: 0, consumed: 0, quota_total: 0, remaining: 0, stock: row.stock, base_stock: row.stock,
            enabled: false, retired: false, valid: !skuErrors.length, issues: skuErrors };
        }) };
    });
    return (await this.skuPreviews(await this.preview([result])))[0];
  }
  async detail(value: unknown) {
    const id = activityId(value);
    const result = await this.read(async tx => {
      const [parent] = await tx.select(parentColumns).from(storeActivity).where(and(eq(storeActivity.id, id), eq(storeActivity.type, 1), eq(storeActivity.isDel, 0))).limit(1);
      if (!parent) throw new NotFoundException('秒杀父活动不存在');
      const summary = await parentSummary(tx, parent), graph = await activityGraph(tx, id);
      const baseIds = [...new Set(graph.children.map(row => row.productId).filter(Boolean))];
      const sources = baseIds.length ? await tx.select().from(storeProduct).where(inArray(storeProduct.id, baseIds)) : [];
      const bases = baseIds.length ? await tx.select().from(storeProductAttrValue).where(and(inArray(storeProductAttrValue.productId, baseIds), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0)))
        .orderBy(asc(storeProductAttrValue.id)).limit(SECKILL_ACTIVITY_MAX_TOTAL_SKUS + 1) : [];
      if (bases.length > SECKILL_ACTIVITY_MAX_TOTAL_SKUS) throw new ValidateException('基础规格超过完整详情容量，不能截断编辑');
      const pictures = await publicProductPictures(tx, graph.children), metadata = await activityProductMetadata(tx, sources);
      const skuPictures = await publicProductPictures(tx, graph.skus.map(row => {
        const child = graph.children.find(child => child.id === row.productId)!;
        return { image: row.image, type: child.type, relationId: child.relationId };
      }));
      const products = await Promise.all(graph.children.map(async (child, index) => {
        const source = sources.find(row => row.id === child.productId), issues = await sourceOwnerIssues(tx, source);
        const rows = graph.skus.filter(row => row.productId === child.id), active = rows.filter(row => row.isRetired === 0);
        if (child.status !== 0 && child.status !== 1) issues.push('子商品状态无效');
        if (child.num !== parent.num || child.onceNum !== parent.onceNum) issues.push('父子限购不一致');
        if (!active.length && child.isDel === 0) issues.push('子商品没有参与规格');
        const skus = rows.map(row => {
          const matches = bases.filter(base => base.productId === child.productId && base.suk === row.suk), base = matches.length === 1 ? matches[0] : undefined;
          const errors = skuIssues(row, base, row.isRetired ? [row] : active);
          if (errors.length && !row.isRetired) issues.push(`规格${row.id}配置无效`);
          return { id: row.id, base_unique: base?.unique ?? '', unique: row.unique, suk: row.suk, price: row.price, cost: row.cost, ot_price: row.otPrice,
            image: skuPictures[graph.skus.findIndex(sku => sku.id === row.id)],
            quota: row.quota, quota_show: row.quotaShow, consumed: row.quotaShow - row.quota, quota_total: row.quotaShow, remaining: row.quota,
            stock: row.stock, base_stock: base?.stock ?? 0, enabled: row.isRetired === 0 && child.isDel === 0,
            retired: row.isRetired === 1, valid: !errors.length, issues: errors };
        });
        return { child_id: child.id, product_id: child.productId, store_name: child.storeName, image: pictures[index],
          product_type: child.productType, category_name: metadata.get(child.productId)?.category_name ?? '',
          status: child.status === 1 ? 1 as const : 0 as const, deleted: child.isDel !== 0, valid: !issues.length, issues, skus };
      }));
      return { ...summary, valid: summary.valid && products.filter(row => !row.deleted).every(row => row.valid), products };
    });
    return { ...(await this.preview([result]))[0], products: await this.skuPreviews(await this.preview(result.products)) };
  }
  async mutate(operation: SeckillActivityOperation, value: unknown, raw: Record<string, unknown>, actor: { id: number }) {
    activityId(actor.id, '管理员ID'); const id = operation === 'create' ? 0 : activityId(value);
    activityWhitelist(raw, ['request_id', ...(id ? ['revision'] : []), ...(operation === 'delete' ? [] : operation === 'status' ? ['status']
      : ['name', 'start_day', 'end_day', 'time_ids', 'num', 'once_num', 'image', 'status', 'products'])]);
    if (typeof raw.request_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(raw.request_id)) throw new ValidateException('请求标识必须是UUID');
    if (id && (typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision))) throw new ValidateException('活动版本无效，请刷新');
    const input = operation === 'create' || operation === 'update' ? parseActivityInput(raw) : null;
    if (!id && input?.products.some(row => row.childId !== null || row.skus.some(sku => sku.id !== null))) throw new ValidateException('新建或复制不能携带旧身份');
    const status = operation === 'status' ? activityFlag(raw.status) : null;
    const fingerprint = await activityHash({ operation, id, revision: raw.revision ?? null, input, status });
    const path = `/activity/seckill-activities/request/${raw.request_id}`;
    return withTx(this.container, async tx => {
      const [isolation] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`);
      if (isolation?.isolation !== 'read committed') throw new ValidateException('父活动写入需要READ COMMITTED事务');
      await deadlines(tx); await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE},1)`);
      const logs = await tx.select({ action: systemLog.action }).from(systemLog).where(and(eq(systemLog.adminId, actor.id), eq(systemLog.type, 'seckill_activity'), eq(systemLog.path, path)))
        .orderBy(desc(systemLog.id)).limit(2);
      if (logs.length) {
        const match = /^([a-z]+);id=([1-9]\d{0,9});payload=([a-f0-9]{64})$/.exec(logs[0].action);
        if (logs.length !== 1 || !match || match[1] !== operation || match[3] !== fingerprint) throw new ValidateException('请求标识已用于其他父活动操作');
        return { id: activityId(match[2]) };
      }
      await acquireSeckillTimeReferenceLock(tx);
      const parent = id ? (await tx.select(parentColumns).from(storeActivity).where(and(eq(storeActivity.id, id), eq(storeActivity.type, 1), eq(storeActivity.isDel, 0))).limit(1).for('update'))[0] : undefined;
      if (id && !parent) throw new NotFoundException('秒杀父活动不存在');
      if (parent && await activityRevision(tx, parent) !== raw.revision) throw new ValidateException('父活动或关联商品已更新，请刷新后重新确认');
      let resultId = id;
      if (operation === 'delete') {
        await tx.update(storeActivity).set({ isDel: 1, status: 0 }).where(eq(storeActivity.id, id));
        await tx.update(storeSeckill).set({ isDel: 1, status: 0 }).where(eq(storeSeckill.activityId, id));
      } else if (operation === 'status') {
        if (status === 1) await this.validateEnable(tx, parent!);
        await tx.update(storeActivity).set({ status: status! }).where(eq(storeActivity.id, id));
        await tx.update(storeSeckill).set({ status: status! }).where(eq(storeSeckill.activityId, id));
      } else if (input) {
        // PHP saves reject dates whose inclusive end day is already over.
        // Re-read the real database clock after waits, rather than authorizing
        // a request that crossed Shanghai midnight while queued for locks.
        const [clock] = await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::double precision AS now`);
        const now = clock?.now;
        if (typeof now !== 'number' || !Number.isFinite(now) || input.endDay + 86400 < now) throw new ValidateException('活动结束日期已经过去，请调整日期后保存');
        const graph = id ? await activityGraph(tx, id, true) : { children: [] as ChildRow[], skus: [] as SkuRow[] };
        const slots = await activitySlots(tx, input.timeIds, true);
        if (slots.length !== input.timeIds.length || slots.some(row => !slotView(row).valid)) throw new ValidateException('场次缺失或损坏，请重新选择');
        if (input.status === 1 && !slots.some(row => row.status === 1)) throw new ValidateException('启用父活动至少需要一个启用场次');
        if (input.image && !(await publicSeckillTimePictures(tx, [input.image], true))[0]) throw new ValidateException('氛围图不属于平台图片素材');
        const [identity] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE},${PRODUCT_SKU_IDENTITY_LOCK_KEY}) AS acquired`);
        if (identity?.acquired !== true) throw new ValidateException('商品规格正在更新，请稍后重试');
        if (graph.skus.length) await failFast(() => tx.select({ id: storeProductAttrValue.id }).from(storeProductAttrValue)
          .where(inArray(storeProductAttrValue.id, graph.skus.map(row => row.id))).orderBy(asc(storeProductAttrValue.id)).for('update', { noWait: true }));
        const patch = { name: input.name, startDay: input.startDay, endDay: input.endDay, timeId: input.timeIds.join(','), num: input.num, onceNum: input.onceNum, image: input.image, status: input.status };
        if (parent) await tx.update(storeActivity).set(patch).where(eq(storeActivity.id, id));
        else { const [created] = await tx.insert(storeActivity).values({ ...patch, type: 1, isDel: 0, addTime: Math.floor(Date.now() / 1000) }).returning({ id: storeActivity.id }); resultId = created.id; }
        for (const product of input.products) await this.saveProduct(tx, resultId, input, product, graph, actor.id);
        const retained = new Set(input.products.filter(row => row.childId !== null).map(row => row.childId));
        for (const child of graph.children) if (!retained.has(child.id) && child.isDel === 0) {
          await tx.update(storeSeckill).set({ status: 0, isDel: 1 }).where(eq(storeSeckill.id, child.id));
          for (const sku of graph.skus.filter(row => row.productId === child.id && row.isRetired === 0)) await retireSku(tx, child.productId, sku, actor.id);
        }
      }
      await tx.insert(systemLog).values({ adminId: actor.id, type: 'seckill_activity', path, method: method(operation),
        action: `${operation};id=${resultId};payload=${fingerprint}`, addTime: Math.floor(Date.now() / 1000) });
      return { id: resultId };
    });
  }
  private async validateEnable(tx: DbClient, parent: ParentRow) {
    if (parentIssues({ ...parent, status: 1 }).length) throw new ValidateException('父活动配置损坏，请先编辑修复');
    const graph = await activityGraph(tx, parent.id, true), ids = seckillSlotIds(parent.timeId), slots = await activitySlots(tx, ids, true);
    if (slots.length !== ids.length || slots.some(row => !slotView(row).valid) || !slots.some(row => row.status === 1)) throw new ValidateException('父活动没有完整有效的启用场次');
    if (parent.image && (!(await publicSeckillTimePictures(tx, [parent.image], true))[0] || [...parent.image].length > 128)) throw new ValidateException('氛围图无效');
    const live = graph.children.filter(row => row.isDel === 0);
    if (!live.length) throw new ValidateException('父活动没有关联商品');
    for (const child of live) {
      const [source] = await failFast(() => tx.select().from(storeProduct).where(eq(storeProduct.id, child.productId)).limit(1).for('share', { noWait: true }));
      if ((await failFast(() => sourceOwnerIssues(tx, source, true))).length || child.num !== parent.num || child.onceNum !== parent.onceNum || child.timeId !== parent.timeId ||
        child.startTime?.getTime() !== parent.startDay * 1000 || child.stopTime?.getTime() !== parent.endDay * 1000) throw new ValidateException(`子商品${child.id}配置无效，请先编辑修复`);
      const active = graph.skus.filter(row => row.productId === child.id && row.isRetired === 0);
      assertChildAccounts(child, graph.skus.filter(row => row.productId === child.id));
      const bases = await failFast(() => tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, child.productId), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0))).orderBy(asc(storeProductAttrValue.id)).limit(501).for('share', { noWait: true }));
      if (!active.length || bases.length > 500 || new Set(bases.map(row => row.unique)).size !== bases.length || new Set(bases.map(row => row.suk)).size !== bases.length ||
        active.some(row => skuIssues(row, bases.find(base => base.suk === row.suk), active).length)) throw new ValidateException(`子商品${child.id}规格无效，请先编辑修复`);
      if (active.reduce((sum, row) => sum + row.quota, 0) > source!.stock ||
        active.some(row => row.quota > activityInteger(bases.find(base => base.suk === row.suk)!.stock, '基础规格库存')))
        throw new ValidateException('活动剩余额度不能超过当前基础商品或规格库存');
      await lockShippingTemplateBindings(tx, [{ tempId: child.tempId, freight: child.freight, ownerType: source!.type, relationId: source!.relationId }]);
    }
  }
  private async saveProduct(tx: DbClient, parentId: number, input: ActivityInput, item: ActivityProductInput,
    graph: { children: ChildRow[]; skus: SkuRow[] }, actorId: number) {
    const existing = item.childId === null ? undefined : graph.children.find(row => row.id === item.childId);
    if (item.childId !== null && (!existing || existing.productId !== item.productId)) throw new ValidateException('旧子商品身份与父活动或基础商品不匹配');
    const current = graph.skus.filter(row => row.productId === existing?.id);
    const requestedIds = new Set(item.skus.filter(row => row.id !== null).map(row => row.id));
    if (item.skus.some(sku => sku.id !== null && !current.some(row => row.id === sku.id))) throw new ValidateException('旧活动规格不属于此子商品');
    if (existing?.isDel) {
      if (item.status !== 0 || item.skus.some(row => row.enabled)) throw new ValidateException('已删除子商品不能通过普通保存恢复');
      return;
    }
    const enabled = item.skus.filter(row => row.enabled);
    if (!enabled.length) {
      if (!existing) return;
      await tx.update(storeSeckill).set({ status: 0 }).where(eq(storeSeckill.id, existing.id));
      for (const row of current.filter(row => row.isRetired === 0)) await retireSku(tx, item.productId, row, actorId);
      return;
    }
    const [source] = await failFast(() => tx.select().from(storeProduct).where(eq(storeProduct.id, item.productId)).limit(1).for('share', { noWait: true }));
    if ((await failFast(() => sourceOwnerIssues(tx, source, true))).length) throw new ValidateException('基础商品或供应商不符合秒杀条件');
    const bases = await failFast(() => tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, item.productId), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0)))
      .orderBy(asc(storeProductAttrValue.id)).limit(501).for('share', { noWait: true }));
    if (bases.length > 500 || new Set(bases.map(row => row.unique)).size !== bases.length || new Set(bases.map(row => row.suk)).size !== bases.length) throw new ValidateException('基础商品规格超过容量或标识重复');
    const chosen = enabled.map(sku => {
      const base = bases.find(row => row.unique === sku.baseUnique), old = sku.id === null ? undefined : current.find(row => row.id === sku.id);
      if (!base || base.suk !== base.suk.trim() || base.unique !== base.unique.trim() || !base.unique || /[\u0000-\u0020\u007f]/u.test(base.unique)) throw new ValidateException('基础商品规格已变化或标识无效');
      if (old && (old.isRetired !== 0 || old.suk !== base.suk)) throw new ValidateException('旧规格不能改变组合或隐式恢复退役身份');
      if (old && (!old.unique || old.unique !== old.unique.trim() || old.unique.length > 8 || /[\u0000-\u0020\u007f]/u.test(old.unique) ||
        bases.some(other => other.unique === old.unique && other.suk !== old.suk))) throw new ValidateException('旧活动规格标识损坏或与基础规格冲突');
      if (!old && current.some(row => row.suk === base.suk)) throw new ValidateException('相同组合已有历史活动身份，请保留原规格');
      const values = old ? quota(old, sku.total!) : { quotaShow: sku.total!, quota: sku.total!, stock: sku.total! };
      if (values.quota > activityInteger(base.stock, '基础规格库存')) throw new ValidateException('剩余额度不能超过当前基础规格库存');
      return { input: sku, base, old, values };
    });
    if (new Set(chosen.map(row => row.base.suk)).size !== chosen.length || new Set(chosen.filter(row => row.old).map(row => row.old!.unique)).size !== chosen.filter(row => row.old).length) throw new ValidateException('参与规格组合或身份重复');
    if (chosen.reduce((sum, row) => sum + row.values.quota, 0) > source!.stock) throw new ValidateException('活动剩余额度不能超过基础商品库存');
    const shipping = { tempId: source!.tempId, freight: source!.freight, ownerType: source!.type, relationId: source!.relationId };
    await lockShippingTemplateBindings(tx, [shipping]);
    const inherited = inheritSource(source!);
    let childId = existing?.id;
    if (!childId) {
      const [created] = await tx.insert(storeSeckill).values({ ...inherited, activityId: parentId, productId: item.productId, status: item.status,
        startTime: new Date(input.startDay * 1000), stopTime: new Date(input.endDay * 1000), timeId: input.timeIds.join(','), num: input.num, onceNum: input.onceNum,
        sales: 0, addTime: Math.floor(Date.now() / 1000) }).returning({ id: storeSeckill.id }); childId = created.id;
    }
    const saved: SkuRow[] = [...current];
    for (const row of chosen) {
      if (row.old) {
        const [updated] = await tx.update(storeProductAttrValue).set({ ...row.values, price: row.input.price! }).where(eq(storeProductAttrValue.id, row.old.id)).returning();
        saved[saved.findIndex(item => item.id === updated.id)] = updated;
      } else {
        let unique = '';
        for (let attempt = 0; attempt < 8 && !unique; attempt++) {
          const candidate = [...crypto.getRandomValues(new Uint8Array(4))].map(byte => byte.toString(16).padStart(2, '0')).join('');
          if (!(await tx.select({ id: storeProductAttrValue.id }).from(storeProductAttrValue).where(eq(storeProductAttrValue.unique, candidate)).limit(1)).length) unique = candidate;
        }
        if (!unique) throw new ValidateException('暂时无法分配规格标识，请重试');
        const { id: _baseId, productId: _baseProduct, unique: _baseUnique, ...baseValues } = row.base;
        const [inserted] = await tx.insert(storeProductAttrValue).values({ ...baseValues, ...row.values, productId: childId, unique, type: 1,
          price: row.input.price!, sales: 0, sumStock: row.values.stock, isRetired: 0, retiredAt: 0, retiredBy: 0, retireReason: '' }).returning(); saved.push(inserted);
      }
    }
    const activeIds = new Set(chosen.filter(row => row.old).map(row => row.old!.id));
    for (const row of current) if (row.isRetired === 0 && (!requestedIds.has(row.id) || !activeIds.has(row.id))) {
      await retireSku(tx, item.productId, row, actorId);
      saved[saved.findIndex(item => item.id === row.id)] = { ...row, isRetired: 1 };
    }
    const aggregate = { quota: 0, quotaShow: 0, stock: 0 };
    for (const row of saved) for (const key of ['quota', 'quotaShow', 'stock'] as const) aggregate[key] = activityInteger(aggregate[key] + activityInteger(row[key], '保留规格账目'), '子商品聚合额度');
    activityInteger(aggregate.stock + aggregate.quotaShow - aggregate.quota, '取消或退款后聚合库存');
    activityInteger((existing?.sales ?? 0) + aggregate.quota, '新增购买后子商品销量');
    if (existing) assertChildAccounts(existing, current);
    await tx.update(storeSeckill).set({ ...inherited, ...aggregate, price: minimum(chosen.map(row => row.input.price!)),
      otPrice: minimum(chosen.map(row => row.base.otPrice)), cost: minimum(chosen.map(row => row.base.cost)), status: item.status,
      timeId: input.timeIds.join(','), num: input.num, onceNum: input.onceNum,
      startTime: new Date(input.startDay * 1000), stopTime: new Date(input.endDay * 1000) }).where(eq(storeSeckill.id, childId));
    await copySourceContent(tx, item.productId, childId);
  }
}

function inheritSource(source: SourceRow): Partial<typeof storeSeckill.$inferInsert> {
  if (source.storeInfo.length > 255 || source.unitName.length > 16 || source.sliderImage.length > 2000 || source.deliveryType.length > 10) throw new ValidateException('基础商品展示或配送字段超过秒杀字段容量');
  return { type: source.type, productType: source.productType, relationId: source.relationId, storeName: source.storeName,
    image: source.image, images: source.sliderImage, info: source.storeInfo, unitName: source.unitName, postage: source.postage,
    isPostage: source.isPostage, tempId: source.tempId, freight: source.freight, deliveryType: source.deliveryType,
    customForm: source.customForm, systemFormId: source.systemFormId, isSupportRefund: source.isSupportRefund,
    storeLabelId: source.storeLabelId, ensureId: source.ensureId, specs: source.specs, giveIntegral: source.giveIntegral };
}
async function retireSku(tx: DbClient, productId: number, row: SkuRow, actorId: number) {
  if (row.isRetired !== 0) return;
  const now = Math.floor(Date.now() / 1000), reason = '秒杀父活动移除参与规格';
  await tx.update(storeProductAttrValue).set({ isRetired: 1, retiredAt: now, retiredBy: actorId, retireReason: reason }).where(eq(storeProductAttrValue.id, row.id));
  await tx.insert(storeProductSkuRetirementLog).values({ productId, skuId: row.id, uniqueSnapshot: row.unique, sukSnapshot: row.suk,
    action: 'retire', reason, actorId, dependencySnapshot: JSON.stringify({ type: 1, seckill_id: row.productId, quota: row.quota, quota_total: row.quotaShow }), addTime: now });
}
async function copySourceContent(tx: DbClient, productId: number, childId: number) {
  const dimensions = await tx.select().from(storeProductAttr).where(and(eq(storeProductAttr.productId, productId), eq(storeProductAttr.type, 0))).orderBy(asc(storeProductAttr.id)).limit(11);
  const results = await tx.select().from(storeProductAttrResult).where(and(eq(storeProductAttrResult.productId, productId), eq(storeProductAttrResult.type, 0))).limit(2);
  const descriptions = await tx.select().from(storeProductDescription).where(and(eq(storeProductDescription.productId, productId), eq(storeProductDescription.type, 0))).limit(2);
  if (dimensions.length > 10 || results.length > 1 || descriptions.length > 1) throw new ValidateException('基础商品内容或规格快照重复/超出容量');
  // Dimension rows are display metadata; orders reference the retained SKU id,
  // unique and suk. Reconcile metadata without replacing any activity SKU.
  await tx.delete(storeProductAttr).where(and(eq(storeProductAttr.productId, childId), eq(storeProductAttr.type, 1)));
  if (dimensions.length) await tx.insert(storeProductAttr).values(dimensions.map(row => ({ productId: childId, type: 1, attrName: row.attrName, attrValues: row.attrValues })));
  // Authoritative activity SKU rows drive price/stock. Do not copy a stale base
  // JSON value array whose base uniques would falsely identify activity SKUs.
  const skus = await tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, childId), eq(storeProductAttrValue.type, 1), eq(storeProductAttrValue.isRetired, 0))).orderBy(asc(storeProductAttrValue.id));
  const result = JSON.stringify({ attr: dimensions.map(row => ({ value: row.attrName, detail: row.attrValues.split(',') })), value: skus }), now = Math.floor(Date.now() / 1000);
  const snapshots = await tx.select({ id: storeProductAttrResult.id }).from(storeProductAttrResult).where(and(eq(storeProductAttrResult.productId, childId), eq(storeProductAttrResult.type, 1))).limit(2);
  if (snapshots.length > 1) throw new ValidateException('历史活动规格快照重复，请先专项核对');
  // The commissioned Admin profile owns INSERT/DELETE for this display cache.
  // Cache ids are not SKU/order identities; replace it atomically without
  // broadening runtime grants or touching retained activity SKU rows.
  if (snapshots[0]) await tx.delete(storeProductAttrResult).where(eq(storeProductAttrResult.id, snapshots[0].id));
  await tx.insert(storeProductAttrResult).values({ productId: childId, type: 1, result, changeTime: now });
  if (descriptions[0]) {
    const savedDescriptions = await tx.select({ productId: storeProductDescription.productId }).from(storeProductDescription)
      .where(and(eq(storeProductDescription.productId, childId), eq(storeProductDescription.type, 1))).limit(2);
    if (savedDescriptions.length > 1) throw new ValidateException('历史活动描述重复，请先专项核对');
    if (savedDescriptions[0]) await tx.update(storeProductDescription).set({ description: descriptions[0].description })
      .where(and(eq(storeProductDescription.productId, childId), eq(storeProductDescription.type, 1)));
    else await tx.insert(storeProductDescription).values({ productId: childId, type: 1, description: descriptions[0].description });
    await tx.update(storeSeckill).set({ description: descriptions[0].description }).where(eq(storeSeckill.id, childId));
  }
}
