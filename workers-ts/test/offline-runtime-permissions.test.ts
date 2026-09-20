import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { spawnSync } from 'node:child_process';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { runOfflineOrderSchema, runOfflineOrder } from '../src/migrations/runOfflineOrder';
import { auditOfflineOrderRuntimePermissions as audit } from '../src/migrations/auditOfflineOrderRuntimePermissions';
import { offlineRuntimeGrantPlan, OFFLINE_RUNTIME_READ_TABLES, OFFLINE_RUNTIME_INSERT_TABLES,
  OFFLINE_RUNTIME_UPDATE_TABLES, OFFLINE_RUNTIME_UPDATE_COLUMNS, OFFLINE_RUNTIME_SEQUENCES } from '../src/migrations/offlineOrderRuntimeContract';

describe('offline actual runtime permission envelope PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string;
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Owned native PG16 required');
    const kit = await import('drizzle-kit/api'), models = await import('../src/models/schema');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}),kit.generateDrizzleJson(models))).join('\n');
  },30000);
  beforeEach(async () => { f=await sequenceRunnerDatabase(); await f.exec(ddl); await runOfflineOrderSchema(f.db,true); },30000);
  afterEach(async () => { await f?.close(); },30000);
  const snapshot = () => f.db.execute(sql`SELECT 'relation' AS kind,oid::text,to_jsonb(c)::text AS value FROM pg_class c WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,to_jsonb(p)::text FROM pg_proc p WHERE pronamespace='public'::regnamespace ORDER BY kind,oid`);
  it('distinguishes protocol-only grants from real connection readiness and never writes or runs pricing',async()=>{
    await f.withRuntimeRole!(async r=>{
      await runOfflineOrder(f.db,r.role);
      expect(await audit(r.db)).toMatchObject({ready:false,checks:{protectedCatalogVerified:true,requiredTablePrivileges:false,requiredSequenceUsage:false}});
      await f.exec(offlineRuntimeGrantPlan(r.role));
      const before=await snapshot();
      const result=await audit(r.db);
      expect(result).toMatchObject({scope:'offline-cashier-collection-v1',ready:true,readOnly:true,completeApplicationVerified:false,businessDataVerified:false,failures:[]});
      expect(Object.values(result.checks).every(Boolean)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(r.role);
      expect(await snapshot()).toEqual(before);
      // Pricing would request SHARE locks. A concurrent writer proves the audit
      // reads metadata only and does not invoke the permitted definer capability.
      await f.withPeer!(async peer=>{
        await peer.exec('BEGIN; LOCK TABLE public.member_right IN ROW EXCLUSIVE MODE');
        try { expect((await audit(r.db)).ready).toBe(true); } finally { await peer.exec('ROLLBACK'); }
      });
    });
  });
  it('finds every missing declared table, column, sequence and function right',async()=>{
    await f.withRuntimeRole!(async r=>{
      await f.exec(offlineRuntimeGrantPlan(r.role));
      const required: Array<[string,string]> = [
        ...OFFLINE_RUNTIME_READ_TABLES.map(n=>['SELECT ON public."'+n+'"','requiredTablePrivileges'] as [string,string]),
        ...OFFLINE_RUNTIME_INSERT_TABLES.map(n=>['INSERT ON public."'+n+'"','requiredTablePrivileges'] as [string,string]),
        ...OFFLINE_RUNTIME_UPDATE_TABLES.map(n=>['UPDATE ON public."'+n+'"','requiredTablePrivileges'] as [string,string]),
        ...Object.entries(OFFLINE_RUNTIME_UPDATE_COLUMNS).flatMap(([table,names])=>names.map(n=>['UPDATE('+n+') ON public."'+table+'"','requiredColumnPrivileges'] as [string,string])),
        ...OFFLINE_RUNTIME_SEQUENCES.map(([n])=>['USAGE ON SEQUENCE public.'+n,'requiredSequenceUsage'] as [string,string]),
        ['EXECUTE ON FUNCTION public.ooa_lock_pricing()','requiredFunctionExecute'],
      ];
      for(const [privilege,check] of required){
        await f.exec('REVOKE '+privilege+' FROM "'+r.role+'"');
        const result=await audit(r.db);
        expect(result.ready,privilege).toBe(false); expect(result.failures,privilege).toContain(check);
        await f.exec('GRANT '+privilege+' TO "'+r.role+'"');
      }
      expect((await audit(r.db)).ready).toBe(true);
    });
  },120000);
  const threats = [
    ['GRANT TRIGGER ON public.other_order_status TO ROLE','noTriggerOrTruncate'],
    ['GRANT TRUNCATE ON public.user_money TO ROLE','noTriggerOrTruncate'],
    ['GRANT DELETE ON public.offline_order_admission TO ROLE','noLedgerRewrite'],
    ['GRANT UPDATE(case_id) ON public.offline_order_payment_dispatch TO ROLE','noLedgerRewrite'],
    ['GRANT UPDATE ON SEQUENCE public.other_order_id_seq TO ROLE','noSequenceReset'],
    ['GRANT SELECT ON public.user_bill TO ROLE WITH GRANT OPTION','noGrantDelegation'],
    ['GRANT UPDATE(now_money) ON public."user" TO ROLE WITH GRANT OPTION','noGrantDelegation'],
    ['GRANT USAGE ON SEQUENCE public.user_money_id_seq TO ROLE WITH GRANT OPTION','noGrantDelegation'],
    ['GRANT EXECUTE ON FUNCTION public.ooa_lock_pricing() TO ROLE WITH GRANT OPTION','noGrantDelegation'],
    ['GRANT SET ON PARAMETER session_replication_role TO ROLE','noReplicationBypass'],
    ['GRANT ALTER SYSTEM ON PARAMETER session_replication_role TO ROLE','noReplicationBypass'],
    ['GRANT CREATE ON SCHEMA public TO ROLE','noSchemaCreation'],
    ['ALTER TABLE public.payment_callback_outbox ENABLE ROW LEVEL SECURITY','objectsPresentAndUnrestricted'],
    ['ALTER SEQUENCE public.user_money_id_seq OWNED BY NONE','sequenceBindingsVerified'],
    ['ALTER FUNCTION public.ooa_lock_pricing() RESET search_path','protectedCatalogVerified'],
    ['ALTER TABLE public.offline_order_balance DISABLE TRIGGER USER','protectedCatalogVerified'],
    ['ALTER TABLE public.offline_order_payment_selection DROP CONSTRAINT oops_rail_ck','protectedCatalogVerified'],
  ];
  it.each(threats)('refuses unsafe or drifted runtime configuration: %s',async(statement,check)=>{
    await f.withRuntimeRole!(async r=>{
      await f.exec(offlineRuntimeGrantPlan(r.role));
      const mutation=statement.replaceAll('ROLE','"'+r.role+'"');
      await f.exec(mutation); const before=await snapshot();
      try { const result=await audit(r.db); expect(result.ready).toBe(false); expect(result.failures).toContain(check); expect(await snapshot()).toEqual(before); }
      finally { if(statement.includes('ON PARAMETER')) await f.exec('REVOKE '+(statement.includes('ALTER SYSTEM')?'ALTER SYSTEM':'SET')+' ON PARAMETER session_replication_role FROM "'+r.role+'"'); }
    });
  });
  it('rejects missing protocol or shared objects without installing or repairing them',async()=>{
    await f.withRuntimeRole!(async r=>{
      await f.exec(offlineRuntimeGrantPlan(r.role));
      for(const table of ['offline_order_admission','other_order_status']){
        await f.exec('ALTER TABLE public.'+table+' RENAME TO hidden_runtime_table');
        const before=await snapshot();
        expect((await audit(r.db)).ready).toBe(false); expect(await snapshot()).toEqual(before);
        await f.exec('ALTER TABLE public.hidden_runtime_table RENAME TO '+table);
      }
    });
  });
  it('rejects role switches and SET SESSION AUTHORIZATION that hide the real connection authority',async()=>{
    await f.withRuntimeRole!(async r=>{
      await f.exec(offlineRuntimeGrantPlan(r.role));
      for(const statement of ['SET ROLE "'+r.role+'"','SET SESSION AUTHORIZATION "'+r.role+'"']){
        await f.withPeer!(async peer=>{
          await peer.exec(statement);
          try { const result=await audit(peer.db); expect(result.ready).toBe(false); expect(result.failures).toContain('unprivilegedReachableRoles'); expect(result.failures).toContain('noOwnerControl'); }
          finally { await peer.exec('RESET SESSION AUTHORIZATION; RESET ROLE'); }
        });
      }
      expect((await audit(r.db)).ready).toBe(true);
    });
  });
  it.each(['SET','INHERIT','ADMIN'])('rejects transitive %s authority despite a restricted LOGIN',async mode=>{
    await f.withRuntimeRole!(async r=>{ await f.withRuntimeRole!(async elevated=>{
      await f.exec(offlineRuntimeGrantPlan(r.role));
      await f.exec('GRANT UPDATE ON SEQUENCE public.user_money_id_seq TO "'+elevated.role+'"');
      await f.exec('GRANT "'+elevated.role+'" TO "'+r.role+'" WITH INHERIT '+(mode==='INHERIT'?'TRUE':'FALSE')+', SET '+(mode==='SET'?'TRUE':'FALSE')+', ADMIN '+(mode==='ADMIN'?'TRUE':'FALSE'));
      try { const result=await audit(r.db); expect(result.ready).toBe(false); expect(result.failures).toContain('noSequenceReset'); if(mode==='ADMIN') expect(result.failures).toContain('noGrantDelegation'); }
      finally { await f.exec('REVOKE "'+elevated.role+'" FROM "'+r.role+'"'); }
    }); });
  });
  it('rejects PUBLIC and extra-schema definer capabilities without invoking them',async()=>{
    await f.withRuntimeRole!(async r=>{
      await f.exec(offlineRuntimeGrantPlan(r.role));
      await f.exec("CREATE SCHEMA runtime_audit_probe; CREATE TABLE runtime_audit_probe.calls(id integer); CREATE FUNCTION runtime_audit_probe.unsafe() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ INSERT INTO runtime_audit_probe.calls VALUES(1) $$; GRANT USAGE ON SCHEMA runtime_audit_probe TO PUBLIC");
      const report=await audit(r.db);
      expect(report.ready).toBe(false); expect(report.failures).toContain('noUnreviewedDefinerRoutine');
      expect(await f.exec('SELECT * FROM runtime_audit_probe.calls')).toEqual([]);
    });
  });
  it.each(['SET','ADMIN'])('rejects mixed %s then INHERIT role paths',async mode=>{
    await f.withRuntimeRole!(async r=>{ await f.withRuntimeRole!(async middle=>{ await f.withRuntimeRole!(async elevated=>{
      await f.exec(offlineRuntimeGrantPlan(r.role));
      await f.exec('GRANT UPDATE ON SEQUENCE public.user_money_id_seq TO "'+elevated.role+'"');
      await f.exec('GRANT "'+elevated.role+'" TO "'+middle.role+'" WITH INHERIT TRUE, SET FALSE, ADMIN FALSE');
      await f.exec('GRANT "'+middle.role+'" TO "'+r.role+'" WITH INHERIT FALSE, SET '+(mode==='SET'?'TRUE':'FALSE')+', ADMIN '+(mode==='ADMIN'?'TRUE':'FALSE'));
      try {
        const [direct]=await r.db.execute(sql`SELECT pg_has_role(current_user,${elevated.role},'USAGE') AS usage,pg_has_role(current_user,${elevated.role},'SET') AS switch`);
        expect(direct).toEqual({usage:false,switch:false});
        // Neither direct role predicate sees the endpoint. Inspect the effective
        // inherited ACLs of each switchable/admin-reachable intermediate role.
        if(mode==='SET') {
          await r.exec('SET ROLE "'+middle.role+'"');
          try { expect(await r.exec("SELECT has_sequence_privilege(current_user,'public.user_money_id_seq','UPDATE') AS allowed")).toEqual([{allowed:true}]); }
          finally { await r.exec('RESET ROLE'); }
        }
        const result=await audit(r.db);
        expect(result.ready).toBe(false);expect(result.failures).toContain('noSequenceReset');
      } finally {
        await f.exec('REVOKE "'+middle.role+'" FROM "'+r.role+'"');
        await f.exec('REVOKE "'+elevated.role+'" FROM "'+middle.role+'"');
      }
    }); }); });
  });
  it('never mistakes a maintenance owner for the runtime and preserves caller session settings',async()=>{
    expect((await audit(f.db)).ready).toBe(false);
    await f.withRuntimeRole!(async r=>{
      await f.exec(offlineRuntimeGrantPlan(r.role));
      await r.exec("SET search_path=pg_catalog,public; SET statement_timeout=4000; SET lock_timeout=100; SET idle_in_transaction_session_timeout=1000");
      const settings=()=>r.exec("SELECT name,setting FROM pg_settings WHERE name IN('search_path','row_security','statement_timeout','lock_timeout','idle_in_transaction_session_timeout') ORDER BY name");
      const before=await settings(); expect((await audit(r.db)).ready).toBe(true); expect(await settings()).toEqual(before);
      await r.db.transaction(async tx=>{ await expect(audit(tx)).rejects.toThrow('root database'); });
    });
  });
  it('audits the explicit runtime CLI with exact identity, remote opt-in and sanitized output',async()=>{
    const [identity]=await f.db.execute(sql`SELECT current_database() AS name`);
    if(typeof identity.name!=='string'||!/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(identity.name))throw Error('Not owned database');
    await f.withRuntimeRole!(async r=>{
      const run=(args:string[],target=r.connectionString)=>spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/audit-offline-runtime-permissions.ts',...args],
        {encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,OFFLINE_RUNTIME_AUDIT_DATABASE_URL:target,OFFLINE_RUNTIME_AUDIT_ALLOW_REMOTE:''}});
      const before=await snapshot(),missing=run([identity.name as string,r.role]); expect(missing.status).toBe(1); expect(JSON.parse(missing.stdout).ready).toBe(false); expect(await snapshot()).toEqual(before);
      await f.exec(offlineRuntimeGrantPlan(r.role));
      const pass=run([identity.name as string,r.role]); expect(pass.status,pass.stderr).toBe(0); expect(JSON.parse(pass.stdout).ready).toBe(true);
      const remote=new URL(r.connectionString);remote.hostname='production.example';
      for(const failure of [run(['wrong-database',r.role]),run([identity.name as string,'wrong_role']),run([identity.name as string,r.role,'--install']),run([identity.name as string,r.role],r.connectionString+'?sslmode=disable'),run([identity.name as string,r.role],remote.href),run([identity.name as string,r.role],'')]){
        expect(failure.error).toBeUndefined();expect(failure.status).toBe(2);expect(failure.stdout).toBe('');expect(failure.stderr).toBe('Offline runtime audit could not complete. No grants, migrations or business writes were performed.\n');
      }
      for(const output of [missing,pass]){expect(output.stdout+output.stderr).not.toContain(r.role);expect(output.stdout+output.stderr).not.toContain(r.connectionString);}
    });
  },120000);
});
