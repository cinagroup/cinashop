import {eq,sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {supplierExtract} from '@/models/schema';
import {assertSupplierExtractApplicationReady} from '@/migrations/supplierExtractApplication';
import {AuthException} from '@/utils/errors';
import type {SupplierVideoActor} from './SupplierVideoAuthority';
import {extractAccountText,extractBroken,extractFact,extractHash,extractId,extractIntent,extractJson,extractMoney,extractRecord,extractText,extractUuid,extractConflict,validateExtractSource,type ExtractIntent,type ExtractSource,type ExtractApplicationResult} from './SupplierExtractApplicationInput';
export interface ExtractOperation {operation_id:string;actor_id:number;supplier_id:number;extract_id:number|null;state:'committed'|'not_applied';request_hash:string;intent:ExtractIntent|null;source:ExtractSource|null;source_hash:string;result:ExtractApplicationResult|null;result_hash:string;created_at:number}
export interface ExtractReceipt {version:'supplier-extract-application-receipt-v1';operation_id:string;actor_id:number;supplier_id:number;state:'unknown'|'committed'|'not_applied';request_hash:string;result:ExtractApplicationResult|null}
const keys=['operation_id','actor_id','supplier_id','extract_id','state','request_hash','intent','source','source_hash','result','result_hash','created_at'];
export async function lockExtractOperation(tx:DbClient,uuid:string) {
 extractUuid(uuid);const[held]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731629,hashtext(${'supplier-extract-application:'+uuid})) AS held`);
 if(held?.held!==true)throw extractConflict('原提现请求仍在处理，请查询原操作');await assertSupplierExtractApplicationReady(tx,'write');
}
function resultFrom(value:unknown):ExtractApplicationResult {
 const row=extractRecord(value,['id','extract_type','extract_price','balance','bank_code','bank_address','alipay_account','wechat','qrcode_url','supplier_mark','status','pay_status','add_time']);
 extractId(row.id);extractId(row.add_time);extractMoney(row.extract_price,10);extractMoney(row.balance,10);
 extractFact(['bank','alipay','weixin'].includes(String(row.extract_type))&&row.status===0&&row.pay_status===0);
 for(const[key,limit]of[['bank_code',32],['bank_address',256],['alipay_account',64],['wechat',15],['qrcode_url',255]] as const)extractAccountText(row[key],limit);extractText(row.supplier_mark,255);
 return JSON.parse(extractJson(value)) as ExtractApplicationResult;
}
export function validateExtractOperation(value:unknown):ExtractOperation {
 try {
  const row=extractRecord(value,keys);extractUuid(row.operation_id);extractId(row.actor_id);extractId(row.supplier_id);extractId(row.created_at);
  if(row.state==='not_applied')extractFact(row.extract_id===null&&row.intent===null&&row.source===null&&row.result===null&&row.request_hash===''&&row.source_hash===''&&row.result_hash==='');
  else {
   extractFact(row.state==='committed');extractId(row.extract_id);
   const stored=extractRecord(row.intent,['version','operation_id','actor_id','supplier_id','revision','extract_type','money','mark']);
   const{version,actor_id,supplier_id,...body}=stored;
   const intent=extractIntent(body,{id:extractId(row.actor_id),supplierId:extractId(row.supplier_id)}),source=validateExtractSource(row.source),result=resultFrom(row.result);
   extractFact(version===intent.version&&actor_id===row.actor_id&&supplier_id===row.supplier_id&&extractJson(intent)===extractJson(stored)
    &&intent.operation_id===row.operation_id&&source.supplier_id===row.supplier_id&&result.id===row.extract_id&&result.extract_type===intent.extract_type
    &&result.extract_price===intent.money&&result.supplier_mark===intent.mark&&result.add_time===row.created_at
    &&row.request_hash===extractHash(intent)&&row.source_hash===extractHash(source)&&row.result_hash===extractHash(result));
   const amount=BigInt(intent.money.replace('.','')),available=BigInt(source.available.replace('.',''));
   const minimum=BigInt(source.min_price.replace('.',''))||1n,maximum=BigInt(source.max_price.replace('.',''));
   extractFact(amount>0n&&amount>=minimum&&maximum>0n&&amount<=maximum&&available>=amount&&BigInt(result.balance.replace('.',''))===available-amount);
   const account=source.accounts[intent.extract_type];extractFact(account.ready);
   const expected={bank_code:'',bank_address:'',alipay_account:'',wechat:'',qrcode_url:''};
   if(intent.extract_type==='bank'){expected.bank_code=source.accounts.bank.bank_code;expected.bank_address=source.accounts.bank.bank_address;}
   else {expected[intent.extract_type==='alipay'?'alipay_account':'wechat']=source.accounts[intent.extract_type].account;expected.qrcode_url=source.accounts[intent.extract_type].qrcode_url;}
   extractFact(Object.entries(expected).every(([key,item])=>(result as unknown as Record<string,unknown>)[key]===item));
  }
  return JSON.parse(extractJson(row)) as ExtractOperation;
 }catch(cause){throw Object.assign(extractBroken(),{cause});}
}
export async function readExtractOperation(tx:DbClient,uuid:string):Promise<ExtractOperation|undefined> {
 extractUuid(uuid);await assertSupplierExtractApplicationReady(tx,'read');
 const rows=await tx.execute(sql`SELECT operation_id::text,actor_id,supplier_id,extract_id,state,request_hash,intent,source,source_hash,result,result_hash,created_at
  FROM public.supplier_extract_application_operation_v1 WHERE operation_id=${uuid}::uuid LIMIT 2`);
 extractFact(rows.length<=1);return rows[0]?validateExtractOperation(rows[0]):undefined;
}
/** Only these nine current columns are mutable in the published Admin/Supplier
 * workflow. Every remaining actual application column stays strongly bound. */
export async function verifyActualExtract(tx:DbClient,operation:ExtractOperation) {
 if(operation.state!=='committed')return;
 const[row]=await tx.select().from(supplierExtract).where(eq(supplierExtract.id,operation.extract_id!)).limit(1);extractFact(row);
 try {
  extractFact([-1,0,1].includes(row.status)&&[0,1].includes(row.payStatus));
  for(const value of[row.adminId,row.failTime,row.payTime])extractFact(Number.isSafeInteger(value)&&value>=0&&value<=2147483647);
  extractText(row.supplierMark,255);extractText(row.failMsg,128);extractText(row.voucherTitle,256);extractAccountText(row.voucherImage,256);
  extractFact(row.status===0||row.adminId>0);
  extractFact(row.payStatus===0||(row.status===1&&row.adminId>0&&row.payTime>0&&!!row.voucherTitle.trim()));
  extractFact(row.status!==-1||(row.payStatus===0&&row.failTime>0&&!!row.failMsg.trim()));
 }catch(cause){throw Object.assign(extractBroken(),{cause});}
 const mutable=['supplierMark','status','payStatus','adminId','failMsg','failTime','voucherImage','voucherTitle','payTime'];
 const current=Object.fromEntries(Object.entries(row).filter(([key])=>!mutable.includes(key))),r=operation.result!;
 const expected={id:r.id,supplierId:operation.supplier_id,extractType:r.extract_type,bankCode:r.bank_code,bankAddress:r.bank_address,
  alipayAccount:r.alipay_account,wechat:r.wechat,qrcodeUrl:r.qrcode_url,extractPrice:r.extract_price,balance:r.balance,mark:'',addTime:r.add_time};
 extractFact(extractJson(current)===extractJson(expected));
}
export function extractReceipt(operation:ExtractOperation|undefined,uuid:string,actor:SupplierVideoActor):ExtractReceipt {
 if(operation&&(operation.actor_id!==actor.id||operation.supplier_id!==actor.supplierId))throw new AuthException('无权读取其他账号或供应商的提现原操作',400011);
 return{version:'supplier-extract-application-receipt-v1',operation_id:extractUuid(uuid),actor_id:actor.id,supplier_id:actor.supplierId,state:operation?.state??'unknown',request_hash:operation?.request_hash??'',result:operation?.result??null};
}
export async function appendExtractOperation(tx:DbClient,value:ExtractOperation) {
 const operation=validateExtractOperation(value);await assertSupplierExtractApplicationReady(tx,'write');
 await tx.execute(sql`INSERT INTO public.supplier_extract_application_operation_v1(operation_id,actor_id,supplier_id,extract_id,state,request_hash,intent,source,source_hash,result,result_hash,created_at)
  VALUES(${operation.operation_id}::uuid,${operation.actor_id},${operation.supplier_id},${operation.extract_id},${operation.state},${operation.request_hash},${operation.intent===null?null:JSON.stringify(operation.intent)}::jsonb,
   ${operation.source===null?null:JSON.stringify(operation.source)}::jsonb,${operation.source_hash},${operation.result===null?null:JSON.stringify(operation.result)}::jsonb,${operation.result_hash},${operation.created_at})`);
 const actual=await readExtractOperation(tx,operation.operation_id);extractFact(actual&&extractJson(actual)===extractJson(operation));return actual;
}
