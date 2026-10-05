import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {lockShippingTemplateBindings} from './ShippingTemplateLifecycleService';
import {storeCart,storeBrand,storeCouponIssue,storeProduct,storeProductAttrValue,storeProductCategory,storeProductCoupon,storeProductLabel,storeProductRelation,storeProductStockRecord,systemForm,userLabel} from '@/models/schema';
import {lockProductWrite} from './ProductAssociationService';
import {HttpApiException,NotFoundException,ValidateException} from '@/utils/errors';
import {outRequestHash} from '@/services/out/OutIdempotency';
import type {AdminProductBatchInput,AdminProductSkuUpdate} from '@/services/admin/AdminMobileProductService';
const PRODUCT_CATEGORY_RELATION=1,PRODUCT_BRAND_RELATION=2,PRODUCT_LABEL_RELATION=3,PRODUCT_USER_LABEL_RELATION=4;
export interface MobileProductCoreOptions {catalogLocked?:boolean;customerStockPolicy?:boolean;expectedBaseSkus?:readonly(typeof storeProductAttrValue.$inferSelect)[];expectedTopology?:readonly{productId:number;skus:readonly(typeof storeProductAttrValue.$inferSelect)[];relations:readonly(typeof storeProductRelation.$inferSelect)[]}[]}
export interface MobileProductAuditEvent {operation:'show'|'hide'|'category'|'label'|'delivery'|'reward'|'user_label'|'recommend'|'form'|'freight'|'brand'|'sku';productIds:number[];evidenceValues:readonly(number|string)[];now:number}
export type MobileProductAudit=(tx:DbClient,event:MobileProductAuditEvent)=>Promise<void>;
async function assertAuthorizedTopology(tx:DbClient,options:MobileProductCoreOptions){for(const expected of options.expectedTopology??[]){const[skus,relations]=await Promise.all([tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId,expected.productId),eq(storeProductAttrValue.type,0))).orderBy(asc(storeProductAttrValue.id)),tx.select().from(storeProductRelation).where(eq(storeProductRelation.productId,expected.productId)).orderBy(asc(storeProductRelation.id))]);if(await outRequestHash({skus,relations})!==await outRequestHash({skus:expected.skus,relations:expected.relations}))throw new HttpApiException('商品规格或关联拓扑在授权后变化，请重新读取',412,412);}}
async function inventoryLock<T>(read: () => PromiseLike<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
      if ("code" in cause && cause.code === "55P03") {
        throw new ValidateException("商品或购物车正在变化，请刷新后重试");
      }
      cause = "cause" in cause ? cause.cause : undefined;
    }
    throw error;
  }
}
export async function applyMobileProductShow(tx: DbClient, input: {ids:number[];isShow:number}, audit: MobileProductAudit, options:MobileProductCoreOptions={}):Promise<{changed:number;verified:true}> {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      for (const productId of input.ids) await lockProductWrite(tx, productId);
      const products = await inventoryLock(() => tx.select({
        id: storeProduct.id,
        isDel: storeProduct.isDel,
        isVerify: storeProduct.isVerify,
      }).from(storeProduct).where(inArray(storeProduct.id, input.ids)).orderBy(asc(storeProduct.id)).for("update", { noWait: true }));
      if (products.length !== input.ids.length) throw new NotFoundException("商品不存在");
      if (products.some((product) => product.isDel === 1)) {
        throw new ValidateException("回收站商品不能修改上下架状态");
      }
      if (input.isShow === 1 && products.some((product) => product.isVerify !== 1)) {
        throw new ValidateException("商品尚未审核通过");
      }
      await assertAuthorizedTopology(tx,options);
      await tx.update(storeProduct).set(input.isShow === 1
        ? { isShow: 1, autoOffTime: 0 }
        : { isShow: 0 }).where(inArray(storeProduct.id, input.ids));
      // One statement uses the same locked candidate set for the update. Do not
      // fetch an unbounded cart ID list into a Worker, skip busy carts, or perform
      // a separate UPDATE that can discover a newly committed, unlocked row.
      await inventoryLock(() => tx.execute(sql`
        WITH locked_carts AS MATERIALIZED (
          SELECT ${storeCart.id} FROM ${storeCart}
          WHERE ${and(inArray(storeCart.productId, input.ids), eq(storeCart.isPay, 0), eq(storeCart.isDel, 0))}
          ORDER BY ${storeCart.id} FOR UPDATE NOWAIT
        )
        UPDATE ${storeCart} SET status = ${input.isShow}
        FROM locked_carts WHERE ${storeCart.id} = locked_carts.id
      `));
      await tx.update(storeProductRelation).set({ status: input.isShow }).where(and(
        inArray(storeProductRelation.productId, input.ids),
        eq(storeProductRelation.type, PRODUCT_CATEGORY_RELATION),
      ));
      const [savedProducts, badCarts, badRelations] = await Promise.all([
        tx.select({
          id: storeProduct.id,
          isShow: storeProduct.isShow,
          autoOffTime: storeProduct.autoOffTime,
        }).from(storeProduct).where(inArray(storeProduct.id, input.ids)),
        tx.select({ id: storeCart.id }).from(storeCart).where(and(
          inArray(storeCart.productId, input.ids),
          eq(storeCart.isPay, 0),
          eq(storeCart.isDel, 0),
          sql`${storeCart.status} <> ${input.isShow}`,
        )).limit(1),
        tx.select({ id: storeProductRelation.id }).from(storeProductRelation).where(and(
          inArray(storeProductRelation.productId, input.ids),
          eq(storeProductRelation.type, PRODUCT_CATEGORY_RELATION),
          sql`${storeProductRelation.status} <> ${input.isShow}`,
        )).limit(1),
      ]);
      if (
        savedProducts.length !== input.ids.length
        || savedProducts.some((product) => (
          product.isShow !== input.isShow
          || (input.isShow === 1 && product.autoOffTime !== 0)
        ))
        || badCarts[0]
        || badRelations[0]
      ) throw new Error("商品批量上下架数据库回读校验失败");
      await audit(tx, { operation: input.isShow === 1 ? "show" : "hide", productIds: input.ids, evidenceValues: [], now: Math.floor(Date.now() / 1000) });
      return { changed: input.ids.length, verified: true };
    }
export async function applyMobileProductSkus(tx: DbClient, productId: number, updates: AdminProductSkuUpdate[], audit: MobileProductAudit, options: MobileProductCoreOptions = {}):Promise<{changed:number}> {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      await lockProductWrite(tx, productId);
      const product = (await inventoryLock(() => tx.select().from(storeProduct).where(and(
        eq(storeProduct.id, productId),
        eq(storeProduct.isDel, 0),
      )).for("update", { noWait: true }).limit(1)))[0];
      if (!product) throw new NotFoundException("商品不存在");
      await assertAuthorizedTopology(tx,options);
      const current = await inventoryLock(() => tx.select().from(storeProductAttrValue).where(and(
        eq(storeProductAttrValue.productId, productId),
        eq(storeProductAttrValue.type, 0),
        eq(storeProductAttrValue.isRetired, 0),
      )).orderBy(storeProductAttrValue.id).for("update", { noWait: true }));
      if (!current.length) throw new NotFoundException("商品规格不存在");
      if(options.expectedBaseSkus){const allBase=await tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId,productId),eq(storeProductAttrValue.type,0))).orderBy(asc(storeProductAttrValue.id));if(await outRequestHash(allBase)!==await outRequestHash(options.expectedBaseSkus))throw new HttpApiException('商品规格拓扑在授权后发生变化，请重新读取',412,412);}
      if (options.customerStockPolicy && current.some(row => !Number.isSafeInteger(row.stock) || row.stock < 0 || row.stock > 2147483647 || !Number.isSafeInteger(row.sumStock) || row.sumStock < 0 || !Number.isSafeInteger(row.sales) || row.sales < 0 || [row.price,row.cost,row.otPrice].some(value=>!/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(value)))) throw new ValidateException('当前规格库存或金额无效，请先修复原始数据');
      if (options.customerStockPolicy && (product.specType === 0 && current.length !== 1 || new Set(current.map(r=>r.unique)).size !== current.length || new Set(current.map(r=>r.suk)).size !== current.length || current.some(r=>!r.unique||r.unique!==r.unique.trim()||r.unique.length>8||/[\u0000-\u001f\u007f]/.test(r.unique)))) throw new ValidateException('商品规格身份不唯一，请先修复规格');
      const currentByUnique = new Map(current.map((item) => [item.unique, item]));
      if (updates.some((item) => !currentByUnique.has(item.unique))) {
        throw new ValidateException("规格不属于当前商品");
      }
      if(options.customerStockPolicy && product.productType === 1 && updates.some(u=>{const row=currentByUnique.get(u.unique)!;return !row.diskInfo && u.stock!==row.stock;}))throw new ValidateException('库存由实际卡密管理，快捷编辑只能修改价格');
      const updatesByUnique = new Map(updates.map((item) => [item.unique, item]));
      const finalRows = current.map((item) => ({
        ...item,
        ...(updatesByUnique.get(item.unique) ?? {}),
      }));
      const aggregateStock = finalRows.reduce((total, item) => total + Number(item.stock), 0);
      if (!Number.isSafeInteger(aggregateStock) || aggregateStock > 2_147_483_647) {
        throw new ValidateException("商品总库存超出允许范围");
      }
      const now = Math.floor(Date.now() / 1000);
      const stockRecords: Array<typeof storeProductStockRecord.$inferInsert> = [];
      for (const update of updates) {
        const previous = currentByUnique.get(update.unique)!;
        await tx.update(storeProductAttrValue).set({
          price: update.price,
          cost: update.cost,
          otPrice: update.otPrice,
          stock: update.stock,
          sumStock: options.customerStockPolicy && product.productType === 1 && !previous.diskInfo ? previous.sumStock : update.stock,
        }).where(and(
          eq(storeProductAttrValue.id, previous.id),
          eq(storeProductAttrValue.productId, productId),
          eq(storeProductAttrValue.type, 0),
          eq(storeProductAttrValue.isRetired, 0),
        ));
        const difference = update.stock - previous.stock;
        if (difference !== 0) stockRecords.push({
          storeId: product.type === 1 ? product.relationId : 0,
          productId,
          unique: update.unique,
          costPrice: update.cost,
          number: Math.abs(difference),
          pm: difference > 0 ? 1 : 0,
          addTime: now,
        });
      }
      await tx.update(storeProduct).set({
        stock: aggregateStock,
        price: Math.max(...finalRows.map((item) => Number(item.price))).toFixed(2),
        cost: Math.max(...finalRows.map((item) => Number(item.cost))).toFixed(2),
        otPrice: Math.max(...finalRows.map((item) => Number(item.otPrice))).toFixed(2),
      }).where(eq(storeProduct.id, productId));
      if (stockRecords.length) await tx.insert(storeProductStockRecord).values(stockRecords);
      const saved = await tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId,productId),eq(storeProductAttrValue.type,0),eq(storeProductAttrValue.isRetired,0))).orderBy(storeProductAttrValue.id);
      const [savedProduct] = await tx.select().from(storeProduct).where(eq(storeProduct.id,productId));
      if(saved.length!==current.length || !savedProduct || savedProduct.stock!==aggregateStock || (['price','cost','otPrice'] as const).some(k=>savedProduct[k]!==Math.max(...finalRows.map(r=>Number(r[k]))).toFixed(2)) || saved.some(row=>{const before=current.find(r=>r.id===row.id),update=updatesByUnique.get(row.unique);return !before||row.unique!==before.unique||row.suk!==before.suk||row.sales!==before.sales|| (update ? row.stock!==update.stock||row.price!==update.price||row.cost!==update.cost||row.otPrice!==update.otPrice||row.sumStock!==(options.customerStockPolicy&&product.productType===1&&!before.diskInfo?before.sumStock:update.stock) : row.stock!==before.stock||row.price!==before.price||row.cost!==before.cost||row.otPrice!==before.otPrice||row.sumStock!==before.sumStock);}))throw Error('商品规格数据库回读校验失败');
      await audit(tx,{operation:'sku',productIds:[productId],evidenceValues:updates.map(u=>u.unique),now});
      return { changed: updates.length };
    }
export async function applyMobileProductBatch(tx: DbClient, input: AdminProductBatchInput, audit: MobileProductAudit, options: MobileProductCoreOptions = {}):Promise<{changed:number;relations:number;verified:true}> {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      for (const productId of input.ids) await lockProductWrite(tx, productId);
      const products = await inventoryLock(() => tx.select({
        id: storeProduct.id,
        isShow: storeProduct.isShow,
        type: storeProduct.type,
        relationId: storeProduct.relationId,
      }).from(storeProduct).where(and(
        inArray(storeProduct.id, input.ids),
        eq(storeProduct.isDel, 0),
      )).orderBy(asc(storeProduct.id)).for("update", { noWait: true }));
      if (products.length !== input.ids.length) throw new NotFoundException("商品不存在或已删除");
      await assertAuthorizedTopology(tx,options);
      const productById = new Map(products.map((product) => [product.id, product]));
      const now = Math.floor(Date.now() / 1000);
      const categoryById = new Map<number, { id: number; pid: number }>();
      let relationType = 0;
      let relationIds: number[] = [];
      let couponIds: number[] = [];
      let evidenceValues: Array<number | string> = [];
      let operation: Exclude<MobileProductAuditEvent['operation'], 'sku'>;

      if (input.type === 1) {
        operation = "category";
        relationType = PRODUCT_CATEGORY_RELATION;
        relationIds = input.relationIds;
        evidenceValues = relationIds;
        const categoryQuery = tx.select({
          id: storeProductCategory.id,
          pid: storeProductCategory.pid,
        }).from(storeProductCategory).where(and(
          inArray(storeProductCategory.id, input.relationIds),
          eq(storeProductCategory.type, 0),
          eq(storeProductCategory.relationId, 0),
          eq(storeProductCategory.isShow, 1),
        )).$dynamic();
        const categories = await (options.catalogLocked ? categoryQuery : categoryQuery.for('share'));
        if (categories.length !== input.relationIds.length) throw new ValidateException("分类不存在或不可用");
        for (const category of categories) categoryById.set(category.id, category);
        await tx.update(storeProduct).set({ cateId: input.relationIds.join(",") })
          .where(inArray(storeProduct.id, input.ids));
      } else if (input.type === 2) {
        operation = "label";
        relationType = PRODUCT_LABEL_RELATION;
        relationIds = input.relationIds;
        evidenceValues = relationIds;
        if (input.relationIds.length) {
          const labelQuery = tx.select({ id: storeProductLabel.id }).from(storeProductLabel).where(and(
            inArray(storeProductLabel.id, input.relationIds),
            eq(storeProductLabel.type, 0),
            eq(storeProductLabel.relationId, 0),
            eq(storeProductLabel.status, 1),
            eq(storeProductLabel.isShow, 1),
          )).$dynamic();
          const labels = await (options.catalogLocked ? labelQuery : labelQuery.for('share'));
          if (labels.length !== input.relationIds.length) throw new ValidateException("商品标签不存在或不可用");
        }
        await tx.update(storeProduct).set({ storeLabelId: input.relationIds.join(",") })
          .where(inArray(storeProduct.id, input.ids));
      } else if (input.type === 3) {
        operation = "delivery";
        evidenceValues = input.deliveryTypes;
        await tx.update(storeProduct).set({ deliveryType: input.deliveryTypes.join(",") })
          .where(inArray(storeProduct.id, input.ids));
      } else if (input.type === 4) {
        operation = "reward";
        couponIds = input.couponIds;
        evidenceValues = [input.giveIntegral, ...couponIds];
        const issues = couponIds.length
          ? await tx.select({
              id: storeCouponIssue.id,
              title: storeCouponIssue.title,
              couponTitle: storeCouponIssue.couponTitle,
            }).from(storeCouponIssue).where(and(
              inArray(storeCouponIssue.id, couponIds),
              eq(storeCouponIssue.isDel, 0),
              eq(storeCouponIssue.status, 1),
            )).orderBy(asc(storeCouponIssue.id)).for("share")
          : [];
        if (issues.length !== couponIds.length) throw new ValidateException("赠送优惠券不存在或不可用");
        await tx.update(storeProduct).set({ giveIntegral: input.giveIntegral })
          .where(inArray(storeProduct.id, input.ids));
        await tx.delete(storeProductCoupon).where(inArray(storeProductCoupon.productId, input.ids));
        if (issues.length) {
          const issueById = new Map(issues.map((issue) => [issue.id, issue]));
          await tx.insert(storeProductCoupon).values(input.ids.flatMap((productId) => couponIds.map((couponId) => {
            const issue = issueById.get(couponId)!;
            return {
              productId,
              issueCouponId: couponId,
              title: issue.couponTitle || issue.title,
              addTime: now,
            };
          })));
        }
      } else if (input.type === 5) {
        operation = "user_label";
        relationType = PRODUCT_USER_LABEL_RELATION;
        relationIds = input.relationIds;
        evidenceValues = relationIds;
        const labels = relationIds.length
          ? await tx.select({
              id: userLabel.id,
              type: userLabel.type,
              relationId: userLabel.relationId,
            }).from(userLabel).where(and(
              inArray(userLabel.id, relationIds),
              eq(userLabel.status, 1),
            )).orderBy(asc(userLabel.id)).for("share")
          : [];
        if (labels.length !== relationIds.length || labels.some((label) => products.some((product) => !(
          (label.type === 0 && label.relationId === 0)
          || (label.type === product.type && label.relationId === product.relationId)
        )))) throw new ValidateException("用户标签不存在或不属于所选商品");
        await tx.update(storeProduct).set({ labelId: relationIds.join(",") })
          .where(inArray(storeProduct.id, input.ids));
      } else if (input.type === 6) {
        operation = "recommend";
        evidenceValues = input.recommendations;
        const selected = new Set(input.recommendations);
        await tx.update(storeProduct).set({
          isHot: selected.has("is_hot") ? 1 : 0,
          isBenefit: selected.has("is_benefit") ? 1 : 0,
          isBest: selected.has("is_best") ? 1 : 0,
          isNew: selected.has("is_new") ? 1 : 0,
          isGood: selected.has("is_good") ? 1 : 0,
        }).where(inArray(storeProduct.id, input.ids));
      } else if (input.type === 7) {
        operation = "form";
        evidenceValues = [input.systemFormId];
        if (input.systemFormId > 0) {
          const forms = await tx.select({ id: systemForm.id }).from(systemForm).where(and(
            eq(systemForm.id, input.systemFormId),
            eq(systemForm.isDel, 0),
            eq(systemForm.status, 1),
          )).limit(1).for("share");
          if (!forms[0]) throw new ValidateException("系统表单不存在或不可用");
        }
        await tx.update(storeProduct).set({ systemFormId: input.systemFormId })
          .where(inArray(storeProduct.id, input.ids));
      } else if (input.type === 8) {
        operation = "freight";
        evidenceValues = [input.freight, input.postage, input.templateId];
        if (input.templateId > 0) {
          // Match the checkout authority: platform templates are not a universal
          // tenant fallback. Products have already been locked by this batch.
          await lockShippingTemplateBindings(tx, products.map(product => ({ tempId: input.templateId,
            freight: input.freight, ownerType: product.type, relationId: product.relationId })));
        }
        await tx.update(storeProduct).set({
          freight: input.freight,
          postage: input.postage,
          tempId: input.templateId,
        }).where(inArray(storeProduct.id, input.ids));
      } else {
        operation = "brand";
        relationType = PRODUCT_BRAND_RELATION;
        relationIds = input.relationIds;
        evidenceValues = relationIds;
        const brands = relationIds.length
          ? await tx.select({ id: storeBrand.id, pid: storeBrand.pid }).from(storeBrand).where(and(
              inArray(storeBrand.id, relationIds),
              eq(storeBrand.isDel, 0),
              eq(storeBrand.isShow, 1),
            )).orderBy(asc(storeBrand.id)).for("share")
          : [];
        if (brands.length !== relationIds.length) throw new ValidateException("商品品牌不存在或不可用");
        const brandById = new Map(brands.map((brand) => [brand.id, brand]));
        if (relationIds.slice(1).some((brandId, index) => brandById.get(brandId)?.pid !== relationIds[index])) {
          throw new ValidateException("商品品牌必须是连续的层级路径");
        }
        await tx.update(storeProduct).set({
          brandId: relationIds.at(-1) ?? 0,
          brandCom: relationIds.join(","),
        }).where(inArray(storeProduct.id, input.ids));
      }

      if (relationType > 0) {
        await tx.delete(storeProductRelation).where(and(
          inArray(storeProductRelation.productId, input.ids),
          eq(storeProductRelation.type, relationType),
        ));
        if (relationIds.length) {
          await tx.insert(storeProductRelation).values(input.ids.flatMap((productId) => relationIds.map((relationId) => ({
            type: relationType,
            productId,
            relationId,
            relationPid: relationType === PRODUCT_CATEGORY_RELATION ? categoryById.get(relationId)?.pid ?? 0 : 0,
            status: relationType === PRODUCT_CATEGORY_RELATION ? productById.get(productId)?.isShow ?? 0 : 1,
            addTime: now,
          }))));
        }
      }

      const [savedProducts, savedRelations, savedCoupons] = await Promise.all([
        tx.select({
          id: storeProduct.id,
          cateId: storeProduct.cateId,
          storeLabelId: storeProduct.storeLabelId,
          deliveryType: storeProduct.deliveryType,
          giveIntegral: storeProduct.giveIntegral,
          labelId: storeProduct.labelId,
          isHot: storeProduct.isHot,
          isBenefit: storeProduct.isBenefit,
          isBest: storeProduct.isBest,
          isNew: storeProduct.isNew,
          isGood: storeProduct.isGood,
          systemFormId: storeProduct.systemFormId,
          freight: storeProduct.freight,
          postage: storeProduct.postage,
          tempId: storeProduct.tempId,
          brandId: storeProduct.brandId,
          brandCom: storeProduct.brandCom,
        }).from(storeProduct).where(inArray(storeProduct.id, input.ids)),
        relationType > 0
          ? tx.select({
              productId: storeProductRelation.productId,
              relationId: storeProductRelation.relationId,
              relationPid: storeProductRelation.relationPid,
              status: storeProductRelation.status,
            }).from(storeProductRelation).where(and(
              inArray(storeProductRelation.productId, input.ids),
              eq(storeProductRelation.type, relationType),
            ))
          : Promise.resolve([]),
        input.type === 4
          ? tx.select({
              productId: storeProductCoupon.productId,
              issueCouponId: storeProductCoupon.issueCouponId,
            }).from(storeProductCoupon).where(inArray(storeProductCoupon.productId, input.ids))
          : Promise.resolve([]),
      ]);
      const expectedCsv = relationIds.join(",");
      const selectedRecommendations = input.type === 6 ? new Set(input.recommendations) : null;
      const productReadbackFailed = savedProducts.length !== input.ids.length || savedProducts.some((product) => {
        switch (input.type) {
          case 1: return product.cateId !== expectedCsv;
          case 2: return product.storeLabelId !== expectedCsv;
          case 3: return product.deliveryType !== input.deliveryTypes.join(",");
          case 4: return String(product.giveIntegral) !== input.giveIntegral;
          case 5: return product.labelId !== expectedCsv;
          case 6: return product.isHot !== (selectedRecommendations!.has("is_hot") ? 1 : 0)
            || product.isBenefit !== (selectedRecommendations!.has("is_benefit") ? 1 : 0)
            || product.isBest !== (selectedRecommendations!.has("is_best") ? 1 : 0)
            || product.isNew !== (selectedRecommendations!.has("is_new") ? 1 : 0)
            || product.isGood !== (selectedRecommendations!.has("is_good") ? 1 : 0);
          case 7: return product.systemFormId !== input.systemFormId;
          case 8: return product.freight !== input.freight
            || String(product.postage) !== input.postage
            || product.tempId !== input.templateId;
          case 9: return product.brandId !== (relationIds.at(-1) ?? 0) || product.brandCom !== expectedCsv;
        }
      });
      const relationReadbackFailed = relationType > 0 && (
        savedRelations.length !== input.ids.length * relationIds.length
        || input.ids.some((productId) => {
          const rows = savedRelations.filter((row) => row.productId === productId);
          return rows.length !== relationIds.length || relationIds.some((relationId) => {
            const row = rows.find((item) => item.relationId === relationId);
            return !row
              || row.relationPid !== (relationType === PRODUCT_CATEGORY_RELATION
                ? categoryById.get(relationId)?.pid ?? 0
                : 0)
              || row.status !== (relationType === PRODUCT_CATEGORY_RELATION
                ? productById.get(productId)?.isShow ?? 0
                : 1);
          });
        })
      );
      const couponReadbackFailed = input.type === 4 && (
        savedCoupons.length !== input.ids.length * couponIds.length
        || input.ids.some((productId) => {
          const savedIds = savedCoupons
            .filter((row) => row.productId === productId)
            .map((row) => row.issueCouponId)
            .sort((left, right) => left - right);
          return savedIds.join(",") !== couponIds.join(",");
        })
      );
      if (
        productReadbackFailed
        || relationReadbackFailed
        || couponReadbackFailed
      ) throw new Error("商品批量运营数据库回读校验失败");
      await audit(tx, { operation: operation, productIds: input.ids, evidenceValues: evidenceValues, now: now });
      return {
        changed: input.ids.length,
        relations: relationIds.length || couponIds.length,
        verified: true,
      };
    }
