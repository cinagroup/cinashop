/** Structural protocol acceptance only. Owned SQL specimens below are neither
 * paid orders nor provider facts. Five actual LOGINs and full formal profiles
 * remain real; no runtime grant, proof, financial producer or auth is mocked. */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { stageRoutineVirtualPaidShippingTx } from '@/services/order/RoutineVirtualPaidShipping';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineShippingUpgrade } from '@/migrations/runRoutineShippingUpgrade';
import { runRoutineVirtualShippingSubjectsUpgrade, runRoutineVirtualShippingSubjectsUpgradeInTransaction } from '@/migrations/runRoutineVirtualShippingSubjectsUpgrade';
import { assertRoutineVirtualShippingSubjectsReadTx, assertRoutineVirtualShippingSubjectsStageTx,
  inspectRoutineVirtualShippingSubjects, ROUTINE_VIRTUAL_SHIPPING_SUBJECT_DEFINITION,
  routineVirtualShippingEventDefinition, ROUTINE_VIRTUAL_SHIPPING_STRUCTURE_SQL, inspectRoutineVirtualShippingSubjectsStructure } from '@/migrations/routineVirtualShippingSubjects';
import { runSupplierOrderPriceRevision, assertSupplierOrderPriceRevisionReady, SUPPLIER_ORDER_PRICE_REVISION_SQL } from '@/migrations/supplierOrderPriceRevision';
import { inspectWithdrawalEffectsUpgrade, runWithdrawalEffectsUpgrade } from '@/migrations/runWithdrawalEffectsUpgrade';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { auditCustomerFinancialRuntimePrivileges, inspectCustomerFinancialRuntimePrivileges } from '@/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditManagerRuntimePrivileges } from '@/migrations/auditManagerRuntimePrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges, inspectCustomerCashierSecondCardRuntimePrivileges } from '@/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import { readFileSync } from 'node:fs';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';

type Fixture=Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
type Query=Pick<DbClient,'execute'>;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('formal virtual Routine shipping subject/event forward',()=>{
  let f:Fixture,network:ReturnType<typeof vi.spyOn<typeof globalThis,'fetch'>>,lookalike:ReturnType<Fixture['connect']>;
  const names=()=>({maintenance:f.target.maintenance,app:f.target.app,admin:f.target.admin});
  const target=()=>({database:f.target.database,...names(),...(f.target.local?{local:[...f.target.local]}:{}),
    ...(f.target.caseLock?{caseLock:{owner:f.target.caseLock.owner,runtimeRoles:[...f.target.caseLock.runtimeRoles]}}:{})});
  const install=()=>runRoutineVirtualShippingSubjectsUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  async function shippingSwitch(work:(set:(enabled:boolean)=>Promise<void>)=>Promise<void>){
    const previous=await f.maintenanceDb.select().from(systemConfig).where(eq(systemConfig.menuName,'order_shipping_open'));
    const clear=()=>f.maintenanceDb.delete(systemConfig).where(eq(systemConfig.menuName,'order_shipping_open'));
    await clear();
    try{await work(async enabled=>{await clear();await f.maintenanceDb.insert(systemConfig).values({menuName:'order_shipping_open',value:enabled?'1':'0'});});}
    finally{await clear();if(previous.length)await f.maintenanceDb.insert(systemConfig).values(previous);}
  }
  async function installCaller(tx:Query){
    try{return await runRoutineVirtualShippingSubjectsUpgradeInTransaction(tx,f.target,f.peers,f.appReaders);}
    catch(error){
      if(error instanceof Error&&error.message.startsWith('Virtual shipping installed catalog/runtime profiles failed verification')){
        // Only fixed, just-authored public schema definitions and booleans;
        // never an exception cause, SQL parameters or financial/provider rows.
        const [row]=await tx.execute(sql.raw(ROUTINE_VIRTUAL_SHIPPING_STRUCTURE_SQL));
        throw Error(error.message+';owned_catalog='+JSON.stringify({subject:row?.subject_definition,event:row?.event_definition,
          indexReady:row?.index_ready,columnsReady:row?.columns_ready}));
      }
      throw error;
    }
  }
  async function snapshot(tx:Query){
    const [row]=await tx.execute<{value:unknown}>(sql`SELECT pg_catalog.jsonb_build_object(
      'tables',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c.oid::text,c.relname,c.relowner::text,c.relacl::text,c.relchecks,c.relfilenode::text,c.reloptions) ORDER BY c.oid)
        FROM pg_catalog.pg_class c WHERE c.oid IN('public.order_notification_delivery'::regclass,'public.store_order_outbox'::regclass)),
      'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a
        WHERE a.attrelid IN('public.order_notification_delivery'::regclass,'public.store_order_outbox'::regclass) AND a.attnum>0),
      'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(k.oid::text,k.conname,pg_catalog.pg_get_constraintdef(k.oid,false),pg_catalog.obj_description(k.oid,'pg_constraint')) ORDER BY k.oid)
        FROM pg_catalog.pg_constraint k WHERE k.conrelid IN('public.order_notification_delivery'::regclass,'public.store_order_outbox'::regclass)),
      'indexes',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) ORDER BY i.indexrelid) FROM pg_catalog.pg_index i
        WHERE i.indrelid IN('public.order_notification_delivery'::regclass,'public.store_order_outbox'::regclass)),
      'defaults',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid) FROM pg_catalog.pg_default_acl d),
      'roles',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) ORDER BY r.oid) FROM pg_catalog.pg_roles r
        WHERE r.rolname IN(${f.appRuntime.role},${f.adminRuntime.role},${f.financialRuntime.role},${f.managerRuntime.role},${f.cashierRuntime.role}))) AS value`);
    const delivery=await tx.execute(sql`SELECT id,event_key,order_id,withdrawal_id,user_id,notice_mark,channel,payload,xmin::text AS xmin FROM public.order_notification_delivery ORDER BY id`);
    const source=await tx.execute(sql`SELECT pg_catalog.to_jsonb(t) AS row,t.xmin::text AS xmin FROM public.store_order_outbox t ORDER BY id`);
    return{catalog:row.value,delivery:Array.from(delivery),source:Array.from(source)};
  }
  async function hold(acquire:(tx:Query)=>Promise<unknown>,work:()=>Promise<void>){
    await f.withMaintenancePeer(async peer=>{
      let ready!:()=>void,release!:()=>void;const acquired=new Promise<void>(r=>{ready=r;}),released=new Promise<void>(r=>{release=r;});
      const held=peer.transaction(async tx=>{await acquire(tx);ready();await released;});
      try{await Promise.race([acquired,held.then(()=>{throw Error('Owned protocol lock ended early');})]);await work();}
      finally{release();await held;}
    });
  }
  beforeAll(async()=>{
    network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No provider transport in structural protocol acceptance'));
    f=await customerCashierRuntimeHttpFixture();
    const unbound=await f.createOwnedRole('virtualsubjectpeer',true);lookalike=f.connect(unbound.role,unbound.password);
    // Negative/structural metadata only, never a real payment/shipping source.
    await f.exec("INSERT INTO public.store_order_outbox(event_key,event_type,aggregate_type,aggregate_id,payload) VALUES('order.paid:900001','order.paid','order',900001,'{\"orderId\":900001,\"orderNo\":\"SQL_PROTOCOL_ONLY\"}'); INSERT INTO public.order_notification_delivery(outbox_id,event_key,order_id,user_id,notice_mark,channel,payload) VALUES(900001,'order.delivery.notice:900001',900001,11,'sql_protocol_only','wechat_shipping','{}')");
    expect(new Set(await Promise.all([f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime].map(peer=>peer.verify()))).size).toBe(5);
  },180000);
  afterAll(async()=>{try{await f?.close();}finally{network?.mockRestore();}},30000);

  it('proves complete old14 absence only to actual App and refuses role/context/declaration substitution',async()=>{
    expect(await inspectRoutineVirtualShippingSubjectsStructure(f.maintenanceDb)).toMatchObject({present:false,ready:false,state:'base14',failures:[]});
    const messages=[...f.messages];
    await shippingSwitch(async set=>{
      await set(false);
      expect(await withTx(createContainerFromDb(f.appRuntime.db),tx=>stageRoutineVirtualPaidShippingTx(tx,{APP_KEY:''},'recharge',900009,Math.floor(Date.now()/1000)))).toBeNull();
      await set(true);
      const installers=[()=>runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders),
        ()=>runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders),
        ()=>runRoutineShippingUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders)];
      const partials=['routine_original_payment_evidence_owned_partial','routine_payment_account_owned_partial','routine_shipping_owned_partial'];
      for(let prefix=0;prefix<installers.length;prefix++){
        const before=await snapshot(f.maintenanceDb);
        expect(await f.appRuntime.db.transaction(tx=>assertRoutineVirtualShippingSubjectsStageTx(tx))).toBe(false);
        expect(await withTx(createContainerFromDb(f.appRuntime.db),tx=>stageRoutineVirtualPaidShippingTx(tx,{APP_KEY:''},'recharge',900009,Math.floor(Date.now()/1000)))).toBeNull();
        for(const peer of[f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime,lookalike])
          await expect(peer.db.transaction(tx=>assertRoutineVirtualShippingSubjectsStageTx(tx))).rejects.toMatchObject({code:503});
        await f.exec(`CREATE TABLE public.${partials[prefix]}(id integer)`);
        try{await expect(f.appRuntime.db.transaction(tx=>assertRoutineVirtualShippingSubjectsStageTx(tx))).rejects.toMatchObject({code:503});}
        finally{await f.exec(`DROP TABLE public.${partials[prefix]}`);}
        expect(await snapshot(f.maintenanceDb)).toEqual(before);expect(f.messages).toEqual(messages);
        if(prefix===0){
          for(const namespace of[731714,731717,731719,731722])await hold(
            tx=>tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(${namespace},0)`),async()=>{
              const started=performance.now();await expect(f.appRuntime.db.transaction(tx=>assertRoutineVirtualShippingSubjectsStageTx(tx))).rejects.toMatchObject({code:503});
              expect(performance.now()-started).toBeLessThan(2000);
            });
          await expect(f.maintenanceDb.transaction(async tx=>{await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.appRuntime.role)}`);return assertRoutineVirtualShippingSubjectsStageTx(tx);})).rejects.toMatchObject({code:503});
          for(const name of['routine_original_payment_evidence','order_notification_delivery'])
            await expect(f.appRuntime.db.transaction(async tx=>{await tx.execute(sql`CREATE TEMP TABLE ${sql.identifier(name)}(id integer) ON COMMIT DROP`);
              await expect(assertRoutineVirtualShippingSubjectsStageTx(tx)).rejects.toMatchObject({code:503});throw Error('Owned absent-namespace shadow rollback');
            })).rejects.toThrow('Owned absent-namespace shadow rollback');
        }
        await installers[prefix]();
      }
    });
    expect(await inspectRoutineVirtualShippingSubjects(f.maintenanceDb,names())).toMatchObject({present:false,ready:false,state:'base14',failures:[]});
    expect(await f.appRuntime.db.transaction(tx=>assertRoutineVirtualShippingSubjectsStageTx(tx))).toBe(false);
    expect(await f.appRuntime.db.transaction(tx=>assertRoutineVirtualShippingSubjectsReadTx(tx),{isolationLevel:'repeatable read',accessMode:'read only'})).toBe(false);
    await shippingSwitch(async set=>{
      for(const enabled of[false,true]){await set(enabled);
        expect(await withTx(createContainerFromDb(f.appRuntime.db),tx=>stageRoutineVirtualPaidShippingTx(tx,{APP_KEY:''},'recharge',900009,Math.floor(Date.now()/1000)))).toBeNull();
      }
    });
    for(const peer of[f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime,lookalike])
      await expect(peer.db.transaction(tx=>assertRoutineVirtualShippingSubjectsReadTx(tx))).rejects.toMatchObject({code:503});
    await expect(f.appRuntime.db.transaction(tx=>assertRoutineVirtualShippingSubjectsStageTx(tx),{accessMode:'read only'})).rejects.toMatchObject({code:503});
    await expect(f.maintenanceDb.transaction(async tx=>{await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.appRuntime.role)}`);return assertRoutineVirtualShippingSubjectsReadTx(tx);})).rejects.toMatchObject({code:503});
    const before=await snapshot(f.maintenanceDb);
    for(const peer of[f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime,lookalike])
      await expect(runRoutineVirtualShippingSubjectsUpgrade(peer.db,f.target,f.peers,f.appReaders)).rejects.toThrow();
    await expect(runRoutineVirtualShippingSubjectsUpgrade(f.maintenanceDb,{...f.target,database:'wrong_virtual_database'},f.peers,f.appReaders)).rejects.toThrow();
    let getters=0;await expect(runRoutineVirtualShippingSubjectsUpgrade(f.maintenanceDb,{...f.target,get app(){getters++;return f.target.app;}},f.peers,f.appReaders)).rejects.toThrow();expect(getters).toBe(0);
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  },90000);

  it.each([false,true])('atomically forwards the real old variant and rolls back every column/index/CHECK: price=%s',async price=>{
    const before=await snapshot(f.maintenanceDb),facts=await f.facts();
    await expect(f.maintenanceDb.transaction(async tx=>{
      if(price)await tx.execute(sql.raw(SUPPLIER_ORDER_PRICE_REVISION_SQL));
      const state=price?'virtual17':'virtual16';
      expect(await installCaller(tx)).toMatchObject({applied:true,state});
      expect(await inspectRoutineVirtualShippingSubjects(tx,names())).toMatchObject({present:true,ready:true,state,failures:[]});
      throw Error('Owned virtual-subject caller rollback');
    })).rejects.toThrow('Owned virtual-subject caller rollback');
    expect(await snapshot(f.maintenanceDb)).toEqual(before);expect(await f.facts()).toEqual(facts);
  },90000);

  it('refuses a real exclusive gate and independent table writer immediately without repairing and succeeds after release',async()=>{
    const before=await snapshot(f.maintenanceDb);
    for(const acquire of[(tx:Query)=>tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(731722,0)`),
      (tx:Query)=>tx.execute(sql`SELECT id FROM public.order_notification_delivery FOR UPDATE`)]){
      await hold(acquire,async()=>{const started=performance.now();await expect(install()).rejects.toThrow();expect(performance.now()-started).toBeLessThan(2000);});
      expect(await snapshot(f.maintenanceDb)).toEqual(before);
    }
    // Success is established by the next real forward; no owner SQL bypass.
  },90000);

  it('forwards old14 preserving data/comments and declaration snapshots, then repeats with no catalog writes',async()=>{
    await f.exec("COMMENT ON CONSTRAINT ond_subject_ck ON public.order_notification_delivery IS 'owned subject comment'; COMMENT ON CONSTRAINT soob_event_type_ck ON public.store_order_outbox IS 'owned event comment'");
    const before=await snapshot(f.maintenanceDb),facts=await f.facts(),caller=structuredClone(f.target),peers=structuredClone(f.peers),reader=structuredClone(f.appReaders);
    const expectedTarget=target(),expectedPeers={...structuredClone(f.peers),target:structuredClone(expectedTarget)},expectedReader=structuredClone(f.appReaders);
    const promise=runRoutineVirtualShippingSubjectsUpgrade(f.maintenanceDb,caller,peers,reader);
    caller.app='changed_after_first_await';if(caller.local)caller.local=[];peers.target.app='changed_after_first_await';
    const result=await promise;expect(result).toMatchObject({applied:true,state:'virtual16'});expect(result.target).toEqual(expectedTarget);expect(result.peers).toEqual(expectedPeers);expect(result.appReader).toEqual(expectedReader);
    expect(Object.hasOwn(result.target,'pricingOwner')).toBe(false);expect(Object.hasOwn(result.peers?.target??{},'pricingOwner')).toBe(false);
    const after=await snapshot(f.maintenanceDb);expect(after.delivery).toEqual(before.delivery);expect(after.source).toEqual(before.source);expect(await f.facts()).toEqual(facts);
    const [definitions]=await f.maintenanceDb.execute<{subject:string;event:string;comments:number}>(sql`SELECT
      (SELECT pg_catalog.pg_get_constraintdef(oid,false) FROM pg_catalog.pg_constraint WHERE conrelid='public.order_notification_delivery'::regclass AND conname='ond_subject_ck') AS subject,
      (SELECT pg_catalog.pg_get_constraintdef(oid,false) FROM pg_catalog.pg_constraint WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck') AS event,
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_constraint WHERE (conrelid='public.order_notification_delivery'::regclass AND conname='ond_subject_ck' AND pg_catalog.obj_description(oid,'pg_constraint')='owned subject comment')
        OR (conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck' AND pg_catalog.obj_description(oid,'pg_constraint')='owned event comment')) AS comments`);
    expect(definitions).toEqual({subject:ROUTINE_VIRTUAL_SHIPPING_SUBJECT_DEFINITION,event:routineVirtualShippingEventDefinition(false),comments:2});
    const queries:string[]=[],debug=f.maintenanceDb.$client.options.debug;
    f.maintenanceDb.$client.options.debug=(_connection,query)=>{queries.push(query);};
    try{expect(await install()).toMatchObject({applied:false,state:'virtual16'});}finally{f.maintenanceDb.$client.options.debug=debug;}
    expect(queries.some(query=>/^\s*(ALTER|CREATE|DROP|INSERT|UPDATE|DELETE)\b/iu.test(query))).toBe(false);expect(await snapshot(f.maintenanceDb)).toEqual(after);
    expect(await f.appRuntime.db.transaction(tx=>assertRoutineVirtualShippingSubjectsStageTx(tx))).toBe(true);
    expect(await f.appRuntime.db.transaction(tx=>assertRoutineVirtualShippingSubjectsReadTx(tx),{isolationLevel:'repeatable read',accessMode:'read only'})).toBe(true);
    const beforeMissingSigning=await snapshot(f.maintenanceDb);
    await shippingSwitch(async set=>{await set(true);
      await expect(withTx(createContainerFromDb(f.appRuntime.db),tx=>stageRoutineVirtualPaidShippingTx(tx,{APP_KEY:''},'recharge',900009,Math.floor(Date.now()/1000)))).rejects.toMatchObject({code:503});
    });
    expect(await snapshot(f.maintenanceDb)).toEqual(beforeMissingSigning);
  },90000);

  it('enforces closed actual App subjects without SQL NULL holes or changing the legacy order/withdrawal forms',async()=>{
    await expect(f.appRuntime.db.transaction(async tx=>{
      const insert=(domain:string|null,id:number|null,event:string,orderId:number|null=null,mark='paid_virtual_shipping',channel='wechat_shipping')=>tx.transaction(inner=>inner.execute(sql`
        INSERT INTO public.order_notification_delivery(outbox_id,event_key,order_id,withdrawal_id,subject_domain,subject_id,user_id,notice_mark,channel,payload)
        VALUES(900001,${event},${orderId},NULL,${domain},${id},11,${mark},${channel},'{}'::jsonb)`));
      await insert('recharge',900002,'recharge.paid.shipping:900002');await insert('membership',900003,'membership.paid.shipping:900003');
      for(const sample of[[null,900004,'recharge.paid.shipping:900004'],['recharge',null,'recharge.paid.shipping:900004'],['other',900004,'other.paid.shipping:900004'],
        ['recharge',0,'recharge.paid.shipping:0'],['membership',-1,'membership.paid.shipping:-1'],['membership',900004,'recharge.paid.shipping:900004'],
        ['recharge',900004,'recharge.paid.shipping:900005']] as const)
        await expect(insert(sample[0],sample[1],sample[2])).rejects.toMatchObject({cause:{code:'23514'}});
      await expect(insert('membership',900004,'membership.paid.shipping:900004',900004)).rejects.toMatchObject({cause:{code:'23514'}});
      await expect(insert('recharge',900004,'recharge.paid.shipping:900004',null,'wrong_mark')).rejects.toMatchObject({cause:{code:'23514'}});
      await expect(insert('recharge',900004,'recharge.paid.shipping:900004',null,'paid_virtual_shipping','sms')).rejects.toMatchObject({cause:{code:'23514'}});
      await tx.execute(sql`INSERT INTO public.order_notification_delivery(outbox_id,event_key,order_id,withdrawal_id,user_id,notice_mark,channel,payload)
        VALUES(900001,'order.delivery.notice:900007',900007,NULL,11,'sql_legacy','wechat_shipping','{}'),(900001,'withdrawal.approved.notice:900008',NULL,900008,11,'sql_legacy','wechat_shipping','{}')`);
      throw Error('Owned structural subject samples rollback');
    })).rejects.toThrow('Owned structural subject samples rollback');
    expect(network).not.toHaveBeenCalled();
  },90000);

  it('preserves Supplier authority through exact16→17 and DB007 successors without narrowing events or replacing repeat OIDs',async()=>{
    await expect(f.appRuntime.db.transaction(tx=>assertSupplierOrderPriceRevisionReady(tx))).rejects.toMatchObject({code:503});
    expect(readFileSync('src/migrations/maintenance/0193_supplier_order_price_revision.sql','utf8')).toBe(SUPPLIER_ORDER_PRICE_REVISION_SQL);
    await runSupplierOrderPriceRevision(f.maintenanceDb);
    expect(await inspectRoutineVirtualShippingSubjects(f.maintenanceDb,names())).toMatchObject({ready:true,state:'virtual17',failures:[]});
    await f.appRuntime.db.transaction(tx=>assertSupplierOrderPriceRevisionReady(tx));
    const before=await snapshot(f.maintenanceDb);
    await runSupplierOrderPriceRevision(f.maintenanceDb);expect(await install()).toMatchObject({applied:false,state:'virtual17'});expect(await snapshot(f.maintenanceDb)).toEqual(before);
    expect(await inspectWithdrawalEffectsUpgrade(f.maintenanceDb)).toMatchObject({supported:true,ready:true});
    expect(await runWithdrawalEffectsUpgrade(f.maintenanceDb)).toMatchObject({applied:false,ready:true});expect(await snapshot(f.maintenanceDb)).toEqual(before);
    for(const result of[await auditRuntimeBusinessPrivileges(f.appRuntime.db,'app',f.target,undefined,f.peers,f.appReaders),
      await auditRuntimeBusinessPrivileges(f.adminRuntime.db,'admin',f.target,undefined,f.peers),
      await auditCustomerFinancialRuntimePrivileges(f.financialRuntime.db,f.target,f.manual,f.readers),
      await auditManagerRuntimePrivileges(f.managerRuntime.db,f.target),
      await auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db,f.cashierRuntime.role,f.target,{abandon:true,conditionalGuards:true,formImages:true})])
      expect(result).toMatchObject({ready:true,failures:[]});
  },90000);

  it.each(['default','column_acl','extra_index','weak_subject'] as const)('refuses %s drift without repairs and preserves the installed catalog after rollback',async fault=>{
    expect(await inspectRoutineVirtualShippingSubjects(f.maintenanceDb,names())).toMatchObject({ready:true,state:'virtual17',failures:[]});
    const before=await snapshot(f.maintenanceDb);
    await expect(f.maintenanceDb.transaction(async tx=>{
      if(fault==='default')await tx.execute(sql`ALTER TABLE public.order_notification_delivery ALTER COLUMN subject_id SET DEFAULT 1`);
      if(fault==='column_acl')await tx.execute(sql`GRANT SELECT(subject_domain) ON public.order_notification_delivery TO ${sql.identifier(f.adminRuntime.role)}`);
      if(fault==='extra_index')await tx.execute(sql`CREATE INDEX ond_virtual_unknown ON public.order_notification_delivery(subject_id)`);
      if(fault==='weak_subject'){await tx.execute(sql`ALTER TABLE public.order_notification_delivery DROP CONSTRAINT ond_subject_ck`);await tx.execute(sql`ALTER TABLE public.order_notification_delivery ADD CONSTRAINT ond_subject_ck CHECK(true)`);}
      const changed=await snapshot(tx);expect((await inspectRoutineVirtualShippingSubjects(tx,names())).ready).toBe(false);
      expect((await inspectCustomerFinancialRuntimePrivileges(tx,{requireLogin:true,routine:{target:f.target,stage:'ready'},
        manualRefund:f.manual,originalPaymentReaders:f.readers})).ready).toBe(false);
      expect((await inspectCustomerCashierSecondCardRuntimePrivileges(tx,{role:f.cashierRuntime.role,requireLogin:true,
        routine:{target:f.target,stage:'ready'},abandon:true,conditionalGuards:true,formImages:true})).ready).toBe(false);
      await expect(tx.transaction(inner=>runRoutineVirtualShippingSubjectsUpgradeInTransaction(inner,f.target,f.peers,f.appReaders))).rejects.toThrow();
      expect(await snapshot(tx)).toEqual(changed);throw Error('Owned virtual subject drift rollback');
    })).rejects.toThrow('Owned virtual subject drift rollback');expect(await snapshot(f.maintenanceDb)).toEqual(before);
  },90000);

  it('refuses actual App TEMP source shadowing and fresh RC/RO while retaining allowed RR/RO historical reads',async()=>{
    await expect(f.appRuntime.db.transaction(async tx=>{await tx.execute(sql`CREATE TEMP TABLE order_notification_delivery(id integer) ON COMMIT DROP`);
      await expect(assertRoutineVirtualShippingSubjectsReadTx(tx)).rejects.toMatchObject({code:503});throw Error('Owned temporary subject shadow rollback');
    })).rejects.toThrow('Owned temporary subject shadow rollback');
    await expect(f.appRuntime.db.transaction(tx=>assertRoutineVirtualShippingSubjectsStageTx(tx),{accessMode:'read only'})).rejects.toMatchObject({code:503});
    expect(await f.appRuntime.db.transaction(tx=>assertRoutineVirtualShippingSubjectsReadTx(tx),{isolationLevel:'repeatable read',accessMode:'read only'})).toBe(true);
    expect(network).not.toHaveBeenCalled();
  },90000);
});
