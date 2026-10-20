import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { inspectRuntimeBusinessProfileInTransaction } from '@/migrations/auditRuntimeBusinessPrivileges';
import { runPurchasePhysicalOriginRuntimeUpgrade,installPurchasePhysicalOriginRuntimeUpgradeInTransaction }
  from '@/migrations/runPurchasePhysicalOriginRuntimeUpgrade';
import { runPurchaseCancellationEvidence,runPurchaseCancellationEvidenceSchema } from '@/migrations/runPurchaseCancellationEvidence';
import { runPurchaseOriginEvidenceSchema } from '@/migrations/runPurchaseOriginEvidence';
import { runPurchasePhysicalOriginEvidenceSchema } from '@/migrations/runPurchasePhysicalOriginEvidence';
import { runPurchaseCancellationGiftEvidence,inspectPurchaseCancellationGiftEvidence } from '@/migrations/runPurchaseCancellationGiftEvidence';
import { MigrationService } from '@/services/MigrationService';
import { createContainerFromDb } from '@/lib/di';
import type { SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

type Peer=SequenceRunnerPeer & {role:string};
type Target={database:string;maintenance:string;app:string;admin:string};
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('physical origin fixed runtime privilege forward',()=>{
  let f:Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async()=>{f=await refundRuntimeFixture();},60000);
  afterEach(async()=>{await f?.close();},45000);
  const catalog=()=>f.exec(`SELECT 'relation' AS kind,oid::text AS id,relname AS name,relowner::text AS owner,relacl::text AS acl
    FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'routine',oid::text,proname,proowner::text,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace
    UNION ALL SELECT 'trigger',oid::text,tgname,tgrelid::text,pg_get_triggerdef(oid) FROM pg_trigger
      WHERE tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
    ORDER BY kind,id`);
  const profile=(peer:Peer,kind:'app'|'admin',target:Target,version:'current'|'pre-physical-origin')=>
    peer.db.transaction(tx=>inspectRuntimeBusinessProfileInTransaction(tx,kind,target,version),{accessMode:'read only'});
  async function roles(run:(app:Peer,admin:Peer,target:Target)=>Promise<void>,frozen=true){
    await f.withRuntimeRole!(app=>f.withRuntimeRole!(async admin=>{
      const [identity]=await f.exec('SELECT current_database() AS database');
      const target={database:String(identity.database),maintenance:'finance_test',app:app.role,admin:admin.role};
      await runRuntimeBusinessCommissioning(f.db,{...target,pricingOwner:f.pricingOwner});
      if(frozen)await f.exec(`REVOKE SELECT,INSERT ON public.store_order_purchase_physical_origin FROM "${app.role}"`);
      await run(app,admin,target);
    }));
  }
  it('grants only app SELECT/INSERT and preserves every other object, row and historical profile',async()=>{
    await roles(async(app,admin,target)=>{
      for(const [peer,kind] of [[app,'app'],[admin,'admin']] as const)
        expect(await profile(peer,kind,target,'pre-physical-origin')).toMatchObject({ready:true,tableCount:283});
      expect(await profile(app,'app',target,'current')).toMatchObject({ready:false});
      const before=await catalog(),rows=await f.state();
      expect(await runPurchasePhysicalOriginRuntimeUpgrade(f.db,target)).toMatchObject({applied:true,profileStage:'current'});
      const after=await catalog();
      expect(after.filter(row=>row.name!=='store_order_purchase_physical_origin')).toEqual(before.filter(row=>row.name!=='store_order_purchase_physical_origin'));
      const old=before.find(row=>row.kind==='relation' && row.name==='store_order_purchase_physical_origin');
      const now=after.find(row=>row.kind==='relation' && row.name==='store_order_purchase_physical_origin');
      expect({...now,acl:old?.acl}).toEqual(old);expect(now?.acl).not.toEqual(old?.acl);expect(await f.state()).toEqual(rows);
      for(const [peer,kind] of [[app,'app'],[admin,'admin']] as const)expect(await profile(peer,kind,target,'current')).toMatchObject({ready:true});
      expect(await app.exec(`SELECT has_table_privilege(current_user,'store_order_purchase_physical_origin','SELECT') AS read,
        has_table_privilege(current_user,'store_order_purchase_physical_origin','INSERT') AS capture,
        has_table_privilege(current_user,'store_order_purchase_physical_origin','UPDATE,DELETE,TRUNCATE') AS rewrite,
        has_function_privilege(current_user,'public.capture_purchase_physical_origin_v1()','EXECUTE') AS execute`))
        .toEqual([{read:true,capture:true,rewrite:false,execute:false}]);
      expect(await admin.exec(`SELECT has_table_privilege(current_user,'store_order_purchase_physical_origin','SELECT,INSERT') AS access`)).toEqual([{access:false}]);
      expect(await runPurchasePhysicalOriginRuntimeUpgrade(f.db,target)).toMatchObject({applied:false});
      expect(await catalog()).toEqual(after);expect(await f.state()).toEqual(rows);
    });
  },60000);
  it('rolls back the sole grant with its caller transaction',async()=>{
    await roles(async(app,_admin,target)=>{
      const before=await catalog();
      await expect(f.db.transaction(async tx=>{await installPurchasePhysicalOriginRuntimeUpgradeInTransaction(tx,target);throw Error('abort physical forward');}))
        .rejects.toThrow('abort physical forward');
      expect(await catalog()).toEqual(before);expect(await profile(app,'app',target,'pre-physical-origin')).toMatchObject({ready:true});
    });
  },60000);
  it('refuses extra grants and canonical drift without repairing or granting',async()=>{
    await roles(async(app,_admin,target)=>{
      await f.exec(`GRANT DELETE ON public.store_order_purchase_physical_origin TO "${app.role}"`);const before=await catalog();
      await expect(runPurchasePhysicalOriginRuntimeUpgrade(f.db,target)).rejects.toThrow();expect(await catalog()).toEqual(before);
    });
  },60000);
  it('rejects runtime callers and read-only maintenance transactions without ACL changes',async()=>{
    await roles(async(app,_admin,target)=>{
      const before=await catalog();
      await expect(runPurchasePhysicalOriginRuntimeUpgrade(app.db,target)).rejects.toThrow();
      await expect(f.db.transaction(tx=>installPurchasePhysicalOriginRuntimeUpgradeInTransaction(tx,target),{accessMode:'read only'})).rejects.toThrow();
      expect(await catalog()).toEqual(before);
    });
  },60000);
  it('refuses historical bootstrap replay and replays exact standalone physical/cancellation forwards',async()=>{
    await roles(async(app,_admin,target)=>{
      await runPurchasePhysicalOriginRuntimeUpgrade(f.db,target);const before=await catalog(),rows=await f.state();
      const expected={executed:[],errors:['Presale outbox already registered; use standalone forward upgrades, not runAll']};
      const service=new MigrationService(createContainerFromDb(f.db));
      expect(await service.runAll()).toEqual(expected);expect(await service.runAll()).toEqual(expected);
      // The bootstrap contains older narrowing CHECKs and must never run again
      // once presale outbox is installed. Only exact standalone forwards replay.
      expect(await catalog()).toEqual(before);expect(await f.state()).toEqual(rows);
      for(let replay=0;replay<2;replay++){
        await runPurchaseOriginEvidenceSchema(f.db);
        await runPurchaseCancellationEvidenceSchema(f.db);
        await runPurchaseCancellationGiftEvidence(f.db);
        await runPurchasePhysicalOriginEvidenceSchema(f.db);
        await runPurchaseCancellationEvidence(f.db,app.role);
      }
      expect(await inspectPurchaseCancellationGiftEvidence(f.db)).toMatchObject({state:'physical-v1',sourcesReady:true});
      expect(await catalog()).toEqual(before);expect(await f.state()).toEqual(rows);
    });
  },60000);
});
