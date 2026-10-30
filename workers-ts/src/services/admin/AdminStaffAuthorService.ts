import {asc,eq,getTableColumns,inArray,sql} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import type {Env} from '@/env';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {systemStoreStaff,user} from '@/models/schema';
import {HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {acquireAdminAuthorityWriteBarrier,loadAdminAuthorityLiveActor,type AdminAuthorityActor} from './AdminAuthorityWriteService';
import {authorizeAdminLegacyProductRead,assertAdminLegacyProductReadDeadline} from './AdminLegacyProductReadAuthority';
import {loadAdminProfileActor} from './AdminProfileService';
import {assertAdminStaffOperationReady} from '@/migrations/adminStaffOperation';
import {assertStaffAvatarChange,publicStaffAvatarReferences,renderStaffAvatarReferences} from '@/services/store/StaffAvatarPolicy';
import {staffUserSelection} from './AdminStaffSupportService';
import {STAFF_FIELDS,newStaffValues,staffReceipt,staffUuid,type StaffAction,type StaffOperation,type StaffReceipt,type StaffValues,type StaffPayload,type StaffRow} from '../../../../view/common/staffAuthor';
import {staffActionHash,staffInput,staffId,staffQuery,staffRequest} from './AdminStaffAuthorInput';

const columns=getTableColumns(systemStoreStaff);
const userColumns={uid:user.uid,nickname:user.nickname,avatar:user.avatar,status:user.status,isDel:user.isDel,deleteTime:user.deleteTime,rowVersion:sql<string>`xmin::text`};
type RecordRow=typeof systemStoreStaff.$inferSelect;
type Stored=RecordRow&{rowVersion:string};
interface StoreSnapshot {value:Record<string,unknown>&{id:number;name:string;is_del:number};row_version:string}
const conflict=(message:string)=>new HttpApiException(message,409,409);
const ordered=(v:unknown):unknown=>v instanceof Date?v.toISOString():Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,ordered(x)])):v;
const same=(a:unknown,b:unknown)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const strip=(r:Stored):RecordRow=>{const{rowVersion:_,...v}=r;return v;};
const plain=(r:RecordRow)=>({...r,phone:r.phone.trimEnd()});
const values=(r:RecordRow):StaffValues=>({uid:r.uid,avatar:r.avatar,store_id:r.storeId,staff_name:r.staffName,phone:r.phone.trimEnd(),verify_status:r.verifyStatus,status:r.status});
function databaseError(error:unknown):never {
 let cause=error;
 for(let i=0;i<8&&cause&&typeof cause==='object';i++){
  const code='code'in cause?String(cause.code):'';
  if(['55P03','40P01','40001','23505'].includes(code))throw conflict('店员、用户、提货点或核销正在更新，请先查回执');
  if(['42501','42P01','42883','57014'].includes(code))throw new ServiceUnavailableException('店员安全写入能力未就绪或操作超时');
  cause='cause'in cause?cause.cause:undefined;
 }
 throw error;
}

/** Only the seven original business values are authored. Private full records
 * are used for CAS/readback and never become a client DTO or audit payload. */
export class AdminStaffAuthorService {
 constructor(private readonly container:Container,private readonly env:Env){}
 private transaction<T>(actor:AdminAuthorityActor,write:boolean,owner:boolean,work:(tx:DbClient)=>Promise<T>):Promise<T>{
  return withTx(this.container,async tx=>{
   if(write){
    await acquireAdminAuthorityWriteBarrier(tx);
    if(owner)await loadAdminProfileActor(tx,actor);else await loadAdminAuthorityLiveActor(tx,actor,'store.manage');
    const[erp]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731745,1) AS locked`);
    const[legacy]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock(8214001,0) AS locked`);
    if(erp?.locked!==true||legacy?.locked!==true)throw conflict('提货点或店员范围正在更新，请先查回执');
    // An actual legacy App reader holds ACCESS SHARE through its transaction.
    // NOWAIT prevents reversing the old user/store/staff row-lock ordering.
    await tx.execute(sql`LOCK TABLE ONLY public.system_store IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    await tx.execute(sql`LOCK TABLE ONLY public.system_store_staff IN ACCESS EXCLUSIVE MODE NOWAIT`);
    await assertAdminStaffOperationReady(tx);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(731632,1)`);
   }else{
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
    if(owner)await loadAdminProfileActor(tx,actor);else await authorizeAdminLegacyProductRead(tx,actor,'store.view');
   }
   const result=await work(tx);await assertAdminLegacyProductReadDeadline(tx,actor);
   if(write&&!owner)await loadAdminAuthorityLiveActor(tx,actor,'store.manage');
   return result;
  }).catch(databaseError);
 }
 private async users(tx:DbClient,ids:number[],lock=false){
  if(!ids.length)return [];
  const query=tx.select(userColumns).from(user).where(inArray(user.uid,[...new Set(ids)].sort((a,b)=>a-b))).orderBy(asc(user.uid));
  return lock?query.for('share',{noWait:true}):query;
 }
 private async source(tx:DbClient,lock=false){
  const[shape]=await tx.execute(sql`SELECT ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public.system_store_staff'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum) AS names`);
  const names=shape?.names,known=Object.values(columns).map(c=>c.name);
  if(!Array.isArray(names)||names.length!==known.length||names.some(n=>typeof n!=='string'||!known.includes(n)))throw new ServiceUnavailableException('店员表结构无法完整核验');
  const rows=await tx.select({...columns,rowVersion:sql<string>`xmin::text`}).from(systemStoreStaff).orderBy(asc(systemStoreStaff.id)).limit(20001);
  // to_jsonb retains base, optional city-delivery and future store metadata.
  // No store columns are written or projected back as insert/update values.
  const stores=Array.from(await tx.execute(sql`SELECT to_jsonb(s) AS value,s.xmin::text AS row_version FROM public.system_store s ORDER BY id LIMIT 5001`)) as unknown as StoreSnapshot[];
  if(rows.length>20000||stores.length>5000)throw new ServiceUnavailableException('完整店员20000项或提货点5000项容量已超出，不能截断');
  const users=await this.users(tx,rows.map(r=>r.uid).filter(id=>id>0),lock);
  if(new TextEncoder().encode(JSON.stringify([rows,stores,users])).length>16*1024*1024)throw new ServiceUnavailableException('店员完整目录超过16MiB，不能截断');
  return {rows,stores,users,revision:hash({domain:'staff-catalog-v1',rows,stores,users})};
 }
 private async project(tx:DbClient,s:Awaited<ReturnType<AdminStaffAuthorService['source']>>):Promise<StaffRow[]>{
  const rows=s.rows.filter(r=>r.isDel===0),users=new Map(s.users.map(r=>[r.uid,r])),stores=new Map(s.stores.map(r=>[r.value.id,r.value]));
  const previews=await renderStaffAvatarReferences(this.env.APP_KEY,await publicStaffAvatarReferences(tx,rows.map(r=>({avatar:r.avatar,uid:r.uid,userAvatar:users.get(r.uid)?.avatar}))));
  return rows.map((r,i)=>({...values(r),id:r.id,is_del:r.isDel,add_time:r.addTime,avatar_preview:previews[i]!.avatar,nickname:users.get(r.uid)?.nickname??'',store_name:stores.get(r.storeId)?.name??''}));
 }
 catalog(q:URLSearchParams,actor:AdminAuthorityActor){staffQuery(q);return this.transaction(actor,false,false,async tx=>{const s=await this.source(tx);const list=await this.project(tx,s);return {list,stores:s.stores.map(({value:r})=>({id:r.id,name:r.name,is_del:r.is_del})),count:list.length,revision:s.revision,can_create:s.rows.length<20000,write_ready:await assertAdminStaffOperationReady(tx).then(()=>true).catch(()=>false)};});}
 private legacyRow(r:RecordRow,s:Awaited<ReturnType<AdminStaffAuthorService['source']>>,detail=false){
  const result={id:r.id,...values(r),account:r.account,roles:r.roles??'',level:r.level,order_status:r.orderStatus,is_admin:r.isAdmin,is_manager:r.isManager,is_cashier:r.isCashier,notify:r.notify,add_time:r.addTime,name:s.stores.find(x=>x.value.id===r.storeId)?.value.name??null,nickname:s.users.find(x=>x.uid===r.uid)?.nickname??null};
  return detail?result:{...result,last_time:r.lastTime,login_count:r.loginCount,is_del:r.isDel};
 }
 legacyList(q:URLSearchParams,actor:AdminAuthorityActor){
  const p=staffQuery(q,['page','limit','store_id','keyword']),page=staffId(p.page??1),limit=staffId(p.limit??20),store=p.store_id&&p.store_id!=='0'?staffId(p.store_id):0,keyword=(p.keyword??'').trim();
  if(limit>100||[...keyword].length>80||/[\u0000-\u001f\u007f]/u.test(keyword))throw new ValidateException('店员筛选或分页无效');
  return this.transaction(actor,false,false,async tx=>{const s=await this.source(tx),pattern=new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replaceAll('%','.*').replaceAll('_','.'),'iu');
   const rows=s.rows.filter(r=>r.isDel===0&&(!store||r.storeId===store)&&(!keyword||[r.id,r.uid,r.staffName,r.phone].some(v=>pattern.test(String(v))))).sort((a,b)=>b.addTime-a.addTime||b.id-a.id);
   return {list:rows.slice((page-1)*limit,page*limit).map(r=>this.legacyRow(r,s)),count:rows.length,page,limit};
  });
 }
 form(idValue:unknown,q:URLSearchParams,actor:AdminAuthorityActor){staffQuery(q);const id=staffId(idValue,true);return this.transaction(actor,false,false,async tx=>{const s=await this.source(tx),row=s.rows.find(r=>r.id===id&&r.isDel===0);if(id&&!row)throw new NotFoundException('店员不存在');return {stores:s.stores.filter(r=>r.value.is_del===0).map(({value:r})=>({id:r.id,name:r.name})).reverse(),info:row?this.legacyRow(row,s,true):null};});}
 private receiptRow(r:Record<string,unknown>,action?:StaffAction):StaffReceipt{const a=action??{operation_id:String(r.operation_id),actor_id:Number(r.actor_id),operation:r.operation as StaffOperation,target_id:Number(r.target_id),revision:String(r.revision),payload_hash:String(r.payload_hash),payload:{}};return staffInput(()=>staffReceipt({operation_id:r.operation_id,actor_id:r.actor_id,operation:r.operation,target_id:r.target_id,revision:r.revision,payload_hash:r.payload_hash,state:r.state,result:r.result},a));}
 private async prior(tx:DbClient,a:StaffAction){const rows=await tx.execute(sql`SELECT * FROM public.admin_staff_operation WHERE operation_id=${a.operation_id}::uuid`);if(!rows.length)return null;const r=rows[0]!;if(r.actor_id!==a.actor_id||r.operation!==a.operation||r.target_id!==a.target_id||r.payload_hash!==a.payload_hash||r.revision!==a.revision)throw conflict('原店员请求标识已用于不同操作');return this.receiptRow(r,a);}
 private async receiptInsert(tx:DbClient,a:StaffAction,state:StaffReceipt['state'],result:StaffReceipt['result']){const rows=await tx.execute(sql`INSERT INTO public.admin_staff_operation(operation_id,actor_id,operation,target_id,payload_hash,revision,state,result,created_at) VALUES (${a.operation_id}::uuid,${a.actor_id},${a.operation},${a.target_id},${a.payload_hash},${a.revision},${state},${JSON.stringify(result)}::jsonb,${Math.floor(Date.now()/1000)}) RETURNING *`);if(rows.length!==1)throw Error('店员操作回执缺失');return this.receiptRow(rows[0]!,a);}
 receipt(id:unknown,q:URLSearchParams,actor:AdminAuthorityActor){staffQuery(q);const uuid=staffInput(()=>staffUuid(id));return this.transaction(actor,false,true,async tx=>{const rows=await tx.execute(sql`SELECT * FROM public.admin_staff_operation WHERE operation_id=${uuid}::uuid AND actor_id=${actor.id}`);if(rows.length!==1)throw new NotFoundException('尚未找到原店员回执，结果仍未知');return this.receiptRow(rows[0]!);});}
 resolve(value:unknown,actor:AdminAuthorityActor){const a=staffRequest(value,actor.id);return this.transaction(actor,true,true,async tx=>await this.prior(tx,a)??await this.receiptInsert(tx,a,'not_applied',{id:a.target_id,created:0,updated:0,count:0,revision:a.revision}));}
 private async eligible(tx:DbClient,s:Awaited<ReturnType<AdminStaffAuthorService['source']>>,uid:number,storeId:number){
  if(!Number.isSafeInteger(uid)||uid<1||!Number.isSafeInteger(storeId)||storeId<1||!s.stores.some(r=>r.value.id===storeId&&r.value.is_del===0))throw new ValidateException('所属提货点不存在或已删除');
  const[row]=await this.users(tx,[uid],true);
  if(!row||row.status!==1||row.isDel!==0||row.deleteTime!==null)throw new ValidateException('关联用户不存在、已停用或已删除');
  return row;
 }
 private async validate(tx:DbClient,s:Awaited<ReturnType<AdminStaffAuthorService['source']>>,v:StaffPayload,old?:Stored){
  const previous=old?values(old):null,changed=(k:keyof StaffValues)=>!previous||v[k]!==previous[k];
  for(const key of ['staff_name','phone'] as const)if(changed(key)&&(!v[key]||v[key]!==v[key].trim()||/[\u0000-\u001f\u007f]/u.test(v[key])))throw new ValidateException('姓名和电话不能为空、含首尾空白或控制字符');
  for(const key of ['status','verify_status'] as const)if(changed(key)&&![0,1].includes(v[key]))throw new ValidateException('店员及核销状态无效');
  const selected=await this.eligible(tx,s,v.uid,v.store_id);
  if((!old||changed('uid'))&&!v.user_selection||v.user_selection&&v.user_selection!==staffUserSelection(selected))throw conflict('所选用户已变化，请重新选择');
  const granting=!old||changed('uid')||changed('store_id')||changed('status')&&v.status===1||changed('verify_status')&&v.verify_status===1;
  if(granting&&s.rows.some(r=>r.id!==old?.id&&r.storeId===v.store_id&&r.uid===v.uid&&r.isDel===0))throw new ValidateException('该用户已经是此提货点店员，不能新增重复身份');
  await assertStaffAvatarChange(tx,old?{avatar:old.avatar,uid:old.uid}:null,{avatar:v.avatar,uid:v.uid,userAvatar:selected.avatar});
  return {selected,data:{uid:v.uid,avatar:v.avatar,storeId:v.store_id,staffName:v.staff_name,phone:v.phone,verifyStatus:v.verify_status,status:v.status}};
 }
 mutate(value:unknown,actor:AdminAuthorityActor){const a=staffRequest(value,actor.id);return this.transaction(actor,true,false,async tx=>{
  const prior=await this.prior(tx,a);if(prior){if(prior.state!=='committed')throw conflict('原店员操作已封存，不能再提交');return prior;}
  const before=await this.source(tx,true);if(a.revision!==before.revision)throw conflict('店员、提货点或关联用户目录已变化，请先核对回执');
  const old=before.rows.find(r=>r.id===a.target_id&&r.isDel===0);if(a.target_id&&!old)throw new NotFoundException('店员不存在或已删除');
  const expected=new Map(before.rows.map(r=>[r.id,plain(strip(r))])),protectedUsers=new Map(before.users.map(r=>[r.uid,r]));
  let id=a.target_id,created=0,updated=0;
  if(a.operation==='create'||a.operation==='update'){
   const{data,selected}=await this.validate(tx,before,a.payload as unknown as StaffPayload,old);protectedUsers.set(selected.uid,selected);
   if(a.operation==='create'){
    if(before.rows.length>=20000)throw conflict('完整店员目录已达20000项');
    const insert={...data,account:'',pwd:'',roles:'',lastIp:'',lastTime:0,loginCount:0,level:1,orderStatus:1,isAdmin:0,isManager:0,isCashier:0,notify:0,isDel:0,addTime:Math.floor(Date.now()/1000)};
    const result=await tx.insert(systemStoreStaff).values(insert).returning(),saved=result[0];
    if(result.length!==1||!saved||!Number.isSafeInteger(saved.id)||saved.id<1||expected.has(saved.id)||!same(plain(saved),plain({...insert,id:saved.id})))throw Error('店员新增完整字段回读不一致');
    id=saved.id;expected.set(id,plain(saved));created=1;
   }else{await tx.update(systemStoreStaff).set(data).where(eq(systemStoreStaff.id,id));expected.set(id,plain({...strip(old!),...data}));updated=1;}
  }else{
   const data=a.operation==='delete'?{isDel:1,status:0,verifyStatus:0,notify:0}:{status:a.payload.status as number};
   if(a.operation==='status'&&data.status===1){const selected=await this.eligible(tx,before,old!.uid,old!.storeId);protectedUsers.set(selected.uid,selected);if(before.rows.some(r=>r.id!==id&&r.storeId===old!.storeId&&r.uid===old!.uid&&r.isDel===0))throw new ValidateException('存在重复店员身份，不能启用');}
   await tx.update(systemStoreStaff).set(data).where(eq(systemStoreStaff.id,id));expected.set(id,plain({...strip(old!),...data}));updated=1;
  }
  const after=await this.source(tx,true),users=await this.users(tx,[...protectedUsers.keys()],true);
  if(!same(after.rows.map(r=>plain(strip(r))),[...expected.values()].sort((a,b)=>a.id-b.id))||!same(after.stores,before.stores)||!same(users,[...protectedUsers.values()].sort((a,b)=>a.uid-b.uid)))throw Error('店员、提货点或用户完整写后回读不一致');
  return this.receiptInsert(tx,a,'committed',{id,created,updated,count:after.rows.filter(r=>r.isDel===0).length,revision:after.revision});
 });}
 async legacy(operation:StaffOperation,idValue:unknown,input:Record<string,unknown>,actor:AdminAuthorityActor){
  const id=operation==='create'?0:staffId(idValue),snapshot=await this.catalog(new URLSearchParams(),actor),row=snapshot.list.find(r=>r.id===id);
  if(id&&!row)throw new NotFoundException('店员不存在');
  const base=newStaffValues(row),metadata=id?await this.transaction(actor,false,false,async tx=>{const source=await this.source(tx),record=source.rows.find(r=>r.id===id&&r.isDel===0);return record?this.legacyRow(record,source):null;}):null;
  const readonly=['account','roles','level','is_admin','is_manager','is_cashier','order_status','notify','add_time','last_time','login_count','is_del','name','nickname'];
  const allowed=[...STAFF_FIELDS,'id','image','storeId','staffName','verifyStatus',...readonly];
  if(Object.keys(input).some(k=>!allowed.includes(k)))throw new ValidateException('旧店员请求包含未授权字段');
  if(input.id!==undefined&&staffId(input.id,true)!==id)throw new ValidateException('店员ID不一致');
  for(const key of readonly)if(input[key]!==undefined&&(!metadata||String(input[key])!==String((metadata as Record<string,unknown>)[key])))throw new ValidateException('旧店员只读资料不能更改');
  const v:Record<string,unknown>={...base};
  for(const key of STAFF_FIELDS)if(input[key]!==undefined)v[key]=input[key];
  for(const[alias,key]of [['storeId','store_id'],['staffName','staff_name'],['verifyStatus','verify_status']] as const)if(input[alias]!==undefined){if(input[key]!==undefined&&String(input[key])!==String(input[alias]))throw new ValidateException('店员字段别名冲突');v[key]=input[alias];}
  if(input.image!==undefined){
   if(operation==='create'&&input.image&&typeof input.image==='object'&&!Array.isArray(input.image)){
    const image=input.image as Record<string,unknown>;
    if(Object.keys(image).some(k=>!['uid','image'].includes(k))||!Object.hasOwn(image,'uid')||!Object.hasOwn(image,'image'))throw new ValidateException('商城用户选择结果无效');
    const uid=staffId(image.uid);if(input.uid!==undefined&&staffId(input.uid,true)!==0&&staffId(input.uid,true)!==uid)throw new ValidateException('用户选择与隐藏UID冲突');
    if(input.avatar!==undefined&&input.avatar!==''&&input.avatar!==image.image)throw new ValidateException('用户选择与头像冲突');v.uid=uid;v.avatar=image.image;
   }else if(typeof input.image==='string'){
    if(input.avatar!==undefined&&input.avatar!==base.avatar&&input.avatar!==input.image)throw new ValidateException('头像字段冲突');v.avatar=input.image;
   }else throw new ValidateException('商城用户或头像选择结果无效');
  }
  for(const key of ['verify_status','status'])if(typeof v[key]==='boolean')v[key]=Number(v[key]);
  for(const key of ['uid','store_id','verify_status','status'])if(typeof v[key]==='string'&&/^(?:0|[1-9]\d*)$/.test(v[key] as string))v[key]=Number(v[key]);
  for(const key of ['staff_name','phone'])if(typeof v[key]==='string')v[key]=(v[key] as string).trim();
  if(operation==='create'||operation==='update')v.user_selection=await this.transaction(actor,false,false,async tx=>{const[u]=await this.users(tx,[staffId(v.uid)]);if(!u)throw new ValidateException('关联用户不存在');return staffUserSelection(u);});
  const payload=operation==='create'||operation==='update'?v:operation==='status'?{status:staffId(input.status,true)}:{};
  const a:StaffAction={operation_id:crypto.randomUUID(),actor_id:actor.id,operation,target_id:id,revision:snapshot.revision,payload,payload_hash:''};a.payload_hash=staffActionHash(a);return this.mutate(a,actor);
 }
}
