import { and, asc, desc, eq, ilike, ne, or, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeIntegral, storeProduct, storeProductAttr, storeProductAttrResult, storeProductAttrValue, storeProductDescription, systemLog } from '@/models/schema';
import { renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { seckillTimePicture } from '@/services/activity/SeckillTimeAssetPolicy';
import { PRODUCT_SKU_IDENTITY_LOCK_KEY, PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE } from '@/services/product/ProductSkuIdentity';
import { lockShippingTemplateBindings } from '@/services/product/ShippingTemplateLifecycleService';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { activityHash, activityId, activityInteger } from './AdminSeckillActivityInput';
import { activityCandidateFilters, activityCategories, activityLabels } from './AdminSeckillActivityData';
import { INTEGRAL_BATCH_LIMITS, integralBatchGraph, integralBatchMetadata, integralBatchMoney, integralBatchOwner, integralBatchPayloadHash, integralBatchPictures,
  integralBatchQuery, integralBatchRequestId, integralBatchSkuIssues, parseIntegralBatchInput, validateIntegralBatchMedia,
  type IntegralBatchActor, type IntegralBatchGraph, type IntegralBatchInput, type IntegralBatchProductInput,
  type IntegralBatchProductReceipt, type IntegralBatchReceipt } from './AdminIntegralBatchData';

const LOCK_NAMESPACE = 731_671;
const JOURNAL_TYPE = 'integral_batch';
const requestPath = (id: string) => `/activity/integral-batch/request/${id}`;
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
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('基础商品、素材或规格正在更新，请刷新后重试');
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}

/** A finite, atomic batch creates independent integral products. It never
 * reserves base inventory, edits previous activities, installs catalog objects,
 * repairs grants or sends external requests. Actual type-4 checkout owns stock. */
export class AdminIntegralBatchService {
  constructor(private readonly container: Container, private readonly appKey?: string) {}
  private read<T>(run: (tx: DbClient) => Promise<T>) {
    return withTx(this.container, async tx => { await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await deadlines(tx); return run(tx); });
  }
  async candidates(parameters: URLSearchParams) {
    const query = integralBatchQuery(parameters);
    const result = await this.read(async tx => {
      // Keep every persisted owner/replica visible; invalid identities are
      // explained per row instead of silently reducing this to platform-only.
      const predicate = and(eq(storeProduct.isDel, 0), await activityCandidateFilters(tx, query), query.keyword ? or(
        ilike(storeProduct.storeName, `%${query.keyword.replace(/[\\%_]/g, '\\$&')}%`),
        /^[1-9]\d{0,9}$/.test(query.keyword) && Number(query.keyword) <= 2147483647 ? eq(storeProduct.id, Number(query.keyword)) : undefined) : undefined);
      const rows = await tx.select().from(storeProduct).where(predicate).orderBy(desc(storeProduct.id)).limit(query.limit).offset(query.offset);
      const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeProduct).where(predicate);
      const metadata = await integralBatchMetadata(tx, rows);
      const list = [];
      for (const row of rows) {
        const ownership = await integralBatchOwner(tx, row);
        const [image] = await integralBatchPictures(tx, row, [row.image]);
        list.push({ id: row.id, store_name: row.storeName, image, stock: row.stock, price: row.price, product_type: row.productType,
          category_name: metadata.get(row.id) ?? '', owner_type: row.type, relation_id: row.relationId,
          owner_name: ownership.ownerName, valid: !ownership.issues.length, issues: ownership.issues });
      }
      return { list, count: count.count, page: query.page, limit: query.limit, categories: (await activityCategories(tx)).options,
        labels: await activityLabels(tx), limits: INTEGRAL_BATCH_LIMITS };
    });
    const previews = await renderProductPictures(this.appKey, result.list.map(row => row.image));
    return { ...result, list: result.list.map((row, index) => ({ ...row, image_preview: previews[index] })) };
  }
  async source(value: unknown) {
    const id = activityId(value, '基础商品ID');
    const result = await this.read(async tx => {
      const graph = await integralBatchGraph(tx, id), row = graph.source;
      const images = await integralBatchPictures(tx, row, [row.image, ...graph.skus.map(sku => sku.image)]);
      const metadata = await integralBatchMetadata(tx, [row]);
      return { product: { id, store_name: row.storeName, image: images[0], stock: row.stock, price: row.price,
        product_type: row.productType, category_name: metadata.get(id) ?? '', owner_type: row.type, relation_id: row.relationId,
        owner_name: graph.ownerName, valid: !graph.issues.length, issues: graph.issues }, revision: graph.revision,
        skus: graph.skus.map((sku, index) => { const issues = integralBatchSkuIssues(sku, graph);
          return { base_unique: sku.unique, suk: sku.suk, image: images[index + 1], price: sku.price, integral: 0, quota: 0,
            cost: sku.cost, stock: sku.stock, weight: sku.weight, volume: sku.volume, bar_code: sku.barCode, code: sku.code,
            valid: !issues.length, issues }; }) };
    });
    const previews = await renderProductPictures(this.appKey, [result.product.image, ...result.skus.map(row => row.image || result.product.image)]);
    return { ...result, product: { ...result.product, image_preview: previews[0] }, skus: result.skus.map((row, index) => ({ ...row, image_preview: previews[index + 1] })) };
  }
  async receipt(value: unknown, actor: IntegralBatchActor): Promise<IntegralBatchReceipt> {
    const requestId = integralBatchRequestId(value); activityId(actor?.id, '管理员ID');
    const result = await this.read(tx => this.readReceipt(tx, requestId, actor.id));
    if (!result) throw new NotFoundException('尚未找到此批次提交回执');
    return result;
  }
  private async readReceipt(tx: DbClient, requestId: string, actorId: number): Promise<IntegralBatchReceipt | null> {
    const path = requestPath(requestId);
    const journals = await tx.select({ path: systemLog.path, action: systemLog.action, method: systemLog.method }).from(systemLog)
      .where(and(eq(systemLog.adminId, actorId), eq(systemLog.type, JOURNAL_TYPE), or(eq(systemLog.path, path), sql`${systemLog.path} LIKE ${`${path}/items/%`}`)))
      .orderBy(asc(systemLog.id)).limit(INTEGRAL_BATCH_LIMITS.max_products + 2);
    if (!journals.length) return null;
    const roots = journals.filter(row => row.path === path), root = roots[0];
    const match = root && /^create;count=([1-9]\d{0,2});show=([01]);payload=([a-f0-9]{64});result=([a-f0-9]{64})$/.exec(root.action);
    if (roots.length !== 1 || !match || root.method !== 'POST' || Number(match[1]) > INTEGRAL_BATCH_LIMITS.max_products || journals.length !== Number(match[1]) + 1) throw new ValidateException('积分批次回执不完整或已冲突，请专项核对');
    const products = journals.filter(row => row !== root).map(row => {
      const item = /^create;source=([1-9]\d{0,9});id=([1-9]\d{0,9});payload=([a-f0-9]{64})$/.exec(row.action);
      if (!item || item[3] !== match[3] || row.method !== 'POST' || row.path !== `${path}/items/${item[1]}`) throw new ValidateException('积分批次商品回执不一致，请专项核对');
      return { product_id: activityId(item[1], '回执基础商品ID'), integral_id: activityId(item[2], '回执积分商品ID') };
    }).sort((a, b) => a.product_id - b.product_id);
    if (new Set(products.map(row => row.product_id)).size !== products.length || new Set(products.map(row => row.integral_id)).size !== products.length ||
      await activityHash({ is_show: Number(match[2]), products }) !== match[4]) throw new ValidateException('积分批次回执身份或摘要不一致，请专项核对');
    return { request_id: requestId, payload_hash: match[3], products, count: products.length, is_show: Number(match[2]) as 0 | 1 };
  }
  async create(raw: Record<string, unknown>, actor: IntegralBatchActor): Promise<IntegralBatchReceipt> {
    activityId(actor?.id, '管理员ID');
    const input = parseIntegralBatchInput(raw), payloadHash = await integralBatchPayloadHash(input);
    return failFast(() => withTx(this.container, async tx => {
      await deadlines(tx);
      // One journal fence makes retry/receipt identity decisions atomic across
      // both aliases and independent sessions, without a new persistent table.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE},1)`);
      const path = requestPath(input.requestId);
      const [foreignClaim] = await tx.select({ id: systemLog.id }).from(systemLog).where(and(eq(systemLog.type, JOURNAL_TYPE),
        ne(systemLog.adminId, actor.id), or(eq(systemLog.path, path), sql`${systemLog.path} LIKE ${`${path}/items/%`}`))).limit(1);
      if (foreignClaim) throw new ValidateException('请求标识已被使用，请重新创建批次');
      const previous = await this.readReceipt(tx, input.requestId, actor.id);
      if (previous) {
        if (previous.payload_hash !== payloadHash) throw new ValidateException('请求标识已用于其他积分批次');
        return previous;
      }
      const [identity] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE},${PRODUCT_SKU_IDENTITY_LOCK_KEY}) AS acquired`);
      if (identity?.acquired !== true) throw new ValidateException('商品规格正在更新，请稍后重试');
      const created: IntegralBatchProductReceipt[] = [];
      const now = Math.floor(Date.now() / 1000);
      for (const product of input.products) {
        const graph = await integralBatchGraph(tx, product.productId, true);
        if (graph.revision !== product.revision) throw new ValidateException('基础商品、库存或规格已变化，请刷新后重新选择');
        if (graph.issues.length) throw new ValidateException(graph.issues.join('；'));
        const id = await this.clone(tx, graph, product, input);
        created.push({ product_id: product.productId, integral_id: id });
        await tx.insert(systemLog).values({ adminId: actor.id, type: JOURNAL_TYPE, path: `${requestPath(input.requestId)}/items/${product.productId}`, method: 'POST',
          action: `create;source=${product.productId};id=${id};payload=${payloadHash}`, addTime: now });
      }
      const resultHash = await activityHash({ is_show: input.isShow, products: created });
      await tx.insert(systemLog).values({ adminId: actor.id, type: JOURNAL_TYPE, path: requestPath(input.requestId), method: 'POST',
        action: `create;count=${created.length};show=${input.isShow};payload=${payloadHash};result=${resultHash}`, addTime: now });
      return { request_id: input.requestId, payload_hash: payloadHash, products: created, count: created.length, is_show: input.isShow };
    }));
  }
  private async clone(tx: DbClient, graph: IntegralBatchGraph, input: IntegralBatchProductInput, batch: IntegralBatchInput) {
    const source = graph.source;
    const chosen = input.skus.map(input => {
      const base = graph.skus.find(row => row.unique === input.baseUnique);
      if (!base) throw new ValidateException('所选基础规格不存在或已退役');
      const issues = integralBatchSkuIssues(base, graph);
      if (issues.length) throw new ValidateException(issues.join('；'));
      if (input.quota > base.stock) throw new ValidateException('兑换次数不能超过当前基础规格库存');
      return { input, base };
    }).sort((a, b) => a.base.id - b.base.id);
    const quota = activityInteger(chosen.reduce((sum, row) => sum + row.input.quota, 0), '积分商品总兑换次数', 1);
    const stock = activityInteger(chosen.reduce((sum, row) => sum + row.base.stock, 0), '积分商品总库存');
    if (quota > source.stock) throw new ValidateException('总兑换次数不能超过当前基础商品库存');
    if ([...source.unitName].length > 16 || source.deliveryType.length > 10) throw new ValidateException('基础商品展示或配送字段超过积分商品容量');
    const postage = integralBatchMoney(source.postage, '继承运费');
    if (BigInt(postage.replace('.', '')) > 9999999999n) throw new ValidateException('继承运费超过积分商品金额容量');
    let gallery: string[] = [];
    if (source.sliderImage) {
      try { const raw: unknown = JSON.parse(source.sliderImage); if (!Array.isArray(raw) || raw.some(value => typeof value !== 'string')) throw Error(); gallery = raw.map(value => seckillTimePicture(value)); }
      catch { throw new ValidateException('基础商品相册格式无效'); }
    }
    const image = source.image === '' ? '' : seckillTimePicture(source.image), images = source.sliderImage ? JSON.stringify(gallery) : '';
    if (images.length > 2000) throw new ValidateException('基础商品相册超过积分商品容量');
    await validateIntegralBatchMedia(tx, graph, [image, ...gallery, ...chosen.map(row => row.input.image)]);
    await lockShippingTemplateBindings(tx, [{ freight: source.freight, tempId: source.tempId, ownerType: source.type, relationId: source.relationId }]);
    // Root display uses the cheapest integral option and THAT option's cash;
    // separate minima would advertise a combination no real SKU can purchase.
    const cheapest = chosen.reduce((left, right) => right.input.integral < left.input.integral ? right : left);
    const [created] = await tx.insert(storeIntegral).values({ productId: source.id, type: source.type, relationId: source.relationId, productType: source.productType,
      storeName: source.storeName, image, images, unitName: source.unitName,
      integral: cheapest.input.integral, price: cheapest.input.price, otPrice: cheapest.base.price,
      quota, quotaShow: quota, stock, sales: 0, num: 0, onceNum: 0, status: batch.isShow, isShow: batch.isShow, isDel: 0, isHost: 0, sort: source.sort,
      deliveryType: source.deliveryType, freight: source.freight, postage, tempId: source.tempId,
      customForm: source.customForm, systemFormId: source.systemFormId, storeLabelId: source.storeLabelId, ensureId: source.ensureId,
      specs: source.specs, addTime: Math.floor(Date.now() / 1000) }).returning({ id: storeIntegral.id });
    const skuRows: Array<typeof storeProductAttrValue.$inferSelect> = [];
    for (const row of chosen) {
      let unique = '';
      for (let attempt = 0; attempt < 8 && !unique; attempt++) {
        const candidate = [...crypto.getRandomValues(new Uint8Array(4))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (!(await tx.select({ id: storeProductAttrValue.id }).from(storeProductAttrValue).where(eq(storeProductAttrValue.unique, candidate)).limit(1)).length) unique = candidate;
      }
      if (!unique) throw new ValidateException('暂时无法分配积分规格标识，请重试');
      const { id: _baseId, productId: _baseProduct, unique: _baseUnique, version: _version, ...values } = row.base;
      const [saved] = await tx.insert(storeProductAttrValue).values({ ...values, productId: created.id, type: 4, unique,
        image: row.input.image, price: row.input.price, otPrice: row.base.price, integral: row.input.integral,
        quota: row.input.quota, quotaShow: row.input.quota, stock: row.base.stock, sumStock: row.base.stock, sales: 0,
        isRetired: 0, retiredAt: 0, retiredBy: 0, retireReason: '' }).returning();
      skuRows.push(saved);
    }
    if (graph.dimensions.length) await tx.insert(storeProductAttr).values(graph.dimensions.map(row => ({ productId: created.id, type: 4, attrName: row.attrName, attrValues: row.attrValues })));
    // Display caches are rebuilt from genuine new IDs/uniques, never copied
    // from the base result JSON, which would bind the wrong activity identity.
    await tx.insert(storeProductAttrResult).values({ productId: created.id, type: 4,
      result: JSON.stringify({ attr: graph.dimensions.map(row => ({ value: row.attrName, detail: row.attrValues.split(',') })), value: skuRows }), changeTime: Math.floor(Date.now() / 1000) });
    await tx.insert(storeProductDescription).values({ productId: created.id, type: 4, description: graph.description });
    return created.id;
  }
}
