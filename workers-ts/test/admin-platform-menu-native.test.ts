import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin } from '@/models/schema';
import { md5 } from '@/utils/jwt';
import { AdminPlatformMenuService } from '@/services/admin/AdminPlatformMenuService';
import { acquireAdminAuthorityWriteBarrier } from '@/services/admin/AdminAuthorityWriteService';
import { acquireAdminAuthorityMenuLock } from '@/migrations/adminAuthorityOperation';
import { runAdminAuthorityOperationUpgrade } from '@/migrations/runAdminAuthorityOperationUpgrade';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { inspectAdminAuthorityMaintenanceSnapshot } from '@/migrations/adminAuthorityOperationMaintenance';
import { ADMIN_PLATFORM_MENU_WRITE_SIGNATURE, assertAdminPlatformMenuWriteReady,
  inspectAdminPlatformMenuOperation, inspectAdminPlatformMenuWriteCapability } from '@/migrations/adminPlatformMenuWriteCapability';
import { runAdminPlatformMenuWriteUpgrade } from '@/migrations/runAdminPlatformMenuWriteUpgrade';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { outcome } from './helpers/financePeers';

function code(error:unknown):string {
  for(let n=0;n<8&&error&&typeof error==='object';n++) {
    if('code' in error&&typeof error.code==='string')return error.code;
    error='cause' in error?error.cause:undefined;
  }
  return '';
}
/** Observe real executed DDL/GRANT and then fault the owned transaction.
 * SQL results, actual owner identities and COMMIT/ROLLBACK are not mocked. */
function interrupted(db:DbClient,trace:{reached:boolean}):DbClient {
  const dialect=new PgDialect();
  return new Proxy(db,{get(target,key){
    const member:unknown=Reflect.get(target,key); if(typeof member!=='function')return member;
    if(key!=='transaction')return member.bind(target);
    return (callback:(tx:Pick<DbClient,'execute'>)=>Promise<unknown>,options:unknown)=>target.transaction(async tx=>{
      const port=new Proxy(tx,{get(current,property){
        const fn:unknown=Reflect.get(current,property);if(typeof fn!=='function')return fn;
        if(property!=='execute')return fn.bind(current);
        return async(query:Parameters<typeof tx.execute>[0])=>{
          const text=dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql;
          const result=await tx.execute(query);
          if(text.startsWith('GRANT EXECUTE ON FUNCTION public.cinashop_admin_platform_menu_write_v1')){
            trace.reached=true;throw Error('Owned platform menu interruption after real capability grants');
          }
          return result;
        };
      }});
      return callback(port);
    },options as Parameters<typeof target.transaction>[1]);
  }});
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Platform menu explicit PG16 addon and independently authenticated LOGINs',()=>{
  afterEach(()=>vi.restoreAllMocks());
  it('commissions atomically, executes real service CRUD/receipt, preserves legacy rows and proves ACL/lock/tombstone boundaries',async()=>{
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Owned native platform menu test forbids provider I/O'));
    const whole=await refundRuntimeFixture();
    let owner='';
    try{
      if(!whole.withRuntimeRole||!whole.withPeer)throw Error('Independent PG16 LOGIN and lock peer required');
      await whole.withRuntimeRole(async app=>whole.withRuntimeRole!(async admin=>{
        const [identity]=await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance,current_setting('server_version_num')::integer/10000 AS major`);
        expect(identity.major).toBe(16);
        const base={database:String(identity.database),maintenance:String(identity.maintenance),app:app.role,admin:admin.role};
        await runRuntimeBusinessCommissioning(whole.db,{...base,pricingOwner:whole.pricingOwner});
        await runAdminAuthorityOperationUpgrade(whole.db,base);
        owner='cinashop_platform_owner_'+randomUUID().replaceAll('-','');
        await whole.exec(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
        const target={...base,owner};
        const password='owned-platform-menu-native-password';
        await whole.db.insert(systemAdmin).values({id:900,account:'owned_menu_root',pwd:password,realName:'Owned root',roles:'',level:0,status:1,isDel:0,adminType:1,relationId:0});
        const audit=async()=>({app:await auditRuntimeBusinessPrivileges(app.db,'app',base),admin:await auditRuntimeBusinessPrivileges(admin.db,'admin',base)});
        const snapshot=async()=>({
          whole:await whole.db.transaction(tx=>inspectAdminAuthorityMaintenanceSnapshot(tx,{wholeData:true}),{isolationLevel:'repeatable read',accessMode:'read only'}),
          sequences:Array.from(await whole.db.execute(sql`SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`),r=>({...r})),
        });
        expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
        await expect(assertAdminPlatformMenuWriteReady(admin.db)).rejects.toMatchObject({code:503});
        const before=await snapshot(),trace={reached:false};
        await expect(runAdminPlatformMenuWriteUpgrade(interrupted(whole.db,trace),target)).rejects.toThrow('Owned platform menu interruption');
        expect(trace.reached).toBe(true);expect(await snapshot()).toEqual(before);
        expect((await inspectAdminPlatformMenuWriteCapability(admin.db)).absent).toBe(true);
        expect(await audit()).toMatchObject({app:{ready:true},admin:{ready:true}});
        expect(await runAdminPlatformMenuWriteUpgrade(whole.db,target)).toEqual({operation:'admin-platform-menu-write-v1',applied:true});
        await expect(assertAdminPlatformMenuWriteReady(admin.db)).resolves.toBeUndefined();
        expect(await inspectAdminPlatformMenuOperation(whole.db,target)).toBe(true);
        expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
        const installed=await snapshot(),oldNames=new Set(before.whole.data.map(row=>row.name));
        expect(installed.whole.tableCount).toBe(before.whole.tableCount+1);
        expect(installed.whole.data.filter(row=>oldNames.has(row.name))).toEqual(before.whole.data);
        expect(installed.sequences).toEqual(before.sequences);
        expect(installed.whole.data.filter(row=>!oldNames.has(row.name))).toEqual([expect.objectContaining({name:'admin_platform_menu_operation',rows:'0'})]);
        for(const peer of [app,admin]){
          const [r]=await peer.db.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super`);
          expect(r).toMatchObject({role:peer.role,session:peer.role,pid:peer.pid,super:false});
          await peer.exec('RESET ROLE'); expect((await peer.db.execute(sql`SELECT current_user AS role`))[0]?.role).toBe(peer.role);
        }
        await expect(app.exec(`SELECT public.cinashop_admin_platform_menu_write_v1('delete',1,'1','{}')`)).rejects.toMatchObject({code:'42501'});
        await expect(app.exec('SELECT * FROM public.admin_platform_menu_operation')).rejects.toMatchObject({code:'42501'});
        for(const statement of ['INSERT INTO public.system_menus(menu_name) VALUES(\'forbidden\')','UPDATE public.system_menus SET menu_name=\'forbidden\'','DELETE FROM public.system_menus','TRUNCATE public.system_menus','ALTER TABLE public.system_menus ADD COLUMN forbidden integer']){
          await expect(admin.exec(statement)).rejects.toMatchObject({code:'42501'});
        }
        await expect(admin.exec("SELECT public.cinashop_admin_platform_menu_write_v1('delete',1,'1','{}')")).rejects.toMatchObject({code:'42501'});
        const actor={id:900,authVersion:md5(password),expiresAt:Math.floor(Date.now()/1000)+3600};
        const service=new AdminPlatformMenuService(createContainerFromDb(admin.db));
        const query=new URLSearchParams();
        const values={pid:0,auth_type:1,menu_name:'Owned navigation',menu_path:'/system',unique_auth:'owned-platform-native',api_url:'',methods:'',icon:'md-settings',sort:0,is_show:0,is_show_path:0};
        const create={...values,request_id:randomUUID(),expected_revision:(await service.catalog(query,actor)).revision};
        const created=await service.mutate('create',0,create,actor);expect(created).toMatchObject({actor_id:900,operation:'create',verified:true});
        const id=created.id;
        await whole.exec(`UPDATE public.system_menus SET module='legacy-module',controller='old-controller',action='old-action',params='{"kept":true}',header='legacy-header',is_header=1 WHERE id=${id}`);
        const update={...values,menu_name:'Renamed navigation',request_id:randomUUID(),expected_revision:(await service.catalog(query,actor)).revision};
        const updated=await service.mutate('update',id,update,actor);expect(updated.operation).toBe('update');
        expect((await whole.db.execute(sql`SELECT module,controller,action,params,header,is_header FROM public.system_menus WHERE id=${id}`))[0]).toMatchObject({module:'legacy-module',controller:'old-controller',action:'old-action',params:'{"kept":true}',header:'legacy-header',is_header:1});
        const show={is_show:1,request_id:randomUUID(),expected_revision:(await service.catalog(query,actor)).revision};
        const shown=await service.mutate('show',id,show,actor);expect(shown.operation).toBe('show');
        const del={request_id:randomUUID(),expected_revision:(await service.catalog(query,actor)).revision};
        const deleted=await service.mutate('delete',id,del,actor);expect(deleted.operation).toBe('delete');
        expect((await whole.db.execute(sql`SELECT is_del FROM public.system_menus WHERE id=${id}`))[0]?.is_del).toBe(1);
        const committed=await snapshot();
        for(const[operation,input,result]of [['create',create,created],['update',update,updated],['show',show,shown],['delete',del,deleted]] as const){
          expect(await service.mutate(operation,operation==='create'?0:id,input,actor)).toEqual(result);
          expect(await service.receipt(input.request_id,query,actor)).toEqual(result);
        }
        expect(await snapshot()).toEqual(committed);
        for(const statement of ['UPDATE public.admin_platform_menu_operation SET actor_id=1','DELETE FROM public.admin_platform_menu_operation','TRUNCATE public.admin_platform_menu_operation']){
          await expect(admin.exec(statement)).rejects.toMatchObject({code:'42501'});
          await expect(whole.exec(statement)).rejects.toMatchObject({code:'42501'});
        }
        expect(await snapshot()).toEqual(committed);
        for(const lock of ['LOCK TABLE ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE','LOCK TABLE ONLY public.system_menus IN SHARE MODE'])await whole.withPeer!(async peer=>{
          await peer.exec('BEGIN');
          try{
            await peer.exec(lock);
            const result=await outcome(service.mutate('create',0,{...values,unique_auth:randomUUID(),request_id:randomUUID(),expected_revision:(await service.catalog(query,actor)).revision},actor));
            if(result.ok)throw Error('Independent conflicting lock did not refuse the menu writer');
            expect(result.error).toMatchObject({httpStatus:409});
          }finally{await peer.exec('ROLLBACK');}
        });
        // A soft-deleted ID cannot be resurrected even by direct use of the
        // capability from a legitimate independently authenticated Admin.
        const stale=String((await whole.db.execute(sql`SELECT xmin::text AS revision FROM public.system_menus WHERE id=${id}`))[0]?.revision);
        const resurrection=await outcome(admin.db.transaction(async tx=>{
          await acquireAdminAuthorityWriteBarrier(tx as unknown as DbClient);await acquireAdminAuthorityMenuLock(tx);
          return tx.execute(sql`SELECT public.cinashop_admin_platform_menu_write_v1('update',${id},${stale},${JSON.stringify(values)}::jsonb)`);
        }));
        if(resurrection.ok)throw Error('Deleted ID was revived');expect(code(resurrection.error)).toBe('P0002');
        expect(await snapshot()).toEqual(committed);
        await whole.exec(`GRANT EXECUTE ON FUNCTION ${ADMIN_PLATFORM_MENU_WRITE_SIGNATURE} TO PUBLIC`);
        try{
          expect((await audit()).admin.ready).toBe(false);
          await expect(runAdminPlatformMenuWriteUpgrade(whole.db,target)).rejects.toThrow('exact existing runtime profiles');
        }finally{await whole.exec(`REVOKE EXECUTE ON FUNCTION ${ADMIN_PLATFORM_MENU_WRITE_SIGNATURE} FROM PUBLIC`);}
        await whole.withPeer!(async peer=>{
          await peer.exec('BEGIN');
          try{await peer.exec('SELECT pg_advisory_xact_lock(731626,14)');await expect(runAdminPlatformMenuWriteUpgrade(whole.db,target)).rejects.toThrow('busy');}
          finally{await peer.exec('ROLLBACK');}
        });
        // Revoking a temporary test grant can leave an explicit ACL equivalent
        // to the initial one; compare the final frozen state after restoration.
        const restored=await snapshot();
        expect(await runAdminPlatformMenuWriteUpgrade(whole.db,target)).toEqual({operation:'admin-platform-menu-write-v1',applied:false});
        expect(await snapshot()).toEqual(restored);expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
      }));
      expect(fetch).not.toHaveBeenCalled();
    }finally{
      try{if(owner)await whole.exec(`DROP OWNED BY "${owner}"; DROP ROLE "${owner}"`);}finally{await whole.close();}
    }
  },180000);
});
