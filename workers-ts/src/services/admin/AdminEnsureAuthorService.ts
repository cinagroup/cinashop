import {and,asc,eq,getTableColumns,sql} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {systemLog,storeProductEnsure,storeProduct,storeProductRelation} from '@/models/schema';
import {HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {acquireAdminAuthorityWriteBarrier,loadAdminAuthorityLiveActor,type AdminAuthorityActor} from './AdminAuthorityWriteService';
import {authorizeAdminLegacyProductRead,assertAdminLegacyProductReadDeadline} from './AdminLegacyProductReadAuthority';
import {loadAdminProfileActor} from './AdminProfileService';
import {assertAdminEnsureOperationReady} from '@/migrations/adminEnsureOperation';
import type {Env} from '@/env';
import {publicEnsureAuthorImages,renderEnsureAuthorImages,assertEnsureAuthorImageChange} from '@/services/product/EnsureAuthorAssetPolicy';
import {ensureName,ensureDescription,ensureImage,ensureSort,ensureReceipt,ensureUuid,type EnsureAction,type EnsureOperation,type EnsureReceipt} from '../../../../view/common/ensureAuthor';
import {ensureInput,ensureQuery,ensureRequest} from './AdminEnsureAuthorInput';

type Stored=typeof storeProductEnsure.$inferSelect&{rowVersion:string};
const columns=getTableColumns(storeProductEnsure);
const conflict=(message:string)=>new HttpApiException(message,409,409);
const data=({rowVersion:_,...row}:Stored)=>row;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const visible=(row:typeof storeProductEnsure.$inferSelect)=>row.type===0&&row.relationId===0;
const publicRow=(row:Stored)=>({id:row.id,type:row.type,relation_id:row.relationId,name:row.name,image:row.image,desc:row.desc,sort:row.sort,status:row.status,add_time:row.addTime});
function databaseError(error:unknown):never {
  let cause=error;
  for(let i=0;i<8&&cause&&typeof cause==='object';i++){
    const code='code'in cause?String(cause.code):'';
    if(['55P03','40P01','40001','23505'].includes(code))throw conflict('商品保障或关联商品正在变化，请先读取原回执');
    if(['42501','42P01','42883','57014'].includes(code))throw Object.assign(new ServiceUnavailableException('商品保障写入能力未就绪或操作超时'),{cause:error});
    cause='cause'in cause?cause.cause:undefined;
  }
  throw error;
}

/** Adds recoverable four-value authoring to the existing platform ensure catalog.
 * Legacy CRUD and platform/Supplier product editors keep their lifecycle fence. */
export class AdminEnsureAuthorService {
  constructor(private readonly container:Container,private readonly env:Pick<Env,'APP_KEY'>){}
  private transaction<T>(actor:AdminAuthorityActor,write:boolean,owner:boolean,work:(tx:DbClient)=>Promise<T>):Promise<T>{
    return withTx(this.container,async tx=>{
      if(write){
        await acquireAdminAuthorityWriteBarrier(tx);
        if(owner)await loadAdminProfileActor(tx,actor);else await loadAdminAuthorityLiveActor(tx,actor,'product.manage');
        // Same fence/order as mature ProductExperienceService, before table/row locks.
        await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
        await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(731614,0)`);
        await tx.execute(sql`LOCK TABLE ONLY public.store_product_ensure IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
        await assertAdminEnsureOperationReady(tx);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(731640,1)`);
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
    const [shape]=await tx.execute(sql`SELECT ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public.store_product_ensure'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum) AS names`);
    const names=shape?.names,known=Object.values(columns).map(column=>column.name);
    if(!Array.isArray(names)||names.length!==known.length||names.some(name=>typeof name!=='string'||!known.includes(name)))throw new ServiceUnavailableException('商品保障表结构无法完整核验');
    // Include every scope and hidden row in CAS/readback, without exposing them.
    const rows=await tx.select({...columns,rowVersion:sql<string>`xmin::text`}).from(storeProductEnsure).orderBy(asc(storeProductEnsure.id)).limit(20001);
    if(rows.length>20000)throw new ServiceUnavailableException('完整商品保障目录超过20000项，不能截断');
    if(new TextEncoder().encode(JSON.stringify(rows)).length>16*1024*1024)throw new ServiceUnavailableException('完整商品保障目录超过16MiB，不能截断');
    return {rows,revision:createHash('sha256').update(JSON.stringify({domain:'product-ensure-catalog-v1',rows})).digest('hex')};
  }
  private async project(tx:DbClient,rows:Stored[]){
    const images=await renderEnsureAuthorImages(this.env.APP_KEY,await publicEnsureAuthorImages(tx,rows.map(row=>row.image)));
    const ids=rows.map(row=>sql`${row.id}`);
    const counts=ids.length?await tx.execute(sql`WITH selected(id) AS (VALUES ${sql.join(ids.map(id=>sql`(${id}::integer)`),sql`,`)})
      SELECT selected.id,count(store_product.id)::integer AS product_count FROM selected LEFT JOIN public.store_product
      ON selected.id::text=ANY(string_to_array(store_product.ensure_id,',')) GROUP BY selected.id`):[];
    const byId=new Map(counts.map(row=>[row.id,row.product_count]));
    if(counts.length!==rows.length||counts.some(row=>!Number.isSafeInteger(row.product_count)||Number(row.product_count)<0))throw Error('商品保障使用商品计数不完整');
    return rows.map((row,index)=>({...publicRow(row),product_count:byId.get(row.id) as number,image_preview:images[index]!}));
  }
  catalog(query:URLSearchParams,actor:AdminAuthorityActor){
    ensureQuery(query);
    return this.transaction(actor,false,false,async tx=>{
      const source=await this.source(tx),rows=source.rows.filter(visible).sort((a,b)=>b.sort-a.sort||b.id-a.id);
      return {list:await this.project(tx,rows),count:rows.length,revision:source.revision,can_create:source.rows.length<20000,
        write_ready:await assertAdminEnsureOperationReady(tx).then(()=>true).catch(()=>false)};
    });
  }
  private receiptRow(row:Record<string,unknown>,action?:EnsureAction):EnsureReceipt {
    const original=action??{operation_id:String(row.operation_id),actor_id:Number(row.actor_id),operation:row.operation as EnsureOperation,target_id:Number(row.target_id),revision:String(row.revision),payload_hash:String(row.payload_hash),payload:{}};
    return ensureInput(()=>ensureReceipt({operation_id:row.operation_id,actor_id:row.actor_id,operation:row.operation,target_id:row.target_id,revision:row.revision,payload_hash:row.payload_hash,state:row.state,result:row.result},original));
  }
  private async prior(tx:DbClient,action:EnsureAction){
    const rows=await tx.execute(sql`SELECT * FROM public.admin_ensure_operation WHERE operation_id=${action.operation_id}::uuid`);
    if(!rows.length)return null;
    const row=rows[0]!;
    if(row.actor_id!==action.actor_id||row.operation!==action.operation||row.target_id!==action.target_id||row.payload_hash!==action.payload_hash||row.revision!==action.revision)throw conflict('原商品保障请求标识已用于不同操作');
    return this.receiptRow(row,action);
  }
  private async insertReceipt(tx:DbClient,action:EnsureAction,state:EnsureReceipt['state'],result:EnsureReceipt['result']){
    const rows=await tx.execute(sql`INSERT INTO public.admin_ensure_operation(operation_id,actor_id,operation,target_id,payload_hash,revision,state,result,created_at)
      VALUES (${action.operation_id}::uuid,${action.actor_id},${action.operation},${action.target_id},${action.payload_hash},${action.revision},${state},${JSON.stringify(result)}::jsonb,${Math.floor(Date.now()/1000)}) RETURNING *`);
    if(rows.length!==1)throw Error('商品保障操作回执缺失');
    return this.receiptRow(rows[0]!,action);
  }
  receipt(id:unknown,query:URLSearchParams,actor:AdminAuthorityActor){
    ensureQuery(query);const uuid=ensureInput(()=>ensureUuid(id));
    return this.transaction(actor,false,true,async tx=>{
      const rows=await tx.execute(sql`SELECT * FROM public.admin_ensure_operation WHERE operation_id=${uuid}::uuid AND actor_id=${actor.id}`);
      if(rows.length!==1)throw new NotFoundException('尚未找到原商品保障回执，结果仍未知');
      return this.receiptRow(rows[0]!);
    });
  }
  resolve(value:unknown,actor:AdminAuthorityActor){
    const action=ensureRequest(value,actor.id);
    return this.transaction(actor,true,true,async tx=>await this.prior(tx,action)??await this.insertReceipt(tx,action,'not_applied',{id:action.target_id,created:0,updated:0,count:0,revision:action.revision}));
  }
  private async audit(tx:DbClient,actor:AdminAuthorityActor,operation:EnsureOperation,id:number,status?:number){
    const expected={adminId:actor.id,type:'product_ensure_catalog',path:`product/ensure/${id}`,page:'商品保障服务管理',
      method:operation==='create'?'POST':operation==='delete'?'DELETE':'PUT',action:JSON.stringify({operation,id,...(status===undefined?{}:{status})}),addTime:Math.floor(Date.now()/1000)};
    const rows=await tx.insert(systemLog).values(expected).returning(),row=rows[0];
    const matches=(value:typeof row|undefined)=>value&&Number.isSafeInteger(value.id)&&value.id>0&&Object.entries(expected).every(([key,v])=>value[key as keyof typeof value]===v);
    if(rows.length!==1||!matches(row))throw Error('商品保障审计回执不完整');
    const [readBack]=await tx.select().from(systemLog).where(eq(systemLog.id,row.id)).limit(1);
    if(!matches(readBack))throw Error('商品保障审计完整回读不一致');
  }
  mutate(value:unknown,actor:AdminAuthorityActor){
    const action=ensureRequest(value,actor.id);
    return this.transaction(actor,true,false,async tx=>{
      const prior=await this.prior(tx,action);
      if(prior){if(prior.state!=='committed')throw conflict('原商品保障操作已封存，不能再提交');return prior;}
      const before=await this.source(tx);
      if(action.revision!==before.revision)throw conflict('商品保障目录已变化，请先核对原回执');
      const old=before.rows.find(row=>row.id===action.target_id&&visible(row));
      if(action.target_id&&!old)throw new NotFoundException('商品保障不存在');
      if(old)await tx.select({id:storeProductEnsure.id}).from(storeProductEnsure).where(eq(storeProductEnsure.id,old.id)).for('update',{noWait:true});
      const expected=new Map(before.rows.map(row=>[row.id,data(row)]));
      let id=action.target_id,created=0,updated=0;
      if(action.operation==='delete'){
        // Counts are CSV-only display data. Deletion checks every relation and
        // every CSV token, across owners/status and soft-deleted products.
        const [relation]=await tx.select({id:storeProductRelation.id}).from(storeProductRelation)
          .where(and(eq(storeProductRelation.type,5),eq(storeProductRelation.relationId,id))).limit(1);
        const [product]=await tx.select({id:storeProduct.id}).from(storeProduct)
          .where(sql`${String(id)}=ANY(string_to_array(${storeProduct.ensureId},','))`).limit(1);
        if(relation||product)throw new ValidateException('该保障服务正在使用，不能删除');
        const removed=await tx.delete(storeProductEnsure).where(eq(storeProductEnsure.id,id)).returning();
        if(removed.length!==1||!same(removed[0],data(old!)))throw Error('商品保障物理删除完整回读不一致');
        expected.delete(id);updated=1;
      }else if(action.operation==='status'){
        const status=action.payload.status as number;
        await tx.update(storeProductEnsure).set({status}).where(eq(storeProductEnsure.id,id));
        expected.set(id,{...data(old!),status});updated=1;
      }else{
        const name=ensureInput(()=>ensureName(action.payload.name,old?.name));
        const desc=ensureInput(()=>ensureDescription(action.payload.desc,old?.desc));
        const image=ensureInput(()=>ensureImage(action.payload.image,old?.image));
        const sort=ensureInput(()=>ensureSort(action.payload.sort,old?.sort));
        await assertEnsureAuthorImageChange(tx,old?.image??null,image);
        if((!old||name!==old.name)&&before.rows.some(row=>row.id!==id&&visible(row)&&row.name===name))throw new ValidateException('保障已经存在，请勿重复添加');
        if(action.operation==='create'){
          if(before.rows.length>=20000)throw conflict('完整商品保障目录已达20000项');
          const values={type:0,relationId:0,name,image,desc,sort,status:1,addTime:Math.floor(Date.now()/1000)};
          const rows=await tx.insert(storeProductEnsure).values(values).returning(),saved=rows[0];
          if(rows.length!==1||!saved||!Number.isSafeInteger(saved.id)||saved.id<1||expected.has(saved.id)||!same(saved,{id:saved.id,...values}))throw Error('商品保障新增完整字段回读不一致');
          id=saved.id;expected.set(id,saved);created=1;
        }else{
          if(name!==old!.name||image!==old!.image||desc!==old!.desc||sort!==old!.sort)await tx.update(storeProductEnsure).set({name,image,desc,sort}).where(eq(storeProductEnsure.id,id));
          expected.set(id,{...data(old!),name,image,desc,sort});updated=1;
        }
      }
      await this.audit(tx,actor,action.operation,id,action.operation==='status'?action.payload.status as number:undefined);
      // Settle deferred catalog/audit constraints before binding the final revision.
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      const after=await this.source(tx);
      if(!same(after.rows.map(data),[...expected.values()].sort((a,b)=>a.id-b.id)))throw Error('商品保障完整写后回读不一致');
      return this.insertReceipt(tx,action,'committed',{id,created,updated,count:after.rows.filter(visible).length,revision:after.revision});
    });
  }
}
