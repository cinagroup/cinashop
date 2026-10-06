import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeCouponTemplate, storeCouponTemplateIssue, storeCouponIssue, storeCouponProduct,
  storeProduct, storeProductCategory, systemLog } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { activityCategories } from './AdminSeckillActivityData';
import { COUPON_TEMPLATE_MAX_IDS_LENGTH, COUPON_TEMPLATE_MAX_PRODUCTS, couponTemplateCreate, couponTemplateHash,
  couponTemplateId, couponTemplatePublish, couponTemplateQuery, couponTemplateRequest, couponTemplateRevision,
  couponTemplateWhitelist, type CouponTemplateInput, type CouponTemplateOperation } from './AdminCouponTemplateInput';

type Row = typeof storeCouponTemplate.$inferSelect;
export type CouponTemplateRow = { id: number; title: string; scope_type: number; category_id: number; product_ids: number[];
  coupon_price: string; use_min_price: string; valid_days: number; sort: number; status: number; deleted: boolean;
  add_time: number; revision: string; valid: boolean; issues: string[]; category_name: string;
  products: Array<{ id: number; store_name: string; deleted: boolean }>; issue_count: number };
export type CouponTemplateIssueRow = { issue_id: number; template_id: number; title: string; receive_type: number; status: number;
  total_count: number; remain_count: number; is_permanent: number; start_time: string | null; end_time: string | null;
  issued_at: number; source_revision: string };
export type CouponTemplateMutationResult = { id: number } | { issue_id: number; template_id: number };
const LOCK_NAMESPACE = 731_650;
async function deadlines(tx: DbClient) {
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
}
async function writeBoundary<T>(run: () => Promise<T>) {
  try { return await run(); }
  catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('优惠券模板、范围或发行实例正在变化，请刷新后重试');
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}
function rawInput(row: Row) { return { title: row.title, scope_type: row.scopeType, category_id: row.categoryId,
  product_ids: row.productIds ? row.productIds.split(',').map(Number) : [], coupon_price: row.couponPrice,
  use_min_price: row.useMinPrice, valid_days: row.validDays, sort: row.sort, status: row.status }; }
async function revision(row: Row) { return couponTemplateHash({ id: row.id, title: row.title, scope_type: row.scopeType,
  category_id: row.categoryId, product_ids: row.productIds, coupon_price: row.couponPrice, use_min_price: row.useMinPrice,
  valid_days: row.validDays, sort: row.sort, status: row.status, deleted: row.isDel, add_time: row.addTime }); }
function inputCheck(row: Row): { input: CouponTemplateInput | null; issues: string[] } {
  try {
    const input = couponTemplateCreate(rawInput(row));
    if (input.productIds !== row.productIds) throw new ValidateException('模板商品范围编码非规范');
    if (![0, 1].includes(row.isDel) || !Number.isSafeInteger(row.addTime) || row.addTime < 0) throw new ValidateException('模板历史状态或创建时间无效');
    return { input, issues: [] };
  } catch (error) { return { input: null, issues: [error instanceof Error ? error.message : '模板历史定义无效'] }; }
}
const literal = (keyword: string) => `%${keyword.replace(/[\\%_]/g, '\\$&')}%`;
const idSearch = (keyword: string) => /^[1-9]\d{0,9}$/.test(keyword) && Number(keyword) <= 2147483647 ? Number(keyword) : undefined;
function iso(value: Date | null) {
  if (value === null) return null;
  if (!Number.isFinite(value.getTime())) throw new ValidateException('发行实例历史时间无效');
  return value.toISOString();
}

/** Source definitions and immutable publication provenance. Checkout remains
 * bound to independent issue/user identities; no source edit or restore exists. */
export class AdminCouponTemplateService {
  constructor(private readonly container: Container, _appKey?: string) {}
  private read<T>(run: (tx: DbClient) => Promise<T>) {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await deadlines(tx); return run(tx);
    });
  }
  async list(parameters: URLSearchParams) {
    const query = couponTemplateQuery(parameters), match = idSearch(query.keyword);
    const where = and(eq(storeCouponTemplate.isDel, 0), query.status === undefined ? undefined : eq(storeCouponTemplate.status, query.status),
      query.keyword ? or(ilike(storeCouponTemplate.title, literal(query.keyword)), match ? eq(storeCouponTemplate.id, match) : undefined) : undefined);
    return this.read(async tx => {
      const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeCouponTemplate).where(where);
      const rows = await tx.select().from(storeCouponTemplate).where(where).orderBy(desc(storeCouponTemplate.sort), desc(storeCouponTemplate.id))
        .limit(query.limit).offset(query.offset);
      return { list: await this.project(tx, rows), count: count.count, page: query.page, limit: query.limit };
    });
  }
  async options() {
    return this.read(async tx => ({ categories: (await activityCategories(tx)).options,
      max_products: COUPON_TEMPLATE_MAX_PRODUCTS, max_product_ids_length: COUPON_TEMPLATE_MAX_IDS_LENGTH }));
  }
  async products(parameters: URLSearchParams) {
    const query = couponTemplateQuery(parameters, 'products'), match = idSearch(query.keyword);
    const where = and(eq(storeProduct.isDel, 0), query.keyword ? or(ilike(storeProduct.storeName, literal(query.keyword)),
      match ? eq(storeProduct.id, match) : undefined) : undefined);
    return this.read(async tx => {
      const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeProduct).where(where);
      const rows = await tx.select({ id: storeProduct.id, store_name: storeProduct.storeName }).from(storeProduct).where(where)
        .orderBy(desc(storeProduct.id)).limit(query.limit).offset(query.offset);
      return { list: rows.map(row => ({ ...row, deleted: false as const })), count: count.count, page: query.page, limit: query.limit };
    });
  }
  async detail(value: string) {
    const id = couponTemplateId(value);
    return this.read(async tx => {
      const [row] = await tx.select().from(storeCouponTemplate).where(eq(storeCouponTemplate.id, id)).limit(1);
      if (!row) throw new NotFoundException('优惠券模板不存在');
      return (await this.project(tx, [row]))[0];
    });
  }
  async issues(value: string, parameters: URLSearchParams) {
    const id = couponTemplateId(value), query = couponTemplateQuery(parameters, 'issues');
    return this.read(async tx => {
      const [source] = await tx.select({ id: storeCouponTemplate.id }).from(storeCouponTemplate).where(eq(storeCouponTemplate.id, id)).limit(1);
      if (!source) throw new NotFoundException('优惠券模板不存在');
      const where = eq(storeCouponTemplateIssue.templateId, id);
      const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeCouponTemplateIssue).where(where);
      const rows = await tx.select({ issue_id: storeCouponIssue.id, template_id: storeCouponTemplateIssue.templateId,
        title: storeCouponIssue.couponTitle, receive_type: storeCouponIssue.receiveType, status: storeCouponIssue.status,
        total_count: storeCouponIssue.totalCount, remain_count: storeCouponIssue.remainCount, is_permanent: storeCouponIssue.isPermanent,
        start_time: storeCouponIssue.startTime, end_time: storeCouponIssue.endTime, issued_at: storeCouponTemplateIssue.issuedAt,
        source_revision: storeCouponTemplateIssue.sourceRevision }).from(storeCouponTemplateIssue)
        .innerJoin(storeCouponIssue, eq(storeCouponIssue.id, storeCouponTemplateIssue.issueId)).where(where)
        .orderBy(desc(storeCouponTemplateIssue.issueId)).limit(query.limit).offset(query.offset);
      const list: CouponTemplateIssueRow[] = rows.map(row => ({ ...row, start_time: iso(row.start_time), end_time: iso(row.end_time) }));
      return { list, count: count.count, page: query.page, limit: query.limit };
    });
  }
  private async project(tx: DbClient, rows: Row[]): Promise<CouponTemplateRow[]> {
    if (!rows.length) return [];
    const checked = rows.map(inputCheck), ids = [...new Set(checked.flatMap(result => result.input?.productIds.split(',').filter(Boolean).map(Number) ?? []))];
    const categoryIds = [...new Set(rows.filter(row => row.scopeType === 1 && row.categoryId > 0).map(row => row.categoryId))];
    const products = ids.length ? await tx.select({ id: storeProduct.id, name: storeProduct.storeName, deleted: storeProduct.isDel })
      .from(storeProduct).where(inArray(storeProduct.id, ids)) : [];
    const categories = categoryIds.length ? await tx.select({ id: storeProductCategory.id, name: storeProductCategory.cateName,
      type: storeProductCategory.type, owner: storeProductCategory.relationId, visible: storeProductCategory.isShow })
      .from(storeProductCategory).where(inArray(storeProductCategory.id, categoryIds)) : [];
    let selectable = new Set<number>(), categoryProblem = '';
    if (categoryIds.length) {
      try { selectable = (await activityCategories(tx)).selectable; }
      catch (error) {
        if (!(error instanceof ValidateException)) throw error;
        categoryProblem = error.message;
      }
    }
    const counts = await tx.select({ id: storeCouponTemplateIssue.templateId, count: sql<number>`count(*)::integer` }).from(storeCouponTemplateIssue)
      .where(inArray(storeCouponTemplateIssue.templateId, rows.map(row => row.id))).groupBy(storeCouponTemplateIssue.templateId);
    const productById = new Map(products.map(row => [row.id, row])), categoryById = new Map(categories.map(row => [row.id, row])), countById = new Map(counts.map(row => [row.id, row.count]));
    return Promise.all(rows.map(async (row, index) => {
      const { input, issues } = checked[index], productIds = input?.productIds ? input.productIds.split(',').map(Number) : [];
      const selected = productIds.map(id => {
        const product = productById.get(id);
        if (!product) issues.push(`适用商品${id}缺失`);
        else if (product.deleted !== 0) issues.push(`适用商品${id}已删除`);
        return { id, store_name: product?.name ?? `缺失商品#${id}`, deleted: !product || product.deleted !== 0 };
      });
      const category = categoryById.get(row.categoryId);
      if (row.scopeType === 1 && (!category || !selectable.has(row.categoryId))) issues.push(categoryProblem || `适用分类${row.categoryId}缺失、隐藏或非可选平台分类`);
      return { id: row.id, title: row.title, scope_type: row.scopeType, category_id: row.categoryId, product_ids: productIds,
        coupon_price: input?.couponPrice ?? row.couponPrice, use_min_price: input?.useMinPrice ?? row.useMinPrice,
        valid_days: row.validDays, sort: row.sort, status: row.status, deleted: row.isDel !== 0, add_time: row.addTime,
        revision: await revision(row), valid: issues.length === 0, issues, category_name: category?.name ?? '',
        products: selected, issue_count: countById.get(row.id) ?? 0 };
    }));
  }
  private async scope(tx: DbClient, input: CouponTemplateInput) {
    if (input.scopeType === 1) {
      const tree = await activityCategories(tx), byId = new Map(tree.rows.map(row => [row.id, row]));
      if (!tree.selectable.has(input.categoryId)) throw new ValidateException('适用分类不存在、隐藏或非可选平台分类');
      const chain: number[] = []; let cursor = byId.get(input.categoryId);
      while (cursor) { chain.push(cursor.id); cursor = cursor.pid ? byId.get(cursor.pid) : undefined; }
      const locked = await tx.select().from(storeProductCategory).where(inArray(storeProductCategory.id, chain)).orderBy(asc(storeProductCategory.id)).for('share');
      if (locked.length !== chain.length || locked.some(row => {
        const previous = byId.get(row.id);
        return !previous || row.pid !== previous.pid || row.isShow !== 1 || row.type !== 0 || row.relationId !== 0;
      })) throw new ValidateException('适用分类树已变化，请刷新后重新确认');
    }
    if (input.scopeType === 2) {
      const ids = input.productIds.split(',').map(Number), products = await tx.select({ id: storeProduct.id }).from(storeProduct)
        .where(and(inArray(storeProduct.id, ids), eq(storeProduct.isDel, 0))).orderBy(asc(storeProduct.id)).for('share');
      if (products.length !== ids.length) throw new ValidateException('部分适用商品不存在或已删除');
    }
  }
  async mutate(operation: CouponTemplateOperation, value: string | undefined, body: Record<string, unknown>, actor: { id: number }): Promise<CouponTemplateMutationResult> {
    if (!['create', 'invalidate', 'delete', 'publish'].includes(operation)) throw new ValidateException('不支持的优惠券模板操作');
    const actorId = couponTemplateId(actor.id, '管理员ID');
    if (operation === 'publish' && (value !== undefined || typeof body.template_id !== 'number')) throw new ValidateException('发布须使用body中的唯一模板身份');
    const id = operation === 'create' ? 0 : operation === 'publish' ? couponTemplateId(body.template_id) : couponTemplateId(value);
    if (operation === 'create' && value !== undefined) throw new ValidateException('添加模板不能携带旧身份');
    const fields = operation === 'create' ? ['title', 'scope_type', 'category_id', 'product_ids', 'coupon_price', 'use_min_price', 'valid_days', 'sort', 'status']
      : operation === 'publish' ? ['template_id', 'receive_type', 'status', 'is_permanent', 'count', 'start_time', 'end_time', 'full_reduction'] : [];
    couponTemplateWhitelist(body, ['request_id', ...(id ? ['revision'] : []), ...fields]);
    const request = couponTemplateRequest(body.request_id), expectedRevision = id ? couponTemplateRevision(body.revision) : null;
    const input = operation === 'create' ? couponTemplateCreate(body) : null, publication = operation === 'publish' ? couponTemplatePublish(body) : null;
    if (publication && (typeof body.template_id !== 'number' || couponTemplateId(body.template_id) !== id)) throw new ValidateException('发布模板身份不一致');
    const fingerprint = await couponTemplateHash({ operation, id, revision: expectedRevision, input, publication });
    const path = `/marketing/coupon-templates/request/${request}`;
    return writeBoundary(() => withTx(this.container, async tx => {
      const [state] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`);
      if (state?.isolation !== 'read committed') throw new ValidateException('优惠券模板写入需要READ COMMITTED事务');
      await deadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE},${actorId})`);
      const logs = await tx.select({ action: systemLog.action }).from(systemLog).where(and(eq(systemLog.adminId, actorId),
        eq(systemLog.type, 'coupon_template'), eq(systemLog.path, path))).orderBy(desc(systemLog.id)).limit(2);
      if (logs.length) {
        const match = /^(create|invalidate|delete|publish);id=([1-9]\d{0,9});issue=(0|[1-9]\d{0,9});payload=([a-f0-9]{64})$/.exec(logs[0].action);
        if (logs.length !== 1 || !match || match[1] !== operation || match[4] !== fingerprint) throw new ValidateException('请求标识已用于其他优惠券模板操作');
        const resultId = couponTemplateId(match[2]);
        if (id && resultId !== id) throw new ValidateException('模板重放身份不一致');
        const [exists] = await tx.select({ id: storeCouponTemplate.id }).from(storeCouponTemplate).where(eq(storeCouponTemplate.id, resultId)).limit(1);
        if (!exists) throw new ValidateException('模板重放记录无法证明原结果');
        if (operation === 'publish') {
          const issueId = couponTemplateId(match[3], '发行实例ID');
          const [proof] = await tx.select({ revision: storeCouponTemplateIssue.sourceRevision }).from(storeCouponTemplateIssue).where(and(
            eq(storeCouponTemplateIssue.issueId, issueId), eq(storeCouponTemplateIssue.templateId, resultId))).limit(1);
          if (!proof || proof.revision !== expectedRevision) throw new ValidateException('发行重放缺少原子来源证据');
          return { issue_id: issueId, template_id: resultId };
        }
        if (match[3] !== '0') throw new ValidateException('模板重放结果无效');
        return { id: resultId };
      }
      const [clock] = await tx.execute(sql`SELECT extract(epoch FROM clock_timestamp())::double precision AS now`);
      if (typeof clock?.now !== 'number' || !Number.isFinite(clock.now)) throw new ValidateException('数据库时间无效');
      const now = Math.floor(clock.now);
      if (now < 0 || now > 2147483647) throw new ValidateException('数据库时间超出可存储范围');
      const [row] = id ? await tx.select().from(storeCouponTemplate).where(eq(storeCouponTemplate.id, id)).limit(1).for('update') : [];
      if (id && !row) throw new NotFoundException('优惠券模板不存在');
      if (row && await revision(row) !== expectedRevision) throw new ValidateException('优惠券模板已变化，请刷新后重新确认');
      if (row && row.isDel !== 0) throw new ValidateException('已删除模板不能再次操作');
      let resultId = id, issueId = 0;
      if (input) {
        await this.scope(tx, input);
        const [created] = await tx.insert(storeCouponTemplate).values({ ...input, addTime: now }).returning({ id: storeCouponTemplate.id });
        resultId = couponTemplateId(created?.id);
      } else if (operation === 'delete') {
        await tx.update(storeCouponTemplate).set({ isDel: 1 }).where(eq(storeCouponTemplate.id, id));
      } else if (operation === 'invalidate') {
        // Source lock serializes publication. Proof is immutable; historical cid
        // collisions never adopt unrelated issues. CTE locks sorted issue rows
        // without returning an unbounded history to application memory.
        await tx.execute(sql`WITH locked AS MATERIALIZED (
          SELECT i.id FROM store_coupon_issue i JOIN store_coupon_template_issue p ON p.issue_id=i.id
          WHERE p.template_id=${id} ORDER BY i.id FOR UPDATE OF i
        ) UPDATE store_coupon_issue i SET status=-1 FROM locked l WHERE i.id=l.id`);
        await tx.update(storeCouponTemplate).set({ status: 0 }).where(eq(storeCouponTemplate.id, id));
      } else if (publication && row) {
        if (row.status !== 1) throw new ValidateException('已失效模板不能再次发布');
        const source = inputCheck(row);
        if (!source.input) throw new ValidateException(source.issues.join('；'));
        if (publication.endTime && publication.endTime.getTime() <= clock.now * 1000) throw new ValidateException('领取结束时间须晚于数据库当前时间');
        await this.scope(tx, source.input);
        const [issued] = await tx.insert(storeCouponIssue).values({ cid: id, category: 0, couponType: source.input.scopeType,
          couponTitle: source.input.title, title: source.input.title, type: 1, couponPrice: source.input.couponPrice, useMinPrice: source.input.useMinPrice,
          productId: source.input.productIds || '0', legacyProductIds: source.input.productIds || '',
          category_id: String(source.input.categoryId), legacyCategoryId: source.input.categoryId, brandId: '0', legacyBrandId: 0,
          day: source.input.validDays, useStartTime: null, useEndTime: null, totalCount: publication.count, remainCount: publication.count,
          receiveLimit: 1, receiveType: publication.receiveType, isPermanent: publication.isPermanent,
          startTime: publication.startTime, endTime: publication.endTime, isDel: 0, status: publication.status, appType: 0,
          isFullGive: publication.receiveType === 3 ? 1 : 0, isGiveSubscribe: publication.receiveType === 2 ? 1 : 0,
          fullReduction: publication.fullReduction, integral: 0, sort: source.input.sort, addTime: now })
          .returning({ id: storeCouponIssue.id });
        issueId = couponTemplateId(issued?.id, '发行实例ID');
        if (source.input.scopeType === 2) await tx.insert(storeCouponProduct).values(source.input.productIds.split(',').map(productId => ({ couponId: issueId, productId: Number(productId) })));
        await tx.insert(storeCouponTemplateIssue).values({ issueId, templateId: id, issuedAt: now, sourceRevision: expectedRevision! });
      }
      await tx.insert(systemLog).values({ adminId: actorId, type: 'coupon_template', path,
        method: operation === 'delete' ? 'DELETE' : 'POST',
        action: `${operation};id=${resultId};issue=${issueId};payload=${fingerprint}`, addTime: now });
      return operation === 'publish' ? { issue_id: issueId, template_id: resultId } : { id: resultId };
    }));
  }
}
