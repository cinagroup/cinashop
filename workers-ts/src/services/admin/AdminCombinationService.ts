import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { shippingTemplates, storeCombination, storePink, storeProduct, storeProductAttr, storeProductAttrResult, storeProductAttrValue,
  storeProductDescription, storeProductSkuRetirementLog, storeProductUnit, systemLog } from '@/models/schema';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { PRODUCT_SKU_IDENTITY_LOCK_KEY, PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE } from '@/services/product/ProductSkuIdentity';
import { lockShippingTemplateBindings } from '@/services/product/ShippingTemplateLifecycleService';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { activityFlag, activityHash, activityId, activityInteger, activityListQuery } from './AdminSeckillActivityInput';
import { activityCandidateFilters, activityCategories, activityLabels, activityProductMetadata, sourceOwnerIssues, type SourceRow } from './AdminSeckillActivityData';
import { combinationWhitelist, parseCombinationInput, COMBINATION_MAX_SKUS, type CombinationInput, type CombinationOperation } from './AdminCombinationInput';
import { assertCombinationAccounts, combinationColumns, combinationGraph, combinationIssues, combinationPhase, combinationRevision,
  combinationSkuIssues, combinationTime, type CombinationRow, type CombinationSkuRow } from './AdminCombinationData';
import { combinationDescription, renderCombinationDescription, validateCombinationMedia } from './AdminCombinationMediaPolicy';

const LOCK_NAMESPACE = 731_647;
const sourcePredicate = and(eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1), eq(storeProduct.isVipProduct, 0), eq(storeProduct.isPresaleProduct, 0));
const method = (operation: CombinationOperation) => operation === 'create' ? 'POST' : operation === 'delete' ? 'DELETE' : 'PUT';
const minimum = (values: string[]) => values.reduce((left, right) => Number(right) < Number(left) ? right : left);
async function deadlines(tx: DbClient) {
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
}
async function failFast<T>(run: () => Promise<T>) {
  try { return await run(); } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('拼团、商品或规格正在变化，请刷新后重试');
      if (!('cause' in cause) || cause.cause === cause) break; cause = cause.cause;
    }
    throw error;
  }
}
function gallery(value: string) {
  try { const parsed: unknown = JSON.parse(value); if (Array.isArray(parsed) && parsed.length <= 10 && parsed.every(image => typeof image === 'string')) return parsed as string[]; } catch { /* Keep damaged legacy data in raw. */ }
  return [];
}
function shippingView(row: { deliveryType: string; freight: number; postage: string; tempId: number }) {
  return { delivery_type: row.deliveryType.split(',').map(Number).filter(value => [1, 2, 3].includes(value)), freight: row.freight, postage: row.postage, temp_id: row.tempId };
}
function quota(row: CombinationSkuRow, total: number) {
  for (const value of [row.quota, row.quotaShow, row.stock, row.sales]) activityInteger(value, '历史拼团规格额度');
  const consumed = row.quotaShow - row.quota, delta = total - row.quotaShow;
  if (consumed < 0 || row.stock < row.quota || total < consumed) throw new ValidateException('配置总额度不能小于已消耗额度，历史账目须一致');
  const stock = activityInteger(row.stock + delta, '拼团规格库存');
  activityInteger(stock + consumed, '取消或退款后库存'); activityInteger(row.sales + total - consumed, '新增购买后销量');
  return { quotaShow: total, quota: activityInteger(total - consumed, '剩余额度'), stock };
}

/** Dedicated complete combination configuration. Existing SKU and refund
 * identities survive editing, retirement and soft deletion. Normal inventory
 * edits use PinkInventory's NO KEY UPDATE boundary. Closing uses NOWAIT UPDATE
 * only, so payment's order -> KEY SHARE order is never reversed by a wait. */
export class AdminCombinationService {
  constructor(private readonly container: Container, private readonly appKey?: string) {}
  private async read<T>(run: (tx: DbClient) => Promise<T>) {
    return withTx(this.container, async tx => { await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await deadlines(tx); return run(tx); });
  }
  private async preview<T extends { image: string }>(rows: T[]) {
    const images = await renderProductPictures(this.appKey, rows.map(row => row.image));
    return rows.map((row, index) => ({ ...row, image_preview: images[index] ?? '' }));
  }
  private async completePreview<T extends { image: string; images: string[]; description: string; skus: Array<{ image: string }> }>(row: T) {
    const signed = await renderProductPictures(this.appKey, [...row.images, ...row.skus.map(sku => sku.image)]);
    return { ...(await this.preview([row]))[0], images_preview: signed.slice(0, row.images.length),
      description_preview: await renderCombinationDescription(this.appKey, row.description),
      skus: row.skus.map((sku, index) => ({ ...sku, image_preview: signed[row.images.length + index] ?? '' })) };
  }
  async list(parameters: URLSearchParams) {
    const query = activityListQuery(parameters), now = new Date().toISOString();
    const badDates = sql`(${storeCombination.startTime} IS NULL OR ${storeCombination.stopTime} IS NULL OR NOT isfinite(${storeCombination.startTime}) OR NOT isfinite(${storeCombination.stopTime}) OR ${storeCombination.startTime}>${storeCombination.stopTime})`;
    const phase = query.phase === 'invalid' ? badDates : query.phase === 'future' ? sql`NOT ${badDates} AND ${storeCombination.startTime}>${now}`
      : query.phase === 'ended' ? sql`NOT ${badDates} AND ${storeCombination.stopTime}<${now}`
        : query.phase === 'active' ? sql`NOT ${badDates} AND ${storeCombination.startTime}<=${now} AND ${storeCombination.stopTime}>=${now}` : undefined;
    const keyword = query.keyword ? or(ilike(storeCombination.storeName, `%${query.keyword.replace(/[\\%_]/g, '\\$&')}%`),
      /^[1-9]\d{0,9}$/.test(query.keyword) && Number(query.keyword) <= 2147483647 ? eq(storeCombination.id, Number(query.keyword)) : undefined) : undefined;
    const predicate = and(eq(storeCombination.isDel, 0), keyword, phase, query.status === 'all' ? undefined : eq(storeCombination.status, Number(query.status)));
    const result = await this.read(async tx => {
      const rows = await tx.select(combinationColumns).from(storeCombination).where(predicate).orderBy(desc(storeCombination.sort), desc(storeCombination.id)).limit(query.limit).offset(query.offset);
      const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeCombination).where(predicate);
      return { list: await Promise.all(rows.map(row => this.summary(tx, row))), count: count.count, page: query.page, limit: query.limit };
    });
    return { ...result, list: await this.preview(result.list) };
  }
  async options() {
    return this.read(async tx => {
      const units = await tx.select({ id: storeProductUnit.id, name: storeProductUnit.name }).from(storeProductUnit)
        .where(and(eq(storeProductUnit.type, 0), eq(storeProductUnit.relationId, 0), eq(storeProductUnit.isDel, 0), eq(storeProductUnit.status, 1)))
        .orderBy(desc(storeProductUnit.sort), desc(storeProductUnit.id)).limit(5001);
      if (units.length > 5000) throw new ValidateException('商品单位超过完整选项容量');
      return { categories: (await activityCategories(tx)).options, labels: await activityLabels(tx), units, templates: await this.templates(tx, 0, 0),
        max_skus: COMBINATION_MAX_SKUS, max_images: 10, max_categories: 5000, max_labels: 5000 };
    });
  }
  private async templates(tx: DbClient, type: number, relationId: number) {
    const ownerType = type === 2 ? 2 : 0, ownerId = ownerType === 2 ? relationId : 0;
    const rows = await tx.select({ id: shippingTemplates.id, name: shippingTemplates.name, owner_type: shippingTemplates.ownerType, relation_id: shippingTemplates.relationId }).from(shippingTemplates)
      .where(and(eq(shippingTemplates.ownerType, ownerType), eq(shippingTemplates.relationId, ownerId), eq(shippingTemplates.status, 1), eq(shippingTemplates.isDel, 0)))
      .orderBy(desc(shippingTemplates.sort), desc(shippingTemplates.id)).limit(5001);
    if (rows.length > 5000) throw new ValidateException('运费模板超过完整选项容量'); return rows;
  }
  async candidates(parameters: URLSearchParams) {
    const query = activityListQuery(parameters, true);
    const result = await this.read(async tx => {
      const predicate = and(sourcePredicate, await activityCandidateFilters(tx, query), query.keyword ? or(ilike(storeProduct.storeName, `%${query.keyword.replace(/[\\%_]/g, '\\$&')}%`),
        /^[1-9]\d{0,9}$/.test(query.keyword) && Number(query.keyword) <= 2147483647 ? eq(storeProduct.id, Number(query.keyword)) : undefined) : undefined);
      const rows = await tx.select().from(storeProduct).where(predicate).orderBy(desc(storeProduct.id)).limit(query.limit).offset(query.offset);
      const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeProduct).where(predicate);
      const pictures = await publicProductPictures(tx, rows), metadata = await activityProductMetadata(tx, rows);
      const list = await Promise.all(rows.map(async (row, index) => { const issues = await sourceOwnerIssues(tx, row);
        return { product_id: row.id, store_name: row.storeName, image: pictures[index], stock: row.stock, ...metadata.get(row.id), valid: !issues.length, issues }; }));
      return { list, count: count.count, page: query.page, limit: query.limit };
    }); return { ...result, list: await this.preview(result.list) };
  }
  async source(value: unknown) {
    const productId = activityId(value, '基础商品ID');
    const result = await this.read(async tx => {
      const [source] = await tx.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1);
      if (!source) throw new NotFoundException('基础商品不存在');
      const rows = await tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, productId), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0))).orderBy(asc(storeProductAttrValue.id)).limit(501);
      const dimensions = await tx.select().from(storeProductAttr).where(and(eq(storeProductAttr.productId, productId), eq(storeProductAttr.type, 0))).orderBy(asc(storeProductAttr.id)).limit(11);
      const descriptions = await tx.select().from(storeProductDescription).where(and(eq(storeProductDescription.productId, productId), eq(storeProductDescription.type, 0))).limit(2);
      if (rows.length > 500 || dimensions.length > 10 || descriptions.length > 1) throw new ValidateException('基础商品规格或详情超过完整选择容量');
      const issues = await sourceOwnerIssues(tx, source), rawImages = gallery(source.sliderImage);
      const pictures = await publicProductPictures(tx, [source, ...rawImages.map(image => ({ ...source, image })), ...rows.map(sku => ({ ...source, image: sku.image }))]);
      if (!rows.length) issues.push('基础商品没有有效规格');
      return { product_id: productId, title: source.storeName, info: source.storeInfo, unit_name: source.unitName, image: pictures[0], images: pictures.slice(1, 1 + rawImages.length),
        description: await combinationDescription(tx, source, descriptions[0]?.description ?? ''), shipping: shippingView(source), templates: await this.templates(tx, source.type, source.relationId),
        owner: { type: source.type, relation_id: source.relationId }, product_type: source.productType, is_support_refund: source.isSupportRefund, stock: source.stock,
        items: dimensions.map(row => ({ value: row.attrName, detail: row.attrValues.split(',') })), valid: !issues.length, issues,
        skus: rows.map((row, index) => {
          const errors = combinationSkuIssues({ ...row, quota: 0, quotaShow: 0 }, row, rows);
          return { id: null, base_sku_id: row.id, base_unique: row.unique, unique: '', suk: row.suk, price: row.price, cost: row.cost, ot_price: row.price, settle_price: row.settlePrice,
            image: pictures[1 + rawImages.length + index], quota_total: 0, consumed: 0, remaining: 0, stock: row.stock, base_stock: row.stock,
            weight: row.weight, volume: row.volume, bar_code: row.barCode, code: row.code, enabled: false, retired: false, valid: !errors.length, issues: errors };
        }) };
    }); return this.completePreview(result);
  }
  private async summary(tx: DbClient, row: CombinationRow) {
    const issues = combinationIssues(row), [image] = await publicProductPictures(tx, [row]);
    const [state] = await tx.execute(sql`SELECT
      (SELECT count(*)::integer FROM store_product_attr_value s WHERE s.product_id=${row.id} AND s.type=3) AS skus,
      (SELECT count(*)::integer FROM store_product_attr_value s WHERE s.product_id=${row.id} AND s.type=3 AND s.is_retired=0) AS active,
      (SELECT p.ot_price::text FROM store_product p WHERE p.id=${row.productId}) AS current_ot_price,
      (SELECT count(*)::integer FROM store_pink p WHERE p.combination_id=${row.id}) AS all_people,
      (SELECT count(*)::integer FROM store_pink p WHERE p.combination_id=${row.id} AND p.k_id=0) AS groups,
      (SELECT count(*)::integer FROM store_pink p WHERE p.combination_id=${row.id} AND p.k_id=0 AND p.status=2) AS completed`);
    if (!image) issues.push('拼团主图无效');
    if (state.active === 0 || Number(state.skus) > 500) issues.push('拼团参与规格为空或超过完整编辑容量');
    return { id: row.id, product_id: row.productId, title: row.storeName, image, start_time: combinationTime(row.startTime) ?? '', end_time: combinationTime(row.stopTime) ?? '',
      status: row.status === 1 && row.isShow === 1 ? 1 as const : 0 as const, is_show: row.isShow === 1 ? 1 : 0, phase: combinationPhase(row), people: row.people,
      quota_total: row.quotaShow, consumed: row.quotaShow - row.quota, remaining: row.quota, stock: row.stock, sales: row.sales, sort: row.sort,
      price: row.price, ot_price: typeof state.current_ot_price === 'string' ? state.current_ot_price : '',
      count_people: Number(state.groups), count_people_all: Number(state.all_people), count_people_pink: Number(state.completed),
      group_count: Number(state.groups), completed_group_count: Number(state.completed), valid: !issues.length, issues, revision: await combinationRevision(tx, row),
      raw: { status: row.status, is_show: row.isShow, image: row.image, images: row.images, start_time: String(row.startTime), end_time: String(row.stopTime) } };
  }
  async detail(value: unknown) {
    const id = activityId(value, '拼团活动ID');
    const result = await this.read(async tx => {
      const [row] = await tx.select(combinationColumns).from(storeCombination).where(and(eq(storeCombination.id, id), eq(storeCombination.isDel, 0))).limit(1);
      if (!row) throw new NotFoundException('拼团活动不存在');
      const summary = await this.summary(tx, row), graph = await combinationGraph(tx, id), [source] = await tx.select().from(storeProduct).where(eq(storeProduct.id, row.productId)).limit(1);
      const bases = await tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, row.productId), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0))).orderBy(asc(storeProductAttrValue.id)).limit(501);
      if (bases.length > 500) throw new ValidateException('基础规格超过完整详情容量，不能截断编辑');
      const issues = [...summary.issues, ...await sourceOwnerIssues(tx, source)], rawImages = gallery(row.images), active = graph.skus.filter(sku => sku.isRetired === 0);
      if (!rawImages.length) issues.push('拼团相册配置无效');
      try { assertCombinationAccounts(row, graph.skus); } catch { issues.push('拼团主行与规格额度不一致'); }
      const pictures = await publicProductPictures(tx, [...rawImages.map(image => ({ ...row, image })), ...graph.skus.map(sku => ({ ...row, image: sku.image }))]);
      const skus = graph.skus.map((sku, index) => {
        const matches = bases.filter(base => base.suk === sku.suk), base = matches.length === 1 ? matches[0] : undefined;
        const errors = combinationSkuIssues(sku, base, sku.isRetired === 1 ? [sku] : active);
        if (errors.length && sku.isRetired !== 1) issues.push(`规格${sku.id}配置无效`);
        return { id: sku.id, base_unique: base?.unique ?? '', unique: sku.unique, suk: sku.suk, price: sku.price, cost: sku.cost, ot_price: sku.otPrice, settle_price: sku.settlePrice,
          image: pictures[rawImages.length + index], quota_total: sku.quotaShow, consumed: sku.quotaShow - sku.quota, remaining: sku.quota, stock: sku.stock, base_stock: base?.stock ?? 0,
          weight: sku.weight, volume: sku.volume, bar_code: sku.barCode, code: sku.code, enabled: sku.isRetired === 0, retired: sku.isRetired === 1,
          valid: !errors.length, issues: errors, raw: { image: sku.image, is_retired: sku.isRetired } };
      });
      return { ...summary, info: row.info, unit_name: row.unitName, images: pictures.slice(0, rawImages.length), description: await combinationDescription(tx, row, graph.description),
        effective_time: row.effectiveTime, num: row.num, once_num: row.onceNum, virtual: row.virtual, is_host: row.isHost === 1 ? 1 : 0, is_support_refund: row.isSupportRefund === 1 ? 1 : 0,
        shipping: shippingView(row), templates: await this.templates(tx, row.type, row.relationId), owner: { type: row.type, relation_id: row.relationId }, product_type: row.productType,
        source_metadata: { custom_form: row.customForm, system_form_id: row.systemFormId, store_label_id: row.storeLabelId, ensure_id: row.ensureId, specs: row.specs },
        items: graph.dimensions.map(item => ({ value: item.attrName, detail: item.attrValues.split(',') })), skus, valid: !issues.length, issues };
    }); return this.completePreview(result);
  }
  async mutate(operation: CombinationOperation, value: unknown, raw: Record<string, unknown>, actor: { id: number }) {
    activityId(actor.id, '管理员ID'); const id = operation === 'create' ? 0 : activityId(value, '拼团活动ID');
    combinationWhitelist(raw, ['request_id', ...(id ? ['revision'] : []), ...(operation === 'delete' ? [] : operation === 'status' ? ['status']
      : ['product_id', 'title', 'info', 'unit_name', 'images', 'description', 'start_time', 'end_time', 'effective_time', 'people', 'num', 'once_num', 'virtual', 'sort', 'status', 'is_host', 'is_support_refund', 'shipping', 'skus'])]);
    if (typeof raw.request_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(raw.request_id)) throw new ValidateException('请求标识必须是UUID');
    if (id && (typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision))) throw new ValidateException('拼团版本无效，请刷新');
    const input = operation === 'create' || operation === 'update' ? parseCombinationInput(raw) : null, status = operation === 'status' ? activityFlag(raw.status) : null;
    if (!id && (!input?.skus.some(sku => sku.enabled) || input.skus.some(sku => sku.id !== null))) throw new ValidateException('新建或复制须选择参与规格且不能携带旧身份');
    const fingerprint = await activityHash({ operation, id, revision: raw.revision ?? null, input, status }), path = `/activity/combinations/request/${raw.request_id}`;
    return failFast(() => withTx(this.container, async tx => {
      const [isolation] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`);
      if (isolation?.isolation !== 'read committed') throw new ValidateException('拼团写入需要READ COMMITTED事务');
      await deadlines(tx); await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE},1)`);
      const logs = await tx.select({ action: systemLog.action }).from(systemLog).where(and(eq(systemLog.adminId, actor.id), eq(systemLog.type, 'combination'), eq(systemLog.path, path))).orderBy(desc(systemLog.id)).limit(2);
      if (logs.length) {
        const match = /^([a-z]+);id=([1-9]\d{0,9});payload=([a-f0-9]{64})$/.exec(logs[0].action);
        if (logs.length !== 1 || !match || match[1] !== operation || match[3] !== fingerprint) throw new ValidateException('请求标识已用于其他拼团操作');
        return { id: activityId(match[2]) };
      }
      const cutoff = status === 0 || input?.status === 0;
      const exclusiveLifecycle = operation === 'delete' || cutoff;
      const query = id ? tx.select(combinationColumns).from(storeCombination).where(and(eq(storeCombination.id, id), eq(storeCombination.isDel, 0))).limit(1) : null;
      // Lifecycle writes cannot WAIT here: an existing payment may own an order row and
      // a refund may own NO KEY UPDATE while waiting for exactly that order.
      const row = query ? (await (exclusiveLifecycle ? query.for('update', { noWait: true }) : query.for('no key update')))[0] : undefined;
      if (id && !row) throw new NotFoundException('拼团活动不存在');
      if (row && await combinationRevision(tx, row) !== raw.revision) throw new ValidateException('拼团或关联规格已更新，请刷新后重新确认');
      const [clock] = await tx.execute(sql`SELECT extract(epoch FROM clock_timestamp())::double precision * 1000 AS now`), now = clock?.now;
      if (typeof now !== 'number' || !Number.isFinite(now)) throw new ValidateException('数据库时间无效');
      let resultId = id;
      if (operation === 'delete') await tx.update(storeCombination).set({ isDel: 1 }).where(eq(storeCombination.id, id));
      else if (operation === 'status') {
        if (status === 1) await this.validateEnable(tx, row!);
        await tx.update(storeCombination).set({ status: status!, isShow: status! }).where(eq(storeCombination.id, id));
      } else if (input) {
        if (input.endTime.getTime() < now) throw new ValidateException('活动结束时间不能小于当前时间');
        if (row && (!combinationTime(row.stopTime) || row.stopTime!.getTime() < now)) throw new ValidateException('活动已结束，请重新添加或复制');
        if (row && row.productId !== input.productId) throw new ValidateException('已有拼团不能更换基础商品，请新建或复制');
        const [identity] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE},${PRODUCT_SKU_IDENTITY_LOCK_KEY}) AS acquired`);
        if (identity?.acquired !== true) throw new ValidateException('商品规格正在更新，请稍后重试');
        const graph = row ? await combinationGraph(tx, id, true) : { skus: [] as CombinationSkuRow[], dimensions: [], snapshots: [], description: '' };
        resultId = await this.save(tx, row, graph.skus, input, actor.id, now);
      }
      if (id && cutoff) {
        const active = await tx.select({ id: storePink.id }).from(storePink).where(and(eq(storePink.combinationId, id), eq(storePink.status, 1))).orderBy(asc(storePink.id)).for('update', { noWait: true });
        if (active.length) await tx.update(storePink).set({ stopTime: new Date(now) }).where(and(eq(storePink.combinationId, id), eq(storePink.status, 1)));
      }
      await tx.insert(systemLog).values({ adminId: actor.id, type: 'combination', path, method: method(operation), action: `${operation};id=${resultId};payload=${fingerprint}`, addTime: Math.floor(now / 1000) });
      return { id: resultId };
    }));
  }
  private async validateEnable(tx: DbClient, row: CombinationRow) {
    if (combinationIssues({ ...row, status: 1, isShow: 1 }).length) throw new ValidateException('拼团配置损坏，请先编辑修复');
    const graph = await combinationGraph(tx, row.id, true); assertCombinationAccounts(row, graph.skus);
    const [source] = await tx.select().from(storeProduct).where(eq(storeProduct.id, row.productId)).limit(1).for('share', { noWait: true });
    if ((await sourceOwnerIssues(tx, source, true)).length || !source || source.type !== row.type || source.relationId !== row.relationId || source.productType !== row.productType) throw new ValidateException('基础商品或所属方已变化');
    const bases = await tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, row.productId), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0))).orderBy(asc(storeProductAttrValue.id)).limit(501).for('share', { noWait: true });
    const active = graph.skus.filter(sku => sku.isRetired === 0);
    if (!active.length || bases.length > 500 || new Set(bases.map(sku => sku.suk)).size !== bases.length || new Set(bases.map(sku => sku.unique)).size !== bases.length ||
      active.some(sku => combinationSkuIssues(sku, bases.find(base => base.suk === sku.suk), active).length || sku.quota > (bases.find(base => base.suk === sku.suk)?.stock ?? 0)) ||
      active.reduce((sum, sku) => sum + sku.quota, 0) > source.stock) throw new ValidateException('拼团规格或剩余额度超过当前基础商品库存');
    await this.validateSourceDimensions(tx, source, active.map(sku => bases.find(base => base.suk === sku.suk)!));
    await lockShippingTemplateBindings(tx, [{ freight: row.freight, tempId: row.tempId, ownerType: source.type === 2 ? 2 : 0, relationId: source.relationId }]);
    const images = gallery(row.images);
    if (!images.length || images[0] !== row.image) throw new ValidateException('拼团相册无效');
    await validateCombinationMedia(tx, row, [...images, ...active.map(sku => sku.image)], graph.description);
  }
  private async save(tx: DbClient, row: CombinationRow | undefined, current: CombinationSkuRow[], input: CombinationInput, actorId: number, now: number) {
    const ids = new Set(input.skus.filter(sku => sku.id !== null).map(sku => sku.id));
    if (current.some(sku => !ids.has(sku.id)) || input.skus.some(sku => sku.id !== null && !current.some(old => old.id === sku.id))) throw new ValidateException('须完整保留真实活动规格身份；移除请显式停止参与');
    const enabled = input.skus.filter(sku => sku.enabled);
    let source: SourceRow | undefined, bases: CombinationSkuRow[] = [];
    if (enabled.length) {
      [source] = await tx.select().from(storeProduct).where(eq(storeProduct.id, input.productId)).limit(1).for('share', { noWait: true });
      if ((await sourceOwnerIssues(tx, source, true)).length || !source) throw new ValidateException('基础商品或供应商不符合拼团条件');
      if (row && (source.type !== row.type || source.relationId !== row.relationId || source.productType !== row.productType)) throw new ValidateException('基础商品所属方或类型已变化，请专项核对');
      bases = await tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, input.productId), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0))).orderBy(asc(storeProductAttrValue.id)).limit(501).for('share', { noWait: true });
      if (bases.length > 500 || new Set(bases.map(sku => sku.suk)).size !== bases.length || new Set(bases.map(sku => sku.unique)).size !== bases.length) throw new ValidateException('基础规格超过容量或组合标识重复');
    }
    const chosen = enabled.map(sku => {
      const base = bases.find(value => value.unique === sku.baseUnique), old = sku.id === null ? undefined : current.find(value => value.id === sku.id);
      if (!base || base.suk !== base.suk.trim() || base.unique !== base.unique.trim() || !base.unique || /[\u0000-\u0020\u007f]/u.test(base.unique)) throw new ValidateException('基础规格无效或已变化');
      if (old && (old.isRetired !== 0 || old.suk !== base.suk || !old.unique || old.unique !== old.unique.trim() || old.unique.length > 8 || bases.some(value => value.unique === old.unique && value.suk !== old.suk))) throw new ValidateException('旧规格不能换组合、伪造或隐式恢复退役身份');
      if (!old && current.some(value => value.suk === base.suk)) throw new ValidateException('该组合已有历史规格身份，不能重新分配');
      const values = old ? quota(old, sku.total!) : { quotaShow: sku.total!, quota: sku.total!, stock: sku.total! };
      if (values.quota > activityInteger(base.stock, '基础规格库存')) throw new ValidateException('剩余额度不能超过当前基础规格库存');
      return { input: sku, base, old, values };
    });
    if (chosen.length) await this.validateSourceDimensions(tx, source!, chosen.map(sku => sku.base));
    if (chosen.length && chosen.reduce((sum, sku) => sum + sku.values.quota, 0) > source!.stock) throw new ValidateException('拼团剩余额度不能超过基础商品库存');
    const owner = source ?? row!;
    await validateCombinationMedia(tx, owner, [...input.images, ...chosen.map(sku => sku.input.image!)], input.description);
    const shipping = { ...input.shipping };
    if (owner.productType !== 0) shipping.deliveryType = [2];
    if ([1, 2, 3].includes(owner.productType)) { shipping.freight = 2; shipping.tempId = 0; shipping.postage = '0.00'; }
    else if (shipping.freight === 2 && shipping.postage === '0.00') throw new ValidateException('固定运费须大于0');
    await lockShippingTemplateBindings(tx, [{ ...shipping, ownerType: owner.type === 2 ? 2 : 0, relationId: owner.relationId }]);
    if (row && chosen.length) assertCombinationAccounts(row, current);
    const inherited = source ? { type: source.type, relationId: source.relationId, productType: source.productType, customForm: source.customForm,
      systemFormId: source.systemFormId, storeLabelId: source.storeLabelId, ensureId: source.ensureId, specs: source.specs } : {};
    const patch = { ...inherited, productId: input.productId, storeName: input.title, info: input.info, unitName: input.unitName, image: input.images[0], images: JSON.stringify(input.images),
      startTime: input.startTime, stopTime: input.endTime, effectiveTime: input.effectiveTime, people: input.people, num: input.num, onceNum: input.onceNum,
      virtual: input.virtual, sort: input.sort, isHost: input.isHost, status: input.status, isShow: input.status, isSupportRefund: input.isSupportRefund,
      deliveryType: shipping.deliveryType.join(','), freight: shipping.freight, postage: shipping.postage, tempId: shipping.tempId, isPostage: shipping.freight === 1 ? 1 : 0 };
    let id = row?.id;
    if (!id) { const [created] = await tx.insert(storeCombination).values({ ...patch, sales: 0, addTime: Math.floor(now / 1000) }).returning({ id: storeCombination.id }); id = created.id; }
    const saved = [...current];
    for (const sku of chosen) {
      const { id: _baseId, productId: _baseProduct, unique: _baseUnique, ...baseValues } = sku.base;
      const values = { ...baseValues, ...sku.values, productId: id, type: 3, productType: source!.productType, image: sku.input.image!, price: sku.input.price!, otPrice: sku.base.price,
        isRetired: 0, retiredAt: 0, retiredBy: 0, retireReason: '' };
      if (sku.old) {
        const [updated] = await tx.update(storeProductAttrValue).set({ ...values, unique: sku.old.unique, sales: sku.old.sales, sumStock: sku.old.sumStock }).where(eq(storeProductAttrValue.id, sku.old.id)).returning();
        saved[saved.findIndex(value => value.id === updated.id)] = updated;
      } else {
        let unique = '';
        for (let attempt = 0; attempt < 8 && !unique; attempt++) {
          const candidate = [...crypto.getRandomValues(new Uint8Array(4))].map(byte => byte.toString(16).padStart(2, '0')).join('');
          if (!(await tx.select({ id: storeProductAttrValue.id }).from(storeProductAttrValue).where(eq(storeProductAttrValue.unique, candidate)).limit(1)).length) unique = candidate;
        }
        if (!unique) throw new ValidateException('暂时无法分配规格标识，请重试');
        const [inserted] = await tx.insert(storeProductAttrValue).values({ ...values, unique, sales: 0, sumStock: sku.values.stock }).returning(); saved.push(inserted);
      }
    }
    const activeIds = new Set(chosen.filter(sku => sku.old).map(sku => sku.old!.id));
    for (const sku of current.filter(sku => sku.isRetired === 0 && !activeIds.has(sku.id))) {
      const reason = '拼团管理停止规格参与';
      await tx.update(storeProductAttrValue).set({ isRetired: 1, retiredAt: Math.floor(now / 1000), retiredBy: actorId, retireReason: reason }).where(eq(storeProductAttrValue.id, sku.id));
      await tx.insert(storeProductSkuRetirementLog).values({ productId: input.productId, skuId: sku.id, uniqueSnapshot: sku.unique, sukSnapshot: sku.suk, action: 'retire', reason, actorId,
        dependencySnapshot: JSON.stringify({ type: 3, combination_id: id, quota: sku.quota, quota_total: sku.quotaShow }), addTime: Math.floor(now / 1000) });
    }
    const aggregate = { quota: 0, quotaShow: 0, stock: 0 };
    for (const sku of saved) for (const key of ['quota', 'quotaShow', 'stock'] as const) aggregate[key] = activityInteger(aggregate[key] + activityInteger(sku[key], '保留规格账目'), '拼团聚合额度');
    activityInteger(aggregate.stock + aggregate.quotaShow - aggregate.quota, '取消或退款后聚合库存'); activityInteger((row?.sales ?? 0) + aggregate.quota, '新增购买后拼团销量');
    await tx.update(storeCombination).set({ ...patch, ...aggregate, ...(chosen.length ? { price: minimum(chosen.map(sku => sku.input.price!)), otPrice: minimum(chosen.map(sku => sku.base.price)) } : {}) }).where(eq(storeCombination.id, id));
    await this.saveContent(tx, input.productId, id, input.description, now, Boolean(source));
    return id;
  }
  private async saveContent(tx: DbClient, productId: number, id: number, description: string, now: number, copyDimensions: boolean) {
    if (copyDimensions) {
      const dimensions = await tx.select().from(storeProductAttr).where(and(eq(storeProductAttr.productId, productId), eq(storeProductAttr.type, 0))).orderBy(asc(storeProductAttr.id)).limit(11);
      if (dimensions.length > 10) throw new ValidateException('基础商品规格维度超过完整容量');
      await tx.delete(storeProductAttr).where(and(eq(storeProductAttr.productId, id), eq(storeProductAttr.type, 3)));
      if (dimensions.length) await tx.insert(storeProductAttr).values(dimensions.map(row => ({ productId: id, type: 3, attrName: row.attrName, attrValues: row.attrValues })));
    }
    const dimensions = await tx.select().from(storeProductAttr).where(and(eq(storeProductAttr.productId, id), eq(storeProductAttr.type, 3))).orderBy(asc(storeProductAttr.id));
    const skus = await tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 3), eq(storeProductAttrValue.isRetired, 0))).orderBy(asc(storeProductAttrValue.id));
    // The existing Admin profile has cache INSERT/DELETE, not UPDATE. Cache ids
    // are display metadata and replacing them does not rebuild SKU identities.
    await tx.delete(storeProductAttrResult).where(and(eq(storeProductAttrResult.productId, id), eq(storeProductAttrResult.type, 3)));
    await tx.insert(storeProductAttrResult).values({ productId: id, type: 3, result: JSON.stringify({ attr: dimensions.map(row => ({ value: row.attrName, detail: row.attrValues.split(',') })), value: skus }), changeTime: Math.floor(now / 1000) });
    await tx.insert(storeProductDescription).values({ productId: id, type: 3, description }).onConflictDoUpdate({ target: [storeProductDescription.productId, storeProductDescription.type], set: { description } });
  }
  private async validateSourceDimensions(tx: DbClient, source: SourceRow, selected: CombinationSkuRow[]) {
    const dimensions = await tx.select().from(storeProductAttr).where(and(eq(storeProductAttr.productId, source.id), eq(storeProductAttr.type, 0))).orderBy(asc(storeProductAttr.id)).limit(11);
    if (dimensions.length > 10 || (source.specType === 1 && !dimensions.length)) throw new ValidateException('基础商品规格维度缺失或超过容量');
    if (!dimensions.length) return; // Single-spec legacy sources can omit display dimensions.
    const names = dimensions.map(row => row.attrName), choices = dimensions.map(row => row.attrValues.split(','));
    if (new Set(names).size !== names.length || names.some(name => !name || name !== name.trim() || /[\u0000-\u001f\u007f]/u.test(name)) ||
      choices.some(values => !values.length || values.length > 500 || new Set(values).size !== values.length || values.some(value => !value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)))) throw new ValidateException('基础商品规格维度损坏或重复');
    for (const sku of selected) {
      const parts = sku.suk.split(',');
      if (parts.length !== choices.length || parts.some((part, index) => !choices[index].includes(part))) throw new ValidateException('基础规格组合与实际维度不一致');
    }
  }
}
