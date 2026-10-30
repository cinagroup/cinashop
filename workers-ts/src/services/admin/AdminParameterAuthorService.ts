import {and,asc,eq,getTableColumns,sql} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {systemLog,legacyCategory,storeProductSpecs,storeProduct,storeProductRelation} from '@/models/schema';
import {HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {acquireAdminAuthorityWriteBarrier,loadAdminAuthorityLiveActor,type AdminAuthorityActor} from './AdminAuthorityWriteService';
import {authorizeAdminLegacyProductRead,assertAdminLegacyProductReadDeadline} from './AdminLegacyProductReadAuthority';
import {loadAdminProfileActor} from './AdminProfileService';
import {assertAdminParameterOperationReady} from '@/migrations/adminParameterOperation';
import {parameterName,parameterSort,parameterSpecs,parameterReceipt,parameterUuid,type ParameterAction,type ParameterOperation,type ParameterReceipt} from '../../../../view/common/parameterAuthor';
import {parameterInput,parameterQuery,parameterRequest} from './AdminParameterAuthorInput';

type Parent=typeof legacyCategory.$inferSelect;
type Child=typeof storeProductSpecs.$inferSelect;
type Versioned<T>=T&{rowVersion:string};
type Source={parents:Versioned<Parent>[];children:Versioned<Child>[];revision:string};
const parentColumns=getTableColumns(legacyCategory),childColumns=getTableColumns(storeProductSpecs);
const conflict=(message:string)=>new HttpApiException(message,409,409);
const data=<T extends {rowVersion:string}>({rowVersion:_,...row}:T)=>row;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const visible=(row:Parent)=>row.type===0&&row.relationId===0&&row.ownerId===0&&row.group===3;
const ownParent=(id:number)=>and(eq(legacyCategory.id,id),eq(legacyCategory.type,0),eq(legacyCategory.relationId,0),eq(legacyCategory.ownerId,0),eq(legacyCategory.group,3));
const ownChildren=(id:number)=>and(eq(storeProductSpecs.tempId,id),eq(storeProductSpecs.type,0),eq(storeProductSpecs.relationId,0));
const publicChild=(row:Child)=>({id:row.id,type:row.type,relation_id:row.relationId,temp_id:row.tempId,name:row.name,value:row.value,sort:row.sort,status:row.status,add_time:row.addTime});
function databaseError(error:unknown):never{
 let cause=error;for(let i=0;i<8&&cause&&typeof cause==='object';i++){
  const code='code'in cause?String(cause.code):'';
  if(['55P03','40P01','40001','23505'].includes(code))throw conflict('参数模板、商品或权限正在变化，请先读取原回执');
  if(['42501','42P01','42883','57014'].includes(code))throw Object.assign(new ServiceUnavailableException('参数模板写入能力未就绪或操作超时'),{cause:error});
  cause='cause'in cause?cause.cause:undefined;
 }throw error;
}

/** Recoverable platform parameter author; legacy CRUD, Supplier and product-copy consumers keep their contracts. */
export class AdminParameterAuthorService{
 constructor(private readonly container:Container){}
 private transaction<T>(actor:AdminAuthorityActor,write:boolean,owner:boolean,work:(tx:DbClient)=>Promise<T>):Promise<T>{
  return withTx(this.container,async tx=>{
   if(write){
    await acquireAdminAuthorityWriteBarrier(tx);
    if(owner)await loadAdminProfileActor(tx,actor);else await loadAdminAuthorityLiveActor(tx,actor,'product.manage');
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(731613,0)`);
    await tx.execute(sql`LOCK TABLE ONLY public.category, ONLY public.store_product_specs IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    await assertAdminParameterOperationReady(tx);
    // Positive second keys can be uid/productId quote locks. Keep this key negative.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(731652,-1)`);
   }else{
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
    if(owner)await loadAdminProfileActor(tx,actor);else await authorizeAdminLegacyProductRead(tx,actor,'product.view');
   }
   const result=await work(tx);await assertAdminLegacyProductReadDeadline(tx,actor);
   if(write&&!owner)await loadAdminAuthorityLiveActor(tx,actor,'product.manage');return result;
  }).catch(databaseError);
 }
 private async source(tx:DbClient):Promise<Source>{
  for(const [table,columns]of [['category',parentColumns],['store_product_specs',childColumns]]as const){
   const [shape]=await tx.execute(sql`SELECT ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid=${'public.'+table}::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum) AS names`);
   const names=shape?.names,known=Object.values(columns).map(column=>column.name);
   if(!Array.isArray(names)||names.length!==known.length||names.some(name=>typeof name!=='string'||!known.includes(name)))throw new ServiceUnavailableException('参数模板表结构无法完整核验');
  }
  // Full private images include every scope and unrelated category group. Public projection is platform group3 only.
  const parents=await tx.select({...parentColumns,rowVersion:sql<string>`xmin::text`}).from(legacyCategory).orderBy(asc(legacyCategory.id)).limit(20001);
  const children=await tx.select({...childColumns,rowVersion:sql<string>`xmin::text`}).from(storeProductSpecs).orderBy(asc(storeProductSpecs.id)).limit(20001);
  if(parents.length>20000||children.length>20000)throw new ServiceUnavailableException('完整参数来源每表超过20000项，不能截断');
  const raw=JSON.stringify({parents,children});if(new TextEncoder().encode(raw).length>16*1024*1024)throw new ServiceUnavailableException('完整参数来源超过16MiB，不能截断');
  return {parents,children,revision:createHash('sha256').update(JSON.stringify({domain:'product-parameter-catalog-v1',parents,children})).digest('hex')};
 }
 private project(source:Source){
  const parents=source.parents.filter(visible).sort((a,b)=>b.sort-a.sort||b.id-a.id);
  if(parents.length>2000)throw new ServiceUnavailableException('完整平台参数模板超过2000项，不能截断');
  const grouped=new Map<number,Versioned<Child>[]>();for(const child of source.children){const group=grouped.get(child.tempId)??[];group.push(child);grouped.set(child.tempId,group);}
  return parents.map(row=>{
   const children=(grouped.get(row.id)??[]).sort((a,b)=>b.sort-a.sort||a.id-b.id);
   if(children.length>2000)throw new ServiceUnavailableException('完整参数子行超过2000项，不能截断');
   if(children.some(child=>child.type!==0||child.relationId!==0))throw new ServiceUnavailableException('参数模板子行归属异常，请先核对历史数据');
   return {id:row.id,pid:row.pid,type:row.type,relation_id:row.relationId,owner_id:row.ownerId,name:row.name,sort:row.sort,group:row.group,other:row.other,is_show:row.isShow,add_time:row.addTime,integral_min:row.integralMin,integral_max:row.integralMax,specs:children.map(publicChild)};
  });
 }
 catalog(query:URLSearchParams,actor:AdminAuthorityActor){parameterQuery(query);return this.transaction(actor,false,false,async tx=>{const source=await this.source(tx),list=this.project(source);return {list,count:list.length,revision:source.revision,can_create:source.parents.length<20000&&source.children.length<20000&&list.length<2000,write_ready:await assertAdminParameterOperationReady(tx).then(()=>true).catch(()=>false)};});}
 private receiptRow(row:Record<string,unknown>,action?:ParameterAction):ParameterReceipt{
  const original=action??{operation_id:String(row.operation_id),actor_id:Number(row.actor_id),operation:row.operation as ParameterOperation,target_id:Number(row.target_id),revision:String(row.revision),payload_hash:String(row.payload_hash),payload:{}};
  return parameterInput(()=>parameterReceipt({operation_id:row.operation_id,actor_id:row.actor_id,operation:row.operation,target_id:row.target_id,revision:row.revision,payload_hash:row.payload_hash,state:row.state,result:row.result},original));
 }
 private async prior(tx:DbClient,action:ParameterAction){const rows=await tx.execute(sql`SELECT * FROM public.admin_parameter_operation WHERE operation_id=${action.operation_id}::uuid`);if(!rows.length)return null;const row=rows[0]!;if(row.actor_id!==action.actor_id||row.operation!==action.operation||row.target_id!==action.target_id||row.payload_hash!==action.payload_hash||row.revision!==action.revision)throw conflict('原参数请求标识已用于不同操作');return this.receiptRow(row,action);}
 private async insertReceipt(tx:DbClient,action:ParameterAction,state:ParameterReceipt['state'],result:ParameterReceipt['result']){
  const rows=await tx.execute(sql`INSERT INTO public.admin_parameter_operation(operation_id,actor_id,operation,target_id,payload_hash,revision,state,result,created_at) VALUES (${action.operation_id}::uuid,${action.actor_id},${action.operation},${action.target_id},${action.payload_hash},${action.revision},${state},${JSON.stringify(result)}::jsonb,${Math.floor(Date.now()/1000)}) RETURNING *`);if(rows.length!==1)throw Error('参数模板操作回执缺失');return this.receiptRow(rows[0]!,action);
 }
 receipt(id:unknown,query:URLSearchParams,actor:AdminAuthorityActor){parameterQuery(query);const uuid=parameterInput(()=>parameterUuid(id));return this.transaction(actor,false,true,async tx=>{const rows=await tx.execute(sql`SELECT * FROM public.admin_parameter_operation WHERE operation_id=${uuid}::uuid AND actor_id=${actor.id}`);if(rows.length!==1)throw new NotFoundException('尚未找到原参数模板回执，结果仍未知');return this.receiptRow(rows[0]!);});}
 resolve(value:unknown,actor:AdminAuthorityActor){const action=parameterRequest(value,actor.id);return this.transaction(actor,true,true,async tx=>await this.prior(tx,action)??await this.insertReceipt(tx,action,'not_applied',{id:action.target_id,created:0,updated:0,count:0,revision:action.revision}));}
 private async audit(tx:DbClient,actor:AdminAuthorityActor,operation:ParameterOperation,id:number){
  const expected={storeId:0,merchantId:0,adminName:'',ip:'',adminId:actor.id,path:`product/specs/${id}`,page:'商品参数模板管理',method:operation==='delete'?'DELETE':'POST',type:'product_specs_catalog',action:JSON.stringify({operation,id}),addTime:Math.floor(Date.now()/1000)};
  const rows=await tx.insert(systemLog).values(expected).returning(),row=rows[0];const matches=(value:typeof row|undefined)=>value&&Number.isSafeInteger(value.id)&&value.id>0&&Object.entries(expected).every(([key,v])=>value[key as keyof typeof value]===v);
  if(rows.length!==1||!matches(row))throw Error('参数模板审计回执不完整');const [readBack]=await tx.select().from(systemLog).where(eq(systemLog.id,row.id)).limit(1);if(!matches(readBack))throw Error('参数模板审计完整回读不一致');
 }
 private async noProductReferences(tx:DbClient,id:number){
  const direct=await tx.select({id:storeProduct.id}).from(storeProduct).where(and(eq(storeProduct.specsId,id),eq(storeProduct.isDel,0))).limit(1);
  const relation=await tx.select({id:storeProductRelation.id}).from(storeProductRelation).where(and(eq(storeProductRelation.type,6),eq(storeProductRelation.relationId,id))).limit(1);
  if(direct.length||relation.length)throw new ValidateException('该参数模板仍被商品使用，不能删除');
 }
 mutate(value:unknown,actor:AdminAuthorityActor){const action=parameterRequest(value,actor.id);return this.transaction(actor,true,false,async tx=>{
  const prior=await this.prior(tx,action);if(prior){if(prior.state!=='committed')throw conflict('原参数操作已封存，不能再提交');return prior;}
  const before=await this.source(tx);if(action.revision!==before.revision)throw conflict('参数模板目录已变化，请先核对原回执');this.project(before);
  const old=before.parents.find(row=>row.id===action.target_id&&visible(row));if(action.target_id&&!old)throw new NotFoundException('参数模板不存在');
  if(old)await tx.select({id:legacyCategory.id}).from(legacyCategory).where(ownParent(old.id)).for('update',{noWait:true});
  const parents=new Map(before.parents.map(row=>[row.id,data(row)])),children=new Map(before.children.map(row=>[row.id,data(row)]));let id=action.target_id,created=0,updated=0;
  const originalChildren=old?before.children.filter(row=>row.tempId===id):[];
  if(originalChildren.some(row=>row.type!==0||row.relationId!==0))throw new ValidateException('参数模板子行归属漂移，请先核对历史数据');
  const proposed=action.operation==='delete'?null:{name:parameterInput(()=>parameterName(action.payload.name,old?.name)),sort:parameterInput(()=>parameterSort(action.payload.sort,old?.sort)),replacement:action.payload.mode==='replace'?parameterInput(()=>parameterSpecs(action.payload.specs)):null};
  if(proposed&&(!old||proposed.name!==old.name)&&before.parents.some(row=>visible(row)&&row.id!==id&&row.name===proposed.name))throw new ValidateException('参数模板名称已存在');
  const now=Math.floor(Date.now()/1000);
  if(action.operation==='delete')await this.noProductReferences(tx,id);
  if(action.operation==='delete'||action.payload.mode==='replace'){
   if(action.operation==='delete'||old){const removed=await tx.delete(storeProductSpecs).where(ownChildren(id)).returning();if(removed.length!==originalChildren.length||new Set(removed.map(row=>row.id)).size!==removed.length||removed.some(row=>{const original=originalChildren.find(old=>old.id===row.id);return !original||!same(row,data(original));}))throw Error('参数子行物理删除完整回读不一致');for(const row of originalChildren)children.delete(row.id);}
  }
  if(action.operation==='delete'){
   const removed=await tx.delete(legacyCategory).where(ownParent(id)).returning();if(removed.length!==1||!same(removed[0],data(old!)))throw Error('参数模板物理删除完整回读不一致');parents.delete(id);updated=1;
  }else{
   const {name,sort,replacement}=proposed!;
   if(action.operation==='create'){
    if(before.parents.length>=20000||before.parents.filter(visible).length>=2000)throw conflict('完整参数模板目录已达容量');
    const values={pid:0,type:0,relationId:0,ownerId:0,name,sort,group:3,other:null,isShow:1,addTime:now,integralMin:0,integralMax:0};const rows=await tx.insert(legacyCategory).values(values).returning(),saved=rows[0];
    if(rows.length!==1||!saved||!Number.isSafeInteger(saved.id)||saved.id<1||parents.has(saved.id)||!same(saved,{id:saved.id,...values}))throw Error('参数模板新增完整回读不一致');id=saved.id;parents.set(id,saved);created=1;
   }else{if(name!==old!.name||sort!==old!.sort)await tx.update(legacyCategory).set({name,sort}).where(ownParent(id));parents.set(id,{...data(old!),name,sort});updated=1;}
   if(replacement){
    if(children.size+replacement.length>20000)throw conflict('完整参数子目录已达容量');
    const values=replacement.map(row=>({type:0,relationId:0,tempId:id,name:row.name,value:row.value,sort:row.sort,status:row.status,addTime:now}));
    const rows=values.length?await tx.insert(storeProductSpecs).values(values).returning():[];
    if(rows.length!==values.length||new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('参数子行新增完整回执不一致');
    const unmatched=[...values];for(const row of rows){const index=unmatched.findIndex(value=>same(row,{id:row.id,...value}));if(!Number.isSafeInteger(row.id)||row.id<1||children.has(row.id)||index<0)throw Error('参数子行新增完整字段回读不一致');unmatched.splice(index,1);children.set(row.id,row);}
   }
  }
  await this.audit(tx,actor,action.operation,id);await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);if(action.operation==='delete')await this.noProductReferences(tx,id);
  const after=await this.source(tx);if(!same(after.parents.map(data),[...parents.values()].sort((a,b)=>a.id-b.id))||!same(after.children.map(data),[...children.values()].sort((a,b)=>a.id-b.id)))throw Error('参数模板完整写后回读不一致');
  return this.insertReceipt(tx,action,'committed',{id,created,updated,count:this.project(after).length,revision:after.revision});
 });}
}
