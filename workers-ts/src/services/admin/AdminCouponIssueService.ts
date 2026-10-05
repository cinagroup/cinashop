import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeBrand, storeCouponIssue, storeCouponIssueUser, storeCouponProduct, storeCouponTemplateIssue,
  storeCouponUser, storeProduct, storeProductCategory, systemLog, user } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { activityCategories } from './AdminSeckillActivityData';
import { combinationStatisticsAvatar } from './AdminCombinationStatisticsInput';
import { COUPON_ISSUE_MAX_IDS_LENGTH, COUPON_ISSUE_MAX_PRODUCTS, couponIssueCreate, couponIssueFields,
  couponIssueHash, couponIssueId, couponIssueInteger, couponIssueQuery, couponIssueRequest, couponIssueRevision,
  couponIssueWhitelist, type CouponIssueInput, type CouponIssueOperation } from './AdminCouponIssueInput';

type Issue = typeof storeCouponIssue.$inferSelect;
type Proof = typeof storeCouponTemplateIssue.$inferSelect;
export type CouponIssueDefinition = {
  title: string; discount_type: number; scope_type: number; category: number; category_id: number; brand_id: number;
  product_ids: number[]; coupon_price: string; use_min_price: string; valid_days: number; use_start_time: string | null;
  use_end_time: string | null; start_time: string | null; end_time: string | null; receive_type: number;
  is_permanent: number; total_count: number; rule: string; status: number; sort: number;
};
export type CouponIssueRow = CouponIssueDefinition & {
  id: number; deleted: boolean; remain_count: number; receive_limit: number; add_time: number; cid: number; app_type: number;
  source_template: { template_id: number; source_revision: string } | null;
  revision: string; valid: boolean; issues: string[]; category_name: string; brand_name: string;
  products: Array<{ id: number; store_name: string; deleted: boolean }>; copy_input: CouponIssueDefinition | null;
};
export type CouponIssueClaim = { id: number | null; row_key: string; uid: number | null; nickname: string;
  avatar_preview: string; add_time: number; missing_user: boolean; deleted_user: boolean };
type ScopeState = { count: number; hash: string; ids: number[]; proof: Proof | null };
type Scope = { categoryId: number; brandId: number; productIds: number[] };
const LOCK_NAMESPACE = 731_651;
const MAX_OPTIONS = 5000;
const literal = (value: string) => `%${value.replace(/[\\%_]/gu, '\\$&')}%`;
const idSearch = (value: string) => /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647 ? Number(value) : undefined;
const errorText = (error: unknown) => error instanceof Error ? error.message : '发行历史定义无效';
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((id, index) => id === b[index]);

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
      if ('code' in cause && ['55P03', '40P01'].includes(String(cause.code))) throw new ValidateException('优惠券或适用范围正在变化，请刷新后重试');
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}
function dateText(value: Date | null) {
  if (value === null) return null;
  if (!Number.isFinite(value.getTime())) throw new ValidateException('发行历史日期无效');
  return value.toISOString();
}
/** Unlike the permissive legacy consumer parser, an Admin copy must account for
 * every stored token. An ambiguous alias must never silently become a new rule. */
function storedIds(value: string | number | null, label: string): number[] {
  if (value === null || value === '' || value === 0 || value === '0') return [];
  let values: unknown[];
  if (typeof value === 'number') values = [value];
  else if (value.trim().startsWith('[')) {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new ValidateException(`${label}编码无效`); }
    if (!Array.isArray(parsed)) throw new ValidateException(`${label}编码无效`);
    values = parsed;
  } else values = value.split(',').map(token => token.trim());
  if (values.length > COUPON_ISSUE_MAX_PRODUCTS) throw new ValidateException(`${label}超过100项，不能截断复制`);
  const ids = values.map(value => couponIssueId(value, label)).sort((a, b) => a - b);
  if (new Set(ids).size !== ids.length) throw new ValidateException(`${label}含重复ID`);
  if (ids.join(',').length > COUPON_ISSUE_MAX_IDS_LENGTH) throw new ValidateException(`${label}超过500字符`);
  return ids;
}
function aliasIds(first: string | number | null, second: string | number | null, label: string) {
  const a = storedIds(first, label), b = storedIds(second, label);
  if (a.length && b.length && !same(a, b)) throw new ValidateException(`${label}历史字段不一致`);
  return a.length ? a : b;
}
function scopeDefinition(row: Issue, state: ScopeState): Scope {
  if (state.count > COUPON_ISSUE_MAX_PRODUCTS || state.ids.length !== state.count) throw new ValidateException('发行商品关系超过100项，不能截断复制');
  const products = aliasIds(row.legacyProductIds, row.productId, '商品范围');
  const related = [...state.ids].sort((a, b) => a - b);
  if (related.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(related).size !== related.length) throw new ValidateException('商品范围关系无效或重复');
  if (products.length && related.length && !same(products, related)) throw new ValidateException('发行商品字段与范围关系不一致');
  const productIds = related.length ? related : products;
  const categories = aliasIds(row.legacyCategoryId, row.category_id, '分类范围');
  const brands = aliasIds(row.legacyBrandId, row.brandId, '品牌范围');
  if (categories.length > 1 || brands.length > 1) throw new ValidateException('历史分类或品牌范围不是单一身份');
  const categoryId = categories[0] ?? 0, brandId = brands[0] ?? 0;
  if ((row.couponType === 0 && (categoryId || brandId || productIds.length))
    || (row.couponType === 1 && (!categoryId || brandId || productIds.length))
    || (row.couponType === 2 && (categoryId || brandId || !productIds.length))
    || (row.couponType === 3 && (categoryId || !brandId || productIds.length))) throw new ValidateException('历史适用范围字段不一致');
  return { categoryId, brandId, productIds };
}
function definition(row: Issue, scope: Scope): CouponIssueDefinition {
  return { title: row.couponTitle || row.title, discount_type: row.type, scope_type: row.couponType,
    category: row.category, category_id: scope.categoryId, brand_id: scope.brandId, product_ids: scope.productIds,
    coupon_price: row.couponPrice, use_min_price: row.useMinPrice, valid_days: row.day,
    use_start_time: dateText(row.useStartTime), use_end_time: dateText(row.useEndTime),
    start_time: dateText(row.startTime), end_time: dateText(row.endTime), receive_type: row.receiveType,
    is_permanent: row.isPermanent, total_count: row.totalCount, rule: row.rule ?? '', status: row.status, sort: row.sort };
}
function copyDefinition(value: CouponIssueDefinition): CouponIssueDefinition {
  return { ...value, category: value.category === 1 ? 0 : value.category, status: value.status === -1 ? 0 : value.status,
    ...(value.receive_type === 2 ? { is_permanent: 1, total_count: 0 } : {}) };
}
function storedCheck(row: Issue, state: ScopeState) {
  const issues: string[] = [];
  let scope: Scope = { categoryId: 0, brandId: 0, productIds: [] }, value: CouponIssueDefinition | null = null;
  let copyInput: CouponIssueDefinition | null = null, input: CouponIssueInput | null = null;
  try { scope = scopeDefinition(row, state); } catch (error) { issues.push(errorText(error)); }
  try {
    value = definition(row, scope);
    copyInput = copyDefinition(value);
    input = couponIssueCreate(copyInput);
    if (![0, 1, 2].includes(row.category) || ![-1, 0, 1].includes(row.status) || ![0, 1].includes(row.isDel)) throw new ValidateException('历史普通/会员或发行状态无效');
    couponIssueInteger(row.remainCount, '历史剩余量', 0);
    couponIssueInteger(row.totalCount, '历史发行量', 0);
    if (row.isPermanent === 0 && (row.totalCount <= 0 || row.remainCount > row.totalCount)) throw new ValidateException('历史限量库存不一致');
    if (row.isPermanent === 1 && (row.totalCount !== 0 || row.remainCount !== 0)) throw new ValidateException('历史不限量计数不一致');
    couponIssueInteger(row.receiveLimit, '历史每人限领', 0, 32767);
    couponIssueInteger(row.addTime, '历史创建时间', 0);
    couponIssueInteger(row.cid, '历史来源ID', 0);
    couponIssueInteger(row.appType, '历史适用渠道', 0, 1);
    couponIssueInteger(row.isFullGive, '历史满赠状态', 0, 1);
    couponIssueInteger(row.isGiveSubscribe, '历史关注赠送状态', 0, 1);
    couponIssueInteger(row.integral, '历史积分', 0);
    if (!/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(row.fullReduction)) throw new ValidateException('历史满赠门槛无效');
    if (state.proof) {
      couponIssueId(state.proof.templateId, '来源模板ID');
      couponIssueRevision(state.proof.sourceRevision);
      couponIssueInteger(state.proof.issuedAt, '发布证明时间', 0);
    }
  } catch (error) { issues.push(errorText(error)); }
  return { scope, value, copyInput: issues.length ? null : copyInput, input: issues.length ? null : input, issues };
}
async function brandTree(tx: DbClient) {
  const rows = await tx.select().from(storeBrand).where(eq(storeBrand.storeId, 0))
    .orderBy(desc(storeBrand.sort), desc(storeBrand.id)).limit(MAX_OPTIONS + 1);
  if (rows.length > MAX_OPTIONS) throw new ValidateException('平台品牌超过5000项，不能截断选项');
  const byId = new Map(rows.map(row => [row.id, row])), verified = new Set<number>();
  for (const row of rows) {
    const visited = new Set<number>(); let cursor: typeof row | undefined = row;
    while (cursor && !verified.has(cursor.id)) {
      if (cursor.id <= 0 || cursor.pid < 0 || visited.has(cursor.id)) throw new ValidateException('品牌树循环或标识无效');
      visited.add(cursor.id);
      if (cursor.pid && !byId.has(cursor.pid)) throw new ValidateException('品牌树缺失平台父节点');
      cursor = cursor.pid ? byId.get(cursor.pid) : undefined;
    }
    for (const id of visited) verified.add(id);
  }
  const children = new Map<number, typeof rows>();
  for (const row of rows) children.set(row.pid, [...(children.get(row.pid) ?? []), row]);
  const selectable = new Set<number>(), pending = [...(children.get(0) ?? [])];
  while (pending.length) {
    const row = pending.pop()!;
    if (row.isShow !== 1 || row.isDel !== 0) continue;
    selectable.add(row.id); pending.push(...(children.get(row.id) ?? []));
  }
  return { rows, byId, selectable, options: rows.filter(row => selectable.has(row.id)).map(row => ({ id: row.id, pid: row.pid, brand_name: row.brandName })) };
}

/** Independent issuer administration. Owned coupon amounts and order evidence are
 * never rewritten here, and a source-template proof is provenance, not ownership. */
export class AdminCouponIssueService {
  constructor(private readonly container: Container, _appKey?: string) {}
  private read<T>(run: (tx: DbClient) => Promise<T>) {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await deadlines(tx); return run(tx);
    });
  }
  private async states(tx: DbClient, rows: Issue[]) {
    const states = new Map<number, ScopeState>();
    if (!rows.length) return states;
    const ids = rows.map(row => row.id);
    // The complete relation fingerprint is calculated in PostgreSQL. Only 101
    // diagnostic identities per issue cross the wire; large histories cannot be
    // authorized by a truncated list, nor allocated as unbounded JS arrays.
    const scopes = await tx.execute(sql`SELECT i.id,
      (SELECT count(*)::integer FROM store_coupon_product p WHERE p.coupon_id=i.id) AS relation_count,
      (SELECT md5(coalesce(string_agg(p.product_id::text,',' ORDER BY p.product_id),''))
        FROM store_coupon_product p WHERE p.coupon_id=i.id) AS relation_hash,
      ARRAY(SELECT p.product_id FROM store_coupon_product p WHERE p.coupon_id=i.id ORDER BY p.product_id LIMIT 101) AS relation_ids
      FROM store_coupon_issue i WHERE i.id IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)})`);
    const proofs = await tx.select().from(storeCouponTemplateIssue).where(inArray(storeCouponTemplateIssue.issueId, ids));
    const proofById = new Map(proofs.map(proof => [proof.issueId, proof]));
    for (const scope of scopes) {
      if (typeof scope.id !== 'number' || typeof scope.relation_count !== 'number' || typeof scope.relation_hash !== 'string'
        || !Array.isArray(scope.relation_ids) || scope.relation_ids.some(id => typeof id !== 'number')) throw new ValidateException('发行范围快照无效');
      states.set(scope.id, { count: scope.relation_count, hash: scope.relation_hash, ids: scope.relation_ids as number[], proof: proofById.get(scope.id) ?? null });
    }
    if (states.size !== rows.length) throw new ValidateException('发行范围快照不完整');
    return states;
  }
  private revision(row: Issue, state: ScopeState) {
    // xmin and remaining inventory change on a legitimate claim. Neither claim
    // activity nor history can invalidate an unrelated switch confirmation.
    const { remainCount: _remaining, ...definition } = row;
    return couponIssueHash({ definition, scope: { count: state.count, hash: state.hash }, proof: state.proof });
  }
  async list(parameters: URLSearchParams) {
    const query = couponIssueQuery(parameters), match = idSearch(query.keyword);
    const where = and(eq(storeCouponIssue.isDel, 0), query.status === undefined ? undefined : eq(storeCouponIssue.status, query.status),
      query.discountType === undefined ? undefined : eq(storeCouponIssue.type, query.discountType),
      query.receiveType === undefined ? undefined : eq(storeCouponIssue.receiveType, query.receiveType),
      query.keyword ? or(ilike(storeCouponIssue.couponTitle, literal(query.keyword)), ilike(storeCouponIssue.title, literal(query.keyword)),
        match ? eq(storeCouponIssue.id, match) : undefined) : undefined);
    return this.read(async tx => {
      const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeCouponIssue).where(where);
      const rows = await tx.select().from(storeCouponIssue).where(where).orderBy(desc(storeCouponIssue.id)).limit(query.limit).offset(query.offset);
      return { list: await this.project(tx, rows), count: count.count, page: query.page, limit: query.limit };
    });
  }
  async options() {
    return this.read(async tx => ({ categories: (await activityCategories(tx)).options, brands: (await brandTree(tx)).options,
      max_products: COUPON_ISSUE_MAX_PRODUCTS, max_product_ids_length: COUPON_ISSUE_MAX_IDS_LENGTH }));
  }
  async products(parameters: URLSearchParams) {
    const query = couponIssueQuery(parameters, 'products'), match = idSearch(query.keyword);
    const where = and(eq(storeProduct.isDel, 0), query.keyword ? or(ilike(storeProduct.storeName, literal(query.keyword)),
      match ? eq(storeProduct.id, match) : undefined) : undefined);
    return this.read(async tx => {
      const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeProduct).where(where);
      const rows = await tx.select({ id: storeProduct.id, store_name: storeProduct.storeName }).from(storeProduct).where(where)
        .orderBy(desc(storeProduct.id)).limit(query.limit).offset(query.offset);
      return { list: rows.map(row => ({ ...row, deleted: false })), count: count.count, page: query.page, limit: query.limit };
    });
  }
  async detail(value: string) {
    const id = couponIssueId(value);
    return this.read(async tx => {
      const [row] = await tx.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, id)).limit(1);
      if (!row) throw new NotFoundException('优惠券发行不存在');
      return (await this.project(tx, [row]))[0];
    });
  }
  async copy(value: string) { return this.detail(value); }
  private async project(tx: DbClient, rows: Issue[]): Promise<CouponIssueRow[]> {
    if (!rows.length) return [];
    const states = await this.states(tx, rows), checked = rows.map(row => storedCheck(row, states.get(row.id)!));
    const productIds = [...new Set(checked.flatMap(item => item.scope.productIds))];
    const products = productIds.length ? await tx.select({ id: storeProduct.id, name: storeProduct.storeName, deleted: storeProduct.isDel })
      .from(storeProduct).where(inArray(storeProduct.id, productIds)) : [];
    const productById = new Map(products.map(row => [row.id, row]));
    let categories: Awaited<ReturnType<typeof activityCategories>> | null = null, brands: Awaited<ReturnType<typeof brandTree>> | null = null;
    let categoryProblem = '', brandProblem = '';
    if (rows.some(row => row.couponType === 1)) {
      try { categories = await activityCategories(tx); } catch (error) { if (!(error instanceof ValidateException)) throw error; categoryProblem = error.message; }
    }
    if (rows.some(row => row.couponType === 3)) {
      try { brands = await brandTree(tx); } catch (error) { if (!(error instanceof ValidateException)) throw error; brandProblem = error.message; }
    }
    const categoryById = new Map(categories?.rows.map(row => [row.id, row]) ?? []);
    return Promise.all(rows.map(async (row, index) => {
      const check = checked[index], state = states.get(row.id)!, issues = [...check.issues];
      const selected = check.scope.productIds.map(id => {
        const product = productById.get(id);
        if (!product || product.deleted !== 0) issues.push(`适用商品${id}不存在或已删除`);
        return { id, store_name: product?.name ?? `缺失商品#${id}`, deleted: !product || product.deleted !== 0 };
      });
      if (row.couponType === 1 && !categories?.selectable.has(check.scope.categoryId)) issues.push(categoryProblem || '适用分类缺失、隐藏或祖先无效');
      if (row.couponType === 3 && !brands?.selectable.has(check.scope.brandId)) issues.push(brandProblem || '适用品牌缺失、隐藏、已删除或祖先无效');
      const valid = !issues.length;
      // The bound creation form has no app_type control. A copied draft must
      // never discard a historical audience restriction and become public.
      // This copy-only diagnostic does not invalidate an otherwise sound
      // issuer's independent status operation, which preserves its app_type.
      if (row.appType !== 0) issues.push('历史发行受众未由本表单支持，请核对后独立新建');
      // Invalid historical dates remain diagnosable; no synthetic date is offered
      // as a copy draft. Financial strings are returned without lossy Number().
      const value = check.value ?? { title: row.couponTitle || row.title, discount_type: row.type, scope_type: row.couponType,
        category: row.category, category_id: check.scope.categoryId, brand_id: check.scope.brandId, product_ids: check.scope.productIds,
        coupon_price: row.couponPrice, use_min_price: row.useMinPrice, valid_days: row.day, use_start_time: null, use_end_time: null,
        start_time: null, end_time: null, receive_type: row.receiveType, is_permanent: row.isPermanent,
        total_count: row.totalCount, rule: row.rule ?? '', status: row.status, sort: row.sort };
      return { ...value, id: row.id, deleted: row.isDel !== 0, remain_count: row.remainCount, receive_limit: row.receiveLimit,
        add_time: row.addTime, cid: row.cid, app_type: row.appType,
        source_template: state.proof ? { template_id: state.proof.templateId, source_revision: state.proof.sourceRevision } : null,
        revision: await this.revision(row, state), valid, issues,
        category_name: categoryById.get(check.scope.categoryId)?.cateName ?? '', brand_name: brands?.byId.get(check.scope.brandId)?.brandName ?? '',
        products: selected, copy_input: !valid || row.isDel !== 0 || row.appType !== 0 ? null : check.copyInput };
    }));
  }
  async claims(value: string, parameters: URLSearchParams) {
    const id = couponIssueId(value), query = couponIssueQuery(parameters, 'claims');
    return this.read(async tx => {
      const [issue] = await tx.select({ id: storeCouponIssue.id, category: storeCouponIssue.category }).from(storeCouponIssue)
        .where(eq(storeCouponIssue.id, id)).limit(1);
      if (!issue) throw new NotFoundException('优惠券发行不存在');
      if (issue.category === 2) {
        const where = eq(storeCouponUser.issueCouponId, id);
        const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeCouponUser).where(where);
        const rows = await tx.select({ id: storeCouponUser.id, uid: storeCouponUser.uid, add_time: storeCouponUser.receiveTime,
          user_id: user.uid, nickname: user.nickname, avatar: user.avatar, user_deleted: user.isDel }).from(storeCouponUser)
          .leftJoin(user, eq(user.uid, storeCouponUser.uid)).where(where).orderBy(desc(storeCouponUser.receiveTime), desc(storeCouponUser.id))
          .limit(query.limit).offset(query.offset);
        const list: CouponIssueClaim[] = rows.map(row => ({ id: row.id, row_key: `owned:${row.id}`, uid: row.uid,
          nickname: row.nickname ?? '', avatar_preview: combinationStatisticsAvatar(row.avatar ?? ''), add_time: row.add_time,
          missing_user: row.user_id === null, deleted_user: row.user_deleted !== null && row.user_deleted !== 0 }));
        return { issue_id: id, source: 'owned' as const, list, count: count.count, page: query.page, limit: query.limit };
      }
      const where = eq(storeCouponIssueUser.issueCouponId, id);
      const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeCouponIssueUser).where(where);
      const rows = await tx.select({ uid: storeCouponIssueUser.uid, add_time: storeCouponIssueUser.addTime,
        user_id: user.uid, nickname: user.nickname, avatar: user.avatar, user_deleted: user.isDel }).from(storeCouponIssueUser)
        .leftJoin(user, eq(user.uid, storeCouponIssueUser.uid)).where(where)
        .orderBy(desc(storeCouponIssueUser.addTime), asc(storeCouponIssueUser.uid), sql`store_coupon_issue_user.ctid`)
        .limit(query.limit).offset(query.offset);
      const list: CouponIssueClaim[] = rows.map((row, index) => ({ id: null, row_key: `issue-log:${id}:${query.offset + index}`,
        uid: row.uid, nickname: row.nickname ?? '', avatar_preview: combinationStatisticsAvatar(row.avatar ?? ''), add_time: row.add_time,
        missing_user: row.user_id === null, deleted_user: row.user_deleted !== null && row.user_deleted !== 0 }));
      return { issue_id: id, source: 'issue_log' as const, list, count: count.count, page: query.page, limit: query.limit };
    });
  }
  private async scope(tx: DbClient, input: CouponIssueInput) {
    if (input.scopeType === 1) {
      const tree = await activityCategories(tx), byId = new Map(tree.rows.map(row => [row.id, row]));
      if (!tree.selectable.has(input.categoryId)) throw new ValidateException('适用分类不存在、隐藏或非平台分类');
      const chain: number[] = []; let cursor = byId.get(input.categoryId);
      while (cursor) { chain.push(cursor.id); cursor = cursor.pid ? byId.get(cursor.pid) : undefined; }
      const locked = await tx.select().from(storeProductCategory).where(inArray(storeProductCategory.id, chain)).orderBy(asc(storeProductCategory.id)).for('share', { noWait: true });
      if (locked.length !== chain.length || locked.some(row => row.pid !== byId.get(row.id)?.pid || row.isShow !== 1 || row.type !== 0 || row.relationId !== 0)) {
        throw new ValidateException('适用分类树已变化，请重新确认');
      }
    }
    if (input.scopeType === 3) {
      const tree = await brandTree(tx);
      if (!tree.selectable.has(input.brandId)) throw new ValidateException('适用品牌不存在、隐藏、已删除或非平台品牌');
      const chain: number[] = []; let cursor = tree.byId.get(input.brandId);
      while (cursor) { chain.push(cursor.id); cursor = cursor.pid ? tree.byId.get(cursor.pid) : undefined; }
      const locked = await tx.select().from(storeBrand).where(inArray(storeBrand.id, chain)).orderBy(asc(storeBrand.id)).for('share', { noWait: true });
      if (locked.length !== chain.length || locked.some(row => row.pid !== tree.byId.get(row.id)?.pid || row.isShow !== 1 || row.isDel !== 0 || row.storeId !== 0)) {
        throw new ValidateException('适用品牌树已变化，请重新确认');
      }
    }
    if (input.scopeType === 2) {
      const ids = input.productIds.split(',').map(Number);
      const products = await tx.select({ id: storeProduct.id }).from(storeProduct).where(and(inArray(storeProduct.id, ids), eq(storeProduct.isDel, 0)))
        .orderBy(asc(storeProduct.id)).for('share', { noWait: true });
      if (products.length !== ids.length) throw new ValidateException('部分适用商品不存在或已删除');
    }
  }
  private currentTime(input: CouponIssueInput, now: number) {
    if (input.status === 1 && ((input.endTime && input.endTime.getTime() <= now * 1000)
      || (input.validDays === 0 && input.useEndTime && input.useEndTime.getTime() <= now * 1000))) throw new ValidateException('启用优惠券的领取或使用时间已经结束');
  }
  async mutate(operation: CouponIssueOperation, value: string | undefined, body: Record<string, unknown>, actor: { id: number }): Promise<{ id: number }> {
    if (!['create', 'status', 'delete'].includes(operation)) throw new ValidateException('不支持的发行操作');
    const actorId = couponIssueId(actor.id, '管理员ID'), id = operation === 'create' ? 0 : couponIssueId(value);
    if (operation === 'create' && value !== undefined) throw new ValidateException('新发行不能携带旧身份');
    couponIssueWhitelist(body, operation === 'create' ? [...couponIssueFields, 'request_id', 'source_id', 'source_revision']
      : ['request_id', 'revision', ...(operation === 'status' ? ['status'] : [])]);
    const request = couponIssueRequest(body.request_id), expected = id ? couponIssueRevision(body.revision) : null;
    const input = operation === 'create' ? couponIssueCreate(body) : null;
    const status = operation === 'status' ? couponIssueInteger(body.status, '状态', 0, 1) as 0 | 1 : null;
    const sourceId = operation === 'create' ? couponIssueInteger(body.source_id, '复制源发行ID', 0) : 0;
    const sourceRevision = sourceId ? couponIssueRevision(body.source_revision) : null;
    if (operation === 'create' && !sourceId && body.source_revision !== null) throw new ValidateException('新建发行不能携带复制版本');
    const fingerprint = await couponIssueHash({ operation, id, revision: expected, sourceId, sourceRevision, input, status });
    const path = `/marketing/coupon-issues/request/${request}`;
    return writeBoundary(() => withTx(this.container, async tx => {
      const [state] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`);
      if (state?.isolation !== 'read committed') throw new ValidateException('优惠券发行写入需要READ COMMITTED事务');
      await deadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE},${actorId})`);
      const logs = await tx.select({ action: systemLog.action }).from(systemLog).where(and(eq(systemLog.adminId, actorId),
        eq(systemLog.type, 'coupon_issue'), eq(systemLog.path, path))).orderBy(desc(systemLog.id)).limit(2);
      if (logs.length) {
        const match = /^(create|status|delete);id=([1-9]\d{0,9});payload=([a-f0-9]{64})$/.exec(logs[0].action);
        if (logs.length !== 1 || !match || match[1] !== operation || match[3] !== fingerprint) throw new ValidateException('请求标识已用于其他发行操作');
        const resultId = couponIssueId(match[2]);
        if (id && resultId !== id) throw new ValidateException('发行重放身份不一致');
        const [exists] = await tx.select({ id: storeCouponIssue.id }).from(storeCouponIssue).where(eq(storeCouponIssue.id, resultId)).limit(1);
        if (!exists) throw new ValidateException('发行重放记录不能证明原结果');
        return { id: resultId };
      }
      const [clock] = await tx.execute(sql`SELECT extract(epoch FROM clock_timestamp())::double precision AS now`);
      if (typeof clock?.now !== 'number' || !Number.isFinite(clock.now)) throw new ValidateException('数据库时间无效');
      const now = Math.floor(clock.now); couponIssueInteger(now, '数据库时间', 0);
      const lockedId = id || sourceId;
      const [row] = lockedId ? await tx.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, lockedId)).limit(1).for('update') : [];
      if (lockedId && !row) throw new NotFoundException('优惠券发行不存在');
      let checked: ReturnType<typeof storedCheck> | null = null;
      if (row) {
        const snapshot = (await this.states(tx, [row])).get(row.id)!;
        if (await this.revision(row, snapshot) !== (id ? expected : sourceRevision)) throw new ValidateException('优惠券发行已变化，请刷新后重新确认');
        if (row.isDel !== 0) throw new ValidateException('已删除发行不能再次操作或复制');
        if (sourceId && row.appType !== 0) throw new ValidateException('历史发行受众未由本表单支持，请核对后独立新建');
        checked = storedCheck(row, snapshot);
        if (sourceId && !checked.input) throw new ValidateException(checked.issues.join('；'));
      }
      let resultId = id;
      if (input) {
        this.currentTime(input, now);
        // Copy accepts an edited draft but does not silently repair an invalid
        // source scope or carry forward its cid, proof, gift flags or counters.
        if (sourceId && checked?.input) await this.scope(tx, checked.input);
        await this.scope(tx, input);
        const [created] = await tx.insert(storeCouponIssue).values({ cid: 0, category: input.category, couponType: input.scopeType,
          couponTitle: input.title, title: input.title, type: input.discountType, couponPrice: input.couponPrice, useMinPrice: input.useMinPrice,
          productId: input.productIds || '0', legacyProductIds: input.productIds || '', category_id: String(input.categoryId),
          legacyCategoryId: input.categoryId, brandId: String(input.brandId), legacyBrandId: input.brandId,
          totalCount: input.totalCount, remainCount: input.isPermanent ? 0 : input.totalCount, receiveLimit: 1,
          receiveType: input.receiveType, startTime: input.startTime, endTime: input.endTime, day: input.validDays,
          isPermanent: input.isPermanent, isGiveSubscribe: 0, isFullGive: 0, fullReduction: '0.00', isDel: 0,
          integral: 0, useStartTime: input.useStartTime, useEndTime: input.useEndTime, rule: input.rule,
          status: input.status, appType: 0, sort: input.sort, addTime: now }).returning({ id: storeCouponIssue.id });
        resultId = couponIssueId(created?.id);
        if (input.scopeType === 2) await tx.insert(storeCouponProduct).values(input.productIds.split(',').map(productId => ({ couponId: resultId, productId: Number(productId) })));
      } else if (operation === 'status') {
        if (status === 1) {
          if (!checked?.input) throw new ValidateException(checked?.issues.join('；') || '历史发行定义无效');
          const enabled = { ...checked.input, status: 1 as const };
          this.currentTime(enabled, now); await this.scope(tx, enabled);
        }
        await tx.update(storeCouponIssue).set({ status: status! }).where(eq(storeCouponIssue.id, id));
      } else {
        // Keep scope, paid-product grant configuration, publication provenance,
        // owned/reserved coupons and all order history. Future grants check isDel.
        await tx.update(storeCouponIssue).set({ isDel: 1, status: -1 }).where(eq(storeCouponIssue.id, id));
      }
      await tx.insert(systemLog).values({ adminId: actorId, type: 'coupon_issue', path,
        method: operation === 'delete' ? 'DELETE' : 'POST', action: `${operation};id=${resultId};payload=${fingerprint}`, addTime: now });
      return { id: resultId };
    }));
  }
}
