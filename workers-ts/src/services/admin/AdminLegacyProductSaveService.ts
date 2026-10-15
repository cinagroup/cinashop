import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrValue, storeProductAttrResult, storeProductDescription, storeProductRelation,
  storeProductCategory, storeProductLabel, storeProductEnsure, storeProductSpecs, storeBrand, legacyCategory,
  storeProductCoupon, storeCouponIssue, storeCart, storeDiscountsProducts, storeSeckill, storeCombination, storeBargain, storeIntegral,
  systemSupplier, systemStore, shippingTemplates, systemForm, userLabel, systemConfig, systemAttachment, systemLog, storeOrderOutbox } from '@/models/schema';
import { ProductAssociationService, tryLockProductWrite } from '@/services/product/ProductAssociationService';
import { PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE } from '@/services/product/ProductSkuIdentity';
import { lockProductUnitLifecycle } from '@/services/product/ProductUnitLifecycle';
import { VirtualProductInventoryService, tryLockVirtualProductInventory } from '@/services/product/VirtualProductInventoryService';
import { tryLockProductCoupon } from '@/services/activity/ProductCouponService';
import { boundBargainSourceProductChange, lockBargainSourceProductChange } from '@/services/activity/BargainSourceProductLifecycle';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { canonicalizePublishedAttachmentReference, canonicalizePublishedHtmlAttachmentReferences } from '@/services/content/ArticleContentPolicy';
import { ERP_CONFIG_LOCK } from '@/services/erp/ErpConnectionPolicy';
import { enqueueProductSaveEffects } from '@/services/product/ProductSaveEffects';
import { ApiErrorCode, AuthException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { normalizeConfigScalar } from '@/utils/config';
import { emitOperationalEvent } from '@/utils/observability';
import { assertAdminAuthoritySession, loadAdminAuthorityLiveActor, withAdminAuthorityWriteTx, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { normalizeAdminLegacyProductInput, resolveAdminLegacyProductOwner, type AdminLegacyProductInput } from './AdminLegacyProductInput';
import { assertProductSaveSame, lockProductSaveTables, lockProductSaveRows, productSaveConflict, productSaveDefaults,
  productSaveSame, productSaveWatermarks, readProductSaveState, emptyProductSaveState, MAX_PRODUCT_SAVE_ROWS } from './AdminLegacyProductSaveState';
import { verifyProductSavePlan, expectedProductSaveMain } from './AdminLegacyProductSaveProof';
import { admitProductEditorSave, completeProductEditorSave, type ProductEditorIntent } from './AdminProductEditorReceipt';
import { admitProductCopy } from './AdminProductCopy';
import { authorizeAdminLegacyProductRead } from './AdminLegacyProductReadAuthority';

export interface AdminLegacyProductSaveEffects { dispatch(outboxId: number): Promise<void> }
export interface AdminLegacyProductSaveContext { localCopy?: boolean; editorOperation?: ProductEditorIntent }
function id(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw new ValidateException('商品ID错误');
  return value;
}
async function dbClock(tx: DbClient, actor: AdminAuthorityActor): Promise<number> {
  assertAdminAuthoritySession(actor);
  const [clock] = await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::bigint::text AS now,
    extract(epoch FROM clock_timestamp())>=${actor.expiresAt} AS expired`) as unknown as Array<{ now: string; expired: boolean }>;
  const now = Number(clock?.now);
  if (clock?.expired !== false || !Number.isSafeInteger(now) || now < 0 || now > 2_147_483_647)
    throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
  return now;
}
function saveError(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(productSaveConflict(), { cause: error });
    if (['42501', '57014', '42P01', '42703', '23514'].includes(code))
      throw Object.assign(new ServiceUnavailableException('商品完整保存运行权限或迁移未就绪，请稍后重试'), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}
function spu(): string { return [...crypto.getRandomValues(new Uint8Array(13))].map(value => value % 10).join(''); }

async function canonicalizeMedia(tx: DbClient, input: AdminLegacyProductInput, owner: { type: number; relationId: number }): Promise<void> {
  const privateImages: string[] = [];
  const picture = (value: string): string => {
    const canonical = canonicalizePublishedAttachmentReference(value);
    if (canonical.startsWith('/api/assets/')) privateImages.push(canonical);
    return canonical;
  };
  const sliders = (input.normalized.slider_image as string[]).map(picture);
  input.productValues.image = sliders[0]; input.normalized.image = sliders[0];
  input.normalized.slider_image = sliders; input.productValues.sliderImage = JSON.stringify(sliders);
  input.productValues.recommendImage = picture(input.productValues.recommendImage ?? '');
  (input.normalized.attrs as Array<Record<string, unknown>>).forEach((row, index) => {
    row.image = picture(String(row.image)); input.skuPayload.skus[index].image = String(row.image);
  });
  input.description = canonicalizePublishedHtmlAttachmentReferences(input.description, reference => { privateImages.push(reference); });
  if (privateImages.length) {
    const mediaOwner = owner.type === 1 ? { type: 0, relationId: 0 } : owner;
    const allowed = await publicProductPictures(tx, privateImages.map(image => ({ image, ...mediaOwner })));
    if (allowed.some((value, index) => value !== privateImages[index])) throw new ValidateException('商品包含不存在或不属于当前归属的私有图片');
  }
}

/** Complete write coordinator. No network/provider work or DDL occurs in the
 * transaction. Route integration must use the strict body reader separately. */
export class AdminLegacyProductSaveService {
  constructor(private readonly container: Container, private readonly effects?: AdminLegacyProductSaveEffects, private readonly appKey?: string) {}

  async save(requestedId: number, body: unknown, actor: AdminAuthorityActor, context: AdminLegacyProductSaveContext = {}) {
    id(requestedId);
    try {
      const completed = await withAdminAuthorityWriteTx(this.container, actor, 'product.manage', async (tx, live) => {
        const previous = context.editorOperation && await admitProductEditorSave(tx, context.editorOperation, requestedId, actor);
        if (previous) return { id: previous.result!.id, committed: true as const, outboxId: null,
          receipt: previous, message: '商品操作已完成' };
        const copy = context.editorOperation?.copy;
        if (copy && requestedId !== 0) throw new ValidateException('复制只能新建商品');
        if (copy) await authorizeAdminLegacyProductRead(tx, actor);
        const now = await dbClock(tx, actor);
        await lockProductUnitLifecycle(tx);
        // Candidate discovery precedes bargain/cart/product locks. The real
        // table barrier below closes both source-link and child-set phantoms.
        const source = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
        const sourceLink = context.localCopy || copy ? '' : typeof source.soure_link === 'string' ? source.soure_link.trim() : '';
        const candidates = async () => requestedId ? tx.select().from(storeProduct).where(eq(storeProduct.id, requestedId)).limit(2)
          : sourceLink ? tx.select().from(storeProduct).where(and(eq(storeProduct.soureLink, sourceLink), eq(storeProduct.isDel, 0))).orderBy(asc(storeProduct.id)).limit(2) : [];
        const initial = await candidates();
        if (initial.length > 1) throw productSaveConflict('采集链接对应多个历史商品，请先核对');
        if (requestedId && !initial[0]) throw new ValidateException('商品不存在');
        const existing = initial[0], productId = existing?.id ?? 0;
        if (productId) {
          await boundBargainSourceProductChange(tx); await lockBargainSourceProductChange(tx, productId);
          if (!await tryLockProductWrite(tx, productId) || !await tryLockVirtualProductInventory(tx, productId)
            || !await tryLockProductCoupon(tx, productId)) throw productSaveConflict();
        }
        const [identity] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE},0) AS locked`) as unknown as Array<{ locked: boolean }>;
        const [erp] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock_shared(${ERP_CONFIG_LOCK},0) AS locked`) as unknown as Array<{ locked: boolean }>;
        const [commerce] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext('admin-commerce-settings')) AS locked`) as unknown as Array<{ locked: boolean }>;
        if (!identity?.locked || !erp?.locked || !commerce?.locked) throw productSaveConflict('商品规格或商城配置正在变化，请刷新后重试');
        await tx.execute(sql`LOCK TABLE ${systemConfig}, ${systemSupplier}, ${shippingTemplates}, ${systemForm}, ${userLabel},
          ${storeProductCategory}, ${storeBrand}, ${storeProductLabel}, ${storeProductEnsure}, ${legacyCategory}, ${storeProductSpecs},
          ${storeCouponIssue}, ${systemAttachment} IN SHARE MODE NOWAIT`);
        if (copy) await tx.execute(sql`LOCK TABLE ONLY ${systemStore} IN SHARE MODE NOWAIT`);
        await lockProductSaveTables(tx);
        await tx.execute(sql`LOCK TABLE ONLY ${systemLog}, ONLY ${storeOrderOutbox} IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
        assertProductSaveSame(await candidates(), initial, '候选');
        if (productId) await lockProductSaveRows(tx, productId);
        const copySource = copy ? await admitProductCopy(tx, copy, this.appKey) : undefined;
        const config = await tx.select().from(systemConfig).where(and(eq(systemConfig.isStore, 0),
          inArray(systemConfig.menuName, ['erp_open', 'store_stock', 'site_url']))).orderBy(asc(systemConfig.id));
        if (new Set(config.map(row => row.menuName)).size !== config.length) throw productSaveConflict('商品配置存在重复键，请先核对');
        const settings = new Map(config.map(row => [row.menuName, normalizeConfigScalar(row.value)]));
        const erpValue = (settings.get('erp_open') ?? '0').toLowerCase(), thresholdValue = settings.get('store_stock') ?? '0';
        if (!['', '0', 'false', '1', 'true'].includes(erpValue) || !/^(?:0|[1-9]\d*)$/.test(thresholdValue)
          || Number(thresholdValue) > 2_147_483_647) throw productSaveConflict('商品库存配置无效');
        const threshold = Number(thresholdValue);
        const input = normalizeAdminLegacyProductInput(body, { now, localCopy: context.localCopy || !!copy,
          erpOpen: ['1', 'true'].includes(erpValue), siteUrl: settings.get('site_url') });
        if (input.copyMode === -1) throw new ValidateException('采集图片处理尚未接入，请先使用本地图文素材保存');
        // Ordinary editing cannot replace trusted import provenance via its
        // intentionally blank source-context fields.
        if (context.editorOperation && existing) input.productValues.soureLink = existing.soureLink;
        if (input.productValues.isShow === 2) throw new ValidateException('定时上架必须填写有效上架时间');
        if (existing?.isDel === 1 && input.productValues.isShow !== 0) throw new ValidateException('回收站商品不能直接上架');
        if (copySource && (input.productType !== copySource.productType
          || input.supplierId !== (copySource.type === 2 ? copySource.relationId : 0)))
          throw new ValidateException('复制不能改变来源商品归属或履约类型');
        const owner = copySource ? { type: copySource.type, relationId: copySource.relationId }
          : resolveAdminLegacyProductOwner(input, existing);
        if (![0, 1, 2].includes(owner.type) || owner.type === 0 && owner.relationId !== 0 || owner.type !== 0 && owner.relationId <= 0)
          throw new ValidateException('商品历史归属无效');
        if (input.supplierId && (!existing || existing.type === 0)) {
          const [supplier] = await tx.select().from(systemSupplier).where(eq(systemSupplier.id, input.supplierId)).limit(1);
          if (!supplier || supplier.isDel !== 0) throw new ValidateException('供应商不存在或已删除');
        }
        if (input.productValues.tempId) {
          const [template] = await tx.select().from(shippingTemplates).where(eq(shippingTemplates.id, input.productValues.tempId)).limit(1);
          if (!template || template.isDel !== 0 || !(template.ownerType === 0 && template.relationId === 0
            || template.ownerType === owner.type && template.relationId === owner.relationId)) throw new ValidateException('运费模板不存在或不属于当前商品');
        }
        if (input.productValues.systemFormId) {
          const [form] = await tx.select().from(systemForm).where(eq(systemForm.id, input.productValues.systemFormId)).limit(1);
          if (!form || (form.isDel !== 0 || form.status !== 1) && existing?.systemFormId !== form.id) throw new ValidateException('系统表单不存在或已停用');
        }
        const userLabelIds = input.normalized.label_id as number[];
        if (context.editorOperation) input.productValues.labelId = userLabelIds.join(',');
        const labels = userLabelIds.length ? await tx.select().from(userLabel).where(inArray(userLabel.id, userLabelIds)) : [];
        if (labels.length !== userLabelIds.length || labels.some(row => !(row.type === 0 && row.relationId === 0
          || row.type === owner.type && row.relationId === owner.relationId))) throw new ValidateException('用户标签不存在或不属于当前商品');
        await canonicalizeMedia(tx, input, owner);
        const before = productId ? await readProductSaveState(tx, productId) : emptyProductSaveState();
        const watermarks = await productSaveWatermarks(tx);
        if (input.productType === 1) for (const sku of before.skus.filter(row => row.type === 0 && row.isRetired === 0 && !row.diskInfo?.trim())) {
          const available = before.cards.filter(card => card.attrUnique === sku.unique && card.uid === 0).length;
          if (sku.stock !== available) throw productSaveConflict('卡密库存与实际未分配卡密数量不一致，请先核对');
        }
        const baselineAttrs = (input.normalized.attrs as Array<Record<string, unknown>>).map((row, index) => ({ ...row,
          ...(input.productType === 1 && !input.skuPayload.skus[index].diskInfo ? {
            stock: before.skus.find(old => old.type === 0 && old.isRetired === 0 && old.suk === input.skuPayload.skus[index].suk)?.diskInfo?.trim()
              ? 0 : before.skus.find(old => old.type === 0 && old.isRetired === 0 && old.suk === input.skuPayload.skus[index].suk)?.stock ?? 0,
          } : {}),
        }));
        const verifiedState = input.supplierId ? undefined : 1 as const;
        const creation = { star: '5.0', spu: spu() };
        const saved = await new ProductAssociationService(createContainerFromDb(tx)).saveInTransaction(tx, productId,
          { ...input.normalized, attrs: baselineAttrs }, { id: actor.id, name: '', ip: '' }, {
            now, locks: 'already-held', audit: 'outer', legacy: { owner, mainValues: input.productValues,
              verifiedState, creation, deliveryPolicy: 'legacy', allowHiddenDeleted: true,
              relationPolicy: context.editorOperation ? 'replace-all' : 'preserve-empty' },
          });
        const actualId = saved.id;
        if (context.editorOperation) await tx.update(storeProduct).set({ labelId: userLabelIds.join(',') })
          .where(eq(storeProduct.id, actualId));
        const inventory = new VirtualProductInventoryService(createContainerFromDb(tx));
        for (const item of input.cardImports) {
          const sku = saved.assignedSkuRows.find(row => row.suk === item.suk);
          if (!sku) throw productSaveConflict('商品卡密规格映射不一致');
          await inventory.importCardsInTransaction(tx, { kind: 'admin' }, actualId, { attr_unique: sku.unique, cards: item.cards },
            { now, allowHiddenDeleted: true });
        }
        await tx.delete(storeProductDescription).where(and(eq(storeProductDescription.productId, actualId), eq(storeProductDescription.type, 0)));
        await tx.insert(storeProductDescription).values({ productId: actualId, type: 0, description: input.description });
        // Preserve source nonempty-only async replacement semantics, but commit
        // the verified relations/coupons synchronously with the full save.
        if (userLabelIds.length || context.editorOperation) {
          await tx.delete(storeProductRelation).where(and(eq(storeProductRelation.productId, actualId), eq(storeProductRelation.type, 4)));
          if (userLabelIds.length) await tx.insert(storeProductRelation).values(userLabelIds.map(relationId => ({ productId: actualId, type: 4, relationId,
            relationPid: 0, status: 1, addTime: now })));
        }
        const couponIds = input.normalized.coupon_ids as number[];
        const issues = couponIds.length ? await tx.select().from(storeCouponIssue).where(and(inArray(storeCouponIssue.id, couponIds), eq(storeCouponIssue.isDel, 0))) : [];
        if (issues.length !== couponIds.length) throw new ValidateException('部分赠送优惠券不存在');
        if (couponIds.length || context.editorOperation) {
          await tx.delete(storeProductCoupon).where(eq(storeProductCoupon.productId, actualId));
          if (issues.length) await tx.insert(storeProductCoupon).values(issues.map(issue => ({ productId: actualId, issueCouponId: issue.id,
            title: issue.couponTitle || issue.title, addTime: now })));
        }
        if (existing) {
          const cartStatus = existing.type === 1 && existing.pid === 0 && verifiedState !== 1 ? 0 : input.productValues.isShow!;
          await tx.update(storeCart).set({ status: cartStatus }).where(eq(storeCart.productId, actualId));
          await tx.update(storeDiscountsProducts).set({ tempId: input.productValues.tempId! }).where(eq(storeDiscountsProducts.productId, actualId));
        }
        if (owner.type === 2) for (const table of [storeSeckill, storeCombination, storeBargain, storeIntegral])
          await tx.update(table).set({ type: 2, relationId: owner.relationId }).where(eq(table.productId, actualId));
        const finalSkus = await tx.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, actualId)).orderBy(asc(storeProductAttrValue.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1);
        if (finalSkus.length > MAX_PRODUCT_SAVE_ROWS) throw new ServiceUnavailableException('商品完整规格超过10000项容量');
        const ordinary = finalSkus.filter(row => row.type === 0), active = ordinary.filter(row => row.isRetired === 0);
        const stock = active.reduce((sum, row) => sum + row.stock, 0);
        if (!Number.isSafeInteger(stock) || stock > 2_147_483_647) throw new ValidateException('商品总库存超出存储范围');
        const isSold = ordinary.some(row => row.stock === 0) ? 1 : 0;
        const isPolices = threshold >= stock || ordinary.some(row => row.stock <= threshold) ? 1 : 0;
        await tx.update(storeProduct).set({ stock, isSold, isPolices }).where(eq(storeProduct.id, actualId));
        const snapshotRows = saved.assignedSkuRows.map(row => {
          const final = active.find(sku => sku.suk === row.suk);
          if (!final) throw productSaveConflict('商品规格快照不完整');
          return { ...row, stock: final.stock, sumStock: final.sumStock };
        });
        await tx.update(storeProductAttrResult).set({ result: JSON.stringify({ attr: input.skuPayload.dimensions, value: snapshotRows }) })
          .where(and(eq(storeProductAttrResult.productId, actualId), eq(storeProductAttrResult.type, 0)));
        const categories = await tx.select().from(storeProductCategory).where(inArray(storeProductCategory.id, input.normalized.cate_id as number[]));
        const expectedMain = expectedProductSaveMain(input, existing, actualId, owner, verifiedState, creation, now, stock, isSold, isPolices);
        const verify = async () => {
          if (copy) await admitProductCopy(tx, copy, this.appKey);
          const [main] = await tx.select().from(storeProduct).where(eq(storeProduct.id, actualId)).limit(1);
          assertProductSaveSame(main, expectedMain, '主表');
          verifyProductSavePlan({ input, existing, before, after: await readProductSaveState(tx, actualId), actualId, owner,
            now, watermarks, baselineAttrs, assigned: saved.assignedSkuRows, categories, issues, snapshotRows, verifiedState,
            replaceEmpty: !!context.editorOperation });
          assertProductSaveSame(await tx.select().from(systemConfig).where(and(eq(systemConfig.isStore, 0),
            inArray(systemConfig.menuName, ['erp_open', 'store_stock', 'site_url']))).orderBy(asc(systemConfig.id)), config, '配置');
        };
        await verify();
        const auditPath = `product/product/${requestedId}`;
        const auditBefore = await tx.select().from(systemLog).where(and(eq(systemLog.path, auditPath), eq(systemLog.type, 'product_save'))).orderBy(asc(systemLog.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1);
        const outboxBefore = await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateType, 'product'), eq(storeOrderOutbox.aggregateId, actualId))).orderBy(asc(storeOrderOutbox.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1);
        if (auditBefore.length > MAX_PRODUCT_SAVE_ROWS || outboxBefore.length > MAX_PRODUCT_SAVE_ROWS) throw new ServiceUnavailableException('商品审计或事件集合超过完整容量');
        const auditExpected = { ...productSaveDefaults(systemLog), adminId: actor.id, path: auditPath, page: '商品完整保存', method: 'POST', type: 'product_save', addTime: now,
          action: JSON.stringify({ operation: 'save', productId: actualId, requestedId, warning: isPolices === 1,
            copied: input.localCopy, ...(copy ? { source_id: copy.sourceId } : {}),
            sourceLinkResolved: requestedId === 0 && !!existing, skuCount: active.length }) };
        const insertedAudit = await tx.insert(systemLog).values(auditExpected as typeof systemLog.$inferInsert).returning();
        if (insertedAudit.length !== 1 || !Number.isInteger(insertedAudit[0].id) || insertedAudit[0].id <= 0)
          throw productSaveConflict('商品审计回执不完整');
        assertProductSaveSame(insertedAudit[0], { id: insertedAudit[0].id, ...auditExpected }, '审计回执');
        const outbox = await enqueueProductSaveEffects(tx, { productId: actualId, requestedId, auditId: insertedAudit[0].id, warning: isPolices === 1 }, now);
        const finalLive = await loadAdminAuthorityLiveActor(tx, actor, 'product.manage');
        const authority = (value: typeof live) => ({ ...value, keys: [...value.keys].sort() });
        if (!productSaveSame(authority(live), authority(finalLive))) throw new AuthException('管理员权限已变化', ApiErrorCode.ERR_AUTH);
        await verify();
        assertProductSaveSame(await tx.select().from(systemLog).where(and(eq(systemLog.path, auditPath), eq(systemLog.type, 'product_save'))).orderBy(asc(systemLog.id)),
          [...auditBefore, insertedAudit[0]].sort((a, b) => a.id - b.id), '审计');
        assertProductSaveSame(await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateType, 'product'), eq(storeOrderOutbox.aggregateId, actualId))).orderBy(asc(storeOrderOutbox.id)),
          [...outboxBefore, outbox].sort((a, b) => a.id - b.id), '事件');
        await dbClock(tx, actor);
        const receipt = context.editorOperation ? await completeProductEditorSave(tx, context.editorOperation,
          { id: actualId, created: requestedId === 0 }, actor) : undefined;
        return { id: actualId, committed: true as const, outboxId: outbox.id,
          receipt,
          message: requestedId ? '保存商品信息成功' : '添加商品成功!' };
      });
      if (this.effects && completed.outboxId !== null) try { await this.effects.dispatch(completed.outboxId); }
      catch { emitOperationalEvent('error', { event: 'product_save_effects_dispatch_failed', component: 'queue', outcome: 'retry', operation: 'product_save', errorCode: 'dispatch_pending' }); }
      return completed;
    } catch (error) { return saveError(error); }
  }
}
