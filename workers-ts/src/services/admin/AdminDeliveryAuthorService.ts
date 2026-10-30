import {asc,eq,getTableColumns,inArray,sql} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import type {Env} from '@/env';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {deliveryService,user} from '@/models/schema';
import {HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {acquireAdminAuthorityWriteBarrier,loadAdminAuthorityLiveActor,type AdminAuthorityActor} from './AdminAuthorityWriteService';
import {authorizeAdminLegacyProductRead,assertAdminLegacyProductReadDeadline} from './AdminLegacyProductReadAuthority';
import {loadAdminProfileActor} from './AdminProfileService';
import {assertAdminDeliveryOperationReady} from '@/migrations/adminDeliveryOperation';
import {assertDeliveryAvatarChange,publicDeliveryAvatarReferences,renderDeliveryAvatarReferences} from '@/services/delivery/DeliveryAvatarPolicy';
import {AdminDeliverySupportService,deliveryUserSelection} from './AdminDeliverySupportService';
import {DELIVERY_FIELDS,newDeliveryValues,deliveryReceipt,deliveryUuid,type DeliveryAction,type DeliveryOperation,type DeliveryReceipt,type DeliveryValues,type DeliveryPayload,type DeliveryRow} from '../../../../view/common/deliveryAuthor';
import {deliveryActionHash,deliveryInput,deliveryAuthorId,deliveryQuery,deliveryRequest} from './AdminDeliveryAuthorInput';

const columns=getTableColumns(deliveryService);
const userColumns={uid:user.uid,nickname:user.nickname,phone:user.phone,avatar:user.avatar,status:user.status,isDel:user.isDel,deleteTime:user.deleteTime,rowVersion:sql<string>`xmin::text`};
type RecordRow=typeof deliveryService.$inferSelect;
type Stored=RecordRow&{rowVersion:string};
const platform=(r:RecordRow)=>r.type===0&&r.relationId===0;
const active=(r:RecordRow)=>platform(r)&&r.isDel===0;
const conflict=(message:string)=>new HttpApiException(message,409,409);
const ordered=(v:unknown):unknown=>v instanceof Date?v.toISOString():Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,ordered(x)])):v;
const same=(a:unknown,b:unknown)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const strip=(r:Stored):RecordRow=>{const{rowVersion:_,...v}=r;return v;};
const values=(r:RecordRow):DeliveryValues=>({uid:r.uid,avatar:r.avatar,nickname:r.nickname,phone:r.phone,status:r.status});
/** PostgreSQL LIKE's %/_ and default backslash escape, with a fixed
 * O(pattern codepoints × field codepoints) budget. No input becomes a regex. */
function legacyLike(value:string,keyword:string):boolean {
 const pattern=[...('%'+keyword+'%').toLowerCase()],text=[...value.toLowerCase()];
 const tokens:Array<{kind:'many'|'one'|'literal';value?:string}>=[];
 for(let i=0;i<pattern.length;i++){
  const char=pattern[i]!;
  if(char==='\\'){if(i+1>=pattern.length)return false;tokens.push({kind:'literal',value:pattern[++i]!});}
  else if(char==='%'){if(tokens.at(-1)?.kind!=='many')tokens.push({kind:'many'});}
  else tokens.push(char==='_'?{kind:'one'}:{kind:'literal',value:char});
 }
 let previous=new Uint8Array(text.length+1);previous[0]=1;
 for(const token of tokens){
  const current=new Uint8Array(text.length+1);
  if(token.kind==='many'){
   current[0]=previous[0]!;for(let i=1;i<=text.length;i++)current[i]=previous[i]||current[i-1]?1:0;
  }else for(let i=1;i<=text.length;i++)if(previous[i-1]&&(token.kind==='one'||token.value===text[i-1]))current[i]=1;
  previous=current;
 }
 return previous[text.length]===1;
}
function databaseError(error:unknown):never {
 let cause=error;
 for(let i=0;i<8&&cause&&typeof cause==='object';i++){
  const code='code'in cause?String(cause.code):'';
  if(['55P03','40P01','40001','23505'].includes(code))throw conflict('配送身份、用户或送达核销正在更新，请先查回执');
  if(['42501','42P01','42883','57014'].includes(code))throw new ServiceUnavailableException('配送员安全写入能力未就绪或操作超时');
  cause='cause'in cause?cause.cause:undefined;
 }
 throw error;
}

/** Platform type0/relation0 author only. Every scope and all ten source
 * columns remain in private CAS/readback; no order or money table is written. */
export class AdminDeliveryAuthorService {
 constructor(private readonly container:Container,private readonly env:Env){}
 private transaction<T>(actor:AdminAuthorityActor,write:boolean,owner:boolean,work:(tx:DbClient)=>Promise<T>):Promise<T>{
  return withTx(this.container,async tx=>{
   if(write){
    await acquireAdminAuthorityWriteBarrier(tx);
    if(owner)await loadAdminProfileActor(tx,actor);else await loadAdminAuthorityLiveActor(tx,actor,'order.manage');
    const[legacy]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock(8214002,0) AS locked`);
    if(legacy?.locked!==true)throw conflict('配送身份正在更新，请先查回执');
    // SHARE ROW EXCLUSIVE conflicts with the established delivery scope SHARE
    // fence and other identity writers without changing its lock contract.
    await tx.execute(sql`LOCK TABLE ONLY public.delivery_service IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    await assertAdminDeliveryOperationReady(tx);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(731633,1)`);
   }else{
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
    if(owner)await loadAdminProfileActor(tx,actor);else await authorizeAdminLegacyProductRead(tx,actor,'order.view');
   }
   const result=await work(tx);await assertAdminLegacyProductReadDeadline(tx,actor);
   if(write&&!owner)await loadAdminAuthorityLiveActor(tx,actor,'order.manage');
   return result;
  }).catch(databaseError);
 }
 private async users(tx:DbClient,ids:number[],lock=false){
  if(!ids.length)return [];
  const query=tx.select(userColumns).from(user).where(inArray(user.uid,[...new Set(ids)].sort((a,b)=>a-b))).orderBy(asc(user.uid));
  return lock?query.for('share',{noWait:true}):query;
 }
 private async source(tx:DbClient,lock=false){
  const[shape]=await tx.execute(sql`SELECT ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public.delivery_service'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum) AS names`);
  const names=shape?.names,known=Object.values(columns).map(c=>c.name);
  if(!Array.isArray(names)||names.length!==known.length||names.some(n=>typeof n!=='string'||!known.includes(n)))throw new ServiceUnavailableException('配送员表结构无法完整核验');
  const rows=await tx.select({...columns,rowVersion:sql<string>`xmin::text`}).from(deliveryService).orderBy(asc(deliveryService.id)).limit(20001);
  if(rows.length>20000)throw new ServiceUnavailableException('完整配送员目录超过20000项，不能截断');
  const users=await this.users(tx,rows.map(r=>r.uid).filter(id=>id>0),lock);
  if(new TextEncoder().encode(JSON.stringify([rows,users])).length>16*1024*1024)throw new ServiceUnavailableException('配送员完整目录超过16MiB，不能截断');
  return {rows,users,revision:hash({domain:'platform-delivery-catalog-v1',rows,users})};
 }
 private async project(tx:DbClient,s:Awaited<ReturnType<AdminDeliveryAuthorService['source']>>):Promise<DeliveryRow[]>{
  const rows=s.rows.filter(active),users=new Map(s.users.map(r=>[r.uid,r]));
  const previews=await renderDeliveryAvatarReferences(this.env.APP_KEY,await publicDeliveryAvatarReferences(tx,rows.map(r=>({avatar:r.avatar,uid:r.uid,userAvatar:users.get(r.uid)?.avatar}))));
  return rows.map((r,i)=>({...values(r),id:r.id,is_del:r.isDel,add_time:r.addTime,avatar_preview:previews[i]!.avatar,user_nickname:users.get(r.uid)?.nickname??''}));
 }
 catalog(q:URLSearchParams,actor:AdminAuthorityActor){deliveryQuery(q);return this.transaction(actor,false,false,async tx=>{const s=await this.source(tx),list=await this.project(tx,s);return {list,count:list.length,revision:s.revision,can_create:s.rows.length<20000,write_ready:await assertAdminDeliveryOperationReady(tx).then(()=>true).catch(()=>false)};});}
 private legacyRow(r:RecordRow,s:Awaited<ReturnType<AdminDeliveryAuthorService['source']>>){return {id:r.id,uid:r.uid,avatar:r.avatar,wx_name:r.nickname,nickname:s.users.find(x=>x.uid===r.uid)?.nickname||r.nickname,phone:r.phone,status:r.status,add_time:r.addTime};}
 legacyList(q:URLSearchParams,actor:AdminAuthorityActor,selectOnly=false){
  const p=deliveryQuery(q,['page','limit','keyword']),page=deliveryAuthorId(p.page??1),limit=deliveryAuthorId(p.limit??20),keyword=(p.keyword??'').trim();
  if(limit>100||[...keyword].length>80||/[\u0000-\u001f\u007f]/u.test(keyword))throw new ValidateException('配送员筛选或分页无效');
  return this.transaction(actor,false,false,async tx=>{const s=await this.source(tx);
   const rows=s.rows.filter(r=>active(r)&&(!selectOnly||r.status===1)&&(!keyword||[r.id,r.uid,r.nickname,r.phone].some(v=>legacyLike(String(v),keyword)))).sort((a,b)=>b.id-a.id);
   return {list:rows.slice((page-1)*limit,page*limit).map(r=>this.legacyRow(r,s)),count:rows.length,page,limit};
  });
 }
 async legacyCandidates(q:URLSearchParams,actor:AdminAuthorityActor){
  const p=deliveryQuery(q,['page','limit','keyword','nickname']),keyword=p.keyword??p.nickname??'';
  if(p.keyword!==undefined&&p.nickname!==undefined&&p.keyword!==p.nickname)throw new ValidateException('用户关键词别名冲突');
  const query=new URLSearchParams({...(p.page!==undefined?{page:p.page}:{}),...(p.limit!==undefined?{limit:p.limit}:{}),keyword});
  const r=await new AdminDeliverySupportService(this.container,this.env).users(query,actor,true);
  return {list:r.list.map(x=>({uid:x.uid,nickname:x.nickname,headimgurl:x.avatar,phone:x.phone})),count:r.count,page:r.page,limit:r.limit};
 }
 form(idValue:unknown,q:URLSearchParams,actor:AdminAuthorityActor){deliveryQuery(q);const id=deliveryAuthorId(idValue,true);return this.transaction(actor,false,false,async tx=>{const s=await this.source(tx),row=s.rows.find(r=>r.id===id&&active(r));if(id&&!row)throw new NotFoundException('配送员不存在');return row?{id:row.id,...values(row),add_time:row.addTime}:{info:null,rules:[{field:'image',title:'商城用户',type:'user-selection',value:''},{field:'nickname',title:'配送员名称',type:'input',value:''},{field:'phone',title:'手机号码',type:'input',value:'',maxlength:11},{field:'status',title:'配送员状态',type:'radio',value:1,options:[{value:1,label:'开启'},{value:0,label:'关闭'}]}],hidden:{uid:0,avatar:''},action:'/order/delivery/save',method:'POST'};});}
 private receiptRow(r:Record<string,unknown>,action?:DeliveryAction):DeliveryReceipt{const a=action??{operation_id:String(r.operation_id),actor_id:Number(r.actor_id),operation:r.operation as DeliveryOperation,target_id:Number(r.target_id),revision:String(r.revision),payload_hash:String(r.payload_hash),payload:{}};return deliveryInput(()=>deliveryReceipt({operation_id:r.operation_id,actor_id:r.actor_id,operation:r.operation,target_id:r.target_id,revision:r.revision,payload_hash:r.payload_hash,state:r.state,result:r.result},a));}
 private async prior(tx:DbClient,a:DeliveryAction){const rows=await tx.execute(sql`SELECT * FROM public.admin_delivery_operation WHERE operation_id=${a.operation_id}::uuid`);if(!rows.length)return null;const r=rows[0]!;if(r.actor_id!==a.actor_id||r.operation!==a.operation||r.target_id!==a.target_id||r.payload_hash!==a.payload_hash||r.revision!==a.revision)throw conflict('原配送员请求标识已用于不同操作');return this.receiptRow(r,a);}
 private async receiptInsert(tx:DbClient,a:DeliveryAction,state:DeliveryReceipt['state'],result:DeliveryReceipt['result']){const rows=await tx.execute(sql`INSERT INTO public.admin_delivery_operation(operation_id,actor_id,operation,target_id,payload_hash,revision,state,result,created_at) VALUES (${a.operation_id}::uuid,${a.actor_id},${a.operation},${a.target_id},${a.payload_hash},${a.revision},${state},${JSON.stringify(result)}::jsonb,${Math.floor(Date.now()/1000)}) RETURNING *`);if(rows.length!==1)throw Error('配送员操作回执缺失');return this.receiptRow(rows[0]!,a);}
 receipt(id:unknown,q:URLSearchParams,actor:AdminAuthorityActor){deliveryQuery(q);const uuid=deliveryInput(()=>deliveryUuid(id));return this.transaction(actor,false,true,async tx=>{const rows=await tx.execute(sql`SELECT * FROM public.admin_delivery_operation WHERE operation_id=${uuid}::uuid AND actor_id=${actor.id}`);if(rows.length!==1)throw new NotFoundException('尚未找到原配送员回执，结果仍未知');return this.receiptRow(rows[0]!);});}
 resolve(value:unknown,actor:AdminAuthorityActor){const a=deliveryRequest(value,actor.id);return this.transaction(actor,true,true,async tx=>await this.prior(tx,a)??await this.receiptInsert(tx,a,'not_applied',{id:a.target_id,created:0,updated:0,count:0,revision:a.revision}));}
 private async eligible(tx:DbClient,uid:number){
  if(!Number.isSafeInteger(uid)||uid<1)throw new ValidateException('关联用户标识无效');
  const[row]=await this.users(tx,[uid],true);
  if(!row||row.status!==1||row.isDel!==0||row.deleteTime!==null)throw new ValidateException('关联用户不存在、已停用或已删除');
  return row;
 }
 private async validate(tx:DbClient,s:Awaited<ReturnType<AdminDeliveryAuthorService['source']>>,v:DeliveryPayload,old?:Stored){
  if(old&&v.uid!==old.uid)throw new ValidateException('编辑配送员不能更改关联UID');
  const selected=await this.eligible(tx,v.uid),previous=old?values(old):null;
  if(!old&&!v.user_selection||v.user_selection&&v.user_selection!==deliveryUserSelection(selected))throw conflict('所选用户已变化，请重新选择');
  const nickname=!old&&v.nickname===''?selected.nickname:v.nickname,phone=!old&&v.phone===''?selected.phone:v.phone;
  if((!old||nickname!==previous!.nickname)&&(!nickname||[...nickname].length>50||nickname!==nickname.trim()||/[\u0000-\u001f\u007f]/u.test(nickname)))throw new ValidateException('配送员名称不能为空、超过50字或含空白控制字符');
  if((!old||phone!==previous!.phone)&&!/^1[3456789]\d{9}$/u.test(phone))throw new ValidateException('新增或改变手机号须为合法11位大陆手机号');
  if((!old||v.status!==previous!.status)&&![0,1].includes(v.status))throw new ValidateException('配送员状态无效');
  const granting=!old||v.status===1&&old.status!==1;
  if(granting&&s.rows.some(r=>active(r)&&r.id!==old?.id&&r.uid===v.uid))throw new ValidateException('该用户已有平台配送身份，不能新增或启用重复身份');
  if((!old||phone!==previous!.phone||granting)&&s.rows.some(r=>active(r)&&r.id!==old?.id&&r.phone===phone))throw new ValidateException('同一手机号已有平台配送员，不能新增或启用重复身份');
  await assertDeliveryAvatarChange(tx,old?{avatar:old.avatar,uid:old.uid}:null,{avatar:v.avatar,uid:v.uid,userAvatar:selected.avatar});
  return {selected,data:{uid:v.uid,avatar:v.avatar,nickname,phone,status:v.status}};
 }
 mutate(value:unknown,actor:AdminAuthorityActor){const a=deliveryRequest(value,actor.id);return this.transaction(actor,true,false,async tx=>{
  const prior=await this.prior(tx,a);if(prior){if(prior.state!=='committed')throw conflict('原配送员操作已封存，不能再提交');return prior;}
  const before=await this.source(tx,true);if(a.revision!==before.revision)throw conflict('配送身份或关联用户目录已变化，请先核对回执');
  const old=before.rows.find(r=>r.id===a.target_id&&active(r));if(a.target_id&&!old)throw new NotFoundException('平台配送员不存在或已删除');
  const expected=new Map(before.rows.map(r=>[r.id,strip(r)])),protectedUsers=new Map(before.users.map(r=>[r.uid,r]));
  let id=a.target_id,created=0,updated=0;
  if(a.operation==='create'||a.operation==='update'){
   const{data,selected}=await this.validate(tx,before,a.payload as unknown as DeliveryPayload,old);protectedUsers.set(selected.uid,selected);
   if(a.operation==='create'){
    if(before.rows.length>=20000)throw conflict('完整配送员目录已达20000项');
    const insert={...data,type:0,relationId:0,isDel:0,addTime:Math.floor(Date.now()/1000)};
    const result=await tx.insert(deliveryService).values(insert).returning(),saved=result[0];
    if(result.length!==1||!saved||!Number.isSafeInteger(saved.id)||saved.id<1||expected.has(saved.id)||!same(saved,{...insert,id:saved.id}))throw Error('配送员新增完整字段回读不一致');
    id=saved.id;expected.set(id,saved);created=1;
   }else{await tx.update(deliveryService).set(data).where(eq(deliveryService.id,id));expected.set(id,{...strip(old!),...data});updated=1;}
  }else{
   const data=a.operation==='delete'?{isDel:1,status:0}:{status:a.payload.status as number};
   if(a.operation==='status'&&data.status===1){const selected=await this.eligible(tx,old!.uid);protectedUsers.set(selected.uid,selected);if(before.rows.some(r=>active(r)&&r.id!==id&&(r.uid===old!.uid||r.phone===old!.phone)))throw new ValidateException('存在重复平台配送身份或手机号，不能启用');}
   await tx.update(deliveryService).set(data).where(eq(deliveryService.id,id));expected.set(id,{...strip(old!),...data});updated=1;
  }
  const after=await this.source(tx,true),users=await this.users(tx,[...protectedUsers.keys()],true);
  if(!same(after.rows.map(strip),[...expected.values()].sort((a,b)=>a.id-b.id))||!same(users,[...protectedUsers.values()].sort((a,b)=>a.uid-b.uid)))throw Error('配送身份或用户完整写后回读不一致');
  return this.receiptInsert(tx,a,'committed',{id,created,updated,count:after.rows.filter(active).length,revision:after.revision});
 });}
 async legacy(operation:DeliveryOperation,idValue:unknown,input:Record<string,unknown>,actor:AdminAuthorityActor){
  const id=operation==='create'?0:deliveryAuthorId(idValue),snapshot=await this.catalog(new URLSearchParams(),actor),row=snapshot.list.find(r=>r.id===id);
  if(id&&!row)throw new NotFoundException('平台配送员不存在');
  const base=newDeliveryValues(row),allowed=[...DELIVERY_FIELDS,'id','image','wx_name','add_time','is_del','type','relation_id'];
  if(Object.keys(input).some(k=>!allowed.includes(k)))throw new ValidateException('旧配送员请求包含未授权字段');
  if(input.id!==undefined&&deliveryAuthorId(input.id,true)!==id)throw new ValidateException('配送员ID不一致');
  for(const key of ['type','relation_id','is_del','add_time'])if(input[key]!==undefined&&String(input[key])!==String(key==='add_time'?row?.add_time??0:0))throw new ValidateException('旧配送员只读资料不能更改');
  const v:Record<string,unknown>={...base};for(const key of DELIVERY_FIELDS)if(input[key]!==undefined)v[key]=input[key];
  if(input.wx_name!==undefined){
   if(input.nickname!==undefined&&input.nickname!==row?.user_nickname&&input.nickname!==input.wx_name)throw new ValidateException('配送员名称字段冲突');
   v.nickname=input.wx_name;
  }
  if(input.image!==undefined){
   if(input.image&&typeof input.image==='object'&&!Array.isArray(input.image)){
    const image=input.image as Record<string,unknown>;
    if(Object.keys(image).some(k=>!['uid','image'].includes(k))||!Object.hasOwn(image,'uid')||!Object.hasOwn(image,'image'))throw new ValidateException('商城用户选择结果无效');
    const uid=deliveryAuthorId(image.uid);if(input.uid!==undefined&&deliveryAuthorId(input.uid,true)!==0&&deliveryAuthorId(input.uid,true)!==uid)throw new ValidateException('用户选择与隐藏UID冲突');
    if(input.avatar!==undefined&&input.avatar!==''&&input.avatar!==image.image)throw new ValidateException('用户选择与头像冲突');v.uid=uid;v.avatar=image.image;
   }else if(typeof input.image==='string'){
    if(input.avatar!==undefined&&input.avatar!==base.avatar&&input.avatar!==input.image)throw new ValidateException('头像字段冲突');v.avatar=input.image;
   }else throw new ValidateException('商城用户或头像选择结果无效');
  }
  if(typeof v.status==='boolean')v.status=Number(v.status);
  for(const key of ['uid','status'])if(typeof v[key]==='string'&&/^(?:0|[1-9]\d*)$/.test(v[key] as string))v[key]=Number(v[key]);
  if(operation!=='create'&&v.uid!==base.uid)throw new ValidateException('编辑配送员不能更改关联UID');
  for(const key of ['nickname','phone'] as const)if(typeof v[key]==='string'&&(operation==='create'||v[key]!==base[key]))v[key]=(v[key] as string).trim();
  if(operation==='create'||operation==='update')v.user_selection=await this.transaction(actor,false,false,async tx=>{const[u]=await this.users(tx,[deliveryAuthorId(v.uid)]);if(!u)throw new ValidateException('关联用户不存在');return deliveryUserSelection(u);});
  const payload=operation==='create'||operation==='update'?v:operation==='status'?{status:v.status}:{};
  const a:DeliveryAction={operation_id:crypto.randomUUID(),actor_id:actor.id,operation,target_id:id,revision:snapshot.revision,payload,payload_hash:''};a.payload_hash=deliveryActionHash(a);return this.mutate(a,actor);
 }
}
