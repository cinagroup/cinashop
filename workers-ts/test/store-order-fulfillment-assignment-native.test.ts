/** Formal PG16 storage/privilege commissioning only. Inserted rows are
 * explicitly structural specimens, not Admin-authored assignments, checkout,
 * payment or Manager fulfillment evidence. No business producer is opened. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { financeNativePostgres } from './helpers/financePostgres';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from '@/migrations/customerRuntimeGiftPeers';
import {
  captureStoreOrderFulfillmentAssignmentsAddon, inspectStoreOrderFulfillmentAssignment,
  STORE_ORDER_FULFILLMENT_ASSIGNMENT_SQL, STORE_ORDER_FULFILLMENT_ASSIGNMENT_CATALOG_SQL,
  STORE_ORDER_FULFILLMENT_ASSIGNMENT_CATALOG_SHA256, STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE,
} from '@/migrations/storeOrderFulfillmentAssignment';
import { upgradeStoreOrderFulfillmentAssignments, upgradeStoreOrderFulfillmentAssignmentsInTransaction } from '@/migrations/upgradeStoreOrderFulfillmentAssignments';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { auditCustomerFinancialRuntimePrivileges } from '@/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges } from '@/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import { auditManagerRuntimePrivileges } from '@/migrations/auditManagerRuntimePrivileges';
import { upgradeFulfillmentCityConflictReaders } from '@/migrations/upgradeFulfillmentCityConflictReaders';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineRefundUpgrade } from '@/migrations/runRoutineRefundUpgrade';
import { upgradeCustomerFinancialRoutineRefund } from '@/migrations/upgradeCustomerFinancialRoutineRefund';
import { upgradeRoutineRefundActors } from '@/migrations/upgradeRoutineRefundActors';

type Query=Pick<DbClient,'execute'>;
type Fixture=Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
const addon={assignments:true} as const;
const hex='a'.repeat(64);
const native=Boolean(process.env.TEST_FINANCE_POSTGRES_URL);

it.runIf(native)('pins the complete canonical assignment storage shape in owned PG16',async()=>{
  const f=await financeNativePostgres([],process.env.TEST_FINANCE_POSTGRES_URL!,{namespace:'public'});
  try{
    await f.db.execute(sql.raw(STORE_ORDER_FULFILLMENT_ASSIGNMENT_SQL));
    const [row]=await f.db.execute<{shape:unknown}>(sql.raw(STORE_ORDER_FULFILLMENT_ASSIGNMENT_CATALOG_SQL));
    const hash=await outRequestHash(row.shape);
    console.log('assignment canonical PG16 SHA256',hash);
    console.log('assignment canonical PG16 shape',JSON.stringify(row.shape));
    expect(hash).toBe(STORE_ORDER_FULFILLMENT_ASSIGNMENT_CATALOG_SHA256);
  }finally{await f.close();}
});

describe.runIf(native)('formal store fulfillment assignment storage successor',()=>{
  let f:Fixture,peers:RuntimeGiftPeerDeclarations,other:string;
  let network:ReturnType<typeof vi.spyOn<typeof globalThis,'fetch'>>;
  const desired=():RuntimeGiftPeerDeclarations=>({...peers,fulfillmentAssignments:{...addon}});
  const named=()=>({maintenance:f.target.maintenance,admin:f.target.admin});
  const targetIdentity=()=>({database:f.target.database,maintenance:f.target.maintenance,app:f.target.app,admin:f.target.admin,
    ...(f.target.local?{local:[...f.target.local]}:{}),
    ...(f.target.caseLock?{caseLock:{owner:f.target.caseLock.owner,runtimeRoles:[...f.target.caseLock.runtimeRoles]}}:{})});
  async function snapshot(db:Query){
    const [row]=await db.execute<{value:unknown}>(sql`SELECT pg_catalog.jsonb_build_object(
      'relations',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c.oid::text,c.relname,c.relowner::text,c.relacl::text,c.reloptions,c.relchecks) ORDER BY c.oid)
        FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace),
      'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.attrelid::text,a.attnum,a.attname,a.atttypid::text,a.atttypmod,a.attacl::text,a.attisdropped) ORDER BY a.attrelid,a.attnum)
        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attnum>0),
      'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(k.oid::text,k.conname,pg_catalog.pg_get_constraintdef(k.oid,false)) ORDER BY k.oid)
        FROM pg_catalog.pg_constraint k WHERE k.connamespace='public'::regnamespace),
      'functions',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(p.oid::text,p.proname,p.proowner::text,p.proacl::text,pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))) ORDER BY p.oid)
        FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind<>'a'),
      'defaults',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid) FROM pg_catalog.pg_default_acl d)
    ) AS value`);
    return row.value;
  }
  async function refusedWithoutRepair(change:(tx:Query)=>Promise<unknown>){
    const before=await snapshot(f.maintenanceDb);
    await expect(f.maintenanceDb.transaction(async tx=>{
      await change(tx);const changed=await snapshot(tx);
      await expect(tx.transaction(inner=>upgradeStoreOrderFulfillmentAssignmentsInTransaction(inner,f.target,addon,desired(),f.appReaders))).rejects.toThrow();
      expect(await snapshot(tx)).toEqual(changed);
      throw Error('owned assignment drift rollback');
    })).rejects.toThrow('owned assignment drift rollback');
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  }
  async function hold(lock:(tx:Query)=>Promise<unknown>,work:()=>Promise<void>){
    await f.withMaintenancePeer(async peer=>{
      let ready!:()=>void,release!:()=>void;
      const acquired=new Promise<void>(resolve=>{ready=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
      const held=peer.transaction(async tx=>{await lock(tx);ready();await released;});
      try{await Promise.race([acquired,held.then(()=>{throw Error('Owned assignment holder exited early');})]);await work();}
      finally{release();await held;}
    });
  }
  beforeAll(async()=>{
    network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No provider transport in assignment storage acceptance'));
    f=await customerCashierRuntimeHttpFixture();peers=f.peers;other=(await f.createOwnedRole('assignother',true)).role;
    const pids=await Promise.all([f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime].map(p=>p.verify()));
    expect(new Set(pids).size).toBe(5);
  },180000);
  afterAll(async()=>{try{if(f)await f.close();}finally{network?.mockRestore();}},30000);

  it('captures only data declarations and rejects incomplete five-role intent before SQL',async()=>{
    let getters=0;
    for(const input of [{},{assignments:false},{assignments:new Boolean(true)},{assignments:true,extra:1},[],
      {get assignments(){getters++;return true;}}])
      expect(()=>captureStoreOrderFulfillmentAssignmentsAddon(input as typeof addon)).toThrow();
    expect(getters).toBe(0);
    const before=await snapshot(f.maintenanceDb);
    const getterPeers={...peers,get fulfillmentAssignments(){getters++;return addon;}};
    expect(()=>captureRuntimeGiftPeerDeclarations(getterPeers)).toThrow();expect(getters).toBe(0);
    for(const bad of [peers,{...desired(),manager:undefined},{...desired(),financial:undefined},
      {...desired(),cashierSecondCard:undefined}])
      await expect(upgradeStoreOrderFulfillmentAssignments(f.maintenanceDb,f.target,addon,bad,f.appReaders)).rejects.toThrow();
    await expect(upgradeStoreOrderFulfillmentAssignments(f.maintenanceDb,f.target,
      {get assignments(){getters++;return true;}} as typeof addon,desired(),f.appReaders)).rejects.toThrow();
    const getterTarget={...f.target,get deployment(){getters++;return 'untrusted';}};
    await expect(upgradeStoreOrderFulfillmentAssignments(f.maintenanceDb,getterTarget,addon,desired(),f.appReaders)).rejects.toThrow();
    expect(getters).toBe(0);
    expect(await inspectStoreOrderFulfillmentAssignment(f.maintenanceDb,named())).toMatchObject({present:false,ready:false});
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  });

  it('rolls fresh complete DDL and grants back with its caller without business mutations',async()=>{
    const before=await snapshot(f.maintenanceDb),facts=await f.facts();
    await expect(f.maintenanceDb.transaction(async tx=>{
      expect((await upgradeStoreOrderFulfillmentAssignmentsInTransaction(tx,f.target,addon,desired(),f.appReaders)).applied).toBe(true);
      expect(await inspectStoreOrderFulfillmentAssignment(tx,named())).toMatchObject({present:true,ready:true});
      throw Error('owned assignment complete rollback');
    })).rejects.toThrow('owned assignment complete rollback');
    expect(await snapshot(f.maintenanceDb)).toEqual(before);expect(await f.facts()).toEqual(facts);
  },90000);

  it('rejects partial namespace state without completing or repairing it',async()=>{
    await refusedWithoutRepair(tx=>tx.execute(sql`CREATE TYPE public.store_order_fulfillment_assignment AS ENUM('partial')`));
  });

  it('snapshots intent before first await and installs precisely Admin append plus Manager read',async()=>{
    const target={...structuredClone(f.target),metadata:'not_authority'},input:{assignments:true}={...addon},wanted=structuredClone(desired()),expected=captureRuntimeGiftPeerDeclarations(structuredClone(wanted)),reader=structuredClone(f.appReaders);
    const facts=await f.facts(),pending=upgradeStoreOrderFulfillmentAssignments(f.maintenanceDb,target,input,wanted,reader);
    target.database='mutated_after_call';Reflect.set(input,'assignments',false);wanted.target.local=[];
    delete wanted.fulfillmentAssignments;Reflect.set(reader,'cashierOrigin',false);
    const result=await pending;expect(result.applied).toBe(true);expect(result.target).toEqual(targetIdentity());
    expect(Object.hasOwn(result.target,'metadata')).toBe(false);expect(Object.hasOwn(result.target,'pricingOwner')).toBe(false);
    expect(result.peers).toEqual(expected);peers=result.peers;
    const installed=await inspectStoreOrderFulfillmentAssignment(f.maintenanceDb,named());
    expect(installed).toMatchObject({present:true,ready:true,binding:{database:f.database,maintenance:f.target.maintenance,admin:f.target.admin,manager:f.managerRuntime.role}});
    expect(await f.facts()).toEqual(facts);
    for(const audit of [
      await auditRuntimeBusinessPrivileges(f.appRuntime.db,'app',f.target,undefined,peers,f.appReaders),
      await auditRuntimeBusinessPrivileges(f.adminRuntime.db,'admin',f.target,undefined,peers),
      await auditCustomerFinancialRuntimePrivileges(f.financialRuntime.db,f.target,f.manual,f.readers),
      await auditManagerRuntimePrivileges(f.managerRuntime.db,f.target,undefined,undefined,addon),
      await auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db,f.cashierRuntime.role,f.target,{abandon:true,conditionalGuards:true,formImages:true}),
    ])expect(audit).toMatchObject({ready:true,failures:[]});
  },90000);

  it('treats exact repeat as read-only and refuses undeclared installed successors',async()=>{
    const before=await snapshot(f.maintenanceDb),facts=await f.facts();
    expect((await upgradeStoreOrderFulfillmentAssignments(f.maintenanceDb,f.target,addon,peers,f.appReaders)).applied).toBe(false);
    expect(await snapshot(f.maintenanceDb)).toEqual(before);expect(await f.facts()).toEqual(facts);
    const {fulfillmentAssignments:_,...old}=peers;
    for(const audit of [
      await auditRuntimeBusinessPrivileges(f.appRuntime.db,'app',f.target,undefined,old,f.appReaders),
      await auditRuntimeBusinessPrivileges(f.adminRuntime.db,'admin',f.target,undefined,old),
      await auditManagerRuntimePrivileges(f.managerRuntime.db,f.target),
    ])expect(audit.ready).toBe(false);
  },90000);

  it('enforces five actual LOGIN ACLs, including column and grant-option denial',async()=>{
    for(const peer of [f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime]){
      const [p]=await f.maintenanceDb.execute<{read:boolean;append:boolean;mutate:boolean;delegate:boolean}>(sql`SELECT
        pg_catalog.has_table_privilege(${peer.role},'public.store_order_fulfillment_assignment','SELECT') AS read,
        pg_catalog.has_table_privilege(${peer.role},'public.store_order_fulfillment_assignment','INSERT') AS append,
        pg_catalog.has_table_privilege(${peer.role},'public.store_order_fulfillment_assignment','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(${peer.role},'public.store_order_fulfillment_assignment','UPDATE,REFERENCES') AS mutate,
        pg_catalog.has_table_privilege(${peer.role},'public.store_order_fulfillment_assignment','SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION') AS delegate`);
      expect(p).toEqual({read:peer===f.adminRuntime||peer===f.managerRuntime,append:peer===f.adminRuntime,mutate:false,delegate:false});
      if(p.read)await peer.db.execute(sql`SELECT * FROM public.store_order_fulfillment_assignment LIMIT 0`);
      else await expect(peer.db.execute(sql`SELECT * FROM public.store_order_fulfillment_assignment LIMIT 0`)).rejects.toMatchObject({cause:{code:'42501'}});
      for(const command of ['UPDATE public.store_order_fulfillment_assignment SET ordinal=ordinal','DELETE FROM public.store_order_fulfillment_assignment WHERE false','TRUNCATE public.store_order_fulfillment_assignment'])
        await expect(peer.db.execute(sql.raw(command))).rejects.toMatchObject({cause:{code:'42501'}});
      if(!p.append)await expect(peer.db.execute(sql`INSERT INTO public.store_order_fulfillment_assignment DEFAULT VALUES`)).rejects.toMatchObject({cause:{code:'42501'}});
    }
  });

  it('preserves immutable structural specimens and rejects forks and financial-store changes',async()=>{
    const id=randomUUID(),source={cart_rows:[{row_id:1,cart_id:'structural-only',product_id:1,unique:'specimen',quantity:1}]};
    const insert=async(tx:Query,operation=id,ordinal=1,previous:string|null=null,financialStore=0)=>tx.execute(sql`INSERT INTO public.store_order_fulfillment_assignment
      (operation_id,format_version,kind,actor_id,root_order_id,order_id,target_store_id,customer_uid,financial_store_id,ordinal,previous_ref,order_revision,payload_hash,source_hash,source)
      VALUES(${operation}::uuid,1,'grant',1,9901,9901,77,11,${financialStore},${ordinal},${previous}::uuid,${hex},${hex},${hex},${JSON.stringify(source)}::jsonb)`);
    // Maintenance exercises the actual immutable trigger; Admin independently
    // exercises the permitted append and its ACL mutation denial.
    for(const db of [f.adminRuntime.db,f.maintenanceDb])await expect(db.transaction(async tx=>{
      await insert(tx);
      await insert(tx,randomUUID(),2,id);
      for(const statement of [sql`UPDATE public.store_order_fulfillment_assignment SET source=source WHERE operation_id=${id}::uuid`,
        sql`DELETE FROM public.store_order_fulfillment_assignment WHERE operation_id=${id}::uuid`,sql`TRUNCATE public.store_order_fulfillment_assignment`])
        await expect(tx.transaction(inner=>inner.execute(statement))).rejects.toMatchObject({cause:{code:'42501'}});
      await expect(tx.transaction(inner=>insert(inner,randomUUID(),2,id))).rejects.toMatchObject({cause:{code:'23505'}});
      await expect(tx.transaction(inner=>insert(inner,randomUUID(),3,id))).rejects.toMatchObject({cause:{code:'23505'}});
      await expect(tx.transaction(inner=>insert(inner,randomUUID(),3,randomUUID(),77))).rejects.toMatchObject({cause:{code:'23514'}});
      for(const invalid of [
        {cart_rows:[]}, {cart_rows:Array.from({length:201},()=>source.cart_rows[0])},
        {...source,phone:'forbidden'}, {cart_rows:[{...source.cart_rows[0],address:'forbidden'}]},
        {cart_rows:[null]}, {cart_rows:[{...source.cart_rows[0],row_id:1.5}]},
        {cart_rows:[{...source.cart_rows[0],cart_id:1}]}, {cart_rows:[{...source.cart_rows[0],quantity:0}]},
        {cart_rows:[{...source.cart_rows[0],unique:'x'.repeat(256)}]},
        {cart_rows:Array.from({length:200},(_,i)=>({...source.cart_rows[0],row_id:i+1,cart_id:'b'.repeat(50),unique:'汉'.repeat(255)}))},
      ])await expect(tx.transaction(inner=>inner.execute(sql`INSERT INTO public.store_order_fulfillment_assignment
        (operation_id,format_version,kind,actor_id,root_order_id,order_id,target_store_id,customer_uid,financial_store_id,ordinal,previous_ref,order_revision,payload_hash,source_hash,source)
        VALUES(${randomUUID()}::uuid,1,'grant',1,9902,9902,77,11,0,1,NULL,${hex},${hex},${hex},${JSON.stringify(invalid)}::jsonb)`))).rejects.toThrow();
      for(const valid of [
        {cart_rows:[{...source.cart_rows[0],unique:''}]},
        {cart_rows:[{...source.cart_rows[0],unique:'x'.repeat(255)}]},
        {cart_rows:Array.from({length:200},(_,i)=>({...source.cart_rows[0],row_id:i+1,cart_id:'cart_'+i}))},
      ])await expect(tx.transaction(async inner=>{
        await inner.execute(sql`INSERT INTO public.store_order_fulfillment_assignment
          (operation_id,format_version,kind,actor_id,root_order_id,order_id,target_store_id,customer_uid,financial_store_id,ordinal,previous_ref,order_revision,payload_hash,source_hash,source)
          VALUES(${randomUUID()}::uuid,1,'grant',1,9902,9902,77,11,0,1,NULL,${hex},${hex},${hex},${JSON.stringify(valid)}::jsonb)`);
        throw Error('positive structural source rollback');
      })).rejects.toThrow('positive structural source rollback');
      const [record]=await tx.execute<{created:string}>(sql`SELECT created_at::text AS created FROM public.store_order_fulfillment_assignment WHERE operation_id=${id}::uuid`);
      expect(Number(record.created)).toBeGreaterThan(0);
      throw Error('owned structural specimens rollback');
    })).rejects.toThrow('owned structural specimens rollback');
    const [count]=await f.maintenanceDb.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM public.store_order_fulfillment_assignment`);expect(count.n).toBe(0);
  });

  it('fails quickly on a busy shared gate and table lock without changes',async()=>{
    const before=await snapshot(f.maintenanceDb);
    await hold(tx=>tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(${STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE[0]},${STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE[1]})`),async()=>{
      await expect(upgradeStoreOrderFulfillmentAssignments(f.maintenanceDb,f.target,addon,peers,f.appReaders)).rejects.toThrow();
    });
    await hold(tx=>tx.execute(sql`LOCK TABLE ONLY public.store_order_fulfillment_assignment IN ACCESS EXCLUSIVE MODE NOWAIT`),async()=>{
      await expect(upgradeStoreOrderFulfillmentAssignments(f.maintenanceDb,f.target,addon,peers,f.appReaders)).rejects.toThrow();
    });
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  },30000);

  it.each([
    ['extra App SELECT',(tx:Query)=>tx.execute(sql`GRANT SELECT ON public.store_order_fulfillment_assignment TO ${sql.identifier(f.appRuntime.role)}`)],
    ['Manager INSERT',(tx:Query)=>tx.execute(sql`GRANT INSERT ON public.store_order_fulfillment_assignment TO ${sql.identifier(f.managerRuntime.role)}`)],
    ['Financial column SELECT',(tx:Query)=>tx.execute(sql`GRANT SELECT(source) ON public.store_order_fulfillment_assignment TO ${sql.identifier(f.financialRuntime.role)}`)],
    ['grant option',(tx:Query)=>tx.execute(sql`GRANT SELECT ON public.store_order_fulfillment_assignment TO ${sql.identifier(f.adminRuntime.role)} WITH GRANT OPTION`)],
    ['owner replacement',(tx:Query)=>tx.execute(sql`ALTER TABLE public.store_order_fulfillment_assignment OWNER TO ${sql.identifier(other)}`)],
    ['RLS',(tx:Query)=>tx.execute(sql`ALTER TABLE public.store_order_fulfillment_assignment ENABLE ROW LEVEL SECURITY`)],
    ['function flags',(tx:Query)=>tx.execute(sql`ALTER FUNCTION public.store_order_fulfillment_assignment_immutable_v1() COST 101`)],
    ['PUBLIC function grant',(tx:Query)=>tx.execute(sql`GRANT EXECUTE ON FUNCTION public.store_order_fulfillment_assignment_immutable_v1() TO PUBLIC`)],
    ['disabled immutable trigger',(tx:Query)=>tx.execute(sql`ALTER TABLE public.store_order_fulfillment_assignment DISABLE TRIGGER sofa_immutable_rows`)],
    ['missing source check',(tx:Query)=>tx.execute(sql`ALTER TABLE public.store_order_fulfillment_assignment DROP CONSTRAINT sofa_source_ck`)],
    ['index addition',(tx:Query)=>tx.execute(sql`CREATE INDEX assignment_extra_index ON public.store_order_fulfillment_assignment(actor_id)`)],
    ['unrelated namespace object',(tx:Query)=>tx.execute(sql`CREATE TABLE public.store_order_fulfillment_assignment_shadow(id integer)`)],
  ] as const)('refuses %s drift without repairing it',async(_label,change)=>{await refusedWithoutRepair(change);});

  it('binds actual maintenance LOGIN, database, isolation and origin rather than SET ROLE',async()=>{
    const before=await snapshot(f.maintenanceDb);
    for(const db of [f.appRuntime.db,f.adminRuntime.db,f.financialRuntime.db,f.managerRuntime.db,f.cashierRuntime.db])
      await expect(upgradeStoreOrderFulfillmentAssignments(db,f.target,addon,peers,f.appReaders)).rejects.toThrow();
    await expect(f.maintenanceDb.transaction(async tx=>{
      await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.adminRuntime.role)}`);
      return upgradeStoreOrderFulfillmentAssignmentsInTransaction(tx,f.target,addon,peers,f.appReaders);
    })).rejects.toThrow();
    await expect(f.maintenanceDb.transaction(async tx=>{
      await tx.execute(sql`SET LOCAL session_replication_role=replica`);
      return upgradeStoreOrderFulfillmentAssignmentsInTransaction(tx,f.target,addon,peers,f.appReaders);
    })).rejects.toThrow();
    await expect(upgradeStoreOrderFulfillmentAssignments(f.maintenanceDb,{...f.target,database:'wrong_fixture_database'},addon,peers,f.appReaders)).rejects.toThrow();
    const wrong={...f.target,database:'wrong_fixture_database'};
    await expect(upgradeStoreOrderFulfillmentAssignments(f.maintenanceDb,wrong,addon,{...peers,target:wrong},f.appReaders)).rejects.toThrow();
    await expect(f.maintenanceDb.transaction(tx=>upgradeStoreOrderFulfillmentAssignmentsInTransaction(tx,f.target,addon,peers,f.appReaders),{isolationLevel:'repeatable read',accessMode:'read only'})).rejects.toThrow();
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  });

  it('keeps catalog metadata independent of TEMP shadows and retains old forward repeats',async()=>{
    const installed=await inspectStoreOrderFulfillmentAssignment(f.maintenanceDb,named());
    await f.maintenanceDb.transaction(async tx=>{
      await tx.execute(sql`CREATE TEMP TABLE pg_class(fake integer) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE store_order_fulfillment_assignment(fake integer) ON COMMIT DROP`);
      await tx.execute(sql`SET LOCAL search_path=pg_temp,pg_catalog`);
      expect(await inspectStoreOrderFulfillmentAssignment(tx,named())).toEqual(installed);
    });
    const owner=(await f.createOwnedRole('assigncity')).role,city={owner,app:true,admin:true,manager:true} as const;
    const after={...peers,cityConflictReaders:city};
    expect((await upgradeFulfillmentCityConflictReaders(f.maintenanceDb,f.target,{readers:city},after,f.appReaders)).applied).toBe(true);
    peers=after;
    expect((await upgradeStoreOrderFulfillmentAssignments(f.maintenanceDb,f.target,addon,peers,f.appReaders)).applied).toBe(false);
    const before=await snapshot(f.maintenanceDb);
    expect((await upgradeFulfillmentCityConflictReaders(f.maintenanceDb,f.target,{readers:city},peers,f.appReaders)).applied).toBe(false);
    expect(await snapshot(f.maintenanceDb)).toEqual(before);expect(network).not.toHaveBeenCalled();
  },90000);

  it('retains the explicit refund actor forward after assignment and city successors',async()=>{
    await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb,f.target,peers,f.appReaders);
    await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb,f.target,peers,f.appReaders);
    await runRoutineRefundUpgrade(f.maintenanceDb,f.target,peers,f.appReaders);
    const financial=await upgradeCustomerFinancialRoutineRefund(f.maintenanceDb,f.target,
      {routineRefund:{routineRefund:true},manualRefund:f.manual,originalPaymentReaders:f.readers},peers,f.appReaders);
    peers=financial.peers;
    const actors={admin:true,manager:true} as const,after={...peers,routineRefundActors:actors};
    const first=await upgradeRoutineRefundActors(f.maintenanceDb,f.target,{actors},after,f.appReaders);
    expect(first.applied).toBe(true);peers=first.peers;
    const before=await snapshot(f.maintenanceDb),facts=await f.facts();
    expect((await upgradeRoutineRefundActors(f.maintenanceDb,f.target,{actors},peers,f.appReaders)).applied).toBe(false);
    expect((await upgradeStoreOrderFulfillmentAssignments(f.maintenanceDb,f.target,addon,peers,f.appReaders)).applied).toBe(false);
    expect(await snapshot(f.maintenanceDb)).toEqual(before);expect(await f.facts()).toEqual(facts);
    expect(network).not.toHaveBeenCalled();
  },90000);
});
