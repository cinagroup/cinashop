/** Source catalog/ACL fixture only. Structural history specimens prove no
 * payment signature, account approval, business author or provider operation. */
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DbClient } from '@/lib/di';
import { userRecharge } from '@/models/schema';
import { runRechargeRefundInstallation, type RechargeRefundBinding } from '@/migrations/rechargeRefund';
import { runRechargeRefundRuntimeCommission } from '@/migrations/rechargeRefundRuntimeCommission';
import { ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_SQL, inspectRoutineOriginalPaymentEvidenceCatalog } from '@/migrations/routineOriginalPaymentEvidence';
import { ROUTINE_PAYMENT_ACCOUNT_POLICY_SQL, inspectRoutinePaymentAccountPolicyCatalog } from '@/migrations/routinePaymentAccountPolicy';
import { financePostgres, validateFinanceFixtureUrl, ownsFinanceFixtureEndpoint } from './financePostgres';
import { ownsSequenceRunnerEndpoint } from './kefuSequenceRunnerDatabase';

export const rechargeRefundSourceTables=['routine_original_payment_evidence','routine_payment_account_policy','routine_payment_account_use'] as const;
const kinds=['app','admin','financial','manager'] as const;
type Kind=typeof kinds[number];
export interface SourceReaderLogin {db:DbClient;role:string;oid:string;pid:number;exec(statement:string):Promise<unknown>}
interface SourceReaderSeed {owner:DbClient;exec(statement:string):Promise<unknown>;close():Promise<void>;
 app:{db:DbClient;role:string};sourcesInstalled:true}
const ownedRole=/^rcfs_(app|admin|financial|manager)_[a-f0-9]{32}$/;
const ident=(value:string)=>{if(!/^[a-z_][a-z0-9_]{0,62}$/.test(value))throw Error('Unsafe source fixture identifier');return '"'+value+'"';};
const options={max:1,prepare:false,connect_timeout:5,idle_timeout:0,max_lifetime:0,
 connection:{options:'-c search_path=public,pg_temp -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000'}};

export async function rechargeRefundSourceReaderFixture(seed?:SourceReaderSeed) {
 const base=validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL??'');
 const fresh=seed?undefined:await financePostgres([userRecharge],{namespace:'public'});
 const owner=seed?.owner??fresh!.db,exec=seed?.exec??fresh!.exec,baseClose=seed?.close??fresh!.close;
 const clients:Array<ReturnType<typeof postgres>>=[],owned:Array<{role:string;oid:string}>=[],peers={} as Record<Kind,SourceReaderLogin>;
 let closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{
  const errors:unknown[]=[];
  for(const client of clients)try{await client.end({timeout:5});}catch(error){errors.push(error);}
  for(const role of [...owned].reverse())try{
   if(!ownedRole.test(role.role))throw Error('Unsafe source fixture role cleanup');
   const rows=await owner.execute<{oid:string}>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=${role.role}`);
   if(rows.length!==1||rows[0].oid!==role.oid)throw Error('Source fixture cleanup OID changed');
   await exec('DROP OWNED BY '+ident(role.role)+';DROP ROLE '+ident(role.role));
   if((await owner.execute(sql`SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${role.role}`)).length)throw Error('Source fixture role cleanup unconfirmed');
  }catch(error){errors.push(error);}
  try{await baseClose();}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,'Source reader fixture cleanup failed');
 })();
 try {
  const [origin]=await owner.execute<{database:string;databaseOid:string;role:string;oid:string;pid:number;host:string;port:number;ready:boolean}>(sql`SELECT
   current_database() AS database,(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS "databaseOid",
   current_user AS role,(SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS oid,pg_backend_pid() AS pid,
   host(inet_server_addr()) AS host,inet_server_port() AS port,current_user=session_user AND current_user='finance_test'
   AND current_schema()='public' AND current_setting('server_version_num')::integer/10000=16 AS ready`);
  if(origin?.ready!==true||!(ownsFinanceFixtureEndpoint(origin.database,'public',base.href,origin.host,origin.port)
   ||ownsSequenceRunnerEndpoint(origin.database,'public',base.href,origin.host,origin.port)))throw Error('Registered owned source PG16 fixture required');
  const verify=async(db:DbClient,role:string)=>{
   const [r]=await db.execute<{role:string;session:string;oid:string;pid:number;ready:boolean}>(sql`SELECT current_user AS role,session_user AS session,
    (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS oid,pg_backend_pid() AS pid,
    current_database()=${origin.database} AND host(inet_server_addr())=${origin.host} AND inet_server_port()=${origin.port}
    AND current_setting('server_version_num')::integer/10000=16 AS ready`);
   if(r?.ready!==true||r.role!==role||r.session!==role||!Number.isSafeInteger(r.pid))throw Error('Actual source LOGIN/endpoint differs');
   return r;
  };
  for(const kind of kinds) {
   if(kind==='app'&&seed) {
    const r=await verify(seed.app.db,seed.app.role);
    peers.app={...seed.app,oid:r.oid,pid:r.pid,exec:s=>seed.app.db.execute(sql.raw(s))};continue;
   }
   const role='rcfs_'+kind+'_'+randomUUID().replaceAll('-',''),password=randomUUID().replaceAll('-','');
   await exec('CREATE ROLE '+ident(role)+" LOGIN PASSWORD '"+password+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS");
   const [created]=await owner.execute<{oid:string}>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=${role}`);
   if(!created)throw Error('Owned source role creation unconfirmed');owned.push({role,oid:created.oid});
   await exec('GRANT CONNECT ON DATABASE '+ident(origin.database)+' TO '+ident(role)+';GRANT USAGE ON SCHEMA public TO '+ident(role));
   const target=new URL(base.href);target.pathname='/'+origin.database;target.username=role;target.password=password;
   const client=postgres(target.href,options);clients.push(client);const db=drizzle(client) as unknown as DbClient,r=await verify(db,role);
   peers[kind]={db,role,oid:r.oid,pid:r.pid,exec:s=>client.unsafe(s)};
  }
  if(new Set([origin.pid,...kinds.map(kind=>peers[kind].pid)]).size!==5)throw Error('Five independent source fixture PIDs required');
  await runRechargeRefundInstallation(owner);
  const binding:RechargeRefundBinding={database:origin.database,databaseOid:origin.databaseOid,maintenance:origin.role,maintenanceOid:origin.oid,
   app:peers.app.role,appOid:peers.app.oid,admin:peers.admin.role,adminOid:peers.admin.oid,
   financial:peers.financial.role,financialOid:peers.financial.oid,manager:peers.manager.role,managerOid:peers.manager.oid};
  await runRechargeRefundRuntimeCommission(owner,binding);
  if(!seed) {
   await exec(ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_SQL);await exec(ROUTINE_PAYMENT_ACCOUNT_POLICY_SQL);
   await exec('GRANT SELECT,INSERT ON public.routine_original_payment_evidence,public.routine_payment_account_use TO '+ident(binding.app)+
    ';GRANT SELECT ON public.routine_payment_account_policy TO '+ident(binding.app));
  }
  const catalogs=[await inspectRoutineOriginalPaymentEvidenceCatalog(owner),await inspectRoutinePaymentAccountPolicyCatalog(owner)];
  if(catalogs.some(c=>!c.ready||c.binding?.app!==binding.app||c.binding.appOid!==binding.appOid))throw Error('Real complete App source catalogs required');
  const evidenceId=createHash('sha256').update(randomUUID()).digest('hex'),useId=createHash('sha256').update(randomUUID()).digest('hex');
  await owner.execute(sql`INSERT INTO public.routine_original_payment_evidence VALUES(${evidenceId},'source_catalog_specimen','source_specimen_only',
   'callback',${'specimen:'+randomUUID()},1,'{"specimen":"structural history, not authenticated payment"}'::jsonb,1,${'a'.repeat(64)})`);
  await owner.execute(sql`INSERT INTO public.routine_payment_account_policy VALUES(${randomUUID()}::uuid,'account',${'specimen_'+randomUUID()},1,
   '{"specimen":"structural history, not approved credentials"}'::jsonb,1,${'b'.repeat(64)})`);
  await owner.execute(sql`INSERT INTO public.routine_payment_account_use VALUES(${useId},${evidenceId},
   '{"specimen":"structural history, not provider authority"}'::jsonb,1,${'c'.repeat(64)})`);
  for(const table of rechargeRefundSourceTables)await owner.execute(sql`COMMENT ON TABLE public.${sql.identifier(table)} IS 'retained source catalog specimen'`);
  const resetReaders=async()=>{
   for(const role of [binding.admin,binding.financial,binding.manager])
    await exec('REVOKE ALL ON '+rechargeRefundSourceTables.map(t=>'public.'+ident(t)).join(',')+' FROM '+ident(role)+' CASCADE');
   await exec('REVOKE ALL ON '+rechargeRefundSourceTables.map(t=>'public.'+ident(t)).join(',')+' FROM PUBLIC');
  };
  const withMaintenancePeer=async<T>(run:(db:DbClient)=>Promise<T>)=>{
   const endpoint=new URL(base.href);endpoint.pathname='/'+origin.database;
   const client=postgres(endpoint.href,options),db=drizzle(client) as unknown as DbClient;
   try{await verify(db,origin.role);return await run(db);}finally{await client.end({timeout:5});}
  };
  return {owner,exec,peers,binding,maintenance:{role:origin.role,oid:origin.oid,pid:origin.pid},close,resetReaders,withMaintenancePeer};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Source fixture initialization/cleanup failed');}throw error;}
}
export type RechargeRefundSourceReaderFixture=Awaited<ReturnType<typeof rechargeRefundSourceReaderFixture>>;

/** Entire real catalog/data, including row/catalog xmin. Successful SELECT
 * forward excludes only the old three table ACL/xmin deltas when requested. */
export async function rechargeRefundSourceSnapshot(db:DbClient,includeSourceAcl=true):Promise<string> {
 const [row]=await db.execute<{value:string}>(sql`SELECT pg_catalog.jsonb_build_object(
  'tables',(SELECT jsonb_agg(jsonb_build_object('class',CASE WHEN ${includeSourceAcl} OR c.relname NOT IN
    ('routine_original_payment_evidence','routine_payment_account_policy','routine_payment_account_use')
    THEN to_jsonb(c)||jsonb_build_object('xmin',c.xmin::text) ELSE to_jsonb(c)-'relacl' END,
    'comment',obj_description(c.oid,'pg_class'),
    'columns',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(a),col_description(c.oid,a.attnum)) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0),
    'constraints',(SELECT jsonb_agg(to_jsonb(k) ORDER BY k.oid) FROM pg_constraint k WHERE k.conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.indexrelid) FROM pg_index i WHERE i.indrelid=c.oid),
    'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t WHERE t.tgrelid=c.oid)) ORDER BY c.relname COLLATE "C")
   FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN('routine_original_payment_evidence',
    'routine_payment_account_policy','routine_payment_account_use','recharge_refund_operation','recharge_refund_state','recharge_refund_attempt','recharge_refund_result')),
  'functions',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(p),p.xmin::text,obj_description(p.oid,'pg_proc')) ORDER BY p.proname)
   FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN('routine_original_payment_evidence_immutable_v1',
    'routine_payment_account_immutable_v1','recharge_refund_valid_v1','recharge_refund_guard_v1','recharge_refund_lock_source_v1')),
  'original',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY evidence_id) FROM public.routine_original_payment_evidence t),
  'policy',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY record_id) FROM public.routine_payment_account_policy t),
  'uses',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY use_id) FROM public.routine_payment_account_use t))::text AS value`);
 return row.value;
}

/** Observation/fault injection at the root transaction boundary only. Every
 * actual SQL statement executes unchanged in the real PG16 transaction. No
 * catalog/result/function/guard is mocked; after runs before the real COMMIT. */
export function observeSourceCommissionRoot(owner:DbClient,after?:(tx:DbClient)=>Promise<void>) {
 const statements:string[]=[],dialect=new PgDialect(),transaction=owner.transaction.bind(owner);
 const db=new Proxy(owner,{get(target,key,receiver){
  if(key!=='transaction')return Reflect.get(target,key,receiver);
  return (callback:(tx:DbClient)=>Promise<unknown>,config:Parameters<DbClient['transaction']>[1])=>transaction(async actual=>{
   const tx=actual as unknown as DbClient;
   const observed=new Proxy(tx,{get(inner,field,source){
    if(field!=='execute')return Reflect.get(inner,field,source);
    return (statement:SQL)=>{statements.push(dialect.sqlToQuery(statement).sql);return inner.execute(statement);};
   }});
   const result=await callback(observed);await after?.(tx);return result;
  },config);
 }});
 return {db,statements};
}
