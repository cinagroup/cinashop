import { describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../src/lib/di';
import { sequenceRunnerDatabase,type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { installCustomerWorkScopeLock } from '../src/migrations/runCustomerWorkScopeLock';
import { CUSTOMER_WORK_LOCK_FUNCTIONS } from '../src/migrations/customerWorkRuntimePrivilegePlan';
import { CUSTOMER_FINANCIAL_FUNCTIONS,customerFinancialRuntimePrivilegePlan } from '../src/migrations/customerFinancialRuntimePlan';
import { CUSTOMER_FINANCIAL_OPERATION_CATALOG_SHA256,CUSTOMER_FINANCIAL_OPERATION_CATALOG_SQL,inspectCustomerFinancialOperation,customerFinancialOperationReadiness,runCustomerFinancialOperation } from '../src/migrations/runCustomerFinancialOperation';

type Native=Extract<Awaited<ReturnType<typeof sequenceRunnerDatabase>>,{format:'pg16'}>;
type Peer=SequenceRunnerPeer&{role:string;connectionString:string};
const ident=(value:string)=>{if(!/^[a-z_][a-z_0-9]{0,62}$/.test(value))throw Error('Unsafe owned financial catalog identifier');return`"${value}"`;};
const literal=(value:string)=>`'${value.replaceAll("'","''")}'`;
const json=(value:unknown)=>`${literal(JSON.stringify(value))}::jsonb`;
const hash=(value:string)=>value.repeat(64);
function postgresCode(error:unknown):string|undefined {let next=error;for(let i=0;i<8&&next&&typeof next==='object';i++){const row=next as {code?:unknown;cause?:unknown};if(typeof row.code==='string')return row.code;next=row.cause;}return undefined;}
async function rejectsCode(pending:Promise<unknown>,code:string){let error:unknown;try{await pending;}catch(failure){error=failure;}expect(error).toBeDefined();expect(postgresCode(error)).toBe(code);}
const relations=['user','store_service','express_company','delivery_service','customer_financial_operation_request'];
async function fixture(ledger=true){
 const candidate=await sequenceRunnerDatabase();if(candidate.format!=='pg16'||!candidate.withRuntimeRole){await candidate.close();throw Error('Financial catalog requires native PG16 independent LOGIN');}
 const f=candidate as Native,owner=`cfo_scope_${randomUUID().replaceAll('-','')}`;let ownerCreated=false;
 const close=async()=>{try{if(ownerCreated)await f.exec(`DROP OWNED BY ${ident(owner)}; DROP ROLE ${ident(owner)}`);}finally{await f.close();}};
 try{
  await f.exec(`CREATE TABLE public."user"(uid integer PRIMARY KEY,status integer NOT NULL DEFAULT 1);
   CREATE TABLE public.store_service(id integer PRIMARY KEY,uid integer NOT NULL,online integer NOT NULL DEFAULT 0,customer integer NOT NULL DEFAULT 1);
   CREATE TABLE public.express_company(id integer PRIMARY KEY);
   CREATE TABLE public.delivery_service(id integer PRIMARY KEY,uid integer NOT NULL);
   INSERT INTO public."user"(uid) VALUES(101); INSERT INTO public.store_service(id,uid) VALUES(1,101);
   INSERT INTO public.express_company(id) VALUES(1); INSERT INTO public.delivery_service(id,uid) VALUES(1,102);`);
  await f.exec(`CREATE ROLE ${ident(owner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);ownerCreated=true;
  await installCustomerWorkScopeLock(f.db,owner);if(ledger)await runCustomerFinancialOperation(f.db);
  const app=<T>(callback:(peer:Peer)=>Promise<T>)=>f.withRuntimeRole(async peer=>{
   const plan=customerFinancialRuntimePrivilegePlan();
   for(const table of relations.filter(name=>ledger||name!=='customer_financial_operation_request')){
    const allowed=plan.tables[table];if(!allowed)throw Error('Installed financial relation absent from actual fixed runtime plan');
    if(allowed.length)await f.exec(`GRANT ${allowed.join(',')} ON public.${ident(table)} TO ${ident(peer.role)}`);
    const columns=plan.updateColumns[table];if(columns?.length)await f.exec(`GRANT UPDATE(${columns.map(ident).join(',')}) ON public.${ident(table)} TO ${ident(peer.role)}`);
   }
   for(const signature of [...CUSTOMER_WORK_LOCK_FUNCTIONS,...(ledger?CUSTOMER_FINANCIAL_FUNCTIONS:[])]){
    expect(plan.functions).toContain(signature);await f.exec(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${ident(peer.role)}`);
   }
   const [identity]=await peer.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num')::integer AS version,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated");
   expect(identity).toMatchObject({role:peer.role,session:peer.role,pid:peer.pid,elevated:false});expect(Math.floor(Number(identity.version)/10000)).toBe(16);
   return callback(peer);
  });return{...f,app,close};
 }catch(error){await close();throw error;}
}
async function withFixture(callback:(f:Awaited<ReturnType<typeof fixture>>)=>Promise<void>,ledger=true){const f=await fixture(ledger);try{await callback(f);}finally{await f.close();}}
const decision={apply_type:2,refund_type:0,received:false};
const refundIdentity={refund_id:11,refund_no:'CR101_Original',expected_refund_revision:hash('e'),review_fingerprint:hash('f')};
const payloads:Record<string,unknown>={
 change_price:{price:'12.34'},confirm_offline:{},
 refund_create:{mode:'items',items:[{cart_row_id:7,cart_num:1}],quoted_price:'10.00',refund_price:'5.00',quote_fingerprint:hash('a'),reason:'真实商品退款'},
 refund_return:{...refundIdentity,decision},refund_refuse:{...refundIdentity,decision,reason:'拒绝原因'},
 refund_execute:{...refundIdentity,decision:{apply_type:2,refund_type:5,received:true},refund_price:'5.00'},
 refund_remark:{...refundIdentity,remark:'真实退款备注'},
};
function intent(kind='change_price',payload:unknown=payloads[kind]){return{version:'customer-work-financial-operation-v1',scope_key:hash('a'),order_id:1,expected_order_revision:hash('b'),expected_financial_revision:hash('c'),payload};}
async function validIntent(db:Pick<SequenceRunnerPeer,'exec'>,kind:string,value:unknown){return(await db.exec(`SELECT public.customer_financial_intent_valid_v1(${literal(kind)},${json(value)}) AS valid`))[0].valid;}
async function validEvidence(db:Pick<SequenceRunnerPeer,'exec'>,kind:string,outcome:string,value:unknown,body:unknown=intent(kind)){return(await db.exec(`SELECT public.customer_financial_evidence_valid_v1(${literal(kind)},${literal(outcome)},${json(body)},${json(value)}) AS valid`))[0].valid;}
const outcomes:Record<string,string>={change_price:'price-changed',confirm_offline:'offline-paid',refund_create:'refund-created',refund_return:'return-approved',refund_refuse:'refused',refund_execute:'balance-settled',refund_remark:'refund-remark-saved'};
const evidences:Record<string,unknown>={change_price:{changed:1,verified:true},confirm_offline:{outbox_id:1,verified:true},refund_create:{refund_id:11,refund_no:'CR101_Original',verified:true},refund_return:{refund_id:11,changed:1,verified:true},refund_refuse:{refund_id:11,verified:true},refund_execute:{refund_id:11,verified:true},refund_remark:{refund_id:11,changed:0,verified:true}};
const providerEvidence={refund_id:11,refund_no:'CR101_Original',payment_order_id:1,uid:201,store_id:0,supplier_id:0,provider:'wechat',out_refund_no:'CNSR11',request_amount:500,total_amount:1000,verified:true};
function receiptSql(overrides:Record<string,unknown>={}){
 const kind=String(overrides.kind??'change_price'),body=intent(kind);
 const row:Record<string,unknown>={actor_uid:101,request_key:randomUUID(),request_hash:hash('d'),service_id:1,order_id:1,kind,outcome:outcomes[kind],scope_key:body.scope_key,expected_revision:body.expected_order_revision,expected_financial_revision:body.expected_financial_revision,intent:body,evidence:evidences[kind],...overrides};
 const columns=Object.keys(row);return`INSERT INTO public.customer_financial_operation_request(${columns.map(ident).join(',')}) VALUES(${columns.map(name=>name==='intent'||name==='evidence'?json(row[name]):typeof row[name]==='number'?String(row[name]):literal(String(row[name]))).join(',')})`;
}
const count=async(peer:Pick<SequenceRunnerPeer,'exec'>)=>Number((await peer.exec('SELECT count(*) AS n FROM public.customer_financial_operation_request'))[0].n);

describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('customer financial catalog PG16 independent LOGIN contract',()=>{
 it('measures canonical financial ledger and immutable validator fingerprint from actual PG16',async()=>{
  await withFixture(async f=>{const state=await inspectCustomerFinancialOperation(f.db),[shape]=await f.db.execute<{shape:unknown}>(sql.raw(CUSTOMER_FINANCIAL_OPERATION_CATALOG_SQL));
   expect(state.present).toBe(true);expect(state.fingerprint).toMatch(/^[a-f0-9]{64}$/);
   const [server]=await f.exec("SELECT current_database() AS database,current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version");
   const [columns]=await f.exec("SELECT count(*) AS n FROM pg_attribute WHERE attrelid='public.customer_financial_operation_request'::regclass AND attnum>0 AND NOT attisdropped");expect(Number(columns.n)).toBe(13);
   console.info('CUSTOMER_FINANCIAL_CANONICAL_PG16 '+JSON.stringify({server,fingerprint:state.fingerprint,expected:CUSTOMER_FINANCIAL_OPERATION_CATALOG_SHA256,shape:shape.shape}));
   if(CUSTOMER_FINANCIAL_OPERATION_CATALOG_SHA256.startsWith('uncommissioned-'))expect(state.complete).toBe(false);else{expect(state.fingerprint).toBe(CUSTOMER_FINANCIAL_OPERATION_CATALOG_SHA256);expect(state.complete).toBe(true);}
  });
 },60000);
 it('reports missing installation without commissioning or granting from a runtime read',async()=>{await withFixture(async f=>{await f.app(async peer=>{expect(await customerFinancialOperationReadiness(peer.db)).toMatchObject({ready:false,reason:'customer_financial_operation_not_installed'});expect((await peer.exec("SELECT to_regclass('public.customer_financial_operation_request') AS relation"))[0].relation).toBeNull();});},false);},60000);
 it('accepts an exact append-only runtime and refuses repeated owner installation',async()=>{await withFixture(async f=>{const before=await inspectCustomerFinancialOperation(f.db);expect(before.complete).toBe(true);await expect(runCustomerFinancialOperation(f.db)).rejects.toThrow('Existing');expect(await inspectCustomerFinancialOperation(f.db)).toEqual(before);await f.app(async peer=>{expect(await customerFinancialOperationReadiness(peer.db)).toMatchObject({ready:true,privileges:{read:true,append:true,mutable:false,append_only_acl:true,validator_safe:true,authority_safe:true}});});});},60000);
 it('checks all seven intent payloads and the sorted one-hundred physical-row boundary',async()=>{await withFixture(async f=>{await f.app(async peer=>{
  for(const[kind,payload]of Object.entries(payloads))expect(await validIntent(peer,kind,intent(kind,payload))).toBe(true);
  const hundred={...payloads.refund_create as object,items:Array.from({length:100},(_,i)=>({cart_row_id:i+1,cart_num:1}))};expect(await validIntent(peer,'refund_create',intent('refund_create',hundred))).toBe(true);
  expect(await validIntent(peer,'refund_create',intent('refund_create',{...hundred,items:[...(hundred.items),{cart_row_id:101,cart_num:1}]}))).toBe(false);
  expect(await validIntent(peer,'refund_create',intent('refund_create',{...payloads.refund_create as object,mode:'remaining',items:[]}))).toBe(true);
 });});},60000);
 it('returns false for malformed nested scalar shapes without unguarded JSON operators',async()=>{await withFixture(async f=>{await f.app(async peer=>{
  for(const malformed of [7,true,[],null,'bad']){expect(await validIntent(peer,'refund_return',intent('refund_return',{...refundIdentity,decision:malformed}))).toBe(false);expect(await validIntent(peer,'refund_create',intent('refund_create',{...payloads.refund_create as object,items:[malformed]}))).toBe(false);expect(await validEvidence(peer,'change_price','price-changed',malformed)).toBe(false);}
 });});},60000);
 it('rejects extra fields numeric aliases invalid precision unsorted duplicates and stale-kind shapes',async()=>{await withFixture(async f=>{await f.app(async peer=>{
  for(const body of [{...intent(),order_id:'1'},{...intent(),scope_key:[hash('a')]},{...intent(),unexpected:true},{...intent(),payload:{price:'12.3'}},{...intent(),payload:{price:'012.34'}},{...intent(),payload:{price:12.34}},{...intent(),payload:{price:'12.34',amount:'12.34'}}])expect(await validIntent(peer,'change_price',body)).toBe(false);
  for(const items of [[{cart_row_id:1,cart_num:1},{cart_row_id:1,cart_num:2}],[{cart_row_id:2,cart_num:1},{cart_row_id:1,cart_num:1}],[{cart_id:1,cart_num:1}],[{cart_row_id:1,cart_num:0}],[{cart_row_id:2147483648,cart_num:1}]])expect(await validIntent(peer,'refund_create',intent('refund_create',{...payloads.refund_create as object,items}))).toBe(false);
  expect(await validIntent(peer,'unknown',intent())).toBe(false);
 });});},60000);
 it('enforces Unicode code points canonical whitespace and PostgreSQL NUL handling',async()=>{await withFixture(async f=>{await f.app(async peer=>{
  const payload=(remark:string)=>({...refundIdentity,remark});expect(await validIntent(peer,'refund_remark',intent('refund_remark',payload('😀'.repeat(255))))).toBe(true);
  for(const value of ['😀'.repeat(256),' 空白','空白 ','\u00a0空白','空白\ufeff','内部\u0001控制','内部\u007f控制',''])expect(await validIntent(peer,'refund_remark',intent('refund_remark',payload(value)))).toBe(false);
  await expect(validIntent(peer,'refund_remark',intent('refund_remark',payload('内部\u0000控制')))).rejects.toThrow();expect(await count(peer)).toBe(0);
 });});},60000);
 it('requires received-return evidence and exact creation amount bounds',async()=>{await withFixture(async f=>{await f.app(async peer=>{
  const historical={apply_type:0,refund_type:0,received:false};
  const historicalRefusal=intent('refund_refuse',{...refundIdentity,decision:historical,reason:'历史未分类申请已核对拒绝'});
  expect(await validIntent(peer,'refund_refuse',historicalRefusal)).toBe(true);
  expect(await validEvidence(peer,'refund_refuse','refused',{refund_id:11,verified:true},historicalRefusal)).toBe(true);
  expect(await validIntent(peer,'refund_refuse',intent('refund_refuse',{...refundIdentity,decision:{...historical,apply_type:-1},reason:'实际类型不受支持'}))).toBe(false);
  expect(await validIntent(peer,'refund_return',intent('refund_return',{...refundIdentity,decision:historical}))).toBe(false);
  expect(await validIntent(peer,'refund_execute',intent('refund_execute',{...refundIdentity,decision:historical,refund_price:'5.00'}))).toBe(false);
  expect(await validEvidence(peer,'refund_execute','balance-settled',{refund_id:11,verified:true},intent('refund_execute',{...refundIdentity,decision:historical,refund_price:'5.00'}))).toBe(false);
  expect(await validIntent(peer,'refund_execute',intent('refund_execute',{...payloads.refund_execute as object,decision:{apply_type:2,refund_type:5,received:false}}))).toBe(false);
  expect(await validIntent(peer,'refund_execute',intent('refund_execute',{...payloads.refund_execute as object,decision:{apply_type:3,refund_type:4,received:true}}))).toBe(true);
  expect(await validIntent(peer,'refund_return',intent('refund_return',{...refundIdentity,decision:{apply_type:1,refund_type:0,received:false}}))).toBe(false);
  expect(await validIntent(peer,'refund_create',intent('refund_create',{...payloads.refund_create as object,quoted_price:'4.99',refund_price:'5.00'}))).toBe(false);
 });});},60000);
 it('validates local phase evidence and the exact original provider admission binding',async()=>{await withFixture(async f=>{await f.app(async peer=>{
  for(const kind of Object.keys(payloads))expect(await validEvidence(peer,kind,outcomes[kind],evidences[kind])).toBe(true);
  expect(await validEvidence(peer,'refund_execute','provider-admitted',providerEvidence)).toBe(true);
  for(const kind of Object.keys(payloads)){expect(await validEvidence(peer,kind,'abandoned',{})).toBe(true);expect(await validEvidence(peer,kind,'rollback-rejected',{code:'revoked'})).toBe(true);}
 });});},60000);
 it('rejects fake verified effects wrong phases and provider identity cent overflow or changed amount',async()=>{await withFixture(async f=>{await f.app(async peer=>{
  for(const evidence of [{changed:1,verified:false},{changed:2,verified:true},{changed:'1',verified:true},{changed:1,verified:true,extra:1},{}])expect(await validEvidence(peer,'change_price','price-changed',evidence)).toBe(false);
  expect(await validEvidence(peer,'refund_return','balance-settled',{refund_id:11,verified:true})).toBe(false);
  for(const patch of [{refund_id:12},{refund_no:'OTHER'},{out_refund_no:'CNSR12'},{provider:'offline'},{request_amount:499},{request_amount:2147483648},{total_amount:2147483648},{total_amount:499},{payment_order_id:0},{uid:0},{store_id:-1},{supplier_id:-1},{verified:false}])expect(await validEvidence(peer,'refund_execute','provider-admitted',{...providerEvidence,...patch})).toBe(false);
 });});},60000);
 it('binds both immutable revisions actor service and strong UUID while rejecting fabricated terminal service',async()=>{await withFixture(async f=>{await f.app(async peer=>{
  for(const kind of Object.keys(payloads))await peer.exec(receiptSql({kind}));expect(await count(peer)).toBe(7);
  await peer.exec(receiptSql({service_id:0,outcome:'abandoned',evidence:{}}));await peer.exec(receiptSql({service_id:0,outcome:'rollback-rejected',evidence:{code:'revoked'}}));
  for(const patch of [{expected_revision:hash('e')},{expected_financial_revision:hash('f')},{scope_key:hash('e')},{order_id:2},{actor_uid:0},{service_id:0},{service_id:1,outcome:'abandoned',evidence:{}},{request_key:'00000000-0000-1000-8000-000000000000'}])await rejectsCode(peer.exec(receiptSql(patch)),'23514');expect(await count(peer)).toBe(9);
 });});},60000);
 it('permits actual append and read but denies ledger update delete truncate and owner authority',async()=>{await withFixture(async f=>{await f.app(async peer=>{
  await peer.exec(receiptSql());expect(await count(peer)).toBe(1);
  await rejectsCode(peer.exec('UPDATE public.customer_financial_operation_request SET evidence=\'{}\'::jsonb'),'42501');await rejectsCode(peer.exec('DELETE FROM public.customer_financial_operation_request'),'42501');await rejectsCode(peer.exec('TRUNCATE public.customer_financial_operation_request'),'42501');
  await rejectsCode(peer.exec('ALTER TABLE public.customer_financial_operation_request ADD COLUMN forged integer'),'42501');expect(await count(peer)).toBe(1);
 });});},60000);
 it('detects column ACL and public validator execute escapes without repairing them',async()=>{await withFixture(async f=>{await f.app(async peer=>{
  await f.exec(`GRANT UPDATE(evidence) ON public.customer_financial_operation_request TO ${ident(peer.role)}`);expect(await customerFinancialOperationReadiness(peer.db)).toMatchObject({ready:false,privileges:{mutable:true,append_only_acl:false}});
  await f.exec(`REVOKE UPDATE(evidence) ON public.customer_financial_operation_request FROM ${ident(peer.role)}`);
  await f.exec('GRANT EXECUTE ON FUNCTION public.customer_financial_intent_valid_v1(text,jsonb) TO PUBLIC');expect(await customerFinancialOperationReadiness(peer.db)).toMatchObject({ready:false,privileges:{validator_safe:false}});
  expect((await peer.exec("SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.customer_financial_intent_valid_v1(text,jsonb)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS retained"))[0].retained).toBe(true);
 });});},60000);
 it('detects altered relation validator overload volatility and inbound foreign key catalogs',async()=>{await withFixture(async f=>{
  const probes=['ALTER TABLE public.customer_financial_operation_request ADD COLUMN unsupported integer',
   'ALTER FUNCTION public.customer_financial_intent_valid_v1(text,jsonb) STABLE',
   "CREATE FUNCTION public.customer_financial_intent_valid_v1(text) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'",
   'CREATE TABLE public.foreign_probe(actor_uid integer,request_key uuid,FOREIGN KEY(actor_uid,request_key) REFERENCES public.customer_financial_operation_request(actor_uid,request_key))'];
  for(const probe of probes){const rollback=Error('Owned financial catalog mutation rollback');try{await f.db.transaction(async tx=>{await tx.execute(sql.raw(probe));expect(await inspectCustomerFinancialOperation(tx as unknown as DbClient)).toMatchObject({present:true,complete:false});throw rollback;});}catch(error){if(error!==rollback)throw error;}expect((await inspectCustomerFinancialOperation(f.db)).complete).toBe(true);}
 });},60000);
 it('serializes owner installation with a distinct authenticated transaction and refuses a transaction handle',async()=>{await withFixture(async f=>{
  await f.app(async peer=>{await peer.db.transaction(async tx=>{await tx.execute(sql`SELECT pg_advisory_xact_lock(731665,0)`);await expect(runCustomerFinancialOperation(f.db)).rejects.toThrow('already running');});});
  await f.db.transaction(async tx=>{await expect(runCustomerFinancialOperation(tx as unknown as DbClient)).rejects.toThrow('root maintenance client');});expect((await f.exec("SELECT to_regclass('public.customer_financial_operation_request') AS ledger"))[0].ledger).toBeNull();
 },false);},60000);
 it('keeps one actor and UUID primary key across two distinct ordinary LOGIN connections',async()=>{await withFixture(async f=>{await f.app(async first=>{await f.app(async second=>{
  expect(first.pid).not.toBe(second.pid);expect(first.role).not.toBe(second.role);const key=randomUUID();await first.exec(receiptSql({request_key:key}));await rejectsCode(second.exec(receiptSql({request_key:key})),'23505');expect(await count(second)).toBe(1);
 });});});},60000);
});
