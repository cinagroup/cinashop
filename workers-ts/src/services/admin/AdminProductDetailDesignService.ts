import { and,eq,sql } from 'drizzle-orm';
import { withTx,type Container } from '@/lib/di';
import { systemDise,systemLog } from '@/models/schema';
import { NotFoundException,ValidateException } from '@/utils/errors';
import { lockDiseCatalogForMutation,themeDeadlines,themeHash } from '@/services/content/ThemeReadService';
import { decodeProductDetailDesign,PRODUCT_DETAIL_MAX_VALUE_BYTES,PRODUCT_DETAIL_TEMPLATE_NAME,productDetailDesignCatalog,ProductDetailDesignReadService,projectProductDetailDesign } from '@/services/content/ProductDetailDesignReadService';
import { productDetailDesignInput,productDetailDesignOperationId,ProductDetailDesignRejected,ProductDetailDesignStaleVersion } from './AdminProductDetailDesignInput';
import type { ProductDetailDesignReceipt } from '../../../../view/common/productDetailDesign';
export const PRODUCT_DETAIL_DESIGN_LOCK_NAMESPACE=731_722;
const JOURNAL_TYPE='product_detail_design',receiptPath=(id:string)=>`/config/product-detail-design/receipt/${id}`;
function parseReceipt(value:string,operationId:string):ProductDetailDesignReceipt|null{
  const match=/^update;id=([1-9]\d{0,9});payload=([a-f0-9]{64})$/.exec(value);
  return match&&Number(match[1])<=2147483647?{operation:'update',id:Number(match[1]),operationId,payloadHash:match[2]}:null;
}
function actorId(actor:{id:number}){if(!actor||!Number.isSafeInteger(actor.id)||actor.id<=0||actor.id>2147483647)throw new ValidateException('管理员身份无效');return actor.id;}
export class AdminProductDetailDesignService{
  constructor(private readonly container:Container){}
  read(){return new ProductDetailDesignReadService(this.container).read();}
  receipt(value:unknown,actor:{id:number}){const operationId=productDetailDesignOperationId(value),id=actorId(actor);
    return withTx(this.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await themeDeadlines(tx);
      const rows=await tx.select({action:systemLog.action}).from(systemLog).where(and(eq(systemLog.type,JOURNAL_TYPE),eq(systemLog.path,receiptPath(operationId)),eq(systemLog.adminId,id))).limit(2);
      if(!rows.length)throw new NotFoundException('商品详情设计回执不存在');const receipt=rows.length===1?parseReceipt(rows[0].action,operationId):null;
      if(!receipt)throw new ValidateException('商品详情设计回执异常，结果未知');return receipt;});}
  save(input:unknown,actor:{id:number}){const id=actorId(actor),{operationId,canonical}=productDetailDesignInput(input);
    return themeHash(canonical).then(payloadHash=>withTx(this.container,async tx=>{
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);await themeDeadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_DETAIL_DESIGN_LOCK_NAMESPACE},0)`);
      const journals=await tx.select({action:systemLog.action,actor:systemLog.adminId}).from(systemLog).where(and(eq(systemLog.type,JOURNAL_TYPE),eq(systemLog.path,receiptPath(operationId)))).limit(2);
      if(journals.length){const receipt=journals.length===1?parseReceipt(journals[0].action,operationId):null;if(!receipt||journals[0].actor!==id||receipt.payloadHash!==payloadHash)throw new ValidateException('操作标识已用于其他商品详情设计请求');return receipt;}
      await lockDiseCatalogForMutation(tx);const catalog=await productDetailDesignCatalog(tx);
      if(catalog.revision!==canonical.revision)throw new ProductDetailDesignStaleVersion(operationId,payloadHash);
      if(!projectProductDetailDesign(catalog).editable)throw new ProductDetailDesignRejected(operationId,payloadHash);
      const now=Math.floor(Date.now()/1000),version=crypto.randomUUID(),row=catalog.rows[0];let resultId:number;
      if(row){resultId=row.id;const saved=decodeProductDetailDesign(row.value)!;
        const merged=JSON.stringify({...saved,...canonical.value});
        if(new TextEncoder().encode(merged).byteLength>PRODUCT_DETAIL_MAX_VALUE_BYTES)throw new ProductDetailDesignRejected(operationId,payloadHash);
        await tx.update(systemDise).set({value:merged,version,updateTime:sql<number>`GREATEST(${systemDise.updateTime}+1,${now})`}).where(eq(systemDise.id,row.id));
      }else{const [created]=await tx.insert(systemDise).values({templateName:PRODUCT_DETAIL_TEMPLATE_NAME,type:3,name:'商品详情',title:'商品详情可视化',
        value:JSON.stringify(canonical.value),status:0,isShow:0,isDel:0,isDiy:1,version,addTime:now,updateTime:now}).returning({id:systemDise.id});resultId=created.id;}
      await tx.insert(systemLog).values({adminId:id,type:JOURNAL_TYPE,path:receiptPath(operationId),page:JOURNAL_TYPE,method:'POST',action:`update;id=${resultId};payload=${payloadHash}`,addTime:now});
      return {operation:'update' as const,id:resultId,operationId,payloadHash};}));}
}
