import { and,asc,eq,inArray,sql } from 'drizzle-orm';
import { withTx,type Container,type DbClient } from '@/lib/di';
import { storeProduct,storeProductAttrValue,storeProductStockRecord } from '@/models/schema';
import type { ErpOperationScope } from '@/models/erp';
import { PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE } from '@/services/product/ProductSkuIdentity';
import { ServiceUnavailableException } from '@/utils/errors';
import { erpCanonical } from './ErpProtocol';
import type { ErpStockInput } from './ErpInput';
import { erpBinding,erpConflict,erpDeadlines } from './ErpConnectionPolicy';
import { ErpOperationService,type ErpOperationAdmission,type ErpOperationRow,type ErpRuntimeSnapshot } from './ErpOperationService';
import type { ErpObservedStock } from './ErpProviderFacts';

const eligibleProduct=and(eq(storeProduct.type,0),eq(storeProduct.relationId,0),eq(storeProduct.productType,0),eq(storeProduct.isDel,0));
const eligibleSku=and(eq(storeProductAttrValue.type,0),eq(storeProductAttrValue.isRetired,0));
async function candidates(tx:DbClient,codes:string[]){return tx.execute<{id:number;productId:number;code:string}>(sql`
  SELECT matched.id,matched.product_id AS "productId",matched.code FROM (
    SELECT ${storeProductAttrValue.id} AS id,${storeProductAttrValue.productId} AS product_id,${storeProductAttrValue.code} AS code,
      row_number() OVER(PARTITION BY ${storeProductAttrValue.code} ORDER BY ${storeProductAttrValue.id}) AS match_number
    FROM ${storeProductAttrValue} JOIN ${storeProduct} ON ${eq(storeProduct.id,storeProductAttrValue.productId)}
    WHERE ${and(eligibleProduct,eligibleSku,inArray(storeProductAttrValue.code,codes))}
  ) matched WHERE matched.match_number<=2 ORDER BY matched.id`);}
export class ErpStockService {
  constructor(private readonly container:Container,private readonly operations:ErpOperationService){}
  async plan(snapshot:ErpRuntimeSnapshot,input:ErpStockInput,stocks:ErpObservedStock[]):Promise<ErpOperationScope>{
    return withTx(this.container,async tx=>{
      await erpDeadlines(tx);await this.operations.recheck(tx,snapshot);
      if(input.items.some(item=>item.shopId!==snapshot.config.defaultShopId))throw erpConflict('ERP 仅支持当前默认店的平台库存');
      erpBinding(snapshot.connection,snapshot.config.defaultShopId,0,0);
      const codes=input.items.map(item=>item.code),rows=await candidates(tx,codes);
      if(codes.some(code=>rows.filter(row=>row.code===code).length!==1))throw erpConflict('ERP SKU 无法唯一匹配当前平台商品');
      return {providerShopId:snapshot.config.defaultShopId,storeId:0,supplierId:0,skuRows:rows.map(row=>{
        const fact=stocks.find(item=>item.code===row.code);if(!fact)throw new ServiceUnavailableException('ERP 库存事实不完整');
        return {...row,quantity:fact.available};})};
    });
  }
  async execute(admission:ErpOperationAdmission):Promise<ErpOperationRow>{
    const targets=admission.operation.scope?.skuRows;
    if(!targets?.length||targets.length>200||targets.some(row=>!Number.isSafeInteger(row.quantity)||row.quantity<0||row.quantity>2147483647))throw erpConflict('ERP 库存范围不一致');
    return withTx(this.container,async tx=>{
      await erpDeadlines(tx);const operation=await this.operations.authorize(tx,admission);
      if(operation.state==='business_committed')return operation;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE},0)`);
      const matches=await candidates(tx,targets.map(row=>row.code));
      if(targets.some(row=>{const found=matches.filter(match=>match.code===row.code);return found.length!==1||found[0].id!==row.id||found[0].productId!==row.productId;}))throw erpConflict('ERP SKU 身份已变化');
      const selected=await tx.select().from(storeProductAttrValue).where(inArray(storeProductAttrValue.id,targets.map(row=>row.id))).orderBy(asc(storeProductAttrValue.id)).for('update',{noWait:true});
      const productIds=[...new Set(targets.map(row=>row.productId))].sort((a,b)=>a-b);
      const products=await tx.select().from(storeProduct).where(inArray(storeProduct.id,productIds)).orderBy(asc(storeProduct.id)).for('update',{noWait:true});
      const allSkus=await tx.select().from(storeProductAttrValue).where(inArray(storeProductAttrValue.productId,productIds)).orderBy(asc(storeProductAttrValue.id)).for('update',{noWait:true});
      if(selected.length!==targets.length||products.length!==productIds.length||products.some(row=>row.type!==0||row.relationId!==0||row.productType!==0||row.isDel!==0)
        ||selected.some(row=>row.type!==0||row.isRetired!==0||!targets.some(item=>item.id===row.id&&item.productId===row.productId&&item.code===row.code)))throw erpConflict('ERP 商品资格已变化');
      const expectedSkus=new Map(allSkus.map(row=>[row.id,{...row}]));let updated=0;
      for(const target of targets){
        const before=selected.find(row=>row.id===target.id)!;const delta=target.quantity-before.stock;
        const sumStock=delta>0?before.sumStock+delta:before.sumStock;
        if(!Number.isSafeInteger(sumStock)||sumStock<0||sumStock>2147483647)throw erpConflict('ERP 累计库存超出存储范围');
        const expected={...before,stock:target.quantity,sumStock};expectedSkus.set(before.id,expected);
        if(delta===0)continue;
        const [saved]=await tx.update(storeProductAttrValue).set({stock:target.quantity,sumStock}).where(eq(storeProductAttrValue.id,before.id)).returning();
        if(!saved||erpCanonical(saved)!==erpCanonical(expected))throw erpConflict('ERP 库存写入不一致');
        const record={storeId:0,productId:before.productId,unique:before.unique,costPrice:before.cost,number:Math.abs(delta),pm:delta>0?1:0,addTime:Math.floor(Date.now()/1000)};
        const [audit]=await tx.insert(storeProductStockRecord).values(record).returning();
        if(!audit||Object.entries(record).some(([key,value])=>audit[key as keyof typeof audit]!==value))throw erpConflict('ERP 库存流水写入不一致');updated++;
      }
      const expectedProducts=new Map(products.map(row=>[row.id,{...row}]));
      for(const product of products){const stock=[...expectedSkus.values()].filter(row=>row.productId===product.id&&row.type===0&&row.isRetired===0).reduce((sum,row)=>sum+row.stock,0);
        if(!Number.isSafeInteger(stock)||stock<0||stock>2147483647)throw erpConflict('ERP 商品库存超出存储范围');
        const expected={...product,stock,isSold:stock>0?0:1};expectedProducts.set(product.id,expected);
        const [written]=await tx.update(storeProduct).set({stock,isSold:expected.isSold}).where(eq(storeProduct.id,product.id)).returning();
        if(!written||erpCanonical(written)!==erpCanonical(expected))throw erpConflict('ERP 商品库存写入不一致');}
      const completed=await this.operations.complete(tx,admission,{updated});
      const freshSkus=await tx.select().from(storeProductAttrValue).where(inArray(storeProductAttrValue.productId,productIds)).orderBy(asc(storeProductAttrValue.id));
      const freshProducts=await tx.select().from(storeProduct).where(inArray(storeProduct.id,productIds)).orderBy(asc(storeProduct.id));
      if(freshSkus.length!==expectedSkus.size||freshSkus.some(row=>erpCanonical(row)!==erpCanonical(expectedSkus.get(row.id)))
        ||freshProducts.length!==expectedProducts.size||freshProducts.some(row=>erpCanonical(row)!==erpCanonical(expectedProducts.get(row.id))))throw erpConflict('ERP 库存或商品完整回读不一致');
      const finalMatches=await candidates(tx,targets.map(row=>row.code));
      if(erpCanonical(finalMatches)!==erpCanonical(matches))throw erpConflict('ERP SKU 最终身份不一致');
      return completed;
    });
  }
}
