import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrValue, storeProductStockRecord, systemAdmin, systemConfig, systemLog } from '@/models/schema';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { normalizeConfigScalar } from '@/utils/config';
import { ApiErrorCode, AuthException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { emitOperationalEvent } from '@/utils/observability';
import { assertAdminAuthoritySession, loadAdminAuthorityLiveActor, parseAdminAuthorityRoleIds, withAdminAuthorityWriteTx, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';
import { loadAdminLegacyRoleReferenceHistory } from './AdminLegacyRoleDeletionProof';
import { enqueueProductStockEffects } from '@/services/product/ProductStockEffects';
import { tryLockProductWrite } from '@/services/product/ProductAssociationService';
import { PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE } from '@/services/product/ProductSkuIdentity';
import { ERP_CONFIG_LOCK } from '@/services/erp/ErpConnectionPolicy';

export type AdminProductStockActor = AdminAuthorityActor;
export interface AdminProductStockAdjustment { unique: string; pm: 0 | 1; stock: number }
export interface AdminProductStockEffects { dispatch(outboxId: number): Promise<void> }
type Product = typeof storeProduct.$inferSelect;
type Sku = typeof storeProductAttrValue.$inferSelect;
const MAX_INTEGER = 2_147_483_647, MIN_INTEGER = -2_147_483_648, MAX_ROWS = 10_000;
const conflict = (message: string) => new HttpApiException(message, 409, 409);
const same = (actual: unknown, expected: unknown): boolean => JSON.stringify(actual) === JSON.stringify(expected);
function id(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_INTEGER) throw new ValidateException('缺少商品ID');
  return value;
}
function integer(value: unknown, label: string): number {
  const parsed = typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_INTEGER) throw new ValidateException(`${label}必须为非负整数`);
  return parsed;
}
export function normalizeAdminProductStockAdjustments(body: unknown): AdminProductStockAdjustment[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidateException('请重新修改规格库存');
  const row = body as Record<string, unknown>;
  if (Object.keys(row).some(key => key !== 'attrs') || !Array.isArray(row.attrs) || !row.attrs.length || row.attrs.length > MAX_ROWS) throw new ValidateException('请重新修改规格库存，单次最多10000项');
  return row.attrs.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ValidateException('请重新修改规格库存');
    const input = item as Record<string, unknown>;
    if (Object.keys(input).some(key => !['unique', 'pm', 'stock'].includes(key)) || typeof input.unique !== 'string'
      || !input.unique || [...input.unique].length > 8 || input.unique !== input.unique.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(input.unique)) throw new ValidateException('规格标识格式错误');
    const pm = integer(input.pm, '库存方向');
    if (pm !== 0 && pm !== 1) throw new ValidateException('库存方向必须为0或1');
    return { unique: input.unique, pm, stock: integer(input.stock, '库存数量') };
  });
}
function storedInteger(value: number, name: string, signed = false) {
  if (!Number.isSafeInteger(value) || value < (signed ? MIN_INTEGER : 0) || value > MAX_INTEGER) throw conflict(`${name}超出存储范围，请先修复原始数据`);
  return value;
}
function owner(product: Product): boolean {
  return product.type === 0 && product.relationId === 0 || [1, 2].includes(product.type) && Number.isSafeInteger(product.relationId) && product.relationId > 0 && product.relationId <= MAX_INTEGER;
}
/** PHP applies each repeated request to the original loaded SKU, while every
 * recognized requested delta contributes to main stock and its own ledger.
 * Do not replace this deliberately retained anomaly with cumulative SKU/SUM. */
export function planAdminProductStockAdjustment(product: Product, allSkus: readonly Sku[], adjustments: readonly AdminProductStockAdjustment[]) {
  storedInteger(product.stock, '商品库存');
  const ordinary = allSkus.filter(row => row.type === 0), byUnique = new Map(ordinary.map(row => [row.unique, row]));
  const expected = new Map(allSkus.map(row => [row.id, { ...row }])), records: Array<{ before: Sku; adjustment: AdminProductStockAdjustment }> = [];
  let net = 0;
  for (const adjustment of adjustments) {
    const before = byUnique.get(adjustment.unique);
    // The readable source skips unrecognized aliases, including an all-unknown request.
    if (!before) continue;
    if (adjustment.stock && ordinary.some(row => row.unique === before.unique && row.isRetired !== before.isRetired)) throw conflict('规格标识同时属于活动及退休规格，请先整理规格身份');
    if (before.isRetired !== 0 && adjustment.stock !== 0) throw conflict('退休规格只能保留零调整，请先恢复规格');
    storedInteger(before.stock, '规格库存'); storedInteger(before.sumStock, '累计库存', true);
    const delta = adjustment.pm === 1 ? adjustment.stock : -adjustment.stock;
    net += delta;
    if (!Number.isSafeInteger(net)) throw conflict('库存净调整超出精确容量');
    const stock = Math.max(0, before.stock + delta), sumStock = before.sumStock + delta;
    storedInteger(stock, '规格库存'); storedInteger(sumStock, '累计库存', true);
    expected.set(before.id, { ...before, stock, sumStock });
    records.push({ before, adjustment });
  }
  const stock = Math.max(0, product.stock + net); storedInteger(stock, '商品库存');
  return { stock, expected, records };
}
async function clock(tx: DbClient, actor: AdminProductStockActor) {
  const [result] = await tx.execute(sql`SELECT extract(epoch FROM clock_timestamp()) >= ${actor.expiresAt} AS expired`) as unknown as Array<{ expired: boolean }>;
  if (result?.expired !== false) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
  assertAdminAuthoritySession(actor);
}
function stockError(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(conflict('商品库存或管理员权限正在变化，请刷新后重试'), { cause: error });
    if (['42501', '57014'].includes(code)) throw Object.assign(new ServiceUnavailableException('库存操作运行权限未就绪或超时'), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

export class AdminProductStockService {
  constructor(private readonly container: Container, private readonly appKey?: string, private readonly effects?: AdminProductStockEffects) {}

  async attrs(productId: number, actor: AdminProductStockActor) {
    id(productId); assertAdminAuthoritySession(actor);
    try {
      return await withTx(this.container, async tx => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        await tx.execute(sql`SET LOCAL statement_timeout='5s'`); await tx.execute(sql`SET LOCAL lock_timeout='2s'`); await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
        const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
        if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0 || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_BANNED);
        const encoder = new TextEncoder();
        if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
        await loadAdminLegacyRoleReferenceHistory(tx, parseAdminAuthorityRoleIds(live.roles), live.level);
        const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);
        if (live.level !== 0 && !hasAdminPermission(keys, 'product.view')) throw new AuthException('管理员权限已变化', ApiErrorCode.ERR_AUTH);
        const rows = await tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, productId), eq(storeProductAttrValue.type, 0))).orderBy(asc(storeProductAttrValue.id)).limit(MAX_ROWS + 1);
        if (rows.length > MAX_ROWS) throw new ServiceUnavailableException('商品完整规格超过10000项');
        // Source does not require a live parent. It is used ONLY to derive media ownership.
        const [parent] = await tx.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1);
        const list = rows.map(row => ({ ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value])),
          id: row.id, product_id: row.productId, unique: row.unique, suk: row.suk, stock: row.stock, sum_stock: row.sumStock,
          image: row.image, disk_info: null, is_retired: row.isRetired }));
        const slots = list.map((row, index) => ({ row, index, reference: canonicalizePublishedAttachmentReference(row.image) })).filter(slot => slot.reference.startsWith('/api/assets/'));
        if (slots.length) {
          const pictures = await publicProductPictures(tx, slots.map(slot => ({ image: parent && owner(parent) && this.appKey && parseCanonicalAttachmentId(slot.reference) !== null ? slot.reference : '',
            type: parent?.type === 1 ? 0 : parent?.type ?? -1, relationId: parent?.type === 1 ? 0 : parent?.relationId ?? -1 })));
          const rendered = await renderProductPictures(this.appKey, pictures);
          slots.forEach((slot, index) => { slot.row.image = rendered[index]; });
        }
        await clock(tx, actor); return list;
      });
    } catch (error) { return stockError(error); }
  }

  async save(productId: number, body: unknown, actor: AdminProductStockActor): Promise<{ stock: string | 0 }> {
    id(productId); const adjustments = normalizeAdminProductStockAdjustments(body);
    try {
      const completed = await withAdminAuthorityWriteTx(this.container, actor, 'product.manage', async (tx, live) => {
        await clock(tx, actor);
        if (!await tryLockProductWrite(tx, productId)) throw conflict('商品正在编辑，请刷新后重试');
        const [identity] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE},0) AS locked`) as unknown as Array<{ locked: boolean }>;
        if (identity?.locked !== true) throw conflict('规格身份正在变化，请刷新后重试');
        const [erp] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock_shared(${ERP_CONFIG_LOCK},0) AS locked`) as unknown as Array<{ locked: boolean }>;
        const [commerce] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext('admin-commerce-settings')) AS locked`) as unknown as Array<{ locked: boolean }>;
        if (erp?.locked !== true || commerce?.locked !== true) throw conflict('商城库存配置正在变化，请刷新后重试');
        // Row locks cannot protect an absent ERP/threshold key. This also
        // conflicts with the real generic configuration insert/update path.
        await tx.execute(sql`LOCK TABLE ${systemConfig} IN SHARE MODE NOWAIT`);
        const config = await tx.select().from(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, ['store_stock', 'erp_open']))).orderBy(asc(systemConfig.sort), asc(systemConfig.id)).for('share', { noWait: true });
        const values = new Map(config.map(row => [row.menuName, normalizeConfigScalar(row.value)]));
        if (values.has('erp_open') && !['', '0', 'false'].includes(values.get('erp_open')!.toLowerCase())) throw conflict('ERP已启用或开关无效，请通过ERP管理库存');
        const thresholdSource = values.get('store_stock') ?? '0';
        if (!/^(?:0|[1-9]\d*)$/.test(thresholdSource) || Number(thresholdSource) > MAX_INTEGER) throw conflict('警戒库存配置无效');
        const threshold = Number(thresholdSource);
        const [product] = await tx.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1).for('update', { noWait: true });
        if (!product) throw new NotFoundException('商品不存在');
        if (!owner(product)) throw conflict('商品归属数据无效');
        if (product.productType === 1) throw conflict('卡密库存必须由实际卡密管理');
        const allSkus = await tx.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, productId)).orderBy(asc(storeProductAttrValue.id)).limit(MAX_ROWS + 1).for('update', { noWait: true });
        if (allSkus.length > MAX_ROWS) throw new ServiceUnavailableException('商品完整规格超过10000项');
        const priorLedgers = await tx.select().from(storeProductStockRecord).where(eq(storeProductStockRecord.productId, productId)).orderBy(asc(storeProductStockRecord.id)).limit(MAX_ROWS + 1);
        if (priorLedgers.length > MAX_ROWS) throw new ServiceUnavailableException('商品库存历史超过10000项，请先使用专用历史维护');
        const plan = planAdminProductStockAdjustment(product, allSkus, adjustments), now = Math.floor(Date.now() / 1000);
        const expected = plan.expected;
        // Multiple source requests for one alias each UPDATE from the same original snapshot.
        const ledgers: Array<typeof storeProductStockRecord.$inferSelect> = [];
        for (const { before, adjustment } of plan.records) {
          const delta = adjustment.pm === 1 ? adjustment.stock : -adjustment.stock;
          const wanted = { ...before, stock: Math.max(0, before.stock + delta), sumStock: before.sumStock + delta };
          const returned = await tx.update(storeProductAttrValue).set({ stock: wanted.stock, sumStock: wanted.sumStock }).where(and(eq(storeProductAttrValue.id, before.id), eq(storeProductAttrValue.productId, productId), eq(storeProductAttrValue.type, 0))).returning();
          if (returned.length !== 1 || !same(returned[0], wanted)) throw conflict('规格库存完整写入结果不一致');
          const record = { storeId: 0, productId, unique: adjustment.unique, costPrice: before.cost, number: adjustment.stock, pm: adjustment.pm, addTime: now };
          const written = await tx.insert(storeProductStockRecord).values(record).returning();
          if (written.length !== 1 || !Number.isSafeInteger(written[0].id) || written[0].id <= 0 || Object.keys(written[0]).length !== Object.keys(record).length + 1
            || Object.entries(record).some(([key, value]) => written[0][key as keyof typeof record] !== value)) throw conflict('库存流水完整写入结果不一致');
          ledgers.push(written[0]);
        }
        // Tips uses EVERY ordinary SKU, including tombstones: target retirement
        // never silently changes the historical stock-alert source algorithm.
        const ordinary = [...expected.values()].filter(row => row.type === 0);
        const isSold = ordinary.some(row => row.stock === 0) ? 1 : 0;
        const isPolices = threshold >= plan.stock || ordinary.some(row => row.stock <= threshold) ? 1 : 0;
        const expectedProduct = { ...product, stock: plan.stock, isSold, isPolices };
        const returned = await tx.update(storeProduct).set({ stock: plan.stock, isSold, isPolices }).where(eq(storeProduct.id, productId)).returning();
        if (returned.length !== 1 || !same(returned[0], expectedProduct)) throw conflict('商品库存完整写入结果不一致');
        const auditFields = { storeId: 0, merchantId: 0, adminName: '', ip: '', adminId: actor.id, path: `product/product/saveStocks/${productId}`, page: '商品库存管理', method: 'PUT', type: 'product_stock_adjustment',
          action: JSON.stringify({ operation: 'saveStocks', productId, attrs: adjustments, stock: plan.stock, threshold }), addTime: now };
        const audits = await tx.insert(systemLog).values(auditFields).returning();
        const audit = audits[0];
        const matchesAudit = (row: typeof audit | undefined) => !!row && Number.isSafeInteger(row.id) && row.id > 0 && Object.keys(row).length === Object.keys(auditFields).length + 1
          && Object.entries(auditFields).every(([key, value]) => row[key as keyof typeof auditFields] === value);
        if (audits.length !== 1 || !matchesAudit(audit)) throw conflict('库存审计完整回执不一致');
        const intent = await enqueueProductStockEffects(tx, { productId, auditId: audit.id, warning: isPolices === 1 }, now);
        const verify = async () => {
          const [freshProduct] = await tx.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1);
          const freshSkus = await tx.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, productId)).orderBy(asc(storeProductAttrValue.id));
          const freshLedgers = await tx.select().from(storeProductStockRecord).where(eq(storeProductStockRecord.productId, productId)).orderBy(asc(storeProductStockRecord.id)).limit(MAX_ROWS + adjustments.length + 1);
          const [freshAudit] = await tx.select().from(systemLog).where(eq(systemLog.id, audit.id)).limit(1);
          const freshConfig = await tx.select().from(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, ['store_stock', 'erp_open']))).orderBy(asc(systemConfig.sort), asc(systemConfig.id));
          if (!same(freshProduct, expectedProduct) || !same(freshSkus, [...expected.values()]) || !same(freshLedgers, [...priorLedgers, ...ledgers].sort((a, b) => a.id - b.id)) || !matchesAudit(freshAudit) || !same(freshConfig, config)) throw conflict('库存完整业务或配置回读不一致');
        };
        await verify();
        const final = await loadAdminAuthorityLiveActor(tx, actor, 'product.manage');
        if (!same({ ...final, keys: [...final.keys].sort() }, { ...live, keys: [...live.keys].sort() })) throw new AuthException('管理员权限已变化', ApiErrorCode.ERR_AUTH);
        await verify(); await clock(tx, actor);
        return { stock: plan.stock > 0 ? String(plan.stock) : 0 as const, outboxId: intent.id };
      });
      if (this.effects) {
        try { await this.effects.dispatch(completed.outboxId); }
        catch { emitOperationalEvent('error', { event: 'product_stock_effects_dispatch_failed', component: 'queue', outcome: 'retry', operation: 'product_stock_adjustment', errorCode: 'dispatch_pending' }); }
      }
      return { stock: completed.stock };
    } catch (error) { return stockError(error); }
  }
}
