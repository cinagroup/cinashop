import { and, asc, eq, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { storeCart, storeProduct, storeProductAttrValue, storeProductRelation, systemAdmin, systemLog } from '@/models/schema';
import { boundBargainSourceProductChange, lockBargainSourceProductChange } from '@/services/activity/BargainSourceProductLifecycle';
import { tryLockProductWrite } from '@/services/product/ProductAssociationService';
import { ApiErrorCode, AuthException, HttpApiException, NotFoundException, ServiceUnavailableException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { assertAdminAuthoritySession, loadAdminAuthorityLiveActor, parseAdminAuthorityRoleIds, withAdminAuthorityWriteTx, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';
import { loadAdminLegacyRoleReferenceHistory } from './AdminLegacyRoleDeletionProof';
import { adminProductModerationId, normalizeAdminProductModerationInput } from './AdminProductModerationInput';

export type AdminProductModerationActor = AdminAuthorityActor;
export type AdminProductModerationFormKind = 'verify' | 'remove';
const MAX_ROWS = 10_000;
const conflict = (message: string) => new HttpApiException(message, 409, 409);
const same = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected);
const fullIdentity = (value: Awaited<ReturnType<typeof loadAdminAuthorityLiveActor>>) => ({ ...value, keys: [...value.keys].sort() });

function moneyCents(value: string): bigint {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) throw new ServiceUnavailableException('规格价格原始数据无效');
  const [integer, fraction = ''] = value.split('.');
  return BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0'));
}
async function clock(tx: DbClient, actor: AdminProductModerationActor) {
  const [result] = await tx.execute(sql`SELECT extract(epoch FROM clock_timestamp()) >= ${actor.expiresAt} AS expired`) as unknown as Array<{ expired: boolean }>;
  if (result?.expired !== false) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
  assertAdminAuthoritySession(actor);
}
function moderationError(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(conflict('商品、购物车或管理员权限正在变化，请刷新后重试'), { cause: error });
    if (['42501', '57014'].includes(code)) throw Object.assign(new ServiceUnavailableException('商品审核运行权限未就绪或超时'), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

/** Four unseeded legacy contracts use explicit target product.view/manage.
 * Each read has an independent immutable database snapshot. */
export class AdminProductModerationService {
  constructor(private readonly container: Container) {}

  private async read<T>(actor: AdminProductModerationActor, callback: (tx: DbClient) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try {
      return await withTx(this.container, async tx => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
        await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
        await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
        const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
        if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0 || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_BANNED);
        const encoder = new TextEncoder();
        if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
        await loadAdminLegacyRoleReferenceHistory(tx, parseAdminAuthorityRoleIds(live.roles), live.level);
        const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);
        if (live.level !== 0 && !hasAdminPermission(keys, 'product.view')) throw new AuthException('管理员权限已变化', ApiErrorCode.ERR_AUTH);
        const result = await callback(tx);
        await clock(tx, actor);
        return result;
      });
    } catch (error) { return moderationError(error); }
  }

  async getVerify(productId: number, actor: AdminProductModerationActor): Promise<{ verify: 0 | 1 }> {
    productId = adminProductModerationId(productId);
    return this.read(actor, async tx => {
      // Parent existence/state are not admission conditions. PHP getColumn
      // uses unordered duplicate suk overwrite; warning on EVERY physical
      // ordinary row is an explicit conservative target warning extension.
      const rows = await tx.select({ id: storeProductAttrValue.id, price: storeProductAttrValue.price, settlePrice: storeProductAttrValue.settlePrice })
        .from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, productId), eq(storeProductAttrValue.type, 0)))
        .orderBy(asc(storeProductAttrValue.id)).limit(MAX_ROWS + 1);
      if (rows.length > MAX_ROWS) throw new ServiceUnavailableException('商品完整规格超过10000项');
      return { verify: rows.some(row => moneyCents(row.settlePrice) > moneyCents(row.price)) ? 1 : 0 };
    });
  }

  async form(productId: number, kind: AdminProductModerationFormKind, actor: AdminProductModerationActor) {
    productId = adminProductModerationId(productId);
    return this.read(actor, async () => {
      const reason = (title: string, message: string) => ({ type: 'input', field: 'refusal', title, value: '',
        props: { type: 'textarea', placeholder: message, maxlength: 255 },
        validate: [{ type: 'string', trigger: 'change', message, required: true }] });
      // Source form builders never fetch the product. Submission checks it.
      const rules = kind === 'remove'
        ? [{ type: 'hidden', field: 'is_verify', value: '-2' }, reason('下架原因', '请输入下架原因')]
        : [{ type: 'radio', field: 'is_verify', title: '审核状态', value: 1,
          options: [{ value: 1, label: '通过' }, { value: -1, label: '拒绝' }],
          control: [{ value: -1, rule: [reason('拒绝原因', '请输入拒绝原因')] }] }];
      return { title: kind === 'remove' ? '强制下架' : '商品审核', action: `product/product/set_verify/${productId}`, method: 'POST', rules };
    });
  }

  async save(productId: number, body: unknown, actor: AdminProductModerationActor): Promise<void> {
    productId = adminProductModerationId(productId);
    const input = normalizeAdminProductModerationInput(body);
    try {
      await withAdminAuthorityWriteTx(this.container, actor, 'product.manage', async (tx, live) => {
        await clock(tx, actor);
        // Lifecycle admission readers take shared before their cart/product
        // work. Review takes exclusive before ANY business row lock.
        await boundBargainSourceProductChange(tx);
        await lockBargainSourceProductChange(tx, productId);
        if (!await tryLockProductWrite(tx, productId)) throw conflict('商品正在编辑，请刷新后重试');
        // Row locks in READ COMMITTED cannot cover inserted target rows.
        // These real barriers cover SKU/cart/relation phantoms and external
        // SQL writers. SHARE ROW EXCLUSIVE avoids SHARE->DML upgrade cycles,
        // at the declared cost of serializing unrelated writes for this TX.
        await tx.execute(sql`LOCK TABLE ONLY ${storeProductAttrValue}, ONLY ${storeCart}, ONLY ${storeProductRelation} IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
        const [product] = await tx.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1).for('update', { noWait: true });
        if (!product) throw new NotFoundException('商品不存在');
        const skus = await tx.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, productId))
          .orderBy(asc(storeProductAttrValue.id)).limit(MAX_ROWS + 1).for('share', { noWait: true });
        const carts = await tx.select().from(storeCart).where(eq(storeCart.productId, productId))
          .orderBy(asc(storeCart.id)).limit(MAX_ROWS + 1).for('update', { noWait: true });
        const relations = await tx.select().from(storeProductRelation).where(eq(storeProductRelation.productId, productId))
          .orderBy(asc(storeProductRelation.id)).limit(MAX_ROWS + 1).for('share', { noWait: true });
        const auditPath = `product/product/set_verify/${productId}`;
        const priorAudits = await tx.select().from(systemLog).where(eq(systemLog.path, auditPath)).orderBy(asc(systemLog.id)).limit(MAX_ROWS + 1);
        if (skus.length > MAX_ROWS || carts.length > MAX_ROWS || relations.length > MAX_ROWS || priorAudits.length > MAX_ROWS) throw new ServiceUnavailableException('商品审核完整关联或审计集合超过10000项');
        // Source has no owner/deleted/type/review/price gate. Only these four
        // fields change; no child propagation, relation rewrite or SKU edit.
        const wantedProduct = { ...product, isVerify: input.isVerify, refusal: input.refusal, isShow: input.isShow, autoOnTime: input.autoOnTime };
        const wantedCarts = carts.map(row => row.status === 1 ? { ...row, status: 0 } : row);
        const targetCarts = wantedCarts.filter((_, index) => carts[index].status === 1);
        const returnedCarts = await tx.update(storeCart).set({ status: 0 }).where(and(eq(storeCart.productId, productId), eq(storeCart.status, 1))).returning();
        if (!same(returnedCarts.sort((a, b) => a.id - b.id), targetCarts)) throw conflict('商品审核购物车完整写入结果不一致');
        const returnedProduct = await tx.update(storeProduct).set({ isVerify: input.isVerify, refusal: input.refusal, isShow: input.isShow, autoOnTime: input.autoOnTime })
          .where(eq(storeProduct.id, productId)).returning();
        if (returnedProduct.length !== 1 || !same(returnedProduct[0], wantedProduct)) throw conflict('商品审核完整写入结果不一致');
        const verifyBusiness = async () => {
          const [freshProduct] = await tx.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1);
          const freshCarts = await tx.select().from(storeCart).where(eq(storeCart.productId, productId)).orderBy(asc(storeCart.id)).limit(MAX_ROWS + 1);
          const freshSkus = await tx.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, productId)).orderBy(asc(storeProductAttrValue.id)).limit(MAX_ROWS + 1);
          const freshRelations = await tx.select().from(storeProductRelation).where(eq(storeProductRelation.productId, productId)).orderBy(asc(storeProductRelation.id)).limit(MAX_ROWS + 1);
          if (!same(freshProduct, wantedProduct) || !same(freshCarts, wantedCarts) || !same(freshSkus, skus) || !same(freshRelations, relations)) throw conflict('商品审核完整业务回读不一致');
        };
        await verifyBusiness();
        const [databaseTime] = await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`) as unknown as Array<{ now: number }>;
        const auditFields = { storeId: 0, merchantId: 0, adminName: '', ip: '', adminId: actor.id, path: auditPath, page: '商品审核', method: 'POST', type: 'product_moderation',
          action: JSON.stringify({ operation: 'set_verify', productId, is_verify: input.isVerify, refusal: input.refusal, is_show: input.isShow, auto_on_time: input.autoOnTime }), addTime: databaseTime.now };
        const audits = await tx.insert(systemLog).values(auditFields).returning(), audit = audits[0];
        const matchesAudit = (row: typeof audit | undefined) => !!row && Number.isSafeInteger(row.id) && row.id > 0 && Object.keys(row).length === Object.keys(auditFields).length + 1
          && Object.entries(auditFields).every(([key, value]) => row[key as keyof typeof auditFields] === value);
        if (audits.length !== 1 || !matchesAudit(audit)) throw conflict('商品审核完整审计回执不一致');
        const verifyAudit = async () => {
          const freshAudits = await tx.select().from(systemLog).where(eq(systemLog.path, auditPath)).orderBy(asc(systemLog.id)).limit(MAX_ROWS + 2);
          const expectedAudits = [...priorAudits, audit].sort((a, b) => a.id - b.id);
          if (!same(freshAudits, expectedAudits)) throw conflict('商品审核完整审计集合回读不一致');
        };
        await verifyAudit();
        await verifyBusiness();
        const final = await loadAdminAuthorityLiveActor(tx, actor, 'product.manage');
        if (!same(fullIdentity(final), fullIdentity(live))) throw new AuthException('管理员权限已变化', ApiErrorCode.ERR_AUTH);
        await verifyBusiness();
        await verifyAudit();
        await clock(tx, actor);
      });
    } catch (error) { return moderationError(error); }
  }
}
