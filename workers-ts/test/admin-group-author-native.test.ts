import {eq,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {DbClient} from '@/lib/di';
import {createContainerFromDb} from '@/lib/di';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {systemAdmin,systemRole,user,userGroup} from '@/models/schema';
import {md5} from '@/utils/jwt';
import {AdminGroupAuthorService} from '@/services/admin/AdminGroupAuthorService';
import {UserSegmentationService} from '@/services/user/UserSegmentationService';
import {groupActionHash} from '@/services/admin/AdminGroupAuthorInput';
import {runAdminGroupUpgrade} from '@/migrations/runAdminGroupUpgrade';
import {assertAdminGroupOperationReady,inspectAdminGroupOperation} from '@/migrations/adminGroupOperation';
import {runRuntimeBusinessCommissioning} from '@/migrations/runRuntimeBusinessCommissioning';
import {auditRuntimeBusinessPrivileges} from '@/migrations/auditRuntimeBusinessPrivileges';
import {refundRuntimeFixture} from './helpers/refundRuntimeFixture';
import type {GroupAction,GroupOperation} from '../../view/common/groupAuthor';

function interrupted(db:DbClient,trace:{reached:boolean}):DbClient{
  const dialect=new PgDialect();
  return new Proxy(db,{get(target,key){
    const method:unknown=Reflect.get(target,key);if(typeof method!=='function')return method;if(key!=='transaction')return method.bind(target);
    return (callback:(tx:Pick<DbClient,'execute'>)=>Promise<unknown>,options:unknown)=>target.transaction(async tx=>{
      const port=new Proxy(tx,{get(current,property){
        const member:unknown=Reflect.get(current,property);if(typeof member!=='function')return member;if(property!=='execute')return member.bind(current);
        return async(query:Parameters<typeof tx.execute>[0])=>{
          const statement=dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql,result=await tx.execute(query);
          if(statement.startsWith('GRANT SELECT, INSERT ON TABLE public.admin_group_operation TO ')){trace.reached=true;throw Error('Owned group interruption after grant');}
          return result;
        };
      }});return callback(port);
    },options as Parameters<typeof target.transaction>[1]);
  }});
}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
async function waitFor(execute:(text:string)=>Promise<any>,statement:string){
  for(let i=0;i<100;i++){const [row]=await execute(statement);if(row?.waiting===true)return;await new Promise(done=>setTimeout(done,10));}
  throw Error('Expected actual independent group lock wait was not observed');
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('group author native PG16 independent LOGIN and original assignGroup consumer',()=>{
  afterEach(()=>vi.restoreAllMocks());
  it('commissions atomically, preserves exact ACL, and fences actual assignment/deletion in both directions',async()=>{
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Group native forbids provider I/O'));
    const whole=await refundRuntimeFixture();
    try{
      if(!whole.withRuntimeRole||!whole.withPeer)throw Error('Independent PG16 LOGIN and maintenance peers required');
      await whole.withRuntimeRole(async app=>whole.withRuntimeRole!(async admin=>{
        const [identity]=await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);
        const target={database:String(identity.database),maintenance:String(identity.maintenance),app:app.role,admin:admin.role};
        await runRuntimeBusinessCommissioning(whole.db,{...target,pricingOwner:whole.pricingOwner});
        const audit=async()=>({app:await auditRuntimeBusinessPrivileges(app.db,'app',target),admin:await auditRuntimeBusinessPrivileges(admin.db,'admin',target)});
        expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
        await expect(admin.db.transaction(tx=>assertAdminGroupOperationReady(tx))).rejects.toMatchObject({code:503});
        const trace={reached:false};await expect(runAdminGroupUpgrade(interrupted(whole.db,trace),target)).rejects.toThrow('Owned group interruption');expect(trace.reached).toBe(true);
        const [absent]=await whole.db.execute(sql`SELECT to_regclass('public.admin_group_operation') IS NULL AS table_absent,to_regprocedure('public.admin_group_operation_immutable_v1()') IS NULL AS function_absent`);
        expect(absent).toEqual({table_absent:true,function_absent:true});
        expect(await runAdminGroupUpgrade(whole.db,target)).toEqual({operation:'admin-group-operation-v1',applied:true});expect(await inspectAdminGroupOperation(whole.db,target)).toBe(true);
        await expect(admin.db.transaction(tx=>assertAdminGroupOperationReady(tx))).resolves.toBeUndefined();
        for(const statement of ['SELECT * FROM public.admin_group_operation','INSERT INTO public.admin_group_operation DEFAULT VALUES'])await expect(app.exec(statement)).rejects.toMatchObject({code:'42501'});
        for(const statement of ['UPDATE public.admin_group_operation SET actor_id=1','DELETE FROM public.admin_group_operation','TRUNCATE public.admin_group_operation','ALTER TABLE public.admin_group_operation ADD COLUMN forbidden integer'])await expect(admin.exec(statement)).rejects.toMatchObject({code:'42501'});
        const uid=990611,id=990601,pwd='owned-group-native-password';
        await whole.db.insert(systemRole).values({id:900,roleName:'Owned group writer',rules:'user.manage'});
        await whole.db.insert(systemAdmin).values({id:900,account:'owned_group',pwd,level:1,roles:'900',status:1});
        await whole.db.insert(user).values({uid,account:'native-group-user',groupId:0,nowMoney:'18.50',integral:70});
        await whole.db.insert(userGroup).values([{id,groupName:'待分配分组'},{id:id+1,groupName:'待删除分组'},{id:id+2,groupName:'旁路不变分组'}]);
        await whole.exec("SELECT setval(pg_get_serial_sequence('public.user_group','id'),(SELECT max(id)+1 FROM public.user_group),false)");
        const actor={id:900,authVersion:md5(pwd),expiresAt:Math.floor(Date.now()/1000)+3600},query=new URLSearchParams();
        const service=new AdminGroupAuthorService(createContainerFromDb(admin.db)),assigner=new UserSegmentationService(createContainerFromDb(app.db));
        const intent=async(operation:GroupOperation,target_id:number,payload:Record<string,unknown>={}):Promise<GroupAction>=>{
          const a={operation_id:crypto.randomUUID(),actor_id:900,operation,target_id,revision:(await service.catalog(query,actor)).revision,payload};return {...a,payload_hash:groupActionHash(a)};
        };
        const snapshot=async()=>({groups:await whole.db.select().from(userGroup).orderBy(userGroup.id),users:await whole.db.select().from(user).orderBy(user.uid),
          logs:Array.from(await whole.db.execute(sql`SELECT * FROM public.system_log ORDER BY id`)),receipts:Array.from(await whole.db.execute(sql`SELECT * FROM public.admin_group_operation ORDER BY operation_id`))});
        const update=await intent('update',id+2,{group_name:'旁路已明确编辑'}),receipt=await service.mutate(update,actor);
        const deletion=await intent('delete',id),seen=deferred(),resume=deferred();
        const assignment=app.db.transaction(async tx=>{
          await new UserSegmentationService(createContainerFromDb(tx as unknown as DbClient)).assignGroup([uid],id);
          seen.resolve();await resume.promise;
        });
        try{
          await Promise.race([seen.promise,assignment.then(()=>{throw Error('Actual assignGroup did not pause');})]);
          const [held]=await whole.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${app.pid} AND relation='public.user_group'::regclass AND mode='RowShareLock' AND granted) AS held`);expect(held.held).toBe(true);
          const before=await snapshot();await expect(service.mutate(deletion,actor)).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(before);
        }finally{resume.resolve();await assignment;}
        expect((await whole.db.select().from(user).where(eq(user.uid,uid)))[0]).toMatchObject({groupId:id,nowMoney:'18.50',integral:70});
        await expect(service.mutate(deletion,actor)).rejects.toThrow('仍有用户');
        await assigner.assignGroup([uid],0);expect((await service.mutate(deletion,actor)).state).toBe('committed');
        // Reverse direction: the actual author is paused inside its ordinary
        // audit, then the unchanged assignGroup consumer must wait and reject.
        const second=await intent('delete',id+1);
        await whole.exec(`CREATE FUNCTION owned_group_audit_hold() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='user_group_catalog' AND (NEW.action::jsonb->>'id')::integer=${id+1} THEN PERFORM pg_advisory_xact_lock(731739,1);END IF;RETURN NEW;END$$;CREATE TRIGGER owned_group_audit_hold BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION owned_group_audit_hold()`);
        try{await whole.withPeer!(async blocker=>{
          await blocker.exec('SELECT pg_advisory_lock(731739,1)');
          const task=service.mutate(second,actor).then(value=>({value,error:null}),error=>({value:null,error}));
          let pending:Promise<unknown>|undefined,finished=false,result:Awaited<typeof task>|undefined,assignmentError:unknown;
          try{
            await waitFor(blocker.exec,`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${admin.pid} AND locktype='advisory' AND classid=731739::oid AND objid=1::oid AND NOT granted) AS waiting`);
            pending=assigner.assignGroup([uid],id+1).then(()=>{finished=true;return null;},error=>{finished=true;return error;});
            await waitFor(blocker.exec,`SELECT ${admin.pid}=ANY(pg_blocking_pids(${app.pid})) AS waiting`);expect(finished).toBe(false);
            expect((await whole.db.select().from(user).where(eq(user.uid,uid)))[0]!.groupId).toBe(0);
          }finally{await blocker.exec('SELECT pg_advisory_unlock(731739,1)');[result,assignmentError]=await Promise.all([task,pending??Promise.resolve(null)]);}
          if(result?.error)throw result.error;expect(result?.value?.state).toBe('committed');expect(assignmentError).toBeInstanceOf(Error);expect((assignmentError as Error).message).toContain('用户分组不存在');
        });}finally{await whole.exec('DROP TRIGGER owned_group_audit_hold ON system_log;DROP FUNCTION owned_group_audit_hold()');}
        expect((await whole.db.select().from(user).where(eq(user.uid,uid)))[0]).toMatchObject({groupId:0,nowMoney:'18.50',integral:70});
        const stable=await snapshot();expect(await service.mutate(update,actor)).toEqual(receipt);expect(await snapshot()).toEqual(stable);
        const unknown=await intent('create',0,{group_name:'封存请求'});await whole.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,900));
        expect((await service.resolve(unknown,actor)).state).toBe('not_applied');expect((await service.receipt(unknown.operation_id,query,actor)).state).toBe('not_applied');
        await whole.db.update(systemRole).set({rules:'user.manage'}).where(eq(systemRole.id,900));await expect(service.mutate(unknown,actor)).rejects.toMatchObject({httpStatus:409});
        await whole.withPeer!(async blocker=>{await blocker.exec('BEGIN');try{await blocker.exec('SELECT pg_advisory_xact_lock(731626,21)');await expect(runAdminGroupUpgrade(whole.db,target)).rejects.toThrow('busy');}finally{await blocker.exec('ROLLBACK');}});
        expect(await runAdminGroupUpgrade(whole.db,target)).toEqual({operation:'admin-group-operation-v1',applied:false});expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
        for(const statement of ['UPDATE public.admin_group_operation SET actor_id=1','DELETE FROM public.admin_group_operation','TRUNCATE public.admin_group_operation'])await expect(whole.exec(statement)).rejects.toMatchObject({code:'42501'});
      }));expect(fetch).not.toHaveBeenCalled();
    }finally{await whole.close();}
  },180000);
});
