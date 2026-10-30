import {asc,eq,getTableColumns,sql} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {systemLog,storeProductRule} from '@/models/schema';
import {HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {acquireAdminAuthorityWriteBarrier,loadAdminAuthorityLiveActor,type AdminAuthorityActor} from './AdminAuthorityWriteService';
import {authorizeAdminLegacyProductRead,assertAdminLegacyProductReadDeadline} from './AdminLegacyProductReadAuthority';
import {loadAdminProfileActor} from './AdminProfileService';
import {assertAdminRuleOperationReady} from '@/migrations/adminRuleOperation';
import {ruleName,ruleSpec,ruleReceipt,ruleUuid,type RuleAction,type RuleOperation,type RuleReceipt} from '../../../../view/common/ruleAuthor';
import {ruleInput,ruleQuery,ruleRequest} from './AdminRuleAuthorInput';

type Stored=typeof storeProductRule.$inferSelect&{rowVersion:string};
const columns=getTableColumns(storeProductRule);
const conflict=(message:string)=>new HttpApiException(message,409,409);
const data=({rowVersion:_,...row}:Stored)=>row;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const visible=(row:typeof storeProductRule.$inferSelect)=>row.type===0&&row.relationId===0;
const publicRow=(row:Stored)=>({id:row.id,type:row.type,relation_id:row.relationId,rule_name:row.ruleName,rule_value:row.ruleValue});
function databaseError(error:unknown):never {
 let cause=error;
 for(let i=0;i<8&&cause&&typeof cause==='object';i++){
  const code='code'in cause?String(cause.code):'';
  if(['55P03','40P01','40001','23505'].includes(code))throw conflict('规格模板或权限正在变化，请先读取原回执');
  if(['42501','42P01','42883','57014'].includes(code))throw Object.assign(new ServiceUnavailableException('规格模板写入能力未就绪或操作超时'),{cause:error});
  cause='cause'in cause?cause.cause:undefined;
 }
 throw error;
}

/** Recoverable platform author; mature old CRUD and copied product/Supplier SKUs remain independent. */
export class AdminRuleAuthorService {
 constructor(private readonly container:Container){}
 private transaction<T>(actor:AdminAuthorityActor,write:boolean,owner:boolean,work:(tx:DbClient)=>Promise<T>):Promise<T>{
  return withTx(this.container,async tx=>{
   if(write){
    await acquireAdminAuthorityWriteBarrier(tx);
    if(owner)await loadAdminProfileActor(tx,actor);else await loadAdminAuthorityLiveActor(tx,actor,'product.manage');
    // Keep the existing platform rule fence before the whole-source/table gate.
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(731612,0)`);
    await tx.execute(sql`LOCK TABLE ONLY public.store_product_rule IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    await assertAdminRuleOperationReady(tx);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(731648,1)`);
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
 private async source(tx:DbClient){
  const [shape]=await tx.execute(sql`SELECT ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public.store_product_rule'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum) AS names`);
  const names=shape?.names,known=Object.values(columns).map(column=>column.name);
  if(!Array.isArray(names)||names.length!==known.length||names.some(name=>typeof name!=='string'||!known.includes(name)))throw new ServiceUnavailableException('规格模板表结构无法完整核验');
  const rows=await tx.select({...columns,rowVersion:sql<string>`xmin::text`}).from(storeProductRule).orderBy(asc(storeProductRule.id)).limit(20001);
  if(rows.length>20000)throw new ServiceUnavailableException('完整规格模板目录超过20000项，不能截断');
  if(new TextEncoder().encode(JSON.stringify(rows)).length>16*1024*1024)throw new ServiceUnavailableException('完整规格模板目录超过16MiB，不能截断');
  return {rows,revision:createHash('sha256').update(JSON.stringify({domain:'product-rule-catalog-v1',rows})).digest('hex')};
 }
 catalog(query:URLSearchParams,actor:AdminAuthorityActor){
  ruleQuery(query);return this.transaction(actor,false,false,async tx=>{const source=await this.source(tx),list=source.rows.filter(visible).sort((a,b)=>b.id-a.id).map(publicRow);
   return {list,count:list.length,revision:source.revision,can_create:source.rows.length<20000,write_ready:await assertAdminRuleOperationReady(tx).then(()=>true).catch(()=>false)};
  });
 }
 private receiptRow(row:Record<string,unknown>,action?:RuleAction):RuleReceipt {
  const original=action??{operation_id:String(row.operation_id),actor_id:Number(row.actor_id),operation:row.operation as RuleOperation,target_id:Number(row.target_id),revision:String(row.revision),payload_hash:String(row.payload_hash),payload:{}};
  return ruleInput(()=>ruleReceipt({operation_id:row.operation_id,actor_id:row.actor_id,operation:row.operation,target_id:row.target_id,revision:row.revision,payload_hash:row.payload_hash,state:row.state,result:row.result},original));
 }
 private async prior(tx:DbClient,action:RuleAction){
  const rows=await tx.execute(sql`SELECT * FROM public.admin_rule_operation WHERE operation_id=${action.operation_id}::uuid`);if(!rows.length)return null;const row=rows[0]!;
  if(row.actor_id!==action.actor_id||row.operation!==action.operation||row.target_id!==action.target_id||row.payload_hash!==action.payload_hash||row.revision!==action.revision)throw conflict('原规格模板请求标识已用于不同操作');return this.receiptRow(row,action);
 }
 private async insertReceipt(tx:DbClient,action:RuleAction,state:RuleReceipt['state'],result:RuleReceipt['result']){
  const rows=await tx.execute(sql`INSERT INTO public.admin_rule_operation(operation_id,actor_id,operation,target_id,payload_hash,revision,state,result,created_at)
   VALUES (${action.operation_id}::uuid,${action.actor_id},${action.operation},${action.target_id},${action.payload_hash},${action.revision},${state},${JSON.stringify(result)}::jsonb,${Math.floor(Date.now()/1000)}) RETURNING *`);
  if(rows.length!==1)throw Error('规格模板操作回执缺失');return this.receiptRow(rows[0]!,action);
 }
 receipt(id:unknown,query:URLSearchParams,actor:AdminAuthorityActor){
  ruleQuery(query);const uuid=ruleInput(()=>ruleUuid(id));return this.transaction(actor,false,true,async tx=>{
   const rows=await tx.execute(sql`SELECT * FROM public.admin_rule_operation WHERE operation_id=${uuid}::uuid AND actor_id=${actor.id}`);
   if(rows.length!==1)throw new NotFoundException('尚未找到原规格模板回执，结果仍未知');return this.receiptRow(rows[0]!);
  });
 }
 resolve(value:unknown,actor:AdminAuthorityActor){const action=ruleRequest(value,actor.id);return this.transaction(actor,true,true,async tx=>await this.prior(tx,action)??await this.insertReceipt(tx,action,'not_applied',{id:action.target_id,created:0,updated:0,count:0,revision:action.revision}));}
 private async audit(tx:DbClient,actor:AdminAuthorityActor,operation:RuleOperation,id:number){
  const expected={storeId:0,merchantId:0,adminName:'',ip:'',adminId:actor.id,type:'product_rule_catalog',path:`product/product/rule/${id}`,page:'商品规格模板管理',method:operation==='delete'?'DELETE':'POST',action:JSON.stringify({operation,id}),addTime:Math.floor(Date.now()/1000)};
  const rows=await tx.insert(systemLog).values(expected).returning(),row=rows[0];
  const matches=(value:typeof row|undefined)=>value&&Number.isSafeInteger(value.id)&&value.id>0&&Object.entries(expected).every(([key,v])=>value[key as keyof typeof value]===v);
  if(rows.length!==1||!matches(row))throw Error('规格模板审计回执不完整');const [readBack]=await tx.select().from(systemLog).where(eq(systemLog.id,row.id)).limit(1);if(!matches(readBack))throw Error('规格模板审计完整回读不一致');
 }
 mutate(value:unknown,actor:AdminAuthorityActor){
  const action=ruleRequest(value,actor.id);return this.transaction(actor,true,false,async tx=>{
   const prior=await this.prior(tx,action);if(prior){if(prior.state!=='committed')throw conflict('原规格模板操作已封存，不能再提交');return prior;}
   const before=await this.source(tx);if(action.revision!==before.revision)throw conflict('规格模板目录已变化，请先核对原回执');
   const old=before.rows.find(row=>row.id===action.target_id&&visible(row));if(action.target_id&&!old)throw new NotFoundException('规格模板不存在');
   if(old)await tx.select({id:storeProductRule.id}).from(storeProductRule).where(eq(storeProductRule.id,old.id)).for('update',{noWait:true});
   const expected=new Map(before.rows.map(row=>[row.id,data(row)]));let id=action.target_id,created=0,updated=0;
   if(action.operation==='delete'){
    // Templates are copy sources. No product rule FK or in-use deletion prohibition.
    const removed=await tx.delete(storeProductRule).where(eq(storeProductRule.id,id)).returning();if(removed.length!==1||!same(removed[0],data(old!)))throw Error('规格模板物理删除完整回读不一致');expected.delete(id);updated=1;
   }else{
    const ruleNameValue=ruleInput(()=>ruleName(action.payload.rule_name,old?.ruleName));
    const ruleValue=action.payload.mode==='preserve'?old!.ruleValue:JSON.stringify(ruleInput(()=>ruleSpec(action.payload.spec)));
    if((!old||ruleNameValue!==old.ruleName)&&before.rows.some(row=>row.id!==id&&visible(row)&&row.ruleName===ruleNameValue))throw new ValidateException('规格模板名称已存在');
    if(action.operation==='create'){
     if(before.rows.length>=20000)throw conflict('完整规格模板目录已达20000项');const values={type:0,relationId:0,ruleName:ruleNameValue,ruleValue};
     const rows=await tx.insert(storeProductRule).values(values).returning(),saved=rows[0];
     if(rows.length!==1||!saved||!Number.isSafeInteger(saved.id)||saved.id<1||expected.has(saved.id)||!same(saved,{id:saved.id,...values}))throw Error('规格模板新增完整字段回读不一致');id=saved.id;expected.set(id,saved);created=1;
    }else{
     if(ruleNameValue!==old!.ruleName||ruleValue!==old!.ruleValue)await tx.update(storeProductRule).set({ruleName:ruleNameValue,ruleValue}).where(eq(storeProductRule.id,id));
     expected.set(id,{...data(old!),ruleName:ruleNameValue,ruleValue});updated=1;
    }
   }
   await this.audit(tx,actor,action.operation,id);await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
   const after=await this.source(tx);if(!same(after.rows.map(data),[...expected.values()].sort((a,b)=>a.id-b.id)))throw Error('规格模板完整写后回读不一致');
   return this.insertReceipt(tx,action,'committed',{id,created,updated,count:after.rows.filter(visible).length,revision:after.revision});
  });
 }
}
