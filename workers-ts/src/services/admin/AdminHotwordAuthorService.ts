import {and,asc,eq,getTableColumns,ne,sql} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {storeProductWords,systemLog} from '@/models/schema';
import type {Env} from '@/env';
import {HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {acquireAdminAuthorityWriteBarrier,loadAdminAuthorityLiveActor,type AdminAuthorityActor} from './AdminAuthorityWriteService';
import {authorizeAdminLegacyProductRead,assertAdminLegacyProductReadDeadline} from './AdminLegacyProductReadAuthority';
import {loadAdminProfileActor} from './AdminProfileService';
import {assertAdminHotwordOperationReady} from '@/migrations/adminHotwordOperation';
import {publicHotwordAuthorImages,renderHotwordAuthorImages,assertHotwordAuthorIconChange} from '@/services/product/HotwordAuthorAssetPolicy';
import {hotwordNormalized,hotwordProjection,hotwordReceipt,hotwordUuid,type HotwordAction,type HotwordOperation,type HotwordReceipt,type HotwordRow} from '../../../../view/common/hotwordAuthor';
import {hotwordInput,hotwordQuery,hotwordRequest} from './AdminHotwordAuthorInput';

type Row=typeof storeProductWords.$inferSelect;
type Stored=Row&{rowVersion:string};
const columns=getTableColumns(storeProductWords),same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const data=({rowVersion:_,...row}:Stored)=>row;
const visible=(row:Row)=>row.type===0&&row.relationId===0&&row.isDel===0;
const owned=(id:number)=>and(eq(storeProductWords.id,id),eq(storeProductWords.type,0),eq(storeProductWords.relationId,0),eq(storeProductWords.isDel,0));
const conflict=(message:string)=>new HttpApiException(message,409,409);
const publicRow=(row:Stored)=>({id:row.id,type:row.type,relation_id:row.relationId,name:row.name,color:row.color,bg_color:row.bgColor,border_color:row.borderColor,icon:row.icon,is_show:row.isShow,sort:row.sort,is_search:row.isSearch,is_hot:row.isHot,is_del:row.isDel,add_time:row.addTime});
function databaseError(error:unknown):never{let cause=error;for(let i=0;i<8&&cause&&typeof cause==='object';i++){const code='code'in cause?String(cause.code):'';if(['55P03','40P01','40001','23505'].includes(code))throw conflict('热词、图库或权限正在变化，请先读取原回执');if(['42501','42P01','42883','57014'].includes(code))throw Object.assign(new ServiceUnavailableException('热词写入能力未就绪或操作超时'),{cause:error});cause='cause'in cause?cause.cause:undefined;}throw error;}

/** Complete recoverable author alongside the mature Word CRUD/public contracts. */
export class AdminHotwordAuthorService{
 constructor(private readonly container:Container,private readonly env:Pick<Env,'APP_KEY'>){}
 private transaction<T>(actor:AdminAuthorityActor,write:boolean,owner:boolean,work:(tx:DbClient)=>Promise<T>):Promise<T>{return withTx(this.container,async tx=>{
  if(write){
   await acquireAdminAuthorityWriteBarrier(tx);
   if(owner)await loadAdminProfileActor(tx,actor);else await loadAdminAuthorityLiveActor(tx,actor,'product.manage');
   await tx.execute(sql`SET LOCAL lock_timeout='2s'`);await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
   await tx.execute(sql`SELECT pg_advisory_xact_lock(731614,0)`);
   await tx.execute(sql`LOCK TABLE ONLY public.store_product_words IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
   await assertAdminHotwordOperationReady(tx);await tx.execute(sql`SELECT pg_advisory_xact_lock(731653,-1)`);
  }else{
   await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
   await tx.execute(sql`SET LOCAL statement_timeout='5s'`);await tx.execute(sql`SET LOCAL lock_timeout='2s'`);await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
   if(owner)await loadAdminProfileActor(tx,actor);else await authorizeAdminLegacyProductRead(tx,actor,'product.view');
  }
  const result=await work(tx);await assertAdminLegacyProductReadDeadline(tx,actor);if(write&&!owner)await loadAdminAuthorityLiveActor(tx,actor,'product.manage');return result;
 }).catch(databaseError);}
 private async source(tx:DbClient){
  const [shape]=await tx.execute(sql`SELECT ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public.store_product_words'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum) AS names`);
  const names=shape?.names,known=Object.values(columns).map(column=>column.name);
  if(!Array.isArray(names)||names.length!==known.length||names.some(name=>typeof name!=='string'||!known.includes(name)))throw new ServiceUnavailableException('热词表结构无法完整核验');
  const rows=await tx.select({...columns,rowVersion:sql<string>`xmin::text`}).from(storeProductWords).orderBy(asc(storeProductWords.id)).limit(20001);
  if(rows.length>20000||new TextEncoder().encode(JSON.stringify(rows)).length>16*1024*1024)throw new ServiceUnavailableException('完整热词来源超过20000项或16MiB，不能截断');
  return {rows,revision:createHash('sha256').update(JSON.stringify({domain:'product-hotword-catalog-v1',rows})).digest('hex')};
 }
 private async project(tx:DbClient,rows:Stored[]):Promise<HotwordRow[]>{
  const icons=await renderHotwordAuthorImages(this.env.APP_KEY,await publicHotwordAuthorImages(tx,rows.map(row=>row.icon)));
  return rows.map((row,i)=>({...publicRow(row),preview:{...hotwordProjection({color:row.color,bg_color:row.bgColor,border_color:row.borderColor,icon:''}),icon:icons[i]!}}));
 }
 catalog(query:URLSearchParams,actor:AdminAuthorityActor){hotwordQuery(query);return this.transaction(actor,false,false,async tx=>{const source=await this.source(tx),rows=source.rows.filter(visible).sort((a,b)=>b.sort-a.sort||b.id-a.id);return {list:await this.project(tx,rows),count:rows.length,revision:source.revision,can_create:source.rows.length<20000,write_ready:await assertAdminHotwordOperationReady(tx).then(()=>true).catch(()=>false)};});}
 private receiptRow(row:Record<string,unknown>,action?:HotwordAction):HotwordReceipt{const original=action??{operation_id:String(row.operation_id),actor_id:Number(row.actor_id),operation:row.operation as HotwordOperation,target_id:Number(row.target_id),revision:String(row.revision),payload_hash:String(row.payload_hash),payload:{}};return hotwordInput(()=>hotwordReceipt({operation_id:row.operation_id,actor_id:row.actor_id,operation:row.operation,target_id:row.target_id,revision:row.revision,payload_hash:row.payload_hash,state:row.state,result:row.result},original));}
 private async prior(tx:DbClient,action:HotwordAction){const rows=await tx.execute(sql`SELECT * FROM public.admin_hotword_operation WHERE operation_id=${action.operation_id}::uuid`);if(!rows.length)return null;const row=rows[0]!;if(row.actor_id!==action.actor_id||row.operation!==action.operation||row.target_id!==action.target_id||row.payload_hash!==action.payload_hash||row.revision!==action.revision)throw conflict('原热词请求标识已用于不同操作');return this.receiptRow(row,action);}
 private async insertReceipt(tx:DbClient,action:HotwordAction,state:HotwordReceipt['state'],result:HotwordReceipt['result']){const rows=await tx.execute(sql`INSERT INTO public.admin_hotword_operation(operation_id,actor_id,operation,target_id,payload_hash,revision,state,result,created_at) VALUES (${action.operation_id}::uuid,${action.actor_id},${action.operation},${action.target_id},${action.payload_hash},${action.revision},${state},${JSON.stringify(result)}::jsonb,${Math.floor(Date.now()/1000)}) RETURNING *`);if(rows.length!==1)throw Error('热词操作回执缺失');return this.receiptRow(rows[0]!,action);}
 receipt(id:unknown,query:URLSearchParams,actor:AdminAuthorityActor){hotwordQuery(query);const uuid=hotwordInput(()=>hotwordUuid(id));return this.transaction(actor,false,true,async tx=>{const rows=await tx.execute(sql`SELECT * FROM public.admin_hotword_operation WHERE operation_id=${uuid}::uuid AND actor_id=${actor.id}`);if(rows.length!==1)throw new NotFoundException('尚未找到原热词回执，结果仍未知');return this.receiptRow(rows[0]!);});}
 resolve(value:unknown,actor:AdminAuthorityActor){const action=hotwordRequest(value,actor.id);return this.transaction(actor,true,true,async tx=>await this.prior(tx,action)??await this.insertReceipt(tx,action,'not_applied',{id:action.target_id,created:0,updated:0,count:0,revision:action.revision}));}
 private async audit(tx:DbClient,actor:AdminAuthorityActor,operation:HotwordOperation,id:number,isShow?:number){
  const name=operation==='delete'?'soft_delete':operation==='show'?isShow?'show':'hide':operation;
  const expected={storeId:0,merchantId:0,adminId:actor.id,adminName:'',ip:'',path:`/api/admin/product/words/${id}`,page:'/product/metadata',method:operation==='delete'?'DELETE':operation==='show'?'PUT':'POST',action:`product_words.${name};id=${id}`,type:'product_words',addTime:Math.floor(Date.now()/1000)};
  const rows=await tx.insert(systemLog).values(expected).returning(),row=rows[0];const matches=(value:typeof row|undefined)=>value&&Number.isSafeInteger(value.id)&&value.id>0&&Object.entries(expected).every(([key,v])=>value[key as keyof typeof value]===v);
  if(rows.length!==1||!matches(row))throw Error('热词审计完整回执不一致');const [readBack]=await tx.select().from(systemLog).where(eq(systemLog.id,row.id)).limit(1);if(!matches(readBack))throw Error('热词审计完整回读不一致');
 }
 mutate(value:unknown,actor:AdminAuthorityActor){const action=hotwordRequest(value,actor.id);return this.transaction(actor,true,false,async tx=>{
  const prior=await this.prior(tx,action);if(prior){if(prior.state!=='committed')throw conflict('原热词操作已封存，不能再提交');return prior;}
  const before=await this.source(tx);if(action.revision!==before.revision)throw conflict('热词目录已变化，请先核对原回执');
  const old=before.rows.find(row=>row.id===action.target_id&&visible(row));if(action.target_id&&!old)throw new NotFoundException('搜索热词不存在');
  if(old)await tx.select({id:storeProductWords.id}).from(storeProductWords).where(owned(old.id)).for('update',{noWait:true});
  const expected=new Map(before.rows.map(row=>[row.id,data(row)]));let id=action.target_id,created=0,updated=0,changedIcon:string|undefined;
  if(action.operation==='delete'){
   const delta={isDel:1,isShow:0,isHot:0};await tx.update(storeProductWords).set(delta).where(owned(id));expected.set(id,{...data(old!),...delta});updated=1;
  }else if(action.operation==='show'){
   const isShow=action.payload.is_show as number;if(isShow!==old!.isShow)await tx.update(storeProductWords).set({isShow}).where(owned(id));expected.set(id,{...data(old!),isShow});updated=1;
  }else{
   const original=old?{...publicRow(old),preview:{color:'',bg_color:'',border_color:'',icon:''}}:undefined;
   const values=hotwordInput(()=>hotwordNormalized(action.payload,original));
   await assertHotwordAuthorIconChange(tx,old?.icon??null,values.icon);if(!old||old.icon!==values.icon)changedIcon=values.icon;
   if(!old||values.name!==old.name){const [duplicate]=await tx.select({id:storeProductWords.id}).from(storeProductWords).where(and(eq(storeProductWords.type,0),eq(storeProductWords.relationId,0),eq(storeProductWords.isDel,0),sql`lower(btrim(${storeProductWords.name}))=${values.name.toLowerCase()}`,ne(storeProductWords.id,id))).limit(1);if(duplicate)throw new ValidateException('热词名称已经存在');}
   const delta={name:values.name,color:values.color,bgColor:values.bg_color,borderColor:values.border_color,icon:values.icon,sort:values.sort,isSearch:values.is_search,isShow:values.is_show};
   if(action.operation==='create'){
    if(before.rows.length>=20000)throw conflict('完整热词目录已达20000项');const inserted={type:0,relationId:0,name:delta.name,color:delta.color,bgColor:delta.bgColor,borderColor:delta.borderColor,icon:delta.icon,isShow:delta.isShow,sort:delta.sort,isSearch:delta.isSearch,isHot:0,isDel:0,addTime:Math.floor(Date.now()/1000)};
    const rows=await tx.insert(storeProductWords).values(inserted).returning(),saved=rows[0];if(rows.length!==1||!saved||!Number.isSafeInteger(saved.id)||saved.id<1||expected.has(saved.id)||!same(saved,{id:saved.id,...inserted}))throw Error('热词新增完整回读不一致');id=saved.id;expected.set(id,saved);created=1;
   }else{
    if(Object.entries(delta).some(([key,v])=>old![key as keyof Row]!==v))await tx.update(storeProductWords).set(delta).where(owned(id));expected.set(id,{...data(old!),...delta});updated=1;
   }
  }
  await this.audit(tx,actor,action.operation,id,action.operation==='show'?action.payload.is_show as number:undefined);
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  if(changedIcon!==undefined)await assertHotwordAuthorIconChange(tx,null,changedIcon);
  const after=await this.source(tx);if(!same(after.rows.map(data),[...expected.values()].sort((a,b)=>a.id-b.id)))throw Error('热词完整写后回读不一致');
  return this.insertReceipt(tx,action,'committed',{id,created,updated,count:after.rows.filter(visible).length,revision:after.revision});
 });}
}
