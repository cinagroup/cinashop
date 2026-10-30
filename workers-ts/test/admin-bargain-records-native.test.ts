import { writeFileSync } from 'node:fs';
import { eq, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole, storeBargainUser } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { AdminBargainRecordsService } from '@/services/admin/AdminBargainRecordsService';
import { AdminPermissionService } from '@/services/admin/AdminPermissionService';
import { createToken, md5 } from '@/utils/jwt';
import { ApiErrorCode } from '@/utils/errors';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { seedBargainRecords } from './helpers/bargainRecordsFixture';
const q=(value='')=>new URLSearchParams(value), dialect=new PgDialect();
type F=Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer=Parameters<NonNullable<F['withRuntimeRole']>>[0] extends (peer:infer R)=>unknown ? R : never;
async function fixture(run:(f:F,app:Peer,admin:Peer)=>Promise<void>) {
  const f=await refundRuntimeFixture();
  try {
    await seedBargainRecords(f.db);
    await f.withRuntimeRole!(app=>f.withRuntimeRole!(async admin=>{
      const [row]=await f.exec('SELECT current_database() AS database,current_user AS maintenance');
      const names={database:String(row.database),maintenance:String(row.maintenance),app:app.role,admin:admin.role,pricingOwner:f.pricingOwner};
      await runRuntimeBusinessCommissioning(f.db,names);
      for(const [peer,kind]of[[app,'app'],[admin,'admin']]as const) expect(await auditRuntimeBusinessPrivileges(peer.db,kind,names)).toMatchObject({ready:true,failures:[]});
      expect((await admin.exec('SELECT current_user AS role,session_user AS session'))[0]).toEqual({role:admin.role,session:admin.role});
      try { await run(f,app,admin); }
      finally {
        await f.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename=${app.role} AND application_name='cinashop_api' AND pid<>pg_backend_pid()`);
        for(let attempt=0;attempt<100;attempt++) {
          if(Number((await f.db.execute(sql`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=${app.role} AND application_name='cinashop_api'`))[0]!.n)===0)break;
          await new Promise(done=>setTimeout(done,10));
        }
      }
    }));
  } finally { await f.close(); }
}
/** Observe only completed genuine statements, without replacing results. */
function observed(db:DbClient,fn:(tx:DbClient,statement:string)=>Promise<void>):DbClient {
  return new Proxy(db,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;
    if(key!=='transaction')return value.bind(target);
    return(callback:(tx:DbClient)=>unknown,...options:unknown[])=>Reflect.apply(value,target,[(tx:DbClient)=>callback(new Proxy(tx,{get(t,k){const op=Reflect.get(t,k);if(typeof op!=='function')return op;if(k!=='execute')return op.bind(t);
      return async(statement:SQL)=>{const rows=await Reflect.apply(op,t,[statement]);await fn(t,dialect.sqlToQuery(statement).sql);return rows;};}})),...options]);
  }});
}
async function state(db:DbClient) {
  const [tables]=await db.execute<{ names:string[] }>(sql`SELECT array_agg(tablename ORDER BY tablename) AS names FROM pg_tables WHERE schemaname='public'`);
  const snapshot:Record<string,unknown>={};
  for(const name of tables.names) snapshot[name]=await db.execute(sql.raw(`SELECT to_jsonb(t) AS row FROM public."${name.replaceAll('"','""')}" t ORDER BY to_jsonb(t)::text`));
  snapshot.sequences=await db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`);
  return snapshot;
}
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('bargain records actual current Admin LOGIN and production Hono/Hyperdrive boundary',()=>{
  afterEach(()=>vi.restoreAllMocks());
  it('executes six modern reads and five PHP aliases, rejects live authority/credential drift and leaves the entire shop and sequences unchanged',async()=>{
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('External I/O forbidden'));
    await fixture(async(f,app,admin)=>{
      const password='owned-bargain-read-password',actors={all:8810,record:8811,statistics:8812,generic:8813,legacy:8814};
      const rules={all:'bargain_record.view,bargain_statistics.view',record:'bargain_record.view',statistics:'bargain_statistics.view',generic:'activity.manage,order.view',legacy:'755,1551'};
      await f.db.insert(systemRole).values(Object.entries(actors).map(([name,id])=>({id,roleName:'Owned bargain '+name,rules:rules[name as keyof typeof rules]})));
      await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name,id])=>({id,account:'owned_bargain_'+name,pwd:password,roles:String(id),level:1,adminType:1})));
      // Match the exact fixed PHP tuples; no fictitious statistics API seed.
      await f.db.delete(systemMenus).where(eq(systemMenus.id,755)); await f.db.delete(systemMenus).where(eq(systemMenus.id,1551));
      await f.db.insert(systemMenus).values([
        {id:755,pid:31,authType:1,menuName:'砍价列表',menuPath:'/admin/marketing/store_bargain/bargain_list',uniqueAuth:'marketing-store_bargain-bargain_list'},
        {id:1551,pid:31,authType:1,menuName:'砍价统计',menuPath:'/admin/marketing/store_bargain/statistics',uniqueAuth:''},
      ]);
      const env={HYPERDRIVE:{connectionString:app.connectionString},HYPERDRIVE_ADMIN:{connectionString:admin.connectionString},APP_KEY:'owned-bargain-record-http',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''} as unknown as Env;
      const tokens=Object.fromEntries(await Promise.all(Object.entries(actors).map(async([name,id])=>[name,(await createToken(id,'admin',md5(password),env.APP_KEY)).token])));
      const http=createApp(),results:Array<{path:string;status:number}>=[];
      const get=async(path:string,token=tokens.all)=>{const response=await http.request(path,{headers:{Authorization:'Bearer '+token}},env);expect(response.headers.get('cache-control')).toContain('private, no-store');const data=await response.json<{status:number;msg:string;data:any}>();results.push({path,status:data.status});
        // A Node test makes many independent Worker requests in one process.
        // Retire only this owned fixture's completed application sessions; the
        // real production container and independently authenticated SQL remain.
        await f.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename=${app.role} AND application_name='cinashop_api' AND pid<>pg_backend_pid()`);
        return data;};
      const paths=['/activity/bargain-records','/activity/bargain-records/8101/helpers','/activity/bargain-statistics/801/head','/activity/bargain-statistics/801/records','/activity/bargain-statistics/801/records/8101/helpers','/activity/bargain-statistics/801/orders',
        '/marketing/bargain_list','/marketing/bargain_list_info/8101','/marketing/bargain/statistics/head/801','/marketing/bargain/statistics/list/801','/marketing/bargain/statistics/order/801'];
      const before=await state(f.db);
      expect(await new AdminPermissionService(createContainerFromDb(app.db)).resolveRulePermissionKeys('755,1551')).toEqual(expect.arrayContaining(['bargain_record.view','bargain_statistics.view']));
      for(const prefix of ['/adminapi','/api/admin']) {
        for(const path of paths) {const response=await get(prefix+path);expect(response.status,path+response.msg).toBe(200);}
        expect((await get(prefix+'/activity/bargain-statistics/801/head')).data).toMatchObject({people_count:4,spread_count:3,start_count:3,success_count:1,ordered_count:1,pay_price:'30.30',pay_count:2,pay_rate:'66.00'});
        expect((await get(prefix+'/marketing/bargain_list?data=2026%2F09%2F26-2026%2F09%2F26&status=4')).data.list[0]).toMatchObject({id:8103,add_time:'2026-09-26 23:59:59',now_price:'11.88'});
        expect((await get(prefix+'/marketing/bargain/statistics/list/801?real_name='+encodeURIComponent('用户%_'))).data.count).toBe(1);
        expect((await get(prefix+'/marketing/bargain/statistics/order/801?real_name='+encodeURIComponent('地址联系人'))).data.count).toBe(2);
        for(const path of paths) expect((await get(prefix+path,tokens.generic)).status).toBe(ApiErrorCode.ERR_AUTH);
        expect((await get(prefix+'/activity/bargain-records',tokens.statistics)).status).toBe(ApiErrorCode.ERR_AUTH);
        expect((await get(prefix+'/activity/bargain-statistics/801/orders',tokens.record)).status).toBe(ApiErrorCode.ERR_AUTH);
        expect((await get(prefix+'/activity/bargain-statistics/801/records/8101/helpers',tokens.statistics)).status).toBe(200);
        expect((await get(prefix+'/activity/bargain-statistics/802/records/8101/helpers')).status).toBe(404);
        for(const path of ['/activity/bargain-records?page=1&page=2','/activity/bargain-statistics/801/head?keyword=x','/marketing/bargain_list?data=bad','/activity/bargain-records/01/helpers']) expect((await get(prefix+path)).status).toBe(400);
        expect((await get(prefix+'/activity/bargain-records',tokens.legacy)).status).toBe(200);
        expect((await get(prefix+'/activity/bargain-statistics/801/head',tokens.legacy)).status).toBe(200);
      }
      expect(await state(f.db)).toEqual(before);
      await f.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,actors.record));
      expect((await get('/adminapi/activity/bargain-records',tokens.record)).status).toBe(ApiErrorCode.ERR_AUTH);
      await f.db.update(systemMenus).set({uniqueAuth:'copied-or-drifted'}).where(eq(systemMenus.id,1551));
      expect((await get('/adminapi/activity/bargain-statistics/801/head',tokens.legacy)).status).toBe(ApiErrorCode.ERR_AUTH);
      await f.db.update(systemAdmin).set({pwd:'changed-password'}).where(eq(systemAdmin.id,actors.all));
      expect((await get('/adminapi/activity/bargain-records')).status).toBe(ApiErrorCode.ERR_EXPIRED);
      const wrong=(await createToken(actors.all,'supplier',md5('changed-password'),env.APP_KEY)).token;
      expect((await get('/adminapi/activity/bargain-records',wrong)).status).toBe(ApiErrorCode.ERR_BANNED);
      if(process.env.BARGAIN_RECORDS_RUNTIME_REPORT)writeFileSync(process.env.BARGAIN_RECORDS_RUNTIME_REPORT,JSON.stringify({actual_production_container:true,app_role:app.role,admin_role:admin.role,results,whole_shop_unchanged:true},null,2)+'\n');
    });
    expect(fetch).not.toHaveBeenCalled();
  },180000);
  it('keeps bounded read-only repeatable snapshots, respects stricter deadlines and refuses accidental DML',async()=>{
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('External I/O forbidden'));
    await fixture(async(f,_app,admin)=>{
      await admin.exec("SET statement_timeout='1s';SET lock_timeout='500ms';SET idle_in_transaction_session_timeout='1500ms'");
      const settings=sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
        (SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS statement,(SELECT setting::integer FROM pg_settings WHERE name='lock_timeout') AS lock,
        (SELECT setting::integer FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle`;
      const before=await admin.db.execute(settings), states:unknown[]=[],commands:string[]=[];
      const service=new AdminBargainRecordsService(createContainerFromDb(observed(admin.db,async(tx,command)=>{commands.push(command);if(command.includes("set_config('statement_timeout'"))states.push((await tx.execute(settings))[0]);})));
      await service.head(801); await service.records(q()); await service.helpers(8101,q()); await service.orders(801,q());
      expect(states).toHaveLength(4); for(const row of states)expect(row).toEqual({isolation:'repeatable read',read_only:'on',statement:1000,lock:500,idle:1500});
      expect(commands.some(command=>/\b(?:INSERT|UPDATE|DELETE|MERGE|LOCK|pg_advisory\w*)\b/iu.test(command))).toBe(false); expect(await admin.db.execute(settings)).toEqual(before);
      let injected=false;
      const concurrent=new AdminBargainRecordsService(createContainerFromDb(observed(admin.db,async(_tx,command)=>{
        if(!injected&&command.includes('SELECT count(*)::integer AS count FROM public.store_bargain_user p')){injected=true;await f.db.insert(storeBargainUser).values({id:8999,bargainId:801,uid:810});}
      })));
      const original=await concurrent.records(q(),801); expect(injected).toBe(true); expect(original.count).toBe(3); expect(original.list).toHaveLength(3);
      expect((await service.records(q(),801)).count).toBe(4); await f.db.delete(storeBargainUser).where(eq(storeBargainUser.id,8999));
      const snapshot=await state(f.db);let attempted=false;
      const invalid=new AdminBargainRecordsService(createContainerFromDb(observed(admin.db,async(tx,command)=>{if(!attempted&&command.includes("set_config('statement_timeout'")){attempted=true;await tx.execute(sql`INSERT INTO public.store_bargain(title) VALUES('forbidden read write')`);}})));
      await expect(invalid.head(801)).rejects.toMatchObject({cause:{code:'25006'}});expect(attempted).toBe(true);expect(await state(f.db)).toEqual(snapshot);
    });
    expect(fetch).not.toHaveBeenCalled();
  },180000);
});
