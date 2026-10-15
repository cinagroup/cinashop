import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { type Container, type DbClient } from '@/lib/di';
import { storeCart, storeOrderOutbox, storeProduct, storeProductAttrValue, storeProductRelation, systemLog } from '@/models/schema';
import { boundBargainSourceProductChange, lockBargainSourceProductChange } from '@/services/activity/BargainSourceProductLifecycle';
import { tryLockProductWrite } from '@/services/product/ProductAssociationService';
import { enqueueProductRecycleEffects } from '@/services/product/ProductRecycleEffects';
import { ApiErrorCode, AuthException, HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { emitOperationalEvent } from '@/utils/observability';
import { assertAdminAuthoritySession, loadAdminAuthorityLiveActor, withAdminAuthorityWriteTx, type AdminAuthorityActor } from './AdminAuthorityWriteService';

export type AdminProductRecycleActor = AdminAuthorityActor;
export interface AdminProductRecycleEffects { dispatch(outboxId: number): Promise<void> }
export interface AdminProductRecycleOptions { mode: 'toggle' | 'recycle'; expectedIsDel?: 0 | 1; auditPath?: string }
const MAX_ROWS = 10_000;
const conflict = (message: string) => new HttpApiException(message, 409, 409);
function canonical(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)])) : item;
  return JSON.stringify(ordered(value));
}
const same = (actual: unknown, expected: unknown) => canonical(actual) === canonical(expected);
const fullIdentity = (value: Awaited<ReturnType<typeof loadAdminAuthorityLiveActor>>) => ({ ...value, keys: [...value.keys].sort() });
export function adminProductRecycleId(value: unknown): number {
  const parsed = typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) throw new ValidateException('商品ID错误');
  return parsed;
}
async function clock(tx: DbClient, actor: AdminProductRecycleActor): Promise<void> {
  const [row] = await tx.execute(sql`SELECT extract(epoch FROM clock_timestamp()) >= ${actor.expiresAt} AS expired`) as unknown as Array<{ expired: boolean }>;
  if (row?.expired !== false) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
  assertAdminAuthoritySession(actor);
}
function recycleError(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(conflict('商品、购物车或管理员权限正在变化，请刷新后重试'), { cause: error });
    if (['42501', '57014'].includes(code)) throw Object.assign(new ServiceUnavailableException('商品回收运行权限未就绪或超时'), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

/** PHP's reversible delete contract, with a bounded, verified transaction.
 * No ownership, card, review or existing deletion state is an admission gate.
 * This path never writes SKU, relations, orders or descendants beyond pid=id. */
export class AdminProductRecycleService {
  constructor(private readonly container: Container, private readonly effects?: AdminProductRecycleEffects) {}

  async change(productId: number, actor: AdminProductRecycleActor, options: AdminProductRecycleOptions): Promise<{ message: string; outboxId?: number }> {
    productId = adminProductRecycleId(productId);
    if (!options || !['toggle', 'recycle'].includes(options.mode) || options.expectedIsDel !== undefined && ![0, 1].includes(options.expectedIsDel)) throw new ValidateException('商品回收参数错误');
    try {
      const completed = await withAdminAuthorityWriteTx<{ message: string; outboxId?: number }>(this.container, actor, 'product.manage', async (tx, live) => {
        await clock(tx, actor);
        // Read the complete candidate family before taking ANY business lock.
        // Checkout takes cart rows before product writes, but participates in
        // the bargain admission fence first. Waiting on that fence while
        // holding a product/cart table barrier would reverse its lock order.
        const [initialParent] = await tx.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1);
        if (!initialParent) throw new ValidateException('商品数据不存在');
        const familyWhere = initialParent.type === 0 ? or(eq(storeProduct.id, productId), eq(storeProduct.pid, productId))! : eq(storeProduct.id, productId);
        const readFamily = () => tx.select().from(storeProduct).where(familyWhere).orderBy(asc(storeProduct.id)).limit(MAX_ROWS + 1);
        const initialFamily = await readFamily();
        if (initialFamily.length > MAX_ROWS) throw new ServiceUnavailableException('商品完整关联超过10000项');
        if (!same(initialFamily.find(row => row.id === productId), initialParent)) throw conflict('商品关联正在变化，请刷新后重试');
        const affectedProductIds = initialFamily.map(row => row.id);
        await boundBargainSourceProductChange(tx);
        for (const id of affectedProductIds) await lockBargainSourceProductChange(tx, id);
        for (const id of affectedProductIds) if (!await tryLockProductWrite(tx, id)) throw conflict('商品正在编辑，请刷新后重试');
        // Actual PostgreSQL barriers cover direct SQL writers and inserted
        // children/SKU/cart/relation phantoms. UPDATE privileges are required.
        // SHARE ROW EXCLUSIVE deliberately serializes unrelated writes briefly;
        // NOWAIT refuses contention instead of waiting with business locks.
        await tx.execute(sql`LOCK TABLE ONLY ${storeProduct}, ONLY ${storeProductAttrValue}, ONLY ${storeCart}, ONLY ${storeProductRelation} IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
        const family = await readFamily();
        if (!same(family, initialFamily)) throw conflict('商品关联正在变化，请刷新后重试');
        const lockedFamily = await tx.select().from(storeProduct).where(inArray(storeProduct.id, affectedProductIds)).orderBy(asc(storeProduct.id)).for('update', { noWait: true });
        if (!same(lockedFamily, family)) throw conflict('商品完整锁定结果不一致');
        const product = family.find(row => row.id === productId)!;
        if (options.expectedIsDel !== undefined && product.isDel !== options.expectedIsDel) throw conflict('商品回收状态已变化，请刷新后重试');
        // Existing one-way aliases remain idempotent. In particular a repeated
        // alias does not invalidate carts or enqueue a second external effect.
        if (options.mode === 'recycle' && product.isDel === 1) {
          const final = await loadAdminAuthorityLiveActor(tx, actor, 'product.manage');
          if (!same(fullIdentity(final), fullIdentity(live))) throw new AuthException('管理员权限已变化', ApiErrorCode.ERR_AUTH);
          if (!same(await readFamily(), family)) throw conflict('商品完整业务回读不一致');
          await clock(tx, actor);
          return { message: '删除成功' };
        }
        const skus = await tx.select().from(storeProductAttrValue).where(inArray(storeProductAttrValue.productId, affectedProductIds)).orderBy(asc(storeProductAttrValue.id)).limit(MAX_ROWS + 1).for('share', { noWait: true });
        const carts = await tx.select().from(storeCart).where(inArray(storeCart.productId, affectedProductIds)).orderBy(asc(storeCart.id)).limit(MAX_ROWS + 1).for('update', { noWait: true });
        const relations = await tx.select().from(storeProductRelation).where(inArray(storeProductRelation.productId, affectedProductIds)).orderBy(asc(storeProductRelation.id)).limit(MAX_ROWS + 1).for('share', { noWait: true });
        // Aliases share the canonical audit identity. auditPath is intentionally
        // not interpolated into the business or audit target.
        const auditPath = `product/product/${productId}`;
        const priorAudits = await tx.select().from(systemLog).where(eq(systemLog.path, auditPath)).orderBy(asc(systemLog.id)).limit(MAX_ROWS + 1);
        const outboxWhere = and(eq(storeOrderOutbox.aggregateType, 'product'), eq(storeOrderOutbox.aggregateId, productId));
        const priorOutbox = await tx.select().from(storeOrderOutbox).where(outboxWhere).orderBy(asc(storeOrderOutbox.id)).limit(MAX_ROWS + 1);
        if ([skus, carts, relations, priorAudits, priorOutbox].some(rows => rows.length > MAX_ROWS)) throw new ServiceUnavailableException('商品回收完整关联或审计集合超过10000项');
        const restore = options.mode === 'toggle' && product.isDel === 1, isDel = restore ? 0 : 1;
        // The declared PHP installer/model has no product_verify_status store
        // column/getter/config append. getStoreInfo(missing/deleted) returns [].
        // Under that source schema type=1 ALWAYS sets is_verify=0, both ways.
        const parentChange = { isDel, ...(!restore ? { isShow: 0 } : {}), ...(product.type === 1 ? { isVerify: 0 } : {}) };
        const wantedFamily = family.map(row => row.id === productId ? { ...row, ...parentChange } : { ...row, isDel });
        if (product.type === 0) {
          // A malformed self pid is included by PHP's child update too; its
          // final parent update wins. Excluding it here preserves that result.
          const returnedChildren = await tx.update(storeProduct).set({ isDel }).where(and(eq(storeProduct.pid, productId), ne(storeProduct.id, productId))).returning();
          if (!same(returnedChildren.sort((a, b) => a.id - b.id), wantedFamily.filter(row => row.id !== productId))) throw conflict('商品子项完整写入结果不一致');
        }
        const returnedParent = await tx.update(storeProduct).set(parentChange).where(eq(storeProduct.id, productId)).returning();
        if (returnedParent.length !== 1 || !same(returnedParent[0], wantedFamily.find(row => row.id === productId))) throw conflict('商品回收完整写入结果不一致');
        // Source DeleteSuccess changes EVERY cart status of the parent ID,
        // including paid/deleted/new/activity carts and prior status!=1.
        const wantedCarts = carts.map(row => row.productId === productId ? { ...row, status: 0 } : row);
        const returnedCarts = await tx.update(storeCart).set({ status: 0 }).where(eq(storeCart.productId, productId)).returning();
        if (!same(returnedCarts.sort((a, b) => a.id - b.id), wantedCarts.filter(row => row.productId === productId))) throw conflict('商品回收购物车完整写入结果不一致');
        const verifyBusiness = async () => {
          const freshFamily = await readFamily();
          const freshSkus = await tx.select().from(storeProductAttrValue).where(inArray(storeProductAttrValue.productId, affectedProductIds)).orderBy(asc(storeProductAttrValue.id)).limit(MAX_ROWS + 1);
          const freshCarts = await tx.select().from(storeCart).where(inArray(storeCart.productId, affectedProductIds)).orderBy(asc(storeCart.id)).limit(MAX_ROWS + 1);
          const freshRelations = await tx.select().from(storeProductRelation).where(inArray(storeProductRelation.productId, affectedProductIds)).orderBy(asc(storeProductRelation.id)).limit(MAX_ROWS + 1);
          if (!same(freshFamily, wantedFamily) || !same(freshSkus, skus) || !same(freshCarts, wantedCarts) || !same(freshRelations, relations)) throw conflict('商品回收完整业务回读不一致');
        };
        await verifyBusiness();
        const [time] = await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`) as unknown as Array<{ now: number }>;
        if (!time || !Number.isSafeInteger(time.now) || time.now < 0) throw new ServiceUnavailableException('商品回收数据库时钟不可用');
        const auditFields = { storeId: 0, merchantId: 0, adminName: '', ip: '', adminId: actor.id, path: auditPath, page: '商品回收站', method: 'DELETE', type: 'product_recycle',
          action: JSON.stringify({ operation: restore ? 'restore' : 'recycle', productId, affectedProductIds }), addTime: time.now };
        const audits = await tx.insert(systemLog).values(auditFields).returning(), audit = audits[0];
        if (audits.length !== 1 || !audit || !Number.isSafeInteger(audit.id) || audit.id <= 0 || Object.keys(audit).length !== Object.keys(auditFields).length + 1
          || !Object.entries(auditFields).every(([key, value]) => audit[key as keyof typeof auditFields] === value)) throw conflict('商品回收完整审计回执不一致');
        const outbox = await enqueueProductRecycleEffects(tx, { productId, auditId: audit.id, affectedProductIds }, time.now);
        const verifyReceipts = async () => {
          const freshAudits = await tx.select().from(systemLog).where(eq(systemLog.path, auditPath)).orderBy(asc(systemLog.id)).limit(MAX_ROWS + 2);
          const freshOutbox = await tx.select().from(storeOrderOutbox).where(outboxWhere).orderBy(asc(storeOrderOutbox.id)).limit(MAX_ROWS + 2);
          if (!same(freshAudits, [...priorAudits, audit].sort((a, b) => a.id - b.id)) || !same(freshOutbox, [...priorOutbox, outbox].sort((a, b) => a.id - b.id))) throw conflict('商品回收完整审计或后置任务集合回读不一致');
        };
        await verifyReceipts();
        await verifyBusiness();
        const final = await loadAdminAuthorityLiveActor(tx, actor, 'product.manage');
        if (!same(fullIdentity(final), fullIdentity(live))) throw new AuthException('管理员权限已变化', ApiErrorCode.ERR_AUTH);
        await verifyBusiness();
        await verifyReceipts();
        await clock(tx, actor);
        return { message: restore ? '成功恢复商品' : '成功移到回收站', outboxId: outbox.id };
      });
      if (completed.outboxId && this.effects) {
        try { await this.effects.dispatch(completed.outboxId); }
        catch { emitOperationalEvent('error', { event: 'product_recycle_effects_dispatch_failed', component: 'queue', outcome: 'retry', operation: 'product_recycle', errorCode: 'dispatch_pending' }); }
      }
      return completed;
    } catch (error) { return recycleError(error); }
  }
}
