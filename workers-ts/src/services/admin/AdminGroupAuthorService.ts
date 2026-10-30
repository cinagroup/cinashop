import {asc,eq,getTableColumns,sql} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {systemLog,userGroup,user} from '@/models/schema';
import {HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {acquireAdminAuthorityWriteBarrier,loadAdminAuthorityLiveActor,type AdminAuthorityActor} from './AdminAuthorityWriteService';
import {authorizeAdminLegacyProductRead,assertAdminLegacyProductReadDeadline} from './AdminLegacyProductReadAuthority';
import {loadAdminProfileActor} from './AdminProfileService';
import {assertAdminGroupOperationReady} from '@/migrations/adminGroupOperation';
import {groupName,groupReceipt,groupUuid,type GroupAction,type GroupOperation,type GroupReceipt} from '../../../../view/common/groupAuthor';
import {groupInput,groupQuery,groupRequest} from './AdminGroupAuthorInput';

type Stored=typeof userGroup.$inferSelect&{rowVersion:string};
const columns=getTableColumns(userGroup);
const conflict=(message:string)=>new HttpApiException(message,409,409);
const data=(row:Stored)=>({id:row.id,groupName:row.groupName});
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function databaseError(error:unknown):never {
  let cause=error;
  for(let i=0;i<8&&cause&&typeof cause==='object';i++){
    const code='code'in cause?String(cause.code):'';
    if(['55P03','40P01','40001','23505'].includes(code))throw conflict('用户分组或关联用户正在变化，请先读取原回执');
    if(['42501','42P01','42883','57014'].includes(code))throw new ServiceUnavailableException('用户分组写入能力未就绪或操作超时');
    cause='cause'in cause?cause.cause:undefined;
  }
  throw error;
}

/** Adds recoverable authoring to the established group catalog. Legacy CRUD
 * and ordinary user assignment keep their original service and row-lock contract. */
export class AdminGroupAuthorService {
  constructor(private readonly container:Container){}

  private transaction<T>(actor:AdminAuthorityActor,write:boolean,owner:boolean,work:(tx:DbClient)=>Promise<T>):Promise<T>{
    return withTx(this.container,async tx=>{
      if(write){
        await acquireAdminAuthorityWriteBarrier(tx);
        if(owner)await loadAdminProfileActor(tx,actor);else await loadAdminAuthorityLiveActor(tx,actor,'user.manage');
        const [legacy]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731621,0) AS locked`);
        if(legacy?.locked!==true)throw conflict('用户分组目录正在更新，请先读取原回执');
        await tx.execute(sql`LOCK TABLE ONLY public.user_group IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
        await assertAdminGroupOperationReady(tx);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(731638,1)`);
      }else{
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
        await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
        await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
        if(owner)await loadAdminProfileActor(tx,actor);else await authorizeAdminLegacyProductRead(tx,actor,'user.view');
      }
      const result=await work(tx);
      await assertAdminLegacyProductReadDeadline(tx,actor);
      if(write&&!owner)await loadAdminAuthorityLiveActor(tx,actor,'user.manage');
      return result;
    }).catch(databaseError);
  }

  private async source(tx:DbClient){
    const [shape]=await tx.execute(sql`SELECT ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public.user_group'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum) AS names`);
    const names=shape?.names,known=Object.values(columns).map(column=>column.name);
    if(!Array.isArray(names)||names.length!==known.length||names.some(name=>typeof name!=='string'||!known.includes(name)))throw new ServiceUnavailableException('用户分组表结构无法完整核验');
    const rows=await tx.select({...columns,rowVersion:sql<string>`xmin::text`}).from(userGroup).orderBy(asc(userGroup.id)).limit(20001);
    if(rows.length>20000)throw new ServiceUnavailableException('完整用户分组目录超过20000项，不能截断');
    if(new TextEncoder().encode(JSON.stringify(rows)).length>16*1024*1024)throw new ServiceUnavailableException('完整用户分组目录超过16MiB，不能截断');
    return {rows,revision:createHash('sha256').update(JSON.stringify({domain:'user-group-catalog-v1',rows})).digest('hex')};
  }

  catalog(query:URLSearchParams,actor:AdminAuthorityActor){
    groupQuery(query);
    return this.transaction(actor,false,false,async tx=>{
      const source=await this.source(tx);
      return {list:[...source.rows].reverse().map(row=>({id:row.id,group_name:row.groupName})),count:source.rows.length,revision:source.revision,
        write_ready:await assertAdminGroupOperationReady(tx).then(()=>true).catch(()=>false)};
    });
  }

  private receiptRow(row:Record<string,unknown>,action?:GroupAction):GroupReceipt {
    const original=action??{operation_id:String(row.operation_id),actor_id:Number(row.actor_id),operation:row.operation as GroupOperation,target_id:Number(row.target_id),revision:String(row.revision),payload_hash:String(row.payload_hash),payload:{}};
    return groupInput(()=>groupReceipt({operation_id:row.operation_id,actor_id:row.actor_id,operation:row.operation,target_id:row.target_id,revision:row.revision,payload_hash:row.payload_hash,state:row.state,result:row.result},original));
  }
  private async prior(tx:DbClient,action:GroupAction){
    const rows=await tx.execute(sql`SELECT * FROM public.admin_group_operation WHERE operation_id=${action.operation_id}::uuid`);
    if(!rows.length)return null;
    const row=rows[0]!;
    if(row.actor_id!==action.actor_id||row.operation!==action.operation||row.target_id!==action.target_id||row.payload_hash!==action.payload_hash||row.revision!==action.revision)throw conflict('原用户分组请求标识已用于不同操作');
    return this.receiptRow(row,action);
  }
  private async insertReceipt(tx:DbClient,action:GroupAction,state:GroupReceipt['state'],result:GroupReceipt['result']){
    const rows=await tx.execute(sql`INSERT INTO public.admin_group_operation(operation_id,actor_id,operation,target_id,payload_hash,revision,state,result,created_at)
      VALUES (${action.operation_id}::uuid,${action.actor_id},${action.operation},${action.target_id},${action.payload_hash},${action.revision},${state},${JSON.stringify(result)}::jsonb,${Math.floor(Date.now()/1000)}) RETURNING *`);
    if(rows.length!==1)throw Error('用户分组操作回执缺失');
    return this.receiptRow(rows[0]!,action);
  }
  receipt(id:unknown,query:URLSearchParams,actor:AdminAuthorityActor){
    groupQuery(query);const uuid=groupInput(()=>groupUuid(id));
    return this.transaction(actor,false,true,async tx=>{
      const rows=await tx.execute(sql`SELECT * FROM public.admin_group_operation WHERE operation_id=${uuid}::uuid AND actor_id=${actor.id}`);
      if(rows.length!==1)throw new NotFoundException('尚未找到原用户分组回执，结果仍未知');
      return this.receiptRow(rows[0]!);
    });
  }
  resolve(value:unknown,actor:AdminAuthorityActor){
    const action=groupRequest(value,actor.id);
    return this.transaction(actor,true,true,async tx=>await this.prior(tx,action)??await this.insertReceipt(tx,action,'not_applied',{id:action.target_id,created:0,updated:0,count:0,revision:action.revision}));
  }

  private async audit(tx:DbClient,actor:AdminAuthorityActor,operation:GroupOperation,id:number){
    const action=JSON.stringify({operation,id});
    const rows=await tx.insert(systemLog).values({adminId:actor.id,type:'user_group_catalog',path:`user/user_group/${operation}`,
      page:'用户分组管理',method:operation==='delete'?'DELETE':'POST',action,addTime:Math.floor(Date.now()/1000)}).returning();
    if(rows.length!==1||rows[0]!.adminId!==actor.id||rows[0]!.type!=='user_group_catalog'||rows[0]!.action!==action)throw Error('用户分组审计回执不完整');
  }

  mutate(value:unknown,actor:AdminAuthorityActor){
    const action=groupRequest(value,actor.id);
    return this.transaction(actor,true,false,async tx=>{
      const prior=await this.prior(tx,action);
      if(prior){if(prior.state!=='committed')throw conflict('原用户分组操作已封存，不能再提交');return prior;}
      const before=await this.source(tx);
      if(action.revision!==before.revision)throw conflict('用户分组目录已变化，请先核对原回执');
      const old=before.rows.find(row=>row.id===action.target_id);
      if(action.target_id&&!old)throw new NotFoundException('用户分组不存在');
      // The established assignGroup consumer holds KEY SHARE on the actual
      // group. A NOWAIT UPDATE lock prevents racing deletion without changing it.
      if(old)await tx.select({id:userGroup.id}).from(userGroup).where(eq(userGroup.id,old.id)).for('update',{noWait:true});
      const expected=new Map(before.rows.map(row=>[row.id,data(row)]));
      let id=action.target_id,created=0,updated=0;
      if(action.operation==='delete'){
        const [used]=await tx.select({uid:user.uid}).from(user).where(eq(user.groupId,id)).limit(1);
        if(used)throw new ValidateException('该分组仍有用户，不能删除');
        await tx.delete(userGroup).where(eq(userGroup.id,id));expected.delete(id);updated=1;
      }else{
        const name=groupInput(()=>groupName(action.payload.group_name,old?.groupName));
        if((!old||name!==old.groupName)&&before.rows.some(row=>row.id!==id&&row.groupName===name))throw new ValidateException('该分组已经存在');
        if(action.operation==='create'){
          if(before.rows.length>=20000)throw conflict('完整用户分组目录已达20000项');
          const rows=await tx.insert(userGroup).values({groupName:name}).returning(),saved=rows[0];
          if(rows.length!==1||!saved||!Number.isSafeInteger(saved.id)||saved.id<1||expected.has(saved.id)||!same(saved,{id:saved.id,groupName:name}))throw Error('用户分组新增完整字段回读不一致');
          id=saved.id;expected.set(id,saved);created=1;
        }else{
          if(name!==old!.groupName)await tx.update(userGroup).set({groupName:name}).where(eq(userGroup.id,id));
          expected.set(id,{id,groupName:name});updated=1;
        }
      }
      await this.audit(tx,actor,action.operation,id);
      const after=await this.source(tx);
      if(!same(after.rows.map(data),[...expected.values()].sort((a,b)=>a.id-b.id)))throw Error('用户分组完整写后回读不一致');
      return this.insertReceipt(tx,action,'committed',{id,created,updated,count:after.rows.length,revision:after.revision});
    });
  }
}
