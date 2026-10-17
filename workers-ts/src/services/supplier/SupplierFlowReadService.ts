/** Supplier ledger reads and descriptive notes. Tenant identity is supplied by
 * authentication; client input cannot select another supplier or any money field. */
import {and,asc,desc,eq,getTableColumns,gte,ilike,inArray,isNull,lte,or,sql,type SQL} from 'drizzle-orm';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {supplierFlowingWater,systemAdmin,systemSupplier,systemRole,systemMenus,user} from '@/models/schema';
import {HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {parseSupplierBillDates} from './SupplierBillReadService';
import {supplierReadIdentity,supplierReadSnapshot} from './SupplierReadSupport';
import {assertSupplierVideoAuthority,type SupplierVideoActor} from './SupplierVideoAuthority';

export type SupplierFlowParameters=Record<string,string|undefined>;
export type SupplierFlowQuery={modern:boolean;type:''|'1'|'2';keyword:string;data:string;start:number|null;end:number|null;page:number;limit:number;offset:number};
const MAX_INT=2147483647,MAX_BYTES=2*1024*1024,REVISION=/^[a-f0-9]{64}$/;
const columns={...getTableColumns(supplierFlowingWater),rowVersion:sql<string>`${supplierFlowingWater}.xmin::text`};
const fail=(message:string):never=>{throw new ValidateException(message);};
function allowed(value:SupplierFlowParameters,keys:readonly string[]) {
 for(const [key,item]of Object.entries(value))if(!keys.includes(key)||typeof item!=='string')fail('资金流水查询参数未知');
}
function positive(value:string|undefined,label:string,fallback:number,maximum=MAX_INT) {
 if(value===undefined||value==='')return fallback;
 if(!/^[1-9]\d{0,9}$/.test(value))return fail(label+'无效');
 const result=Number(value);if(!Number.isSafeInteger(result)||result>maximum)return fail(label+'超出范围');return result;
}
export function parseSupplierFlowQuery(parameters:SupplierFlowParameters):SupplierFlowQuery {
 const modern=parameters.selection!==undefined;if(modern){if(parameters.selection!=='ledger')fail('资金流水选择方式无效');allowed(parameters,['selection','type','keyword','data','page','limit']);}
 const type=parameters.type??'';if(modern&&!['','1','2'].includes(type))fail('资金流水类型无效');
 const keyword=(parameters.keyword??'').trim();if([...keyword].length>80||/[\u0000-\u001f\u007f]/u.test(keyword))fail('资金流水搜索词无效');
 let page:number,limit:number;
 if(modern){page=positive(parameters.page,'页码',1);limit=positive(parameters.limit,'每页条数',20,100);}
 else{const p=Number(parameters.page??'1'),l=Number(parameters.limit??'20');page=Number.isInteger(p)&&p>0?p:1;limit=Number.isInteger(l)&&l>0?Math.min(l,100):20;}
 const offset=(page-1)*limit;if(!Number.isSafeInteger(offset)||offset>MAX_INT)fail('资金流水分页超出范围');
 return {modern,type:type==='1'||type==='2'?type:'',keyword,...parseSupplierBillDates(parameters.data),page,limit,offset};
}
export function parseSupplierFlowMarkInput(value:unknown) {
 if(!value||typeof value!=='object'||Array.isArray(value))return fail('资金流水备注格式错误');
 const input=value as Record<string,unknown>,modern=Object.hasOwn(input,'selection');
 const keys=modern?['selection','mark','expected_revision']:['mark'];
 if(Object.keys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key))||modern&&input.selection!=='ledger')fail('资金流水备注字段错误');
 if(typeof input.mark!=='string')return fail('请输入备注');
 const mark=input.mark.trim();if(!mark||[...mark].length>255||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(mark))fail('备注须为1至255个字符');
 if(modern&&(typeof input.expected_revision!=='string'||!REVISION.test(input.expected_revision)))fail('流水版本无效，请刷新后重试');
 return {modern,mark,expectedRevision:modern?input.expected_revision as string:undefined};
}
export async function supplierFlowRevision(supplierId:number,id:number,rowVersion:string) {
 supplierReadIdentity(supplierId);supplierReadIdentity(id);if(!/^\d{1,20}$/.test(rowVersion))return fail('流水版本无法核对');
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([supplierId,id,rowVersion])));
 return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
const displayTime=(value:number)=>value?new Date((value+28800)*1000).toISOString().slice(0,19).replace('T',' '):'';
const payTypes:Record<string,string>={weixin:'微信支付',yue:'余额支付',offline:'线下支付',alipay:'支付宝支付',cash:'现金支付',automatic:'自动转账',store:'微信支付'};
async function rowDetail(row:typeof supplierFlowingWater.$inferSelect&{rowVersion:string},nickname:string|null) {
 return {id:row.id,supplier_id:row.supplierId,uid:row.uid,order_id:row.orderId,link_id:row.linkId,pm:row.pm,number:row.number,
  type:row.type,pay_type:row.payType,status:row.status,mark:row.mark,remark:row.remark,add_time:displayTime(row.addTime),
  trade_time:displayTime(row.tradeTime||row.addTime),finish_time:displayTime(row.finishTime),user_nickname:nickname||'游客',
  type_name:row.type===1?'支付订单':row.type===2?'退款订单':'其他类型',pay_type_name:Object.hasOwn(payTypes,row.payType)?payTypes[row.payType]:'其他方式',
  is_del:0 as const,revision:await supplierFlowRevision(row.supplierId,row.id,row.rowVersion)};
}
function checked<T>(value:T):T {if(new TextEncoder().encode(JSON.stringify(value)).byteLength>MAX_BYTES)fail('资金流水响应超过2MiB，请缩小范围');return value;}
async function markResult(row:typeof supplierFlowingWater.$inferSelect&{rowVersion:string}) {
 return {version:'supplier-flow-mark-v1' as const,supplier_id:row.supplierId,id:row.id,mark:row.mark,
  revision:await supplierFlowRevision(row.supplierId,row.id,row.rowVersion),bounded:true as const};
}
function failed(error:unknown):never {
 let cause=error;for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++) {
  const code='code'in cause?String(cause.code):'';
  if(['55P03','40P01','40001'].includes(code))throw new HttpApiException('流水或权限正在变化，请重新核对备注',409,409);
  if(['42501','57014'].includes(code))throw new ServiceUnavailableException('流水备注运行权限或处理时限尚未就绪');
  cause='cause'in cause?cause.cause:undefined;
 }throw error;
}
/** Lock exactly the authority rows used by the established permission reader.
 * Row SHARE locks accept the fixture's UPDATE(id) qualification without broad
 * table UPDATE grants. Existing roles/menus cannot be revoked until commit. */
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
export class SupplierFlowReadService {
 constructor(private readonly container:Container){}
 async list(supplierId:number,parameters:SupplierFlowParameters) {
  supplierReadIdentity(supplierId);const query=parseSupplierFlowQuery(parameters),conditions:SQL[]=[eq(supplierFlowingWater.supplierId,supplierId),eq(supplierFlowingWater.isDel,0)];
  if(query.type)conditions.push(eq(supplierFlowingWater.type,Number(query.type)));
  if(query.start!==null)conditions.push(gte(supplierFlowingWater.addTime,query.start));
  if(query.end!==null)conditions.push(lte(supplierFlowingWater.addTime,query.end));
  if(query.keyword){const pattern=`%${query.keyword.replace(/[\\%_]/g,'\\$&')}%`;conditions.push(or(ilike(supplierFlowingWater.orderId,pattern),ilike(supplierFlowingWater.linkId,pattern),
   sql`EXISTS(SELECT 1 FROM "user" flow_user WHERE flow_user.uid=${supplierFlowingWater.uid} AND flow_user.delete_time IS NULL AND(flow_user.nickname ILIKE ${pattern} OR flow_user.uid::text ILIKE ${pattern}))`)!);}
  return supplierReadSnapshot(this.container,async tx=>{
   const where=and(...conditions),[total]=await tx.select({count:sql<string>`count(*)::text`}).from(supplierFlowingWater).where(where);
   const count=Number(total?.count??0);if(!Number.isSafeInteger(count)||count<0||count>MAX_INT)fail('资金流水数量超出可分页范围');
   const rows=await tx.select({flow:columns,nickname:user.nickname}).from(supplierFlowingWater).leftJoin(user,and(eq(user.uid,supplierFlowingWater.uid),isNull(user.deleteTime)))
    .where(where).orderBy(desc(supplierFlowingWater.id)).limit(query.limit).offset(query.offset);
   const list=await Promise.all(rows.map(async({flow,nickname})=>{const detail=await rowDetail(flow,nickname);if(query.modern)return detail;
    const {rowVersion:_version,...legacy}=flow;return {...legacy,...detail};}));
   return checked(query.modern?{version:'supplier-flow-v1' as const,selection:'ledger' as const,supplier_id:supplierId,type:query.type,keyword:query.keyword,data:query.data,
    page:query.page,limit:query.limit,bounded:true as const,list,count}:{list,count,page:query.page,limit:query.limit});
  });
 }
 async mark(supplierId:number,id:number,parameters:SupplierFlowParameters) {
  supplierReadIdentity(supplierId);supplierReadIdentity(id);allowed(parameters,['selection']);if(parameters.selection!=='ledger')fail('资金流水选择方式无效');
  return supplierReadSnapshot(this.container,async tx=>{const[row]=await tx.select(columns).from(supplierFlowingWater)
   .where(and(eq(supplierFlowingWater.id,id),eq(supplierFlowingWater.supplierId,supplierId),eq(supplierFlowingWater.isDel,0))).limit(1);
   if(!row)throw new NotFoundException('流水不存在或不属于当前供应商');return checked(await markResult(row));});
 }
 async updateMark(supplierId:number,id:number,value:unknown,identity:SupplierVideoActor) {
  supplierReadIdentity(supplierId);supplierReadIdentity(id);const input=parseSupplierFlowMarkInput(value),actor=Object.freeze({...identity});
  if(actor.supplierId!==supplierId)fail('流水备注供应商身份不一致');
  try{return await withTx(this.container,async tx=>{
   await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
   await tx.execute(sql`SELECT set_config('lock_timeout','2000ms',true),set_config('statement_timeout','5000ms',true)`);
   await lockAuthority(tx,actor);
   const[row]=await tx.select(columns).from(supplierFlowingWater).where(and(eq(supplierFlowingWater.id,id),eq(supplierFlowingWater.supplierId,supplierId),eq(supplierFlowingWater.isDel,0)))
    .limit(1).for('update');
   if(!row)throw new NotFoundException('流水不存在或不属于当前供应商');
   if(input.expectedRevision!==undefined&&input.expectedRevision!==await supplierFlowRevision(supplierId,id,row.rowVersion))throw new HttpApiException('流水备注已变化，请刷新后重试',409,409);
   let current=row;
   // A lost acknowledgement may be retried after an explicit refresh. An
   // identical note is a no-op and does not create a new xmin/revision.
   if(input.mark!==row.mark){const[updated]=await tx.update(supplierFlowingWater).set({mark:input.mark}).where(and(eq(supplierFlowingWater.id,id),eq(supplierFlowingWater.supplierId,supplierId),eq(supplierFlowingWater.isDel,0),sql`${supplierFlowingWater}.xmin::text=${row.rowVersion}`)).returning(columns);
    if(!updated)throw new HttpApiException('流水备注已变化，请刷新后重试',409,409);current=updated;}
   await assertSupplierVideoAuthority(tx,actor,'supplier.finance.manage');return input.modern?checked(await markResult(current)):null;
  });}catch(error){return failed(error);}
 }
}
