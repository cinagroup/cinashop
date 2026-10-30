import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import {
  SUPPLIER_PRODUCT_LABEL_CAPABILITY_FUNCTION, SUPPLIER_PRODUCT_LABEL_CAPABILITY_SIGNATURE,
  supplierProductLabelCapabilityBody, supplierProductLabelOwnerGrantSql,
  inspectSupplierProductLabelCapability, inspectSupplierProductLabelOwner,
} from '@/migrations/supplierProductLabelCapability';
import { financePostgres, ownsFinanceFixtureEndpoint, ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './financePostgres';
import type { SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';

export type SupplierLabelCapabilityPeer = SequenceRunnerPeer & { role: string; connectionString: string };
const rolePattern = /^cinashop_runtime_[a-f0-9]{32}$/;
const readTables = ['category','store_product_label','store_product_relation','store_product','system_admin','system_supplier','system_role','system_menus','system_log'];

/** Deliberately narrower than the commissioned current whole-shop App. This
 * regression fixture keeps category UPDATE(id) only, preserves the old tests'
 * no-category-name-write assertion, and installs the actual canonical label
 * capability. Whole-current-profile proof belongs to the new runtime suite.
 * PG16 is mandatory: no PGlite version claim, mock inspector or old service. */
export async function createSupplierProductLabelCapabilityFixture(tables: PgTable[]) {
  const rawUrl=process.env.TEST_FINANCE_POSTGRES_URL;
  if (!rawUrl) throw Error('Legacy Supplier label capability regression requires actual owned PG16');
  const base=validateFinanceFixtureUrl(rawUrl);
  const f=await financePostgres(tables,{namespace:'public'});
  const app=`cinashop_runtime_${randomUUID().replaceAll('-','')}`,owner=`cinashop_runtime_${randomUUID().replaceAll('-','')}`;
  const appPassword=randomUUID().replaceAll('-','');
  let appCreated=false,ownerCreated=false;
  let client:ReturnType<typeof postgres>|undefined;
  let closePromise:Promise<void>|undefined;
  const peers=new Set<ReturnType<typeof postgres>>();
  const temporaryRoles=new Set<string>();
  let database='';
  const targetUrl=new URL(base.href);
  const owned=()=>{
    if (!ownsFinanceFixtureTarget(database,'public',base.href)) throw Error('Supplier label fixture target is no longer owned');
  };
  const dropRole=async(role:string)=>{
    owned(); if (!rolePattern.test(role)) throw Error('Unsafe Supplier label fixture role cleanup');
    await f.exec(`DROP OWNED BY ${pricingIdentifier(role)}; DROP ROLE ${pricingIdentifier(role)}`);
    const rows=await f.db.execute(sql`SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${role}`);
    if (rows.length) throw Error('Supplier label fixture role cleanup not confirmed');
  };
  const options={max:1,prepare:false,connect_timeout:5,idle_timeout:0,max_lifetime:0,
    connection:{options:'-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=15000'}};
  async function verify(connection:ReturnType<typeof postgres>,role:string):Promise<number>{
    owned();
    const [identity]=await connection`SELECT current_database() AS database,current_user AS role,session_user AS session,
      pg_backend_pid() AS pid,current_setting('server_version_num')::integer AS version,
      host(inet_server_addr()) AS host,inet_server_port() AS port`;
    if(identity.database!==database||identity.role!==role||identity.session!==role||Math.floor(Number(identity.version)/10000)!==16
      ||!Number.isSafeInteger(identity.pid)||!ownsFinanceFixtureEndpoint(database,'public',base.href,identity.host,identity.port))
      throw Error('Supplier label fixture independent LOGIN identity mismatch');
    return Number(identity.pid);
  }
  async function close(){
    closePromise??=(async()=>{
      const failures:unknown[]=[];
      for(const active of peers){try{await active.end({timeout:1});}catch(error){failures.push(error);}}
      peers.clear();
      try{await client?.end({timeout:1});}catch(error){failures.push(error);}
      for(const role of temporaryRoles){try{await dropRole(role);}catch(error){failures.push(error);}}
      temporaryRoles.clear();
      if(appCreated){try{await dropRole(app);appCreated=false;}catch(error){failures.push(error);}}
      if(ownerCreated){try{await dropRole(owner);ownerCreated=false;}catch(error){failures.push(error);}}
      try{await f.close();}catch(error){failures.push(error);}
      if(failures.length)throw new AggregateError(failures,'Supplier label fixture cleanup failed');
    })();
    return closePromise;
  }
  try{
    const [origin]=await f.db.execute(sql`SELECT current_database() AS database,current_user AS role,current_setting('server_version_num')::integer AS version`);
    database=String(origin.database);
    owned();
    if(origin.role!=='finance_test'||Math.floor(Number(origin.version)/10000)!==16)throw Error('Actual owned PG16 maintenance fixture required');
    targetUrl.pathname=`/${database}`;
    await f.exec(`CREATE ROLE ${pricingIdentifier(app)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${appPassword}'`);appCreated=true;
    await f.exec(`CREATE ROLE ${pricingIdentifier(owner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);ownerCreated=true;
    if(!await inspectSupplierProductLabelOwner(f.db,owner,false))throw Error('Supplier label fixture owner is not empty/restricted');
    const appName=pricingIdentifier(app),ownerName=pricingIdentifier(owner);
    await f.exec(`GRANT CONNECT ON DATABASE ${pricingIdentifier(database)} TO ${appName}; GRANT USAGE ON SCHEMA public TO ${appName}`);
    await f.exec(`GRANT SELECT ON ${readTables.map(t=>`public.${pricingIdentifier(t)}`).join(',')} TO ${appName}`);
    for(const table of ['category','system_admin','system_supplier','system_role','system_menus','store_product_label','store_product_relation'])
      await f.exec(`GRANT UPDATE(id) ON public.${pricingIdentifier(table)} TO ${appName}`);
    await f.exec(`GRANT UPDATE(store_label_id) ON public.store_product TO ${appName}; GRANT INSERT,DELETE ON public.store_product_relation TO ${appName}; GRANT USAGE ON SEQUENCE public.store_product_relation_id_seq TO ${appName}`);
    // Explicit test-only installation of the same production SQL and exact
    // owner grants. No production installer/current-profile acceptance claim.
    await f.db.transaction(async tx=>{
      for(const grant of supplierProductLabelOwnerGrantSql(owner))await tx.execute(sql.raw(grant));
      await tx.execute(sql.raw(`GRANT USAGE,CREATE ON SCHEMA public TO ${ownerName}`));
      await tx.execute(sql.raw(`CREATE FUNCTION public.${SUPPLIER_PRODUCT_LABEL_CAPABILITY_FUNCTION}(p_context jsonb,p_operation text,p_id integer,p_expected jsonb,p_payload jsonb)
        RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $supplier_label_regression$${supplierProductLabelCapabilityBody(app)}$supplier_label_regression$`));
      await tx.execute(sql.raw(`REVOKE ALL ON FUNCTION ${SUPPLIER_PRODUCT_LABEL_CAPABILITY_SIGNATURE} FROM PUBLIC; ALTER FUNCTION ${SUPPLIER_PRODUCT_LABEL_CAPABILITY_SIGNATURE} OWNER TO ${ownerName}; REVOKE CREATE ON SCHEMA public FROM ${ownerName}; GRANT EXECUTE ON FUNCTION ${SUPPLIER_PRODUCT_LABEL_CAPABILITY_SIGNATURE} TO ${appName}`));
      const state=await inspectSupplierProductLabelCapability(tx);
      if(!state.ready||state.appRole!==app||state.ownerRole!==owner)throw Error(`Narrow Supplier label canonical capability verification failed: ${JSON.stringify(state)}`);
    });
    const appUrl=new URL(targetUrl.href);appUrl.username=app;appUrl.password=appPassword;
    const connectionString=appUrl.href;
    client=postgres(connectionString,options);
    const primary=client,pid=await verify(primary,app);
    const peer:SupplierLabelCapabilityPeer={db:drizzle(primary) as unknown as DbClient,role:app,connectionString,pid,
      exec:async statement=>Array.from(await primary.unsafe(statement))};
    async function withPeer<T>(run:(other:SequenceRunnerPeer)=>Promise<T>):Promise<T>{
      const other=postgres(connectionString,options);peers.add(other);
      try{
        const otherPid=await verify(other,app);if(otherPid===pid)throw Error('Supplier label peers share a backend');
        const result=await run({db:drizzle(other) as unknown as DbClient,pid:otherPid,exec:async statement=>Array.from(await other.unsafe(statement))});
        if(await verify(other,app)!==otherPid)throw Error('Supplier label peer unexpectedly reconnected');
        return result;
      }finally{await other.end({timeout:1});peers.delete(other);}
    }
    async function withBusiness<T>(write:boolean,run:(business:SupplierLabelCapabilityPeer)=>Promise<T>):Promise<T>{
      if(write){const result=await run(peer);if(await verify(primary,app)!==pid)throw Error('Supplier label App unexpectedly reconnected');return result;}
      // Original negative: SELECT-only reader cannot obtain authority row locks
      // before write admission. Missing UPDATE(id) gives real42501; no fake SQL.
      const role=`cinashop_runtime_${randomUUID().replaceAll('-','')}`,password=randomUUID().replaceAll('-','');
      await f.exec(`CREATE ROLE ${pricingIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);temporaryRoles.add(role);
      let reader:ReturnType<typeof postgres>|undefined;
      try{
        await f.exec(`GRANT CONNECT ON DATABASE ${pricingIdentifier(database)} TO ${pricingIdentifier(role)}; GRANT USAGE ON SCHEMA public TO ${pricingIdentifier(role)}; GRANT SELECT ON ${readTables.map(t=>`public.${pricingIdentifier(t)}`).join(',')} TO ${pricingIdentifier(role)}`);
        const url=new URL(targetUrl.href);url.username=role;url.password=password;reader=postgres(url.href,options);peers.add(reader);
        const actual=reader,readerPid=await verify(actual,role);
        const result=await run({db:drizzle(actual) as unknown as DbClient,role,connectionString:url.href,pid:readerPid,
          exec:async statement=>Array.from(await actual.unsafe(statement))});
        if(await verify(actual,role)!==readerPid)throw Error('Supplier label reader unexpectedly reconnected');return result;
      }finally{
        if(reader){await reader.end({timeout:1});peers.delete(reader);}
        await dropRole(role);temporaryRoles.delete(role);
      }
    }
    return {...f,format:'pg16' as const,container:createContainerFromDb(peer.db),withPeer,withBusiness,close};
  }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Supplier label setup and cleanup failed');}throw error;}
}
