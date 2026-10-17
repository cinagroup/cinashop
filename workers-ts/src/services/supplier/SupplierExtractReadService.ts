/** Supplier withdrawal history and shared descriptive notes. This module never
 * admits an application, approves a withdrawal, or confirms a bank transfer. */
import {and,asc,desc,eq,getTableColumns,gte,inArray,lte,sql,type SQL} from 'drizzle-orm';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {supplierExtract,supplierFlowingWater,systemAdmin,systemConfig,systemMenus,systemRole,systemSupplier} from '@/models/schema';
import {HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {normalizeConfigScalar} from '@/utils/config';
import {parseSupplierBillDates} from './SupplierBillReadService';
import {supplierReadIdentity,supplierReadSnapshot} from './SupplierReadSupport';
import {assertSupplierVideoAuthority,type SupplierVideoActor} from './SupplierVideoAuthority';

export type SupplierExtractParameters=Record<string,string|undefined>;
export type SupplierExtractHistoryQuery={modern:boolean;status:''|'-1'|'0'|'1';pay_status:''|'0'|'1';extract_type:''|'bank'|'alipay'|'weixin';data:string;start:number|null;end:number|null;page:number;limit:number;offset:number};
const MAX_INT=2147483647,MAX_BYTES=2*1024*1024,REVISION=/^[a-f0-9]{64}$/;
const columns={...getTableColumns(supplierExtract),rowVersion:sql<string>`${supplierExtract}.xmin::text`};
const fail=(message:string):never=>{throw new ValidateException(message);};
function allowed(value:SupplierExtractParameters,keys:readonly string[]) {
 for(const [key,item]of Object.entries(value))if(!keys.includes(key)||typeof item!=='string')fail('提现记录查询参数未知');
}
function positive(value:string|undefined,label:string,fallback:number,maximum=MAX_INT) {
 if(value===undefined||value==='')return fallback;
 if(!/^[1-9]\d{0,9}$/.test(value))return fail(label+'无效');
 const result=Number(value);if(!Number.isSafeInteger(result)||result>maximum)return fail(label+'超出范围');return result;
}
export function parseSupplierExtractHistoryQuery(parameters:SupplierExtractParameters):SupplierExtractHistoryQuery {
 const modern=parameters.selection!==undefined;
 if(modern){if(parameters.selection!=='history')fail('提现记录选择方式无效');allowed(parameters,['selection','status','pay_status','extract_type','data','page','limit']);}
 const status=parameters.status??'',pay=parameters.pay_status??'',rawType=parameters.extract_type??'',type=rawType==='wx'?'weixin':rawType;
 if(modern&&(!['','-1','0','1'].includes(status)||!['','0','1'].includes(pay)||!['','bank','alipay','weixin'].includes(type)))fail('提现记录筛选值无效');
 let page:number,limit:number;
 if(modern){page=positive(parameters.page,'页码',1);limit=positive(parameters.limit,'每页条数',20,100);}
 else{const p=Number(parameters.page??'1'),l=Number(parameters.limit??'20');page=Number.isInteger(p)&&p>0?p:1;limit=Number.isInteger(l)&&l>0?Math.min(l,100):20;}
 const offset=(page-1)*limit;if(!Number.isSafeInteger(offset)||offset>MAX_INT)fail('提现记录分页超出范围');
 return{modern,status:['-1','0','1'].includes(status)?status as '-1'|'0'|'1':'',pay_status:pay==='0'||pay==='1'?pay:'',
  extract_type:['bank','alipay','weixin'].includes(type)?type as 'bank'|'alipay'|'weixin':'',...parseSupplierBillDates(parameters.data),page,limit,offset};
}
export function parseSupplierExtractMarkInput(value:unknown) {
 if(!value||typeof value!=='object'||Array.isArray(value))return fail('提现备注格式错误');
 const input=value as Record<string,unknown>,modern=Object.hasOwn(input,'selection'),keys=modern?['selection','mark','expected_revision']:['mark'];
 if(Object.keys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key))||modern&&input.selection!=='history')fail('提现备注字段错误');
 if(typeof input.mark!=='string')return fail('请输入备注');
 const mark=input.mark.trim();
 // Both public realms edit supplier_mark. Preserve the established Admin
 // contract so a Supplier note remains a valid expected_supplier_mark there.
 if(!mark||[...mark].length>255||/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(mark))fail('提现备注须为1至255个字符');
 if(modern&&(typeof input.expected_revision!=='string'||!REVISION.test(input.expected_revision)))fail('提现备注版本无效，请刷新后重试');
 return{modern,mark,expectedRevision:modern?input.expected_revision as string:undefined};
}
export async function supplierExtractRevision(supplierId:number,id:number,rowVersion:string) {
 supplierReadIdentity(supplierId);supplierReadIdentity(id);if(!/^\d{1,20}$/.test(rowVersion))return fail('提现备注版本无法核对');
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([supplierId,id,rowVersion])));
 return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function supplierExtractConfigAmount(value:string|undefined) {
 const text=normalizeConfigScalar(value);if(!text)return '0.00';
 if(!/^\d{1,18}(?:\.\d{1,2})?$/.test(text))throw new ServiceUnavailableException('提现上下限配置无法核对');
 const [whole,fraction='']=text.split('.');return `${BigInt(whole)}.${fraction.padEnd(2,'0')}`;
}
function minor(value:string):bigint {
 if(!/^-?(?:0|[1-9]\d{0,17})\.\d{2}$/.test(value)||value==='-0.00')throw new ServiceUnavailableException('提现金额汇总无法核对');
 return BigInt(value.replace('.',''));
}
const decimal=(value:bigint)=>`${value<0n?'-':''}${(value<0n?-value:value)/100n}.${String((value<0n?-value:value)%100n).padStart(2,'0')}`;
const displayTime=(value:number)=>value?new Date((value+28800)*1000).toISOString().slice(0,19).replace('T',' '):'';
function checked<T>(value:T):T {if(new TextEncoder().encode(JSON.stringify(value)).byteLength>MAX_BYTES)fail('提现记录响应超过2MiB，请缩小范围');return value;}
async function detail(row:typeof supplierExtract.$inferSelect&{rowVersion:string},adminName:string|null) {
 return{id:row.id,supplier_id:row.supplierId,extract_type:row.extractType,bank_code:row.bankCode,bank_address:row.bankAddress,
  alipay_account:row.alipayAccount,wechat:row.wechat,qrcode_url:row.qrcodeUrl,extract_price:row.extractPrice,balance:row.balance,
  supplier_mark:row.supplierMark,status:row.status,pay_status:row.payStatus,admin_id:row.adminId,admin_name:row.adminId?adminName??'':'',
  fail_msg:row.failMsg,fail_time:displayTime(row.failTime),voucher_image:row.voucherImage,voucher_title:row.voucherTitle,
  pay_time:displayTime(row.payTime),add_time:displayTime(row.addTime),revision:await supplierExtractRevision(row.supplierId,row.id,row.rowVersion)};
}
async function markResult(row:typeof supplierExtract.$inferSelect&{rowVersion:string}) {
 return{version:'supplier-extract-mark-v1' as const,supplier_id:row.supplierId,id:row.id,supplier_mark:row.supplierMark,
  revision:await supplierExtractRevision(row.supplierId,row.id,row.rowVersion),bounded:true as const};
}
function failed(error:unknown):never {
 let cause=error;for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++) {
  const code='code'in cause?String(cause.code):'';
  if(['55P03','40P01','40001'].includes(code))throw new HttpApiException('提现记录或权限正在变化，请重新核对备注',409,409);
  if(['42501','57014'].includes(code))throw new ServiceUnavailableException('提现记录运行权限或处理时限尚未就绪');
  cause='cause'in cause?cause.cause:undefined;
 }throw error;
}
/** Same real-row authorization barrier as the established Supplier note writer.
 * UPDATE(id) on authority tables qualifies locks; no authority row is written. */
async function lockAuthority(tx:DbClient,actor:SupplierVideoActor) {
 await assertSupplierVideoAuthority(tx,actor,'supplier.finance.manage');
 const[admin]=await tx.select().from(systemAdmin).where(and(eq(systemAdmin.id,actor.id),eq(systemAdmin.adminType,4),eq(systemAdmin.relationId,actor.supplierId),eq(systemAdmin.status,1),eq(systemAdmin.isDel,0))).limit(1).for('share',{noWait:true});
 const[supplier]=await tx.select().from(systemSupplier).where(and(eq(systemSupplier.id,actor.supplierId),eq(systemSupplier.isShow,1),eq(systemSupplier.isDel,0))).limit(1).for('share',{noWait:true});
 if(!admin||!supplier){await assertSupplierVideoAuthority(tx,actor,'supplier.finance.manage');throw new HttpApiException('供应商权限已变化',409,409);}
 if(admin.id!==supplier.adminId){
  const numeric=(raw:string)=>{const tokens=[...new Set(raw.split(',').map(value=>value.trim()).filter(Boolean))];if(tokens.length>512)fail('供应商权限目录超出范围');return tokens.filter(value=>/^[1-9]\d*$/.test(value)).map(Number).filter(value=>Number.isSafeInteger(value)&&value<=MAX_INT).sort((a,b)=>a-b);};
  const ids=numeric(admin.roles),roles=ids.length?await tx.select().from(systemRole).where(and(inArray(systemRole.id,ids),eq(systemRole.type,4),eq(systemRole.relationId,actor.supplierId),eq(systemRole.status,1))).orderBy(asc(systemRole.id)).for('share',{noWait:true}):[];
  const menus=[...new Set(roles.flatMap(role=>numeric(role.rules)))].sort((a,b)=>a-b);if(menus.length>512)fail('供应商权限目录超出范围');
  if(menus.length)await tx.select({id:systemMenus.id}).from(systemMenus).where(and(inArray(systemMenus.id,menus),eq(systemMenus.type,4),eq(systemMenus.authType,2),eq(systemMenus.access,1),eq(systemMenus.isDel,0))).orderBy(asc(systemMenus.id)).for('share',{noWait:true});
 }
 await assertSupplierVideoAuthority(tx,actor,'supplier.finance.manage');
}
export class SupplierExtractReadService {
 constructor(private readonly container:Container){}
 async list(supplierId:number,parameters:SupplierExtractParameters) {
  supplierReadIdentity(supplierId);const query=parseSupplierExtractHistoryQuery(parameters),base:SQL[]=[eq(supplierExtract.supplierId,supplierId)];
  if(query.extract_type)base.push(eq(supplierExtract.extractType,query.extract_type));
  if(query.start!==null)base.push(gte(supplierExtract.addTime,query.start));if(query.end!==null)base.push(lte(supplierExtract.addTime,query.end));
  const filters=[...base];if(query.status!=='')filters.push(eq(supplierExtract.status,Number(query.status)));if(query.pay_status!=='')filters.push(eq(supplierExtract.payStatus,Number(query.pay_status)));
  try{return await supplierReadSnapshot(this.container,async tx=>{
   const[total]=await tx.select({count:sql<string>`count(*)::text`}).from(supplierExtract).where(and(...filters));
   const count=Number(total?.count??0);if(!Number.isSafeInteger(count)||count<0||count>MAX_INT)fail('提现记录数量超出可分页范围');
   const rows=await tx.select({extract:columns,adminName:systemAdmin.realName}).from(supplierExtract).leftJoin(systemAdmin,eq(systemAdmin.id,supplierExtract.adminId))
    .where(and(...filters)).orderBy(desc(supplierExtract.id)).limit(query.limit).offset(query.offset);
   const[stats]=await tx.select({
    pendingReview:sql<string>`coalesce(sum(CASE WHEN ${supplierExtract.status}=0 ${query.pay_status===''?sql``:sql`AND ${supplierExtract.payStatus}=${Number(query.pay_status)}`} THEN ${supplierExtract.extractPrice} ELSE 0 END),0)::numeric(20,2)::text`,
    pendingTransfer:sql<string>`coalesce(sum(CASE WHEN ${supplierExtract.status}=1 AND ${supplierExtract.payStatus}=0 THEN ${supplierExtract.extractPrice} ELSE 0 END),0)::numeric(20,2)::text`,
    paid:sql<string>`coalesce(sum(CASE WHEN ${supplierExtract.status}=1 AND ${supplierExtract.payStatus}=1 THEN ${supplierExtract.extractPrice} ELSE 0 END),0)::numeric(20,2)::text`,
   }).from(supplierExtract).where(and(...base));
   const[flow]=await tx.select({
    income:sql<string>`coalesce(sum(CASE WHEN ${supplierFlowingWater.status}=1 AND ${supplierFlowingWater.pm}=1 THEN ${supplierFlowingWater.number} ELSE 0 END),0)::numeric(20,2)::text`,
    expense:sql<string>`coalesce(sum(CASE WHEN ${supplierFlowingWater.status}=1 AND ${supplierFlowingWater.pm}=0 THEN ${supplierFlowingWater.number} ELSE 0 END),0)::numeric(20,2)::text`,
    pending:sql<string>`coalesce(sum(CASE WHEN ${supplierFlowingWater.status}=0 THEN CASE WHEN ${supplierFlowingWater.pm}=1 THEN ${supplierFlowingWater.number} ELSE -${supplierFlowingWater.number} END ELSE 0 END),0)::numeric(20,2)::text`,
    refund:sql<string>`coalesce(sum(CASE WHEN ${supplierFlowingWater.status} IN(0,1) AND ${supplierFlowingWater.pm}=0 THEN ${supplierFlowingWater.number} ELSE 0 END),0)::numeric(20,2)::text`,
   }).from(supplierFlowingWater).where(and(eq(supplierFlowingWater.supplierId,supplierId),eq(supplierFlowingWater.isDel,0)));
   const[all]=await tx.select({reserved:sql<string>`coalesce(sum(CASE WHEN ${supplierExtract.status}<>-1 THEN ${supplierExtract.extractPrice} ELSE 0 END),0)::numeric(20,2)::text`,
    pending:sql<string>`coalesce(sum(CASE WHEN ${supplierExtract.status}=0 THEN ${supplierExtract.extractPrice} ELSE 0 END),0)::numeric(20,2)::text`,
    paid:sql<string>`coalesce(sum(CASE WHEN ${supplierExtract.status}=1 AND ${supplierExtract.payStatus}=1 THEN ${supplierExtract.extractPrice} ELSE 0 END),0)::numeric(20,2)::text`,
   }).from(supplierExtract).where(eq(supplierExtract.supplierId,supplierId));
   const available=minor(flow.income)-minor(flow.expense)-minor(all.reserved),withdrawable=decimal(available>0n?available:0n);
   const list=await Promise.all(rows.map(async({extract,adminName})=>{const modern=await detail(extract,adminName);if(query.modern)return modern;const{rowVersion:_version,...legacy}=extract;return{...legacy,...modern};}));
   if(!query.modern)return checked({list,count,page:query.page,limit:query.limit,extract_statistics:{available:withdrawable,pending_settlement:flow.pending,total_income:flow.income,total_refund:flow.refund,pending_extract:all.pending,paid_extract:all.paid}});
   const config=await tx.selectDistinctOn([systemConfig.menuName],{menuName:systemConfig.menuName,value:systemConfig.value}).from(systemConfig)
    .where(and(eq(systemConfig.isStore,0),inArray(systemConfig.menuName,['supplier_extract_min_price','supplier_extract_max_price'])))
    .orderBy(asc(systemConfig.menuName),desc(systemConfig.sort),desc(systemConfig.id));
   const values=new Map(config.map(row=>[row.menuName,row.value]));
   return checked({version:'supplier-extract-v1' as const,selection:'history' as const,supplier_id:supplierId,status:query.status,pay_status:query.pay_status,extract_type:query.extract_type,data:query.data,
    page:query.page,limit:query.limit,bounded:true as const,list,count,statistics:{pending_review:stats.pendingReview,pending_transfer:stats.pendingTransfer,paid:stats.paid,withdrawable,
     extract_min_price:supplierExtractConfigAmount(values.get('supplier_extract_min_price')),extract_max_price:supplierExtractConfigAmount(values.get('supplier_extract_max_price'))}});
  });}catch(error){return failed(error);}
 }
 async mark(supplierId:number,id:number,parameters:SupplierExtractParameters) {
  supplierReadIdentity(supplierId);supplierReadIdentity(id);allowed(parameters,['selection']);if(parameters.selection!=='history')fail('提现记录选择方式无效');
  return supplierReadSnapshot(this.container,async tx=>{const[row]=await tx.select(columns).from(supplierExtract).where(and(eq(supplierExtract.id,id),eq(supplierExtract.supplierId,supplierId))).limit(1);
   if(!row)throw new NotFoundException('提现记录不存在或不属于当前供应商');return checked(await markResult(row));});
 }
 async updateMark(supplierId:number,id:number,value:unknown,identity:SupplierVideoActor) {
  supplierReadIdentity(supplierId);supplierReadIdentity(id);const input=parseSupplierExtractMarkInput(value),actor=Object.freeze({...identity});if(actor.supplierId!==supplierId)fail('提现备注供应商身份不一致');
  try{return await withTx(this.container,async tx=>{
   await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
   await tx.execute(sql`SELECT set_config('lock_timeout','2000ms',true),set_config('statement_timeout','5000ms',true)`);
   await lockAuthority(tx,actor);
   const[row]=await tx.select(columns).from(supplierExtract).where(and(eq(supplierExtract.id,id),eq(supplierExtract.supplierId,supplierId))).limit(1).for('update');
   if(!row)throw new NotFoundException('提现记录不存在或不属于当前供应商');
   if(input.expectedRevision!==undefined&&input.expectedRevision!==await supplierExtractRevision(supplierId,id,row.rowVersion))throw new HttpApiException('提现记录已变化，请刷新后重试',409,409);
   let current=row;if(input.mark!==row.supplierMark){const[updated]=await tx.update(supplierExtract).set({supplierMark:input.mark}).where(and(eq(supplierExtract.id,id),eq(supplierExtract.supplierId,supplierId),sql`${supplierExtract}.xmin::text=${row.rowVersion}`)).returning(columns);
    if(!updated)throw new HttpApiException('提现记录已变化，请刷新后重试',409,409);current=updated;}
   await assertSupplierVideoAuthority(tx,actor,'supplier.finance.manage');return input.modern?checked(await markResult(current)):null;
  });}catch(error){return failed(error);}
 }
}
