import {and,asc,desc,eq,inArray,sql} from 'drizzle-orm';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {supplierExtract,supplierFlowingWater,systemAdmin,systemConfig,systemMenus,systemRole,systemSupplier} from '@/models/schema';
import {assertSupplierExtractApplicationReady} from '@/migrations/supplierExtractApplication';
import {normalizeConfigScalar} from '@/utils/config';
import {HttpApiException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {lockSupplierFinance} from './SupplierFinanceLock';
import {assertSupplierVideoAuthority,type SupplierVideoActor} from './SupplierVideoAuthority';
import {appendExtractOperation,extractReceipt,lockExtractOperation,readExtractOperation,verifyActualExtract,type ExtractOperation} from './SupplierExtractApplicationOperation';
import {assertExtractRevision,extractAccountText,extractCents,extractConflict,extractDecimal,extractFact,extractHash,extractId,extractIntent,extractMoney,extractRevision,extractUuid,validateExtractSource,type ExtractApplicationResult,type ExtractSource} from './SupplierExtractApplicationInput';
function failure(error:unknown):never {let cause=error;for(let i=0;i<8&&cause&&typeof cause==='object';i++){
 const code='code'in cause?String(cause.code):'';
 if(['55P03','40P01','40001','23505','23503','23514'].includes(code))throw new HttpApiException('提现申请、权限或原请求正在变化，请查询原结果',409,409);
 if(['42501','57014','42P01','42703','22003'].includes(code))throw new ServiceUnavailableException('提现目录、权限或处理容量尚未就绪');cause='cause'in cause?cause.cause:undefined;
 }throw error;}
export function extractConfigAmount(value:string|undefined):string {
 const text=normalizeConfigScalar(value);if(!text)return'0.00';if(!/^\d{1,18}(?:\.\d{1,2})?$/.test(text))throw new ServiceUnavailableException('提现上下限配置无法核对');
 const[whole,fraction='']=text.split('.');return`${BigInt(whole)}.${fraction.padEnd(2,'0')}`;
}
function canApply(source:ExtractSource) {const min=extractCents(source.min_price)>0n?extractCents(source.min_price):1n;return extractCents(source.max_price)>0n&&extractCents(source.max_price)>=min&&extractCents(source.available)>=min;}
async function now(tx:DbClient){const[row]=await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);return extractId(row?.now);}
/** Minimum column rights are tested independently; safe existing combined app
 * LOGIN rights on ordinary business tables are not rejected by feature admission. */
async function businessReady(tx:DbClient,write:boolean) {
 const[row]=await tx.execute(sql`SELECT current_user=session_user AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolbypassrls
  AND NOT has_schema_privilege(current_user,'public','CREATE')
  AND NOT EXISTS(WITH RECURSIVE parents(oid) AS(SELECT r.oid UNION SELECT m.roleid FROM pg_auth_members m JOIN parents p ON p.oid=m.member)
   SELECT 1 FROM parents p JOIN pg_roles unsafe ON unsafe.oid=p.oid WHERE unsafe.rolsuper OR unsafe.rolcreaterole OR unsafe.rolcreatedb OR unsafe.rolreplication OR unsafe.rolbypassrls)
  AND (SELECT count(*)=7 AND bool_and(c.relkind='r' AND has_table_privilege(current_user,c.oid,'SELECT')) FROM pg_class c WHERE c.relnamespace='public'::regnamespace
   AND c.relname IN('system_admin','system_supplier','system_role','system_menus','supplier_extract','supplier_flowing_water','system_config'))
  AND (${!write} OR(has_table_privilege(current_user,'public.supplier_extract','INSERT')
   AND has_sequence_privilege(current_user,pg_get_serial_sequence('public.supplier_extract','id'),'USAGE')
   AND has_any_column_privilege(current_user,'public.system_admin','UPDATE') AND has_any_column_privilege(current_user,'public.system_supplier','UPDATE')
   AND has_any_column_privilege(current_user,'public.system_role','UPDATE') AND has_any_column_privilege(current_user,'public.system_menus','UPDATE'))) AS ready
  FROM pg_roles r WHERE r.rolname=current_user`);
 if(row?.ready!==true)throw new ServiceUnavailableException('提现实际运行身份或业务权限尚未就绪');
}
async function authority(tx:DbClient,actor:SupplierVideoActor) {
 await assertSupplierVideoAuthority(tx,actor,null);
 const[admin]=await tx.select().from(systemAdmin).where(and(eq(systemAdmin.id,actor.id),eq(systemAdmin.adminType,4),eq(systemAdmin.relationId,actor.supplierId),eq(systemAdmin.status,1),eq(systemAdmin.isDel,0))).limit(1).for('share',{noWait:true});
 const[supplier]=await tx.select().from(systemSupplier).where(and(eq(systemSupplier.id,actor.supplierId),eq(systemSupplier.isShow,1),eq(systemSupplier.isDel,0))).limit(1).for('share',{noWait:true});
 extractFact(admin&&supplier);
 if(admin.id!==supplier.adminId){const ids=(value:string)=>{const raw=[...new Set(value.split(',').map(x=>x.trim()).filter(Boolean))];if(raw.length>512)throw new ValidateException('提现权限目录超出范围');return raw.filter(x=>/^[1-9]\d*$/.test(x)).map(Number).filter(x=>Number.isSafeInteger(x)&&x<=2147483647).sort((a,b)=>a-b);};
  const roleIds=ids(admin.roles),roles=roleIds.length?await tx.select().from(systemRole).where(and(inArray(systemRole.id,roleIds),eq(systemRole.type,4),eq(systemRole.relationId,actor.supplierId),eq(systemRole.status,1))).orderBy(asc(systemRole.id)).for('share',{noWait:true}):[];
  const menus=[...new Set(roles.flatMap(role=>ids(role.rules)))].sort((a,b)=>a-b);if(menus.length>512)throw new ValidateException('提现权限目录超出范围');
  if(menus.length)await tx.select({id:systemMenus.id}).from(systemMenus).where(and(inArray(systemMenus.id,menus),eq(systemMenus.type,4),eq(systemMenus.authType,2),eq(systemMenus.access,1),eq(systemMenus.isDel,0))).orderBy(asc(systemMenus.id)).for('share',{noWait:true});
 }
 await assertSupplierVideoAuthority(tx,actor,null);
}
async function source(tx:DbClient,supplierId:number):Promise<ExtractSource> {
 const[supplier]=await tx.select().from(systemSupplier).where(and(eq(systemSupplier.id,supplierId),eq(systemSupplier.isShow,1),eq(systemSupplier.isDel,0))).limit(1);extractFact(supplier);
 const[flow]=await tx.select({net:sql<string>`coalesce(sum(CASE WHEN ${supplierFlowingWater.pm}=1 THEN ${supplierFlowingWater.number} WHEN ${supplierFlowingWater.pm}=0 THEN -${supplierFlowingWater.number} ELSE 0 END),0)::numeric(20,2)::text`}).from(supplierFlowingWater).where(and(eq(supplierFlowingWater.supplierId,supplierId),eq(supplierFlowingWater.status,1),eq(supplierFlowingWater.isDel,0)));
 const[reserved]=await tx.select({amount:sql<string>`coalesce(sum(${supplierExtract.extractPrice}),0)::numeric(20,2)::text`}).from(supplierExtract).where(and(eq(supplierExtract.supplierId,supplierId),sql`${supplierExtract.status}<>-1`));
 const net=String(flow.net);if(!/^-?(?:0|[1-9]\d{0,17})\.\d{2}$/.test(net))throw new ServiceUnavailableException('提现结算汇总超出容量');
 const balance=BigInt(net.replace('.',''))-extractCents(reserved.amount),config=await tx.selectDistinctOn([systemConfig.menuName],{name:systemConfig.menuName,value:systemConfig.value}).from(systemConfig).where(and(eq(systemConfig.isStore,0),inArray(systemConfig.menuName,['supplier_extract_min_price','supplier_extract_max_price']))).orderBy(asc(systemConfig.menuName),desc(systemConfig.sort),desc(systemConfig.id));
 const values=new Map(config.map(row=>[row.name,row.value])),clean=(value:string,limit:number)=>{try{return extractAccountText(value,limit).trim();}catch(cause){throw Object.assign(new ServiceUnavailableException('提现收款资料无法核对'),{cause});}};
 const bank_code=clean(supplier.bankCode,32),bank_address=clean(supplier.bankAddress,256),alipay=clean(supplier.alipayAccount,64),alipayQr=clean(supplier.alipayQrcodeUrl,255),wechat=clean(supplier.wechat,15),wechatQr=clean(supplier.wechatQrcodeUrl,255);
 return validateExtractSource({version:'supplier-extract-application-source-v1',supplier_id:supplierId,available:extractDecimal(balance>0n?balance:0n),min_price:extractConfigAmount(values.get('supplier_extract_min_price')),max_price:extractConfigAmount(values.get('supplier_extract_max_price')),
  accounts:{bank:{bank_code,bank_address,ready:!!bank_code&&bank_code!=='0'&&!!bank_address},alipay:{account:alipay,qrcode_url:alipayQr,ready:!!alipay&&!!alipayQr},weixin:{account:wechat,qrcode_url:wechatQr,ready:!!wechat&&!!wechatQr}}});
}
export class SupplierExtractApplicationService {
 constructor(private readonly container:Container,private readonly appKey:string){}
 private async transaction<T>(actor:SupplierVideoActor,write:boolean,run:(tx:DbClient)=>Promise<T>) {
  try{return await withTx(this.container,async tx=>{
   await tx.execute(sql.raw(write?'SET TRANSACTION ISOLATION LEVEL READ COMMITTED':'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'));
   await tx.execute(sql`SELECT set_config('lock_timeout','2000ms',true),set_config('statement_timeout','5000ms',true)`);
   await assertSupplierExtractApplicationReady(tx,write?'write':'read');await businessReady(tx,write);await assertSupplierVideoAuthority(tx,actor,null);
   if(write)await authority(tx,actor);const result=await run(tx);await assertSupplierVideoAuthority(tx,actor,null);return result;
  });}catch(error){return failure(error);}
 }
 async seed(value:SupplierVideoActor) {
  const actor=Object.freeze({...value});return this.transaction(actor,false,async tx=>{
   await assertSupplierVideoAuthority(tx,actor,'supplier.finance.view');const actual=await source(tx,actor.supplierId);
   return{version:'supplier-extract-application-seed-v1' as const,actor_id:actor.id,supplier_id:actor.supplierId,revision:extractRevision(this.appKey,actual,actor),available:actual.available,min_price:actual.min_price,max_price:actual.max_price,accounts:actual.accounts,can_apply:canApply(actual)};
  });
 }
 async execute(body:unknown,value:SupplierVideoActor) {
  const actor=Object.freeze({...value}),intent=extractIntent(body,actor),requestHash=extractHash(intent);
  return this.transaction(actor,true,async tx=>{
   await lockExtractOperation(tx,intent.operation_id);const old=await readExtractOperation(tx,intent.operation_id);
   if(old){extractReceipt(old,intent.operation_id,actor);if(old.state!=='committed'||old.request_hash!==requestHash)throw extractConflict('同一提现原操作不能更改正文或重用已封存请求');await verifyActualExtract(tx,old);return extractReceipt(old,intent.operation_id,actor);}
   await assertSupplierVideoAuthority(tx,actor,'supplier.finance.view');await assertSupplierVideoAuthority(tx,actor,'supplier.finance.manage');
   await lockSupplierFinance(tx,actor.supplierId);const actual=await source(tx,actor.supplierId);
   assertExtractRevision(intent.revision,extractRevision(this.appKey,actual,actor));
   if(!canApply(actual))throw new ValidateException('当前提现上下限或可用余额不允许申请');
   const amount=extractCents(intent.money),min=extractCents(actual.min_price)>0n?extractCents(actual.min_price):1n;
   if(amount<min||amount>extractCents(actual.max_price)||amount>extractCents(actual.available))throw new ValidateException('提现金额超出本次上下限或可提现余额');
   if(!actual.accounts[intent.extract_type].ready)throw new ValidateException('请先设置所选收款账号及完整银行或收款码信息');
   const balance=extractMoney(extractDecimal(extractCents(actual.available)-amount),10),createdAt=await now(tx);
   const account={bankCode:'',bankAddress:'',alipayAccount:'',wechat:'',qrcodeUrl:''};
   if(intent.extract_type==='bank'){account.bankCode=actual.accounts.bank.bank_code;account.bankAddress=actual.accounts.bank.bank_address;}
   else{account[intent.extract_type==='alipay'?'alipayAccount':'wechat']=actual.accounts[intent.extract_type].account;account.qrcodeUrl=actual.accounts[intent.extract_type].qrcode_url;}
   const[written]=await tx.insert(supplierExtract).values({supplierId:actor.supplierId,extractType:intent.extract_type,extractPrice:intent.money,balance,supplierMark:intent.mark,status:0,payStatus:0,addTime:createdAt,...account}).returning();extractFact(written);
   const result:ExtractApplicationResult={id:written.id,extract_type:intent.extract_type,extract_price:intent.money,balance,bank_code:account.bankCode,bank_address:account.bankAddress,alipay_account:account.alipayAccount,wechat:account.wechat,qrcode_url:account.qrcodeUrl,supplier_mark:intent.mark,status:0,pay_status:0,add_time:createdAt};
   const saved=await appendExtractOperation(tx,{operation_id:intent.operation_id,actor_id:actor.id,supplier_id:actor.supplierId,extract_id:written.id,state:'committed',request_hash:requestHash,intent,source:actual,source_hash:extractHash(actual),result,result_hash:extractHash(result),created_at:createdAt});
   await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);await verifyActualExtract(tx,saved);
   const reread=await readExtractOperation(tx,intent.operation_id);extractFact(reread&&extractHash(reread)===extractHash(saved));
   await assertSupplierVideoAuthority(tx,actor,'supplier.finance.view');await assertSupplierVideoAuthority(tx,actor,'supplier.finance.manage');return extractReceipt(saved,intent.operation_id,actor);
  });
 }
 async receipt(value:string,actor:SupplierVideoActor) {const uuid=extractUuid(value);return this.transaction(actor,false,async tx=>{const row=await readExtractOperation(tx,uuid);if(row&&(row.actor_id!==actor.id||row.supplier_id!==actor.supplierId))return extractReceipt(undefined,uuid,actor);if(row)await verifyActualExtract(tx,row);return extractReceipt(row,uuid,actor);});}
 async resolve(value:string,actor:SupplierVideoActor) {const uuid=extractUuid(value);return this.transaction(actor,true,async tx=>{
  await lockExtractOperation(tx,uuid);const row=await readExtractOperation(tx,uuid);if(row){extractReceipt(row,uuid,actor);await verifyActualExtract(tx,row);return extractReceipt(row,uuid,actor);}
  const empty:ExtractOperation={operation_id:uuid,actor_id:actor.id,supplier_id:actor.supplierId,extract_id:null,state:'not_applied',request_hash:'',intent:null,source:null,source_hash:'',result:null,result_hash:'',created_at:await now(tx)};
  return extractReceipt(await appendExtractOperation(tx,empty),uuid,actor);
 });}
}
