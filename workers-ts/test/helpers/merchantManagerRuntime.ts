import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import type { DbClient } from '@/lib/di';
import { managerRuntimePrivilegePlan } from '@/migrations/managerRuntimePrivilegePlan';
import { installManagerScopeLock } from '@/migrations/runManagerScopeLock';
import { installManagerRuntimeCapabilities } from '@/migrations/managerRuntimeCapabilities';
import { ownsFinanceFixtureEndpoint, ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './financePostgres';

const identifier=(value:string)=>{if(!/^[a-z_][a-z_0-9]*$/.test(value))throw Error('Invalid owned merchant runtime identifier');return `"${value}"`;};
export interface MerchantRuntimeOptions {
  installScopeLocks?:boolean;
  /** Explicitly install a reviewed lock-only protocol in this new owned DB.
   * No generic privilege repair and no caller-supplied production connection. */
  installLockProtocol?:(owner:DbClient,role:string)=>Promise<void|(()=>Promise<void>)>;
}
/** Independent LOGIN, not SET ROLE on a maintenance session. Grants are the
 * fixed manager profile for this fixture's present tables. This subset cannot
 * replace the complete production role audit or service verification. */
export async function createMerchantManagerRuntime(owner:DbClient,tables:PgTable[],options:MerchantRuntimeOptions={}) {
  const base=validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL??'');
  const [origin]=await owner.execute<{database:string;schema:string;role:string;session:string;version:string;host:string;port:number}>(sql`SELECT current_database() AS database,current_schema() AS schema,current_user AS role,session_user AS session,current_setting('server_version_num') AS version,host(inet_server_addr()) AS host,inet_server_port() AS port`);
  if(!origin||origin.schema!=='public'||origin.role!=='finance_test'||origin.session!==origin.role||Math.floor(Number(origin.version)/10000)!==16||!ownsFinanceFixtureTarget(origin.database,origin.schema,base.href)||!ownsFinanceFixtureEndpoint(origin.database,origin.schema,base.href,origin.host,origin.port))throw Error('Merchant runtime requires the registered owned native PG16 fixture');
  const role=`merchant_runtime_${crypto.randomUUID().replaceAll('-','')}`,password=crypto.randomUUID().replaceAll('-','');identifier(role);identifier(origin.database);
  const execute=(statement:string)=>owner.execute(sql.raw(statement));
  const target=new URL(base.href);target.pathname=`/${origin.database}`;target.username=role;target.password=password;
  let created=false,client:ReturnType<typeof postgres>|undefined,protocolCleanup:void|(()=>Promise<void>)=undefined,closed:Promise<void>|undefined;
  const verifyOwner=async()=>{const [row]=await owner.execute<{database:string;role:string}>(sql`SELECT current_database() AS database,current_user AS role`);if(row?.database!==origin.database||row.role!==origin.role)throw Error('Owned merchant cleanup target changed');};
  const verify=async(connection:ReturnType<typeof postgres>)=>{const [row]=await connection`SELECT current_database() AS database,current_user AS role,session_user AS session,current_setting('server_version_num') AS version,pg_backend_pid() AS pid,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated`;if(row.database!==origin.database||row.role!==role||row.session!==role||row.version!==origin.version||row.elevated!==false)throw Error('Independent merchant LOGIN identity changed');return Number(row.pid);};
  const connect=()=>postgres(target.href,{max:1,prepare:false,connect_timeout:5,idle_timeout:0,max_lifetime:0,connection:{options:'-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=2000'}});
  const close=()=>closed??=(async()=>{await client?.end({timeout:5});await verifyOwner();if(protocolCleanup)await protocolCleanup();if(created){await execute(`DROP OWNED BY ${identifier(role)}`);await execute(`DROP ROLE ${identifier(role)}`);const rows=await owner.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${role}`);if(rows.length)throw Error('Owned merchant runtime role cleanup not confirmed');created=false;}})();
  try {
    await execute(`CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);created=true;
    await execute(`GRANT CONNECT ON DATABASE ${identifier(origin.database)} TO ${identifier(role)}`);await execute(`GRANT USAGE ON SCHEMA public TO ${identifier(role)}`);
    if(options.installScopeLocks&&options.installLockProtocol)throw Error('Choose one explicit owned lock-protocol installation');
    if(options.installScopeLocks){
      const scopeOwner=`merchant_scope_${crypto.randomUUID().replaceAll('-','')}`;identifier(scopeOwner);
      await execute(`CREATE ROLE ${identifier(scopeOwner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      protocolCleanup=async()=>{await verifyOwner();await execute(`DROP OWNED BY ${identifier(scopeOwner)}`);await execute(`DROP ROLE ${identifier(scopeOwner)}`);const rows=await owner.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${scopeOwner}`);if(rows.length)throw Error('Owned merchant scope role cleanup not confirmed');};
      await installManagerScopeLock(owner,scopeOwner,'public');
      await execute(`GRANT EXECUTE ON FUNCTION public.manager_lock_scope_v1(integer,integer),public.manager_lock_carrier_v1(text) TO ${identifier(role)}`);
    }else protocolCleanup=await options.installLockProtocol?.(owner,role);
    const [relations]=await owner.execute(sql`SELECT to_regclass('public.order_waybill_job') IS NOT NULL AS waybill,to_regclass('public.store_order_promotions') IS NOT NULL AS promotion`);
    if(relations?.waybill===true){
      const previousCleanup=protocolCleanup,waybillOwner=`manager_waybill_${crypto.randomUUID().replaceAll('-','')}`;
      const [manual]=await owner.execute<{name:string}>(sql`SELECT r.rolname AS name FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.pronamespace='public'::regnamespace AND p.proname='customer_manual_refund_promotion_delete_v1'`);
      const promotionOwner=relations.promotion===true?(manual?.name??`manager_promotion_${crypto.randomUUID().replaceAll('-','')}`):undefined;
      const createdOwners:string[]=[];
      protocolCleanup=async()=>{
        await verifyOwner();
        if(manual&&promotionOwner)await execute('DROP FUNCTION IF EXISTS public.manager_delete_order_promotions_v1(integer,jsonb)');
        for(const name of createdOwners){await execute(`DROP OWNED BY ${identifier(name)}`);await execute(`DROP ROLE ${identifier(name)}`);}
        if(previousCleanup)await previousCleanup();
      };
      for(const name of [waybillOwner,...(promotionOwner&&!manual?[promotionOwner]:[])]){
        await execute(`CREATE ROLE ${identifier(name)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);createdOwners.push(name);
      }
      await owner.transaction(tx=>installManagerRuntimeCapabilities(tx,{waybillOwner,promotionOwner}),{isolationLevel:'read committed',accessMode:'read write'});
      await execute(`GRANT EXECUTE ON FUNCTION public.manager_lock_waybill_v1(),public.manager_lock_delivery_agents_v1(integer,integer) TO ${identifier(role)}`);
      if(promotionOwner)await execute(`GRANT EXECUTE ON FUNCTION public.manager_delete_order_promotions_v1(integer,jsonb) TO ${identifier(role)}`);
    }
    const plan=managerRuntimePrivilegePlan();
    // Fixtures contain unrelated App/Admin tables. Only the fixed manager
    // profile's present subset is granted here; production audit requires all.
    for(const table of tables){const definition=getTableConfig(table),name=definition.name,privileges=plan.tables[name];if(!privileges)continue;if(!privileges.includes('SELECT'))throw Error(`Manager profile cannot read fixture table ${name}`);await execute(`GRANT ${privileges.join(',')} ON public.${identifier(name)} TO ${identifier(role)}`);const columns=plan.updateColumns[name];if(columns?.length)await execute(`GRANT UPDATE(${columns.map(identifier).join(',')}) ON public.${identifier(name)} TO ${identifier(role)}`);if(privileges.includes('INSERT'))for(const column of definition.columns)if(['serial','bigserial'].includes(column.getSQLType())){const rows=await owner.execute<{name:string}>(sql`SELECT pg_get_serial_sequence(${`public.${name}`},${column.name}) AS name`);const parts=rows[0]?.name?.split('.');if(parts?.length!==2||parts[0]!=='public')throw Error('Unexpected owned merchant sequence');await execute(`GRANT USAGE ON SEQUENCE public.${identifier(parts[1])} TO ${identifier(role)}`);}}
    await execute(`GRANT SELECT,INSERT ON public.manager_order_operation_request TO ${identifier(role)}`);
    client=connect();await verify(client);const database=drizzle(client) as unknown as DbClient;
    return{db:database,role,connectionString:target.href,close,withPeer:async<T>(callback:(db:DbClient,pid:number)=>Promise<T>)=>{const peer=connect();try{const pid=await verify(peer),result=await callback(drizzle(peer) as unknown as DbClient,pid);if(await verify(peer)!==pid)throw Error('Merchant runtime peer reconnected');return result;}finally{await peer.end({timeout:5});}}};
  } catch(error) {await close();throw error;}
}
