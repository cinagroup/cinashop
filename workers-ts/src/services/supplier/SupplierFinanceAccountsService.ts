/** Current Supplier payee settings. This is a reversible six-column mutation,
 * never a withdrawal, financial ledger write, or durable application receipt. */
import {createHmac,timingSafeEqual} from 'node:crypto';
import {and,asc,eq,getTableColumns,inArray,sql} from 'drizzle-orm';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {systemAdmin,systemMenus,systemRole,systemSupplier} from '@/models/schema';
import {HttpApiException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {classifyProductMediaReference} from '../../../../view/common/productMediaReference';
import {lockSupplierProductMedia,projectSupplierProductMedia} from './SupplierProductMediaService';
import {assertSupplierVideoAuthority,type SupplierVideoActor} from './SupplierVideoAuthority';

export const SUPPLIER_FINANCE_ACCOUNT_FIELDS=['bank_code','bank_address','alipay_account','alipay_qrcode_url','wechat','wechat_qrcode_url'] as const;
export type SupplierFinanceAccountField=typeof SUPPLIER_FINANCE_ACCOUNT_FIELDS[number];
export type SupplierFinanceAccounts=Record<SupplierFinanceAccountField,string>;
export interface SupplierFinanceAccountPreview {reference:string;status:'ready'|'unavailable';src:string;expires_at:number|null}
export interface SupplierFinanceAccountsContext {
 version:'supplier-finance-accounts-v1';actor_id:number;supplier_id:number;revision:string;accounts:SupplierFinanceAccounts;
 ready:{bank:boolean;alipay:boolean;weixin:boolean};previews:{alipay:SupplierFinanceAccountPreview;weixin:SupplierFinanceAccountPreview};bounded:true;
}
const limits:Record<SupplierFinanceAccountField,number>={bank_code:32,bank_address:256,alipay_account:64,alipay_qrcode_url:255,wechat:15,wechat_qrcode_url:255};
const names={bank_code:'bankCode',bank_address:'bankAddress',alipay_account:'alipayAccount',alipay_qrcode_url:'alipayQrcodeUrl',wechat:'wechat',wechat_qrcode_url:'wechatQrcodeUrl'} as const;
const projection={...getTableColumns(systemSupplier),rowVersion:sql<string>`${systemSupplier}.xmin::text`};
type Row=typeof systemSupplier.$inferSelect&{rowVersion:string};
const conflict=()=>new HttpApiException('收款资料或权限正在变化，请重新读取当前设置',409,409);
const unavailable=()=>new ServiceUnavailableException('收款资料、运行权限或实际保存结果尚未就绪');
const fact=(value:unknown)=>{if(!value)throw unavailable();};
function canonical(value:unknown):string {return JSON.stringify(value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,typeof (value as Record<string,unknown>)[k]==='object'&&(value as Record<string,unknown>)[k]!==null?JSON.parse(canonical((value as Record<string,unknown>)[k])):(value as Record<string,unknown>)[k]])):value);}
export function normalizeSupplierFinanceAccount(field:SupplierFinanceAccountField,value:unknown):string {
 if(typeof value!=='string'||/[\u0000-\u001f\u007f]/u.test(value)||[...value].some(c=>c.length===1&&c.charCodeAt(0)>=0xd800&&c.charCodeAt(0)<=0xdfff))throw new ValidateException('收款资料须为不含控制字符的Unicode文本');
 const text=value.trim();if([...text].length>limits[field])throw new ValidateException(`${field} 超过${limits[field]}个字符`);return text;
}
export function parseSupplierFinanceAccountsInput(value:unknown,modern:boolean) {
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new ValidateException('收款设置须为JSON对象');
 const body=value as Record<string,unknown>,keys=Reflect.ownKeys(body),allowed:readonly string[]=modern?[...SUPPLIER_FINANCE_ACCOUNT_FIELDS,'revision']:SUPPLIER_FINANCE_ACCOUNT_FIELDS;
 if(!keys.length||keys.some(k=>typeof k!=='string'||!allowed.includes(k)||!Object.hasOwn(Object.getOwnPropertyDescriptor(body,k)!,'value'))||modern&&(keys.length!==7||allowed.some(k=>!Object.hasOwn(body,k))))throw new ValidateException('收款设置字段不完整或含未知字段');
 if(modern&&(typeof body.revision!=='string'||!/^[a-f0-9]{64}$/.test(body.revision)))throw new ValidateException('收款设置版本无效');
 const accounts:Partial<SupplierFinanceAccounts>={};for(const field of SUPPLIER_FINANCE_ACCOUNT_FIELDS)if(Object.hasOwn(body,field))accounts[field]=normalizeSupplierFinanceAccount(field,body[field]);
 if(modern&&accounts.bank_code==='0')accounts.bank_code='';
 return{accounts,revision:modern?body.revision as string:undefined};
}
/** Expiring tickets and aliases are never new durable payee references. */
export function isSupplierFinanceAccountReference(reference:string):boolean {
 if(!reference)return true;
 const value=classifyProductMediaReference(reference);
 if(value.kind==='invalid')return false;
 if(value.kind==='asset')return reference===value.reference;
 const url=new URL(reference,'https://supplier-finance.invalid');
 return ![...url.searchParams.keys()].some(k=>/^(expires|signature)$/i.test(k));
}
function rawAccounts(row:Row):SupplierFinanceAccounts {return Object.fromEntries(SUPPLIER_FINANCE_ACCOUNT_FIELDS.map(field=>[field,row[names[field]]])) as SupplierFinanceAccounts;}
function accounts(row:Row):SupplierFinanceAccounts {
 try {const current=rawAccounts(row);for(const field of SUPPLIER_FINANCE_ACCOUNT_FIELDS)current[field]=normalizeSupplierFinanceAccount(field,current[field]);if(current.bank_code==='0')current.bank_code='';return current;}
 catch(cause){throw Object.assign(unavailable(),{cause});}
}
export function supplierFinanceAccountsRevision(key:string,actor:SupplierVideoActor,rowVersion:string,current:SupplierFinanceAccounts):string {
 if(!key||!/^\d{1,20}$/.test(rowVersion))throw unavailable();
 return createHmac('sha256',key).update('cinashop.supplier-finance-accounts.revision.v1\0').update(canonical({version:'supplier-finance-accounts-v1',actor_id:actor.id,supplier_id:actor.supplierId,auth_version:actor.authVersion,xmin:rowVersion,accounts:current})).digest('hex');
}
export async function assertSupplierFinanceAccountsReady(tx:DbClient,write=false,media=true) {
 const required=['system_admin','system_supplier','system_role','system_menus',...(media?['system_attachment']:[])];
 const[row]=await tx.execute(sql`SELECT current_user=session_user AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolbypassrls
  AND NOT has_schema_privilege(current_user,'public','CREATE')
  AND NOT EXISTS(WITH RECURSIVE parents(oid) AS(SELECT r.oid UNION SELECT m.roleid FROM pg_auth_members m JOIN parents p ON p.oid=m.member)
   SELECT 1 FROM parents p JOIN pg_roles unsafe ON unsafe.oid=p.oid WHERE unsafe.rolsuper OR unsafe.rolcreaterole OR unsafe.rolcreatedb OR unsafe.rolreplication OR unsafe.rolbypassrls)
  AND(SELECT count(*)=${required.length} AND bool_and(c.relkind='r' AND has_table_privilege(current_user,c.oid,'SELECT')) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN(${sql.join(required.map(n=>sql`${n}`),sql`, `)}))
  AND(${!write} OR(has_any_column_privilege(current_user,'public.system_admin','UPDATE') AND has_any_column_privilege(current_user,'public.system_role','UPDATE') AND has_any_column_privilege(current_user,'public.system_menus','UPDATE')
   AND(SELECT bool_and(has_column_privilege(current_user,'public.system_supplier',n,'UPDATE')) FROM unnest(ARRAY['bank_code','bank_address','alipay_account','alipay_qrcode_url','wechat','wechat_qrcode_url']) n))) AS ready
  FROM pg_roles r WHERE r.rolname=current_user`);fact(row?.ready===true);
}
async function readRow(tx:DbClient,supplierId:number,lock=false):Promise<Row> {
 const query=tx.select(projection).from(systemSupplier).where(and(eq(systemSupplier.id,supplierId),eq(systemSupplier.isShow,1),eq(systemSupplier.isDel,0))).limit(1);
 const[row]=lock?await query.for('update',{noWait:true}):await query;fact(row);return row!;
}
async function lockAuthority(tx:DbClient,actor:SupplierVideoActor):Promise<Row> {
 await assertSupplierVideoAuthority(tx,actor,'supplier.finance.manage');
 const[admin]=await tx.select().from(systemAdmin).where(and(eq(systemAdmin.id,actor.id),eq(systemAdmin.adminType,4),eq(systemAdmin.relationId,actor.supplierId),eq(systemAdmin.status,1),eq(systemAdmin.isDel,0))).limit(1).for('share',{noWait:true});fact(admin);
 // UPDATE first, never SHARE -> finance mutex -> UPDATE. The withdrawal
 // admission keeps SHARE on this same row until its source/receipt commits.
 const supplier=await readRow(tx,actor.supplierId,true);
 if(admin!.id!==supplier.adminId){
  const ids=(raw:string)=>{const tokens=[...new Set(raw.split(',').map(x=>x.trim()).filter(Boolean))];if(tokens.length>512)throw new ValidateException('收款权限目录超出范围');return tokens.filter(x=>/^[1-9]\d*$/.test(x)).map(Number).filter(x=>Number.isSafeInteger(x)&&x<=2147483647).sort((a,b)=>a-b);};
  const roleIds=ids(admin!.roles),roles=roleIds.length?await tx.select().from(systemRole).where(and(inArray(systemRole.id,roleIds),eq(systemRole.type,4),eq(systemRole.relationId,actor.supplierId),eq(systemRole.status,1))).orderBy(asc(systemRole.id)).for('share',{noWait:true}):[];
  const menuIds=[...new Set(roles.flatMap(r=>ids(r.rules)))].sort((a,b)=>a-b);if(menuIds.length>512)throw new ValidateException('收款权限目录超出范围');
  if(menuIds.length)await tx.select({id:systemMenus.id}).from(systemMenus).where(and(inArray(systemMenus.id,menuIds),eq(systemMenus.type,4),eq(systemMenus.authType,2),eq(systemMenus.access,1),eq(systemMenus.isDel,0))).orderBy(asc(systemMenus.id)).for('share',{noWait:true});
 }
 await assertSupplierVideoAuthority(tx,actor,'supplier.finance.manage');return supplier;
}
function failed(error:unknown):never {let cause=error;for(let n=0;n<8&&cause&&typeof cause==='object';n++){
 const code='code'in cause?String(cause.code):'';if(['55P03','40P01','40001'].includes(code))throw conflict();if(['42501','57014','42P01','42703','22001','22021'].includes(code))throw Object.assign(unavailable(),{cause:error});cause='cause'in cause?cause.cause:undefined;
 }throw error;}
export class SupplierFinanceAccountsService {
 constructor(private readonly container:Container,private readonly appKey:string){}
 private async transaction<T>(actor:SupplierVideoActor,write:boolean,modern:boolean,run:(tx:DbClient,row:Row)=>Promise<T>):Promise<T> {
  try{return await withTx(this.container,async tx=>{
   await tx.execute(sql.raw(write?'SET TRANSACTION ISOLATION LEVEL READ COMMITTED':'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'));
   await tx.execute(sql`SELECT set_config('lock_timeout','2000ms',true),set_config('statement_timeout','5000ms',true)`);
   await assertSupplierFinanceAccountsReady(tx,write,modern);await assertSupplierVideoAuthority(tx,actor,write?'supplier.finance.manage':'supplier.finance.view');
   const row=write?await lockAuthority(tx,actor):await readRow(tx,actor.supplierId),result=await run(tx,row);
   await assertSupplierVideoAuthority(tx,actor,write?'supplier.finance.manage':'supplier.finance.view');return result;
  });}catch(error){return failed(error);}
 }
 private async project(tx:DbClient,row:Row,actor:SupplierVideoActor):Promise<SupplierFinanceAccountsContext> {
  const values=accounts(row),references={alipay:values.alipay_qrcode_url,weixin:values.wechat_qrcode_url};
  const eligible=Object.values(references).filter(r=>/^\/api\/assets\/[1-9]\d*$/.test(r));
  const media=await projectSupplierProductMedia(tx,actor.supplierId,{sliderImages:eligible,skus:[],description:''},this.appKey);
  const preview=(reference:string):SupplierFinanceAccountPreview=>{
   if(reference&&isSupplierFinanceAccountReference(reference)&&classifyProductMediaReference(reference).kind==='public')return{reference,status:'ready',src:reference,expires_at:null};
   const item=isSupplierFinanceAccountReference(reference)?media.previews[reference]:undefined;
   return item?.status==='ready'?{reference,status:'ready',src:item.src,expires_at:item.expires_at}:{reference,status:'unavailable',src:'',expires_at:null};
  };
  return{version:'supplier-finance-accounts-v1',actor_id:actor.id,supplier_id:actor.supplierId,revision:supplierFinanceAccountsRevision(this.appKey,actor,row.rowVersion,rawAccounts(row)),accounts:values,
   ready:{bank:!!values.bank_code&&values.bank_code!=='0'&&!!values.bank_address,alipay:!!values.alipay_account&&!!values.alipay_qrcode_url,weixin:!!values.wechat&&!!values.wechat_qrcode_url},previews:{alipay:preview(references.alipay),weixin:preview(references.weixin)},bounded:true};
 }
 async context(value:SupplierVideoActor){const actor=Object.freeze({...value});return this.transaction(actor,false,true,(tx,row)=>this.project(tx,row,actor));}
 async legacy(value:SupplierVideoActor){const actor=Object.freeze({...value});return this.transaction(actor,false,false,async(_tx,row)=>accounts(row));}
 async save(body:unknown,value:SupplierVideoActor,modern:boolean):Promise<SupplierFinanceAccountsContext|null> {
  const actor=Object.freeze({...value}),input=parseSupplierFinanceAccountsInput(body,modern);
  return this.transaction(actor,true,modern,async(tx,before)=>{
   if(modern){const expected=supplierFinanceAccountsRevision(this.appKey,actor,before.rowVersion,rawAccounts(before));if(!timingSafeEqual(Buffer.from(input.revision!),Buffer.from(expected)))throw conflict();}
   const changed:Partial<typeof systemSupplier.$inferInsert>={},privateReferences:string[]=[];
   for(const field of SUPPLIER_FINANCE_ACCOUNT_FIELDS)if(Object.hasOwn(input.accounts,field)){
    const desired=input.accounts[field]!;changed[names[field]]=desired;
    if(field==='alipay_qrcode_url'||field==='wechat_qrcode_url'){
     if(desired!==before[names[field]].trim()&&!isSupplierFinanceAccountReference(desired))throw new ValidateException('收款二维码须使用安全公共地址或当前供应商稳定附件引用');
     if(desired!==before[names[field]].trim()&&/^\/api\/assets\/[1-9]\d*$/.test(desired))privateReferences.push(desired);
    }
   }
   if(privateReferences.length){
    await assertSupplierFinanceAccountsReady(tx,true,true);const[rights]=await tx.execute(sql`SELECT has_any_column_privilege(current_user,'public.system_attachment','UPDATE') AS ready`);fact(rights?.ready===true);
    await lockSupplierProductMedia(tx,actor.supplierId,{sliderImages:privateReferences,skus:[],description:''});
   }
   const[written]=await tx.update(systemSupplier).set(changed).where(and(eq(systemSupplier.id,actor.supplierId),eq(systemSupplier.isShow,1),eq(systemSupplier.isDel,0))).returning();fact(written);
   await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);const after=await readRow(tx,actor.supplierId),{rowVersion:ignored,...original}=before,{rowVersion:next,...actual}=after;
   fact(canonical(actual)===canonical({...original,...changed}));fact(next!==ignored);accounts(after);
   return modern?this.project(tx,after,actor):null;
  });
 }
}
