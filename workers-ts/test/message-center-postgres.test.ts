import {describe,expect,it} from 'vitest';
import {sql,eq} from 'drizzle-orm';
import {auditCheckoutPricingLockRuntime} from '@/migrations/checkoutPricingLock';
import {createDb,createDbFromConnectionString,createContainerFromDb} from '@/lib/di';
import type {Env} from '@/env';
import {systemMessage,userMessage} from '@/models/schema';
import {MessageCenterService} from '@/services/message/MessageCenterService';
import {KefuRealtimeService} from '@/services/kefu/KefuRealtimeService';
import {auditRuntimeBusinessPrivileges} from '@/migrations/auditRuntimeBusinessPrivileges';
import {installUserMessageReadCapability,inspectUserMessageReadCapability,USER_MESSAGE_READ_SIGNATURE,MESSAGE_READ_LOCK_NAMESPACE} from '@/migrations/userMessageReadCapability';
import {IDS,messageCenterFixture,messageFixturePassword,messageVisibleRows,messageUnreadCount,assertMessageReadConsumption} from './helpers/messageCenterFixture';

// Actual 185-migration PG16 database and authenticated non-owner App LOGIN;
// every business operation is compared across all 283 tables/229 sequences.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('message center exact full-schema native read consumption',()=>{
 it('preserves legacy envelopes, owner/broadcast isolation, duplicate evidence, explicit offline history, serial-idempotency, two-LOGIN races and fail-closed capability drift',async()=>{
  const f=await messageCenterFixture();
  try{await f.withApplication(async({app,admin,container,env,names,owner})=>{
   const service=new MessageCenterService(container,env),a={uid:IDS.a,pwd:messageFixturePassword},b={uid:IDS.b,pwd:messageFixturePassword},c={uid:IDS.empty,pwd:messageFixturePassword};
   const q={modern:true,page:1,limit:20},baseline=await f.snapshot();
   expect(await inspectUserMessageReadCapability(app.db)).toMatchObject({absent:true,ready:false});
   await expect(service.list(a,q)).rejects.toThrow('能力');expect(await f.snapshot()).toEqual(baseline);
   // NOLOGIN does not end an already authenticated connection. Reject this
   // otherwise fresh owner before any grants or function can be installed.
   let refusedOwner='';
   await f.withRuntimeRole!(async oldLogin=>{
    refusedOwner=oldLogin.role;
    await f.exec(`ALTER ROLE "${oldLogin.role}" NOLOGIN`);
    const[session]=await oldLogin.db.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid`);
    expect(session).toEqual({role:oldLogin.role,session:oldLogin.role,pid:oldLogin.pid});
    const[active]=await f.db.execute(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE usesysid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${oldLogin.role})`);
    expect(active.n).toBe(1);
    const rights=async()=>{const[r]=await f.db.execute(sql`SELECT
     pg_catalog.has_table_privilege(${oldLogin.role},'public.user_message','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR pg_catalog.has_any_column_privilege(${oldLogin.role},'public.user_message','SELECT,INSERT,UPDATE,REFERENCES') AS receipt_data,
     pg_catalog.has_sequence_privilege(${oldLogin.role},'public.user_message_id_seq','USAGE,SELECT,UPDATE') AS receipt_serial,
     pg_catalog.has_schema_privilege(${oldLogin.role},'public','CREATE') AS schema_create,
     (SELECT count(*)::integer FROM pg_catalog.pg_proc WHERE proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${oldLogin.role})) AS owned_functions`);return r;};
    const beforeRights=await rights();expect(beforeRights).toEqual({receipt_data:false,receipt_serial:false,schema_create:false,owned_functions:0});
    await expect(installUserMessageReadCapability(f.db,{...names,owner:oldLogin.role})).rejects.toThrow('fresh restricted NOLOGIN');
    expect(await rights()).toEqual(beforeRights);
    expect(await inspectUserMessageReadCapability(app.db)).toMatchObject({absent:true,ready:false});
    expect(await f.snapshot()).toEqual(baseline);
   });
   expect(await f.db.execute(sql`SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${refusedOwner}`)).toHaveLength(0);
   expect(await installUserMessageReadCapability(f.db,names)).toEqual({applied:true,ready:true});
   expect(await installUserMessageReadCapability(f.db,names)).toEqual({applied:false,ready:true});
   const capability=await inspectUserMessageReadCapability(app.db);expect(capability).toMatchObject({ready:true,definitionSafe:true,ownerSafe:true,aclSafe:true,tablesSafe:true});
   const[pricing]=await f.db.execute(sql`SELECT oid::text AS oid FROM pg_proc WHERE proname='checkout_lock_pricing_v1'`);expect(capability.functionOid).not.toBe(pricing.oid);
   expect(await auditRuntimeBusinessPrivileges(app.db,'app',names)).toMatchObject({ready:true,failures:[]});
   expect(await auditRuntimeBusinessPrivileges(admin.db,'admin',names)).toMatchObject({ready:true,failures:[]});
   expect(await auditCheckoutPricingLockRuntime(app.db,'public','shared-shop')).toMatchObject({ready:true,noUnreviewedDefinerRoutine:true});
   expect(await auditCheckoutPricingLockRuntime(app.db,'public','isolated')).toMatchObject({ready:false,noUnreviewedDefinerRoutine:false});
   // A commissioned owner may later gain a LOGIN briefly and retain its
   // authenticated session after NOLOGIN. Its body/ACL/data grants still match,
   // so the live-session predicate must independently close every admission.
   const ownerUrl=new URL(app.connectionString);ownerUrl.username=owner;ownerUrl.password='synthetic-message-owner-session';
   let ownerSession:ReturnType<typeof createDbFromConnectionString>|undefined;
   try{
    await f.exec(`ALTER ROLE "${owner}" LOGIN PASSWORD 'synthetic-message-owner-session'`);
    ownerSession=createDbFromConnectionString(ownerUrl.href,1,{searchPath:'public,pg_temp'});
    const[connected]=await ownerSession.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid`);
    expect(connected).toMatchObject({role:owner,session:owner});expect(connected.pid).not.toBe(app.pid);
    await f.exec(`ALTER ROLE "${owner}" NOLOGIN`);
    const[survived]=await ownerSession.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid`);expect(survived).toEqual(connected);
    const[active]=await f.db.execute(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE usesysid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${owner})`);expect(active.n).toBe(1);
    expect(await inspectUserMessageReadCapability(app.db)).toMatchObject({absent:false,ready:false,definitionSafe:true,aclSafe:true,tablesSafe:true,ownerSafe:false});
    await expect(service.list(a,q)).rejects.toThrow('能力');
    await expect(installUserMessageReadCapability(f.db,names)).rejects.toThrow('drift requires review');
    for(const [db,kind]of[[app.db,'app'],[admin.db,'admin']] as const){const audit=await auditRuntimeBusinessPrivileges(db,kind,names);expect(audit.ready).toBe(false);expect(audit.failures).toContain('user_message_read_capability');}
    expect(await auditCheckoutPricingLockRuntime(app.db,'public','shared-shop')).toMatchObject({ready:false,noUnreviewedDefinerRoutine:false});
    expect(await f.snapshot()).toEqual(baseline);
   }finally{
    try{await f.exec(`ALTER ROLE "${owner}" NOLOGIN PASSWORD NULL`);}finally{await ownerSession?.$client.end({timeout:5});}
   }
   const[closedOwner]=await f.db.execute(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE usesysid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${owner})`);expect(closedOwner.n).toBe(0);
   expect(await inspectUserMessageReadCapability(app.db)).toMatchObject({ready:true,ownerSafe:true});
   expect(await installUserMessageReadCapability(f.db,names)).toEqual({applied:false,ready:true});
   expect(await auditRuntimeBusinessPrivileges(app.db,'app',names)).toMatchObject({ready:true,failures:[]});
   expect(await auditRuntimeBusinessPrivileges(admin.db,'admin',names)).toMatchObject({ready:true,failures:[]});
   expect(await auditCheckoutPricingLockRuntime(app.db,'public','shared-shop')).toMatchObject({ready:true,noUnreviewedDefinerRoutine:true});
   await expect(app.db.execute(sql`INSERT INTO public.user_message(uid,message_id,is_read) VALUES(11,710001,1)`)).rejects.toThrow();
   await expect(app.db.execute(sql`UPDATE public.user_message SET is_read=1 WHERE uid=11`)).rejects.toThrow();
   await expect(app.db.execute(sql`SELECT nextval('public.user_message_id_seq')`)).rejects.toThrow();
   await expect(app.db.execute(sql`SELECT public.cinashop_user_message_read_v1(11,ARRAY[710001])`)).rejects.toThrow();
   expect(await f.snapshot()).toEqual(baseline);
   const center=await service.center(a,q);expect(center).toMatchObject({owner_uid:IDS.a,system:{id:IDS.ownMessage,message_num:21},service_count:23,page_count:2});
   expect(center.service).toHaveLength(20);expect(center.service.some(r=>r.message_type===7)).toBe(true);expect(center.service[0].mssage_num).toBe(101);
   const secondCenter=await service.center(a,{...q,page:2});expect('service'in secondCenter&&secondCenter.service).toHaveLength(3);
   const legacyCenter=await service.center(a,{...q,modern:false});expect(Object.keys(legacyCenter).sort()).toEqual(['service','system']);
   expect(legacyCenter.system).toMatchObject({id:IDS.ownMessage,message_num:21,add_time:expect.any(String)});expect(await f.snapshot()).toEqual(baseline);
   expect(f.assetReads).toHaveLength(0); // Signing metadata never reads R2 bytes.
   const start=Math.floor(Date.now()/1000),first=await service.list(a,q),afterFirst=await f.snapshot();
   expect(first).toMatchObject({owner_uid:IDS.a,count:23,page_count:2,service_num:21});expect(first.list).toHaveLength(20);
   const firstIds=messageVisibleRows(baseline,IDS.a).slice(0,20).map(r=>r.id);
   expect(first.list.map(r=>r.id)).toEqual(firstIds);
   const firstOracle=assertMessageReadConsumption(baseline,afterFirst,IDS.a,firstIds,start,Math.floor(Date.now()/1000));
   expect(firstOracle).toMatchObject({serial_allocations:17,updated_receipt_ids:[9001,9002]});expect(messageUnreadCount(afterFirst,IDS.a)).toBe(3);
   const replay=await service.list(a,q);expect(replay).toMatchObject({service_num:3});expect(await f.snapshot()).toEqual(afterFirst);
   const nextStart=Math.floor(Date.now()/1000),second=await service.list(a,{...q,page:2}),afterSecond=await f.snapshot();
   expect(second).toMatchObject({count:23,page_count:2,service_num:3});expect(second.list).toHaveLength(3);
   expect(assertMessageReadConsumption(afterFirst,afterSecond,IDS.a,second.list.map(r=>r.id),nextStart,Math.floor(Date.now()/1000))).toMatchObject({serial_allocations:3,updated_receipt_ids:[]});
   await service.list(a,{...q,page:2});expect(await f.snapshot()).toEqual(afterSecond);expect(messageUnreadCount(afterSecond,IDS.a)).toBe(0);
   for(const id of[IDS.foreignMessage,IDS.staffMessage,IDS.hiddenMessage,IDS.deletedMessage])expect(await service.detail(a,id,{...q,limit:1})).toMatchObject({owner_uid:IDS.a,id,message:null,service_num:0});
   expect(await f.snapshot()).toEqual(afterSecond);
   const bStart=Math.floor(Date.now()/1000),other=await service.detail(b,IDS.broadcast,{...q,limit:1}),afterOther=await f.snapshot();
   expect(other).toMatchObject({owner_uid:IDS.b,message:{id:IDS.broadcast},service_num:1});
   expect(assertMessageReadConsumption(afterSecond,afterOther,IDS.b,[IDS.broadcast],bStart,Math.floor(Date.now()/1000))).toMatchObject({serial_allocations:1});
   expect(afterOther.system_message.find(r=>r.id===IDS.broadcast)!.look).toBe(0);
   await service.detail(b,IDS.broadcast,{...q,limit:1});expect(await f.snapshot()).toEqual(afterOther);
   await expect(service.list({uid:IDS.a,pwd:'old-version'},q)).rejects.toThrow('登录');expect(await f.snapshot()).toEqual(afterOther);
   // Imported look=1 and mixed (read=1/read=0) evidence stay byte-for-byte intact.
   expect(afterOther.user_message.filter(r=>r.message_id===IDS.legacyRead)).toEqual([]);
   expect(afterOther.user_message.filter(r=>r.message_id===IDS.mixedRead)).toEqual(baseline.user_message.filter(r=>r.message_id===IDS.mixedRead));
   expect(await service.list(a,{modern:false,page:1000,limit:20})).toEqual({list:[],count:0});
   const legacyList=await service.list(a,{...q,modern:false});expect(legacyList).toMatchObject({count:23,service_num:0});expect(legacyList.list).toHaveLength(20);
   expect(legacyList.list.every(r=>'look'in r&&r.look===1)).toBe(true);expect(await f.snapshot()).toEqual(afterOther);
   const chat=new KefuRealtimeService(container,env),stable=await f.snapshot();
   for(const to_uid of[String(IDS.disabledService),'2147483000'])await expect(chat.userRecord(IDS.a,{to_uid})).rejects.toThrow('指定客服');
   const offline=await chat.userRecord(IDS.a,{to_uid:String(IDS.offlineService)});expect(offline).toMatchObject({uid:IDS.offlineService,nickname:'离线客服34',online:0});
   expect(offline.serviceList.map(r=>r.msn_type)).toEqual([1,7]);expect(offline.avatar).toMatch(/^\/api\/assets\/740201\?expires=[1-9]\d*&signature=[A-Za-z0-9_-]{43}$/);expect(f.assetReads).toHaveLength(0);expect(JSON.stringify(offline)).toContain('离线客服给A的历史');expect(JSON.stringify(offline)).not.toContain('B独立历史');
   expect(await chat.userRecord(IDS.a,{to_uid:'0'})).toMatchObject({uid:IDS.firstService,nickname:'在线客服33'});expect(await f.snapshot()).toEqual(stable);
   for(const [revoke,restore]of[['passwd-revoke','passwd-restore'],['status-revoke','status-restore']] as const){await f.control(revoke);const blocked=await f.snapshot();await expect(service.list(a,q)).rejects.toThrow('登录');expect(await f.snapshot()).toEqual(blocked);await f.control(restore);}
   await f.control('hide-broadcast');const emptyState=await f.snapshot();
   expect(await service.center(c,q)).toMatchObject({owner_uid:IDS.empty,system:null,service:[],service_count:0,page_count:0});
   expect(await service.list(c,q)).toEqual({owner_uid:IDS.empty,query:{page:1,limit:20},list:[],count:0,page_count:0,service_num:0});expect(await f.snapshot()).toEqual(emptyState);await f.control('restore-broadcast');
   // Explicit finite maintenance setup removes ONE known fixture receipt. Two
   // independently connected App sessions then wait on the same UID lock before
   // either can observe absence; the second must observe the first's commit.
   const removed=afterFirst.user_message.find(r=>r.uid===IDS.a&&r.message_id===IDS.ownMessage)!;
   await f.db.delete(userMessage).where(eq(userMessage.id,removed.id));const concurrentBefore=await f.snapshot(),concurrentStart=Math.floor(Date.now()/1000);
   const peerDb=createDb({...env,HYPERDRIVE:{connectionString:app.connectionString}} as Env),gateDb=createDb({...env,HYPERDRIVE:{connectionString:app.connectionString}} as Env);
   let settled:Promise<PromiseSettledResult<Awaited<ReturnType<MessageCenterService['list']>>>[]>|undefined;
   try{
    const[p1]=await app.db.execute(sql`SELECT pg_backend_pid() AS pid`),[p2]=await peerDb.execute(sql`SELECT pg_backend_pid() AS pid`);expect(p1.pid).not.toBe(p2.pid);
    const peer=new MessageCenterService(createContainerFromDb(peerDb),env);
    await gateDb.transaction(async gate=>{await gate.execute(sql`SELECT pg_advisory_xact_lock(${MESSAGE_READ_LOCK_NAMESPACE},${IDS.a})`);settled=Promise.allSettled([service.list(a,q),peer.list(a,q)]);
     const end=Date.now()+1000;let waiting=0;while(Date.now()<end){const[r]=await f.exec(`SELECT count(*)::integer AS n FROM pg_locks WHERE locktype='advisory' AND classid=${MESSAGE_READ_LOCK_NAMESPACE} AND objid=${IDS.a} AND NOT granted`);waiting=Number(r.n);if(waiting===2)break;await new Promise(resolve=>setTimeout(resolve,10));}expect(waiting).toBe(2);
    });
    const results=await settled!;expect(results.every(r=>r.status==='fulfilled')).toBe(true);
    expect(results.map(r=>r.status==='fulfilled'&&'service_num'in r.value?r.value.service_num:-1).sort()).toEqual([0,1]);
    expect(assertMessageReadConsumption(concurrentBefore,await f.snapshot(),IDS.a,firstIds,concurrentStart,Math.floor(Date.now()/1000))).toMatchObject({serial_allocations:1,updated_receipt_ids:[]});
   }finally{await settled;await peerDb.$client.end();await gateDb.$client.end();}
   // Capacity validation happens before the fixed writer, including serials.
   const oldContent=baseline.system_message.find(r=>r.id===IDS.ownMessage)!.content;
   await f.db.update(systemMessage).set({content:'x'.repeat(65537)}).where(eq(systemMessage.id,IDS.ownMessage));const malformed=await f.snapshot();
   await expect(service.list(a,q)).rejects.toThrow('完整读取');expect(await f.snapshot()).toEqual(malformed);await f.db.update(systemMessage).set({content:oldContent}).where(eq(systemMessage.id,IDS.ownMessage));
   await f.exec(`REVOKE EXECUTE ON FUNCTION ${USER_MESSAGE_READ_SIGNATURE} FROM "${app.role}"`);const revoked=await f.snapshot();
   expect(await inspectUserMessageReadCapability(app.db)).toMatchObject({ready:false});await expect(service.list(a,q)).rejects.toThrow('能力');expect(await f.snapshot()).toEqual(revoked);
   await f.exec(`GRANT EXECUTE ON FUNCTION ${USER_MESSAGE_READ_SIGNATURE} TO "${app.role}"`);
   await f.exec(`GRANT DELETE ON public.user_message TO "${owner}"`);expect(await inspectUserMessageReadCapability(app.db)).toMatchObject({ready:false});
   expect(await auditRuntimeBusinessPrivileges(app.db,'app',names)).toMatchObject({ready:false});
   expect(await auditCheckoutPricingLockRuntime(app.db,'public','shared-shop')).toMatchObject({ready:false,noUnreviewedDefinerRoutine:false});await expect(service.list(a,q)).rejects.toThrow('能力');
   await f.exec(`REVOKE DELETE ON public.user_message FROM "${owner}"`);expect(await inspectUserMessageReadCapability(app.db)).toMatchObject({ready:true});
   expect(f.resources().forbidden).toBe(0);
  },{installCapability:false});}finally{await f.close();}
 },180000);
});
