import {and,asc,eq,getTableColumns,sql} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {systemLog,storeProductUnit,storeProduct} from '@/models/schema';
import {HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {acquireAdminAuthorityWriteBarrier,loadAdminAuthorityLiveActor,type AdminAuthorityActor} from './AdminAuthorityWriteService';
import {authorizeAdminLegacyProductRead,assertAdminLegacyProductReadDeadline} from './AdminLegacyProductReadAuthority';
import {loadAdminProfileActor} from './AdminProfileService';
import {assertAdminUnitOperationReady} from '@/migrations/adminUnitOperation';
import {lockProductUnitLifecycle} from '@/services/product/ProductUnitLifecycle';
import {unitName,unitSort,unitReceipt,unitUuid,type UnitAction,type UnitOperation,type UnitReceipt} from '../../../../view/common/unitAuthor';
import {unitInput,unitQuery,unitRequest} from './AdminUnitAuthorInput';

type Stored=typeof storeProductUnit.$inferSelect&{rowVersion:string};
const columns=getTableColumns(storeProductUnit);
const conflict=(message:string)=>new HttpApiException(message,409,409);
const data=({rowVersion:_,...row}:Stored)=>row;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const visible=(row:typeof storeProductUnit.$inferSelect)=>row.type===0&&row.relationId===0&&row.status===1&&row.isDel===0;
const publicRow=(row:Stored)=>({id:row.id,type:row.type,relation_id:row.relationId,name:row.name,sort:row.sort,status:row.status,is_del:row.isDel,add_time:row.addTime});
function databaseError(error:unknown):never {
  let cause=error;
  for(let i=0;i<8&&cause&&typeof cause==='object';i++){
    const code='code'in cause?String(cause.code):'';
    if(['55P03','40P01','40001','23505'].includes(code))throw conflict('商品单位或关联商品正在变化，请先读取原回执');
    if(['42501','42P01','42883','57014'].includes(code))throw new ServiceUnavailableException('商品单位写入能力未就绪或操作超时');
    cause='cause'in cause?cause.cause:undefined;
  }
  throw error;
}

/** Adds recoverable name/sort authoring to the existing platform unit catalog.
 * Legacy CRUD and platform/Supplier product editors keep their lifecycle fence. */
export class AdminUnitAuthorService {
  constructor(private readonly container:Container){}
  private transaction<T>(actor:AdminAuthorityActor,write:boolean,owner:boolean,work:(tx:DbClient)=>Promise<T>):Promise<T>{
    return withTx(this.container,async tx=>{
      if(write){
        await acquireAdminAuthorityWriteBarrier(tx);
        if(owner)await loadAdminProfileActor(tx,actor);else await loadAdminAuthorityLiveActor(tx,actor,'product.manage');
        await lockProductUnitLifecycle(tx);
        await tx.execute(sql`LOCK TABLE ONLY public.store_product_unit IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
        await assertAdminUnitOperationReady(tx);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(731639,1)`);
      }else{
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
        await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
        await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
        if(owner)await loadAdminProfileActor(tx,actor);else await authorizeAdminLegacyProductRead(tx,actor,'product.view');
      }
      const result=await work(tx);
      await assertAdminLegacyProductReadDeadline(tx,actor);
      if(write&&!owner)await loadAdminAuthorityLiveActor(tx,actor,'product.manage');
      return result;
    }).catch(databaseError);
  }
  private async source(tx:DbClient){
    const [shape]=await tx.execute(sql`SELECT ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public.store_product_unit'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum) AS names`);
    const names=shape?.names,known=Object.values(columns).map(column=>column.name);
    if(!Array.isArray(names)||names.length!==known.length||names.some(name=>typeof name!=='string'||!known.includes(name)))throw new ServiceUnavailableException('商品单位表结构无法完整核验');
    // Include every scope and hidden row in CAS/readback, without exposing them.
    const rows=await tx.select({...columns,rowVersion:sql<string>`xmin::text`}).from(storeProductUnit).orderBy(asc(storeProductUnit.id)).limit(20001);
    if(rows.length>20000)throw new ServiceUnavailableException('完整商品单位目录超过20000项，不能截断');
    if(new TextEncoder().encode(JSON.stringify(rows)).length>16*1024*1024)throw new ServiceUnavailableException('完整商品单位目录超过16MiB，不能截断');
    return {rows,revision:createHash('sha256').update(JSON.stringify({domain:'product-unit-catalog-v1',rows})).digest('hex')};
  }
  catalog(query:URLSearchParams,actor:AdminAuthorityActor){
    unitQuery(query);
    return this.transaction(actor,false,false,async tx=>{
      const source=await this.source(tx),list=source.rows.filter(visible).sort((a,b)=>b.sort-a.sort||b.id-a.id).map(publicRow);
      return {list,count:list.length,revision:source.revision,can_create:source.rows.length<20000,
        write_ready:await assertAdminUnitOperationReady(tx).then(()=>true).catch(()=>false)};
    });
  }
  private receiptRow(row:Record<string,unknown>,action?:UnitAction):UnitReceipt {
    const original=action??{operation_id:String(row.operation_id),actor_id:Number(row.actor_id),operation:row.operation as UnitOperation,target_id:Number(row.target_id),revision:String(row.revision),payload_hash:String(row.payload_hash),payload:{}};
    return unitInput(()=>unitReceipt({operation_id:row.operation_id,actor_id:row.actor_id,operation:row.operation,target_id:row.target_id,revision:row.revision,payload_hash:row.payload_hash,state:row.state,result:row.result},original));
  }
  private async prior(tx:DbClient,action:UnitAction){
    const rows=await tx.execute(sql`SELECT * FROM public.admin_unit_operation WHERE operation_id=${action.operation_id}::uuid`);
    if(!rows.length)return null;
    const row=rows[0]!;
    if(row.actor_id!==action.actor_id||row.operation!==action.operation||row.target_id!==action.target_id||row.payload_hash!==action.payload_hash||row.revision!==action.revision)throw conflict('原商品单位请求标识已用于不同操作');
    return this.receiptRow(row,action);
  }
  private async insertReceipt(tx:DbClient,action:UnitAction,state:UnitReceipt['state'],result:UnitReceipt['result']){
    const rows=await tx.execute(sql`INSERT INTO public.admin_unit_operation(operation_id,actor_id,operation,target_id,payload_hash,revision,state,result,created_at)
      VALUES (${action.operation_id}::uuid,${action.actor_id},${action.operation},${action.target_id},${action.payload_hash},${action.revision},${state},${JSON.stringify(result)}::jsonb,${Math.floor(Date.now()/1000)}) RETURNING *`);
    if(rows.length!==1)throw Error('商品单位操作回执缺失');
    return this.receiptRow(rows[0]!,action);
  }
  receipt(id:unknown,query:URLSearchParams,actor:AdminAuthorityActor){
    unitQuery(query);const uuid=unitInput(()=>unitUuid(id));
    return this.transaction(actor,false,true,async tx=>{
      const rows=await tx.execute(sql`SELECT * FROM public.admin_unit_operation WHERE operation_id=${uuid}::uuid AND actor_id=${actor.id}`);
      if(rows.length!==1)throw new NotFoundException('尚未找到原商品单位回执，结果仍未知');
      return this.receiptRow(rows[0]!);
    });
  }
  resolve(value:unknown,actor:AdminAuthorityActor){
    const action=unitRequest(value,actor.id);
    return this.transaction(actor,true,true,async tx=>await this.prior(tx,action)??await this.insertReceipt(tx,action,'not_applied',{id:action.target_id,created:0,updated:0,count:0,revision:action.revision}));
  }
  private async audit(tx:DbClient,actor:AdminAuthorityActor,operation:UnitOperation,id:number){
    const action=JSON.stringify({operation:operation==='update'?'save':operation,id});
    const method=operation==='delete'?'DELETE':operation==='update'?'PUT':'POST';
    const rows=await tx.insert(systemLog).values({adminId:actor.id,type:'product_unit_catalog',path:`product/unit/${id}`,
      page:'商品单位管理',method,action,addTime:Math.floor(Date.now()/1000)}).returning();
    if(rows.length!==1||rows[0]!.adminId!==actor.id||rows[0]!.type!=='product_unit_catalog'||rows[0]!.method!==method||rows[0]!.action!==action)throw Error('商品单位审计回执不完整');
  }
  mutate(value:unknown,actor:AdminAuthorityActor){
    const action=unitRequest(value,actor.id);
    return this.transaction(actor,true,false,async tx=>{
      const prior=await this.prior(tx,action);
      if(prior){if(prior.state!=='committed')throw conflict('原商品单位操作已封存，不能再提交');return prior;}
      const before=await this.source(tx);
      if(action.revision!==before.revision)throw conflict('商品单位目录已变化，请先核对原回执');
      const old=before.rows.find(row=>row.id===action.target_id&&visible(row));
      if(action.target_id&&!old)throw new NotFoundException('商品单位不存在');
      if(old)await tx.select({id:storeProductUnit.id}).from(storeProductUnit).where(eq(storeProductUnit.id,old.id)).for('update',{noWait:true});
      const expected=new Map(before.rows.map(row=>[row.id,data(row)]));
      let id=action.target_id,created=0,updated=0;
      const reference=async()=>{
        const [used]=await tx.select({id:storeProduct.id}).from(storeProduct).where(and(eq(storeProduct.unitName,old!.name),eq(storeProduct.isDel,0))).limit(1);
        if(used)throw new ValidateException('该单位正在使用，不能修改名称或删除');
      };
      if(action.operation==='delete'){
        await reference();
        await tx.update(storeProductUnit).set({isDel:1}).where(eq(storeProductUnit.id,id));
        expected.set(id,{...data(old!),isDel:1});updated=1;
      }else{
        const name=unitInput(()=>unitName(action.payload.name,old?.name));
        const sort=unitInput(()=>unitSort(action.payload.sort,old?.sort));
        if(old&&name!==old.name)await reference();
        if((!old||name!==old.name)&&before.rows.some(row=>row.id!==id&&row.type===0&&row.relationId===0&&row.isDel===0&&row.name===name))throw new ValidateException('单位已经存在，请勿重复添加');
        if(action.operation==='create'){
          if(before.rows.length>=20000)throw conflict('完整商品单位目录已达20000项');
          const values={type:0,relationId:0,name,sort,status:1,isDel:0,addTime:Math.floor(Date.now()/1000)};
          const rows=await tx.insert(storeProductUnit).values(values).returning(),saved=rows[0];
          if(rows.length!==1||!saved||!Number.isSafeInteger(saved.id)||saved.id<1||expected.has(saved.id)||!same(saved,{id:saved.id,...values}))throw Error('商品单位新增完整字段回读不一致');
          id=saved.id;expected.set(id,saved);created=1;
        }else{
          if(name!==old!.name||sort!==old!.sort)await tx.update(storeProductUnit).set({name,sort}).where(eq(storeProductUnit.id,id));
          expected.set(id,{...data(old!),name,sort});updated=1;
        }
      }
      await this.audit(tx,actor,action.operation,id);
      const after=await this.source(tx);
      if(!same(after.rows.map(data),[...expected.values()].sort((a,b)=>a.id-b.id)))throw Error('商品单位完整写后回读不一致');
      return this.insertReceipt(tx,action,'committed',{id,created,updated,count:after.rows.filter(visible).length,revision:after.revision});
    });
  }
}
