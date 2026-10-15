import { storeProduct, storeProductAttrValue, storeProductAttr, storeProductAttrResult, storeProductVirtual,
  storeProductStockRecord, storeProductRelation, storeProductCoupon, type storeProductCategory, type storeCouponIssue } from '@/models/schema';
import { productSkuSummary, type ProductSkuEditorRow } from '@/services/product/ProductSkuEditorService';
import { virtualInventoryCardUnique } from '@/services/product/VirtualProductInventoryService';
import type { AdminLegacyProductInput } from './AdminLegacyProductInput';
import { assertProductSaveSame, assertProductSaveGeneratedRows, productSaveDefaults, productSaveConflict, type ProductSaveState } from './AdminLegacyProductSaveState';

type Product = typeof storeProduct.$inferSelect;
type Row = Record<string, unknown>;
export function expectedProductSaveMain(input: AdminLegacyProductInput, existing: Product | undefined, id: number,
  owner: { type: number; relationId: number }, verifiedState: 0 | 1 | undefined, creation: { star: string; spu: string },
  now: number, stock: number, isSold: number, isPolices: number): Row {
  const normalized = input.normalized, summary = productSkuSummary(input.skuPayload);
  const brandIds = normalized.brand_id as number[], specs = normalized.specs as unknown[];
  return { ...(existing ?? { ...productSaveDefaults(storeProduct), id, addTime: now, codePath: '', ...creation }),
    ...input.productValues, type: owner.type, relationId: owner.relationId,
    ...(verifiedState === undefined ? {} : { isVerify: verifiedState }),
    specType: input.skuPayload.specType, price: summary.price, settlePrice: summary.settlePrice, cost: summary.cost,
    otPrice: summary.otPrice, vipPrice: summary.vipPrice, stock, isSold, isPolices,
    cateId: (normalized.cate_id as number[]).join(','), brandCom: brandIds.join(','), brandId: brandIds.at(-1) ?? 0,
    storeLabelId: (normalized.store_label_id as number[]).join(','), ensureId: (normalized.ensure_id as number[]).join(','),
    specsId: normalized.specs_id, specs: specs.length ? JSON.stringify(specs) : '',
  };
}
interface Proof {
  input: AdminLegacyProductInput; existing: Product | undefined; before: ProductSaveState; after: ProductSaveState;
  actualId: number; owner: { type: number; relationId: number }; now: number; watermarks: Record<string, number>;
  baselineAttrs: Row[]; assigned: ProductSkuEditorRow[]; snapshotRows: ProductSkuEditorRow[];
  categories: Array<typeof storeProductCategory.$inferSelect>; issues: Array<typeof storeCouponIssue.$inferSelect>;
  verifiedState: 0 | 1 | undefined;
}
/** Compare all persisted columns/rows, including other activity types, retired
 * SKUs, paid/deleted carts and assigned card inventory. Serial receipts are
 * admitted only above the pre-write watermark; old identities stay exact. */
export function verifyProductSavePlan(plan: Proof): void {
  const { input, existing, before, after, actualId, owner, now, watermarks, baselineAttrs, assigned, snapshotRows } = plan;
  const storeId = owner.type === 0 ? 0 : owner.relationId;
  if (before.descriptions.filter(row => row.type === 0).length > 1) throw productSaveConflict('商品历史描述存在重复');
  const expectedCards: Row[] = [], importedCounts = new Map<string, number>();
  for (const item of input.cardImports) {
    const sku = assigned.find(row => row.suk === item.suk);
    if (!sku) throw productSaveConflict('商品卡密规格不完整');
    const candidates = item.cards.map(card => ({ ...productSaveDefaults(storeProductVirtual), productId: actualId, storeId,
      attrUnique: sku.unique, cardNo: card.cardNo, cardPwd: card.cardPwd, cardUnique: virtualInventoryCardUnique(sku.unique, card) }));
    const fresh = candidates.filter(card => !before.cards.some(old => old.attrUnique === card.attrUnique && old.cardUnique === card.cardUnique
      && old.cardNo === card.cardNo && old.cardPwd === card.cardPwd));
    expectedCards.push(...fresh); importedCounts.set(item.suk, fresh.length);
  }
  const oldCardIds = new Set(before.cards.map(row => row.id));
  assertProductSaveSame(after.cards.filter(row => oldCardIds.has(row.id)), before.cards, '既有卡密');
  assertProductSaveGeneratedRows(after.cards.filter(row => !oldCardIds.has(row.id)), expectedCards, watermarks.cards, '新增卡密');
  const expectedLedgers: Row[] = [], expectedNewSkus: Row[] = [];
  const expectedExisting = new Map(before.skus.map(row => [row.id, { ...row }]));
  const expectedAssigned: ProductSkuEditorRow[] = [];
  for (const [index, sku] of input.skuPayload.skus.entries()) {
    const receipt = assigned[index], base = Number(baselineAttrs[index].stock);
    const old = before.skus.find(row => row.type === 0 && row.isRetired === 0 && row.suk === sku.suk);
    if (!receipt || receipt.suk !== sku.suk || (old ? old.unique !== receipt.unique : !/^[a-f0-9]{8}$/.test(receipt.unique)))
      throw productSaveConflict('商品稳定规格身份不一致');
    const imported = importedCounts.get(sku.suk) ?? 0;
    const sumStock = (old ? old.sumStock + Math.max(0, base - old.stock) : base) + imported;
    const stock = base + imported;
    const values = { productType: input.productType, suk: sku.suk, unique: receipt.unique, stock, sumStock,
      price: sku.price, settlePrice: sku.settlePrice, cost: sku.cost, image: sku.image || input.productValues.image!.slice(0, 128),
      barCode: sku.barCode, otPrice: sku.otPrice, vipPrice: sku.vipPrice, weight: sku.weight, volume: sku.volume,
      brokerage: sku.brokerage, brokerageTwo: sku.brokerageTwo, code: sku.code, diskInfo: input.productType === 1 ? sku.diskInfo : '',
      writeTimes: sku.writeTimes, writeValid: sku.writeValid, writeDays: sku.writeDays, writeStart: sku.writeStart, writeEnd: sku.writeEnd };
    if (old) expectedExisting.set(old.id, { ...old, ...values });
    else expectedNewSkus.push({ ...productSaveDefaults(storeProductAttrValue), productId: actualId, ...values, sales: 0, type: 0 });
    expectedAssigned.push({ ...sku, unique: receipt.unique, sales: old?.sales ?? 0, sumStock, stock,
      diskInfo: input.productType === 1 ? sku.diskInfo : '' });
    const difference = base - (old?.stock ?? 0);
    if (difference) expectedLedgers.push({ ...productSaveDefaults(storeProductStockRecord), storeId, productId: actualId,
      unique: receipt.unique, costPrice: sku.cost, number: Math.abs(difference), pm: difference > 0 ? 1 : 0, addTime: now });
    if (imported) expectedLedgers.push({ ...productSaveDefaults(storeProductStockRecord), storeId, productId: actualId,
      unique: receipt.unique, costPrice: sku.cost, number: imported, pm: 1, addTime: now });
  }
  assertProductSaveSame(snapshotRows, expectedAssigned, '规格内存快照');
  const oldSkuIds = new Set(before.skus.map(row => row.id));
  assertProductSaveSame(after.skus.filter(row => oldSkuIds.has(row.id)), [...expectedExisting.values()], '既有规格');
  assertProductSaveGeneratedRows(after.skus.filter(row => !oldSkuIds.has(row.id)), expectedNewSkus, watermarks.skus, '新增规格');
  const oldLedgerIds = new Set(before.ledgers.map(row => row.id));
  assertProductSaveSame(after.ledgers.filter(row => oldLedgerIds.has(row.id)), before.ledgers, '既有库存记录');
  assertProductSaveGeneratedRows(after.ledgers.filter(row => !oldLedgerIds.has(row.id)), expectedLedgers, watermarks.ledgers, '新增库存记录');
  assertProductSaveSame(after.attrs.filter(row => row.type !== 0), before.attrs.filter(row => row.type !== 0), '活动规格维度');
  assertProductSaveGeneratedRows(after.attrs.filter(row => row.type === 0), input.skuPayload.dimensions.map(row => ({
    ...productSaveDefaults(storeProductAttr), productId: actualId, attrName: row.value, attrValues: row.detail.join(','), type: 0,
  })), watermarks.attrs, '普通规格维度');
  assertProductSaveSame(after.results.filter(row => row.type !== 0), before.results.filter(row => row.type !== 0), '活动规格快照');
  assertProductSaveGeneratedRows(after.results.filter(row => row.type === 0), [{ ...productSaveDefaults(storeProductAttrResult),
    productId: actualId, result: JSON.stringify({ attr: input.skuPayload.dimensions, value: expectedAssigned }), changeTime: now, type: 0,
  }], watermarks.results, '普通规格快照');
  assertProductSaveSame(after.descriptions, [...before.descriptions.filter(row => row.type !== 0), {
    productId: actualId, type: 0, description: input.description,
  }].sort((a, b) => a.type - b.type), '描述');
  const groups = new Map<number, number[]>([
    [1, input.normalized.cate_id as number[]], [2, input.normalized.brand_id as number[]],
    [3, input.normalized.store_label_id as number[]], [4, input.normalized.label_id as number[]],
    [5, input.normalized.ensure_id as number[]], [6, input.normalized.specs_id ? [Number(input.normalized.specs_id)] : []],
  ]);
  const replaced = new Set([...groups].filter(([, ids]) => ids.length).map(([type]) => type));
  assertProductSaveSame(after.relations.filter(row => !replaced.has(row.type)), before.relations.filter(row => !replaced.has(row.type)), '保留关联');
  const expectedRelations = [...groups].flatMap(([type, ids]) => ids.map(relationId => ({
    ...productSaveDefaults(storeProductRelation), productId: actualId, type, relationId,
    relationPid: type === 1 ? plan.categories.find(row => row.id === relationId)?.pid ?? -1 : 0,
    status: type === 1 ? input.productValues.isShow : 1, addTime: now,
  })));
  assertProductSaveGeneratedRows(after.relations.filter(row => replaced.has(row.type)), expectedRelations, watermarks.relations, '替换关联');
  const couponIds = input.normalized.coupon_ids as number[];
  if (!couponIds.length) assertProductSaveSame(after.coupons, before.coupons, '保留赠券');
  else assertProductSaveGeneratedRows(after.coupons, plan.issues.map(issue => ({ ...productSaveDefaults(storeProductCoupon),
    productId: actualId, issueCouponId: issue.id, title: issue.couponTitle || issue.title, addTime: now,
  })), watermarks.coupons, '替换赠券');
  const cartStatus = existing?.type === 1 && existing.pid === 0 && plan.verifiedState !== 1 ? 0 : input.productValues.isShow;
  assertProductSaveSame(after.carts, existing ? before.carts.map(row => ({ ...row, status: cartStatus })) : [], '购物车');
  assertProductSaveSame(after.discounts, existing ? before.discounts.map(row => ({ ...row, tempId: input.productValues.tempId })) : [], '套餐运费');
  for (const key of ['seckill', 'combination', 'bargain', 'integral'] as const)
    assertProductSaveSame(after[key], before[key].map(row => owner.type === 2 ? { ...row, type: 2, relationId: owner.relationId } : row), '活动归属');
}
