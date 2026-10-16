import { and, eq, inArray, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { AdminLegacyProductSaveService, type AdminLegacyProductSaveEffects } from '@/services/admin/AdminLegacyProductSaveService';
import { boundBargainSourceProductChange } from '@/services/activity/BargainSourceProductLifecycle';
import { lockProductUnitLifecycle } from '@/services/product/ProductUnitLifecycle';
import { assertSupplierProductCategoryBindings, lockSupplierCategoryScope } from './SupplierProductCategoryService';
import { assertSupplierProductLabelBindings } from './SupplierProductLabelBindings';
import { storeBrand, storeProduct, systemForm, shippingTemplates, userLabel } from '@/models/schema';
import { assertSupplierVideoAuthority, type SupplierVideoActor } from './SupplierVideoAuthority';
import { readSupplierCopySource, assertSupplierCopyToken, overlaySupplierCopy, supplierCopyId } from './SupplierProductCopySource';
import { appendSupplierCopyOperation, lockSupplierCopyOperation, prepareSupplierProductCopy, readSupplierCopyOperation,
  replaySupplierCopyOperation, supplierCopyOperationId, supplierCopyReceiptDto, unknownSupplierCopyReceipt, type SupplierProductCopyReceipt } from './SupplierProductCopyOperation';
import { projectSupplierProductMedia } from './SupplierProductMediaService';
import { parseCanonicalAttachmentId, signAttachmentReferences } from '@/services/system/AttachmentService';
import { ApiErrorCode, AuthException, HttpApiException, ServiceUnavailableException, NotFoundException, ValidateException } from '@/utils/errors';
import { emitOperationalEvent } from '@/utils/observability';

function fail(error:unknown):never {
  let cause=error;
  for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++){
    const code='code'in cause?String(cause.code):'';
    if(['55P03','40P01','40001'].includes(code))throw Object.assign(new HttpApiException('商品或复制操作正在变化，请查询原结果',409,409),{cause:error});
    if(['42501','57014','42P01','42703','23514'].includes(code))throw Object.assign(new ServiceUnavailableException('供应商完整复制运行权限或维护协议未就绪'),{cause:error});
    cause='cause'in cause?cause.cause:undefined;
  }
  throw error;
}
async function clock(tx:DbClient,actor:SupplierVideoActor):Promise<number>{
  const [row]=await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
  if(!row||!Number.isSafeInteger(row.now)||Number(row.now)<0||Number(row.now)>=actor.expiresAt)
    throw new AuthException('供应商会话已过期',ApiErrorCode.ERR_EXPIRED);
  return Number(row.now);
}
async function bindings(tx:DbClient,supplierId:number,body:Record<string,unknown>){
  await assertSupplierProductCategoryBindings(tx,supplierId,body.cate_id as number[]);
  await assertSupplierProductLabelBindings(tx,supplierId,body.store_label_id as number[]);
  const brands=body.brand_id as number[], labels=body.label_id as number[], recommendations=body.recommend_list as number[];
  if(brands.length){const rows=await tx.select().from(storeBrand).where(inArray(storeBrand.id,brands));
    if(rows.length!==brands.length||rows.some(r=>r.isShow!==1||r.isDel!==0||r.storeId!==0))throw new ValidateException('来源商品品牌不可用于新绑定');}
  if(labels.length){const rows=await tx.select().from(userLabel).where(inArray(userLabel.id,labels));
    if(rows.length!==labels.length||rows.some(r=>r.status!==1))throw new ValidateException('来源用户标签不可用于新绑定');}
  if(recommendations.length){const rows=await tx.select().from(storeProduct).where(and(inArray(storeProduct.id,recommendations),eq(storeProduct.isDel,0)));
    if(rows.length!==recommendations.length||rows.some(r=>!(r.type===2&&r.relationId===supplierId)&&!(r.isShow===1&&r.isVerify===1)))
      throw new ValidateException('来源推荐商品不存在或不可读取');}
  if(body.temp_id){const [row]=await tx.select().from(shippingTemplates).where(eq(shippingTemplates.id,Number(body.temp_id))).limit(1);
    if(!row||row.status!==1)throw new ValidateException('运费模板不可用于新商品');}
  if(body.system_form_id){const [row]=await tx.select().from(systemForm).where(eq(systemForm.id,Number(body.system_form_id))).limit(1);
    if(!row||row.status!==1||row.isDel!==0)throw new ValidateException('来源系统表单不可用于新商品');}
}
export class SupplierProductCopyService {
  constructor(private readonly container:Container,private readonly appKey:string,private readonly effects?:AdminLegacyProductSaveEffects){}
  private async transaction<T>(actor:SupplierVideoActor,write:boolean,capability:string|null,work:(tx:DbClient)=>Promise<T>):Promise<T>{
    try{return await withTx(this.container,async tx=>{
      await tx.execute(sql.raw(write?'SET TRANSACTION ISOLATION LEVEL READ COMMITTED':'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'));
      await boundBargainSourceProductChange(tx);
      if(write)await tx.execute(sql`LOCK TABLE ONLY public.system_admin, ONLY public.system_supplier, ONLY public.system_role, ONLY public.system_menus IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      await assertSupplierVideoAuthority(tx,actor,capability);await clock(tx,actor);
      const result=await work(tx);
      await assertSupplierVideoAuthority(tx,actor,capability);await clock(tx,actor);return result;
    });}catch(error){return fail(error);}
  }
  async seed(sourceId:number,actor:SupplierVideoActor){
    return this.transaction(actor,false,'supplier.product.manage',async tx=>{
      const source=await readSupplierCopySource(tx,supplierCopyId(sourceId),actor,this.appKey);
      const media=await projectSupplierProductMedia(tx,actor.supplierId,{sliderImages:source.safe.slider_image as string[],
        skus:source.safe.attrs as Array<{image:string}>,description:String(source.safe.description)},this.appKey);
      const video=String(source.safe.video_link??'');
      const preview=video&&parseCanonicalAttachmentId(video)!==null?(await signAttachmentReferences(this.appKey,[video]))[0]:video;
      return {copy:{source_id:sourceId,token:source.token,destination:{type:2 as const,relation_id:actor.supplierId}},
        product:{...source.safe,media,video_preview_url:preview}};
    });
  }
  async save(sourceId:number,body:unknown,actor:SupplierVideoActor):Promise<SupplierProductCopyReceipt>{
    const intent=prepareSupplierProductCopy(body,sourceId,actor,this.appKey);
    const completed=await this.transaction(actor,true,'supplier.product.manage',async tx=>{
      const replay=await replaySupplierCopyOperation(tx,intent,actor);
      if(replay)return {receipt:replay,outboxId:null};
      await lockProductUnitLifecycle(tx);await lockSupplierCategoryScope(tx,actor.supplierId);
      const readSource=async(inner:DbClient)=>{
        try{const current=await readSupplierCopySource(inner,sourceId,actor,this.appKey);assertSupplierCopyToken(intent.token,current.token);return current;}
        catch(cause){if(cause instanceof NotFoundException)throw new HttpApiException('复制来源已删除或归属已变化',409,409);throw cause;}
      };
      const source=await readSource(tx);
      const full=overlaySupplierCopy(source,intent.product);
      let receipt:SupplierProductCopyReceipt|undefined;
      const result=await new AdminLegacyProductSaveService(this.container,undefined,this.appKey).saveSupplierCopyInTransaction(tx,full,actor,{
        supplierId:actor.supplierId,sourceId,
        admitSource:async inner=>{const current=await readSource(inner);await bindings(inner,actor.supplierId,full);return current.product;},
        check:async inner=>{await assertSupplierVideoAuthority(inner,actor,'supplier.product.manage');await clock(inner,actor);},
        complete:async(inner,id)=>{receipt=await appendSupplierCopyOperation(inner,intent.operationId,sourceId,actor,await clock(inner,actor),intent.requestHash,{id,is_show:0,is_verify:0});},
      });
      if(!receipt)throw new ServiceUnavailableException('复制回执未完成');
      return {receipt,outboxId:result.outboxId};
    });
    if(this.effects&&completed.outboxId!==null)try{await this.effects.dispatch(completed.outboxId);}
    catch{emitOperationalEvent('error',{event:'supplier_product_copy_effects_dispatch_failed',component:'queue',outcome:'retry',operation:'product_save',errorCode:'dispatch_pending'});}
    return completed.receipt;
  }
  async receipt(operationId:string,actor:SupplierVideoActor):Promise<SupplierProductCopyReceipt>{
    supplierCopyOperationId(operationId);
    return this.transaction(actor,false,null,async tx=>{
      const row=await readSupplierCopyOperation(tx,operationId,actor);return row?supplierCopyReceiptDto(row):unknownSupplierCopyReceipt(operationId,actor);
    });
  }
  async resolve(operationId:string,sourceId:number,actor:SupplierVideoActor):Promise<SupplierProductCopyReceipt>{
    supplierCopyOperationId(operationId);supplierCopyId(sourceId);
    return this.transaction(actor,true,null,async tx=>{
      await lockSupplierCopyOperation(tx,operationId);
      const row=await readSupplierCopyOperation(tx,operationId,actor);
      if(row){if(row.source_id!==sourceId)throw new HttpApiException('复制来源与原操作不一致',409,409);return supplierCopyReceiptDto(row);}
      return appendSupplierCopyOperation(tx,operationId,sourceId,actor,await clock(tx,actor),'',null);
    });
  }
}
