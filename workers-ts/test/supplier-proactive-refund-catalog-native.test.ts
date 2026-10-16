import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import {
  SUPPLIER_PROACTIVE_REFUND_SQL, SUPPLIER_PROACTIVE_REFUND_CONSTRAINTS_SHA256,
  inspectSupplierProactiveRefund, supplierProactiveRefundReadiness, assertSupplierProactiveRefundReady,
  installSupplierProactiveRefund,
} from '@/migrations/supplierProactiveRefund';
import { supplierProactiveRefundJson } from '@/services/supplier/SupplierProactiveRefundInput';
import { financePostgres, validateFinanceFixtureUrl } from './helpers/financePostgres';

type Fixture = Awaited<ReturnType<typeof financePostgres>>;
type Executor = Pick<DbClient,'execute'>;
const operation='public.supplier_proactive_refund_operation_v1',decision='public.supplier_proactive_refund_decision_v1';
const payment='public.supplier_refund_money_payment_v1',completion='public.supplier_refund_money_completion_v1';
const sequence='public.supplier_refund_money_payment_v1_id_seq';
const immutable='public.supplier_proactive_refund_immutable_v1()',progress='public.supplier_refund_money_payment_guard_v1()';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Synthetic catalog rows prove DDL/ACL/immutability only. Actual purchase,
 * delivery and cash/provider completion belong to the separate flow suites. */
async function seedOperation(db:Executor,kind:'goods'|'money'|'refuse'='money') {
  const id=randomUUID(),intent={version:'supplier-proactive-refund-intent-v1',operation_id:id,actor_id:21,supplier_id:7,
    order_id:81,revision:'a'.repeat(64),refund_price:'1.25',type:kind==='refuse'?2:1};
  const intentJson=supplierProactiveRefundJson(intent),sourceJson=supplierProactiveRefundJson({order:{id:81},carts:[{id:1}]});
  const requestHash=digest(intentJson),sourceHash=digest(sourceJson);
  await db.execute(sql`INSERT INTO public.supplier_proactive_refund_operation_v1
    (operation_id,actor_id,supplier_id,order_id,state,kind,request_hash,intent,intent_json,source,source_json,source_hash,result,created_at)
    VALUES(${id}::uuid,21,7,81,'committed',${kind},${requestHash},${intentJson}::jsonb,${intentJson},${sourceJson}::jsonb,
      ${sourceJson},${sourceHash},'{}'::jsonb,1)`);
  return {id,intentJson,sourceJson,requestHash,sourceHash};
}
async function seedDecision(db:Executor,op:Awaited<ReturnType<typeof seedOperation>>) {
  const evidence=supplierProactiveRefundJson({version:1,origin:op.id});
  await db.execute(sql`INSERT INTO public.supplier_proactive_refund_decision_v1 VALUES
    (${op.id}::uuid,21,7,81,'money','provider-admitted',${op.requestHash},${evidence}::jsonb,${evidence},${digest(evidence)},1)`);
}
async function seedPayment(db:Executor,op:Awaited<ReturnType<typeof seedOperation>>) {
  const request=supplierProactiveRefundJson({outTradeNo:'actual-source-placeholder',outRefundNo:'SPR'+op.id.replaceAll('-',''),refundAmount:125,totalAmount:1875});
  const [row]=await db.execute<{id:number}>(sql`INSERT INTO public.supplier_refund_money_payment_v1
    (operation_id,order_id,payment_order_id,provider,out_refund_no,transaction_id,request_amount,total_amount,provider_status,
      request,request_json,request_hash,created_at,updated_at)
    VALUES(${op.id}::uuid,81,81,'wechat',${'SPR'+op.id.replaceAll('-','')},'provider-trade-id',125,1875,'INIT',
      ${request}::jsonb,${request},${digest(request)},1,1) RETURNING id`);
  return row.id;
}
async function seedCompletion(db:Executor,op:Awaited<ReturnType<typeof seedOperation>>) {
  const proof=supplierProactiveRefundJson({version:1,first_refund_id:3,operation_id:op.id});
  await db.execute(sql`INSERT INTO public.supplier_refund_money_completion_v1 VALUES
    (${op.id}::uuid,21,7,81,3,81,1.25,'offline',${op.sourceHash},${op.requestHash},7.00,8.25,
      ${proof}::jsonb,${proof},${digest(proof)},1)`);
}
async function rows(db:Executor) {
  const result=[];
  for(const table of [operation,decision,payment,completion]) {
    result.push([...await db.execute(sql.raw(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`))]);
  }
  return result;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('independent Supplier proactive refund PG16 catalog',()=>{
  let f:Fixture;
  const roles:string[]=[];
  const createRole=async(options='')=>{
    const role='supplier_proactive_'+randomUUID().replaceAll('-',''),password=randomUUID().replaceAll('-','');roles.push(role);
    await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}' ${options}`);
    const [origin]=await f.db.execute<{database:string}>(sql`SELECT current_database() AS database`);
    await f.exec(`GRANT CONNECT ON DATABASE "${origin.database}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}"`);
    const url=validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL??'');url.pathname='/'+origin.database;url.username=role;url.password=password;
    return {role,url};
  };
  const login=(url:URL)=>postgres(url.href,{max:1,prepare:false,connect_timeout:5,idle_timeout:0,
    connection:{options:'-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=1000'}});
  beforeAll(async()=>{f=await financePostgres([],{namespace:'public'});},60000);
  beforeEach(async()=>{
    await f.exec(`DROP TABLE IF EXISTS ${completion},${payment},${decision},${operation} CASCADE;
      DROP SEQUENCE IF EXISTS ${sequence}; DROP FUNCTION IF EXISTS ${immutable}; DROP FUNCTION IF EXISTS ${progress};
      DROP FUNCTION IF EXISTS public.supplier_proactive_refund_immutable_v1(integer)`);
    for(const role of roles.splice(0))await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
  });
  afterAll(async()=>{try{for(const role of roles)await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);}finally{await f?.close();}},30000);

  it('pins actual PG16 proactive refund constraints and the exact independent four-table SQL mirror',async()=>{
    expect(readFileSync(resolve(import.meta.dirname,'../src/migrations/maintenance/0196_supplier_proactive_refund.sql'),'utf8')
      .split('\n').slice(1).join('\n')).toBe(SUPPLIER_PROACTIVE_REFUND_SQL);
    await f.db.transaction(async tx=>{
      await tx.execute(sql.raw(SUPPLIER_PROACTIVE_REFUND_SQL));
      const actual=await inspectSupplierProactiveRefund(tx);
      console.log('SUPPLIER_PROACTIVE_REFUND_PG16_CATALOG',JSON.stringify(actual));
      expect(actual.constraints_hash).toBe(SUPPLIER_PROACTIVE_REFUND_CONSTRAINTS_SHA256);
      expect(actual.tables.map(table=>Array.isArray(table?.columns)?table.columns.length:0)).toEqual([14,11,22,16]);
      await assertSupplierProactiveRefundReady(tx);
    });
    const bootstrap=readFileSync(resolve(import.meta.dirname,'../src/services/MigrationService.ts'),'utf8');
    for(const table of [operation,decision,payment,completion])expect(bootstrap).not.toContain(table.slice(7));
  });

  it('installs only under explicit owner maintenance and is exactly idempotent without business DML',async()=>{
    await expect(installSupplierProactiveRefund(f.db)).rejects.toThrow('transaction');
    await f.exec("CREATE TABLE public.untouched_proactive_fixture(id integer PRIMARY KEY,value text); INSERT INTO public.untouched_proactive_fixture VALUES(1,'unchanged')");
    const original=()=>f.db.execute(sql`SELECT c.oid::text,c.relacl::text,(SELECT jsonb_agg(t) FROM public.untouched_proactive_fixture t) AS rows
      FROM pg_catalog.pg_class c WHERE c.oid='public.untouched_proactive_fixture'::regclass`);
    const before=await original();
    expect(await f.db.transaction(tx=>installSupplierProactiveRefund(tx))).toEqual({applied:true});
    expect(await rows(f.db)).toEqual([[],[],[],[]]);
    const op=await seedOperation(f.db);await seedCompletion(f.db,op);const stored=await rows(f.db);
    expect(await f.db.transaction(tx=>installSupplierProactiveRefund(tx))).toEqual({applied:false});
    expect(await rows(f.db)).toEqual(stored);expect(await original()).toEqual(before);
  });

  it('rejects unsupported maintenance contexts and unsafe runtime roles before creating objects',async()=>{
    const peer=await createRole();
    await expect(f.db.transaction(tx=>installSupplierProactiveRefund(tx,{runtimeRole:'unsafe-role'}))).rejects.toThrow('identity');
    await expect(f.db.transaction(tx=>installSupplierProactiveRefund(tx,{runtimeRole:'finance_test'}))).rejects.toThrow('restricted');
    for(const options of [{isolationLevel:'repeatable read' as const},{accessMode:'read only' as const}])
      await expect(f.db.transaction(tx=>installSupplierProactiveRefund(tx),options)).rejects.toThrow('PG16');
    for(const setting of ["SET LOCAL session_replication_role='replica'",'SET LOCAL search_path=pg_catalog',`SET LOCAL ROLE "${peer.role}"`]) {
      await expect(f.db.transaction(async tx=>{await tx.execute(sql.raw(setting));await installSupplierProactiveRefund(tx);})).rejects.toThrow('PG16');
    }
    await f.exec(`ALTER ROLE "${peer.role}" CREATEDB`);
    await expect(f.db.transaction(tx=>installSupplierProactiveRefund(tx,{runtimeRole:peer.role}))).rejects.toThrow('restricted');
    expect((await f.db.execute(sql`SELECT to_regclass('public.supplier_proactive_refund_operation_v1') IS NULL AS absent,
      to_regprocedure('public.supplier_refund_money_payment_guard_v1()') IS NULL AS no_function`))[0]).toEqual({absent:true,no_function:true});
  });

  it('refuses missing partial and overloaded catalogs without repairing any object',async()=>{
    expect((await supplierProactiveRefundReadiness(f.db)).ready).toBe(false);
    await expect(f.db.transaction(tx=>assertSupplierProactiveRefundReady(tx))).rejects.toMatchObject({httpStatus:503});
    for(const definition of [`CREATE TABLE ${operation}(operation_id uuid)`,
      `CREATE FUNCTION public.supplier_proactive_refund_immutable_v1(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1'`]) {
      const rollback=Error('rollback owned partial catalog');
      await expect(f.db.transaction(async tx=>{
        await tx.execute(sql.raw(definition));const before=await tx.execute(sql`SELECT oid::text,relname FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid`);
        await expect(installSupplierProactiveRefund(tx)).rejects.toThrow('Partial');
        expect(await tx.execute(sql`SELECT oid::text,relname FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid`)).toEqual(before);
        throw rollback;
      })).rejects.toBe(rollback);
    }
  });

  it('fails closed for column CHECK FK index sequence trigger function owner and ACL drift without repair',async()=>{
    await f.db.transaction(tx=>installSupplierProactiveRefund(tx));
    const peer=await createRole(),baseline=await inspectSupplierProactiveRefund(f.db);
    const rollback=Error('rollback owned proactive catalog drift');
    for(const statement of [
      `ALTER TABLE ${completion} ADD COLUMN unreviewed text`,
      `ALTER TABLE ${payment} ALTER COLUMN attempts SET DEFAULT 1`,
      `ALTER TABLE ${operation} ALTER COLUMN kind SET NOT NULL`,
      `ALTER TABLE ${operation} ALTER COLUMN request_hash TYPE text COLLATE "C"`,
      `ALTER TABLE ${completion} DROP CONSTRAINT srmc_money_ck`,
      `ALTER TABLE ${decision} DROP CONSTRAINT sprd_operation_fk`,
      `CREATE INDEX unreviewed_proactive_index ON ${operation}(actor_id)`,
      'ALTER INDEX public.spro_order SET (fillfactor=70)',
      `ALTER SEQUENCE ${sequence} INCREMENT BY 2`,
      `GRANT SELECT ON SEQUENCE ${sequence} TO PUBLIC`,
      `ALTER TABLE ${payment} ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${payment} REPLICA IDENTITY FULL`,
      `ALTER TABLE ${decision} DISABLE TRIGGER sprd_immutable_rows`,
      `ALTER FUNCTION ${immutable} SECURITY DEFINER`,
      `ALTER FUNCTION ${progress} RESET ALL`,
      `ALTER FUNCTION ${progress} OWNER TO "${peer.role}"`,
      `GRANT EXECUTE ON FUNCTION ${progress} TO PUBLIC`,
      `GRANT SELECT ON ${operation} TO PUBLIC`,
      `GRANT UPDATE(request_amount) ON ${payment} TO "${peer.role}"`,
      `GRANT UPDATE ON ${payment} TO "${peer.role}"`,
      `GRANT INSERT ON ${operation} TO "${peer.role}" WITH GRANT OPTION`,
      `CREATE TABLE public.unreviewed_proactive_reference(operation_id uuid REFERENCES ${operation}(operation_id))`,
    ]) {
      await expect(f.db.transaction(async tx=>{
        await tx.execute(sql.raw(statement));const drifted=await inspectSupplierProactiveRefund(tx);
        await expect(assertSupplierProactiveRefundReady(tx)).rejects.toMatchObject({httpStatus:503});
        await expect(installSupplierProactiveRefund(tx)).rejects.toMatchObject({httpStatus:503});
        expect(await inspectSupplierProactiveRefund(tx)).toEqual(drifted);throw rollback;
      })).rejects.toBe(rollback);
      expect(await inspectSupplierProactiveRefund(f.db)).toEqual(baseline);
    }
  },30000);

  it('keeps operation decision and money-completion facts append-only even for the maintenance owner',async()=>{
    await f.db.transaction(tx=>installSupplierProactiveRefund(tx));
    const op=await seedOperation(f.db);await seedDecision(f.db,op);await seedCompletion(f.db,op);
    const before=await rows(f.db);
    for(const table of [operation,decision,completion]) {
      for(const command of [`UPDATE ${table} SET actor_id=22`,`DELETE FROM ${table}`])
        await expect(f.exec(command)).rejects.toMatchObject({code:'42501'});
    }
    await expect(f.exec(`TRUNCATE ${operation},${decision},${payment},${completion}`)).rejects.toMatchObject({code:'42501'});
    expect(await rows(f.db)).toEqual(before);
  });

  it('enforces tombstones bounded paired JSON positive identities internal FKs and exact finite cash arithmetic',async()=>{
    await f.db.transaction(tx=>installSupplierProactiveRefund(tx));
    await f.db.execute(sql`INSERT INTO public.supplier_proactive_refund_operation_v1 VALUES
      (${randomUUID()}::uuid,21,7,81,'not_applied',NULL,'',NULL,NULL,NULL,NULL,'',NULL,1)`);
    const op=await seedOperation(f.db);
    for(const command of [
      `INSERT INTO ${operation} VALUES('${randomUUID()}',0,7,81,'not_applied',NULL,'',NULL,NULL,NULL,NULL,'',NULL,1)`,
      `INSERT INTO ${operation} VALUES('${randomUUID()}',21,7,81,'not_applied','money','',NULL,NULL,NULL,NULL,'',NULL,1)`,
      `INSERT INTO ${operation} VALUES('${randomUUID()}',21,7,81,'not_applied',NULL,'','{}','{}',NULL,NULL,'',NULL,1)`,
      `INSERT INTO ${decision} VALUES('${op.id}',21,7,81,'refuse','provider-admitted','${op.requestHash}','{}','{}','${op.sourceHash}',1)`,
      `INSERT INTO ${decision} VALUES('${op.id}',21,7,81,'money','local-settled','${op.requestHash}','{}','{"mismatch":true}','${op.sourceHash}',1)`,
      `INSERT INTO ${decision} VALUES('${op.id}',21,7,81,'money','local-settled','${op.requestHash}',jsonb_build_object('oversized',repeat('x',16777216)),jsonb_build_object('oversized',repeat('x',16777216))::text,'${op.sourceHash}',1)`,
      ...["0,7,7","1.25,-1,0.25","1.25,7,8.24","'NaN',7,'NaN'","1.25,'NaN','NaN'"].map(amounts=>
        `INSERT INTO ${completion} VALUES('${op.id}',21,7,81,3,81,${amounts.split(',')[0]},'offline','${op.sourceHash}','${op.requestHash}',${amounts.split(',').slice(1).join(',')},'{}','{}','${op.sourceHash}',1)`),
    ]) await expect(f.exec(command)).rejects.toMatchObject({code:'23514'});
    await expect(f.db.execute(sql`INSERT INTO public.supplier_proactive_refund_decision_v1 VALUES
      (${randomUUID()}::uuid,21,7,81,'money','local-settled',${op.requestHash},'{}','{}',${op.sourceHash},1)`)).rejects.toMatchObject({cause:{code:'23503'}});
    await seedDecision(f.db,op);await seedCompletion(f.db,op);
    const [actual]=await f.db.execute<{amount:string;before_refunded:string;after_refunded:string}>(sql`SELECT amount::text,before_refunded::text,after_refunded::text FROM public.supplier_refund_money_completion_v1`);
    expect(actual).toEqual({amount:'1.25',before_refunded:'7.00',after_refunded:'8.25'});
  },30000);

  it('permits only monotone provider progress and never changes its source request or successful result',async()=>{
    await f.db.transaction(tx=>installSupplierProactiveRefund(tx));const op=await seedOperation(f.db),id=await seedPayment(f.db,op);
    for(const change of ["provider='alipay'","order_id=82","payment_order_id=82","request_amount=126","total_amount=1876",
      "out_refund_no='different'","transaction_id='different'","request='{}',request_json='{}'","request_hash=repeat('c',64)",
      'created_at=2',`operation_id='${randomUUID()}'`]) {
      await expect(f.exec(`UPDATE ${payment} SET ${change} WHERE id=${id}`)).rejects.toMatchObject({code:'42501'});
    }
    await f.exec(`UPDATE ${payment} SET provider_status='REQUESTING',attempts=1,request_lease_until=121,updated_at=2 WHERE id=${id}`);
    await f.exec(`UPDATE ${payment} SET provider_status='UNKNOWN',last_error='response lost',request_lease_until=NULL,next_retry_at=122,
      last_queried_at=2,query_count=1,updated_at=3 WHERE id=${id}`);
    const stable=await rows(f.db);
    for(const change of ['attempts=0','query_count=0','updated_at=2','last_queried_at=NULL','last_queried_at=1'])
      await expect(f.exec(`UPDATE ${payment} SET ${change} WHERE id=${id}`)).rejects.toMatchObject({code:'42501'});
    expect(await rows(f.db)).toEqual(stable);
    await f.exec(`UPDATE ${payment} SET provider_status='SUCCESS',provider_refund_id='actual-provider-refund',last_error='',updated_at=4 WHERE id=${id}`);
    for(const change of ["provider_status='PROCESSING'","provider_status='UNKNOWN'","provider_refund_id='other-refund'","provider_refund_id=''"])
      await expect(f.exec(`UPDATE ${payment} SET ${change} WHERE id=${id}`)).rejects.toMatchObject({code:'42501'});
    await expect(f.exec(`DELETE FROM ${payment}`)).rejects.toMatchObject({code:'42501'});
    await expect(f.exec(`TRUNCATE ${payment}`)).rejects.toMatchObject({code:'42501'});
    const [actual]=await f.db.execute<{id:number;provider_status:string;request_amount:number;attempts:number;query_count:number}>(sql`SELECT id,provider_status,request_amount,attempts,query_count FROM public.supplier_refund_money_payment_v1`);
    expect(actual).toEqual({id,provider_status:'SUCCESS',request_amount:125,attempts:1,query_count:1});
    await assertSupplierProactiveRefundReady(f.db);
  });

  it('executes with a genuinely separate restricted LOGIN and only SELECT INSERT progress-column UPDATE and identity USAGE',async()=>{
    const peer=await createRole();await f.db.transaction(tx=>installSupplierProactiveRefund(tx,{runtimeRole:peer.role}));
    const client=login(peer.url);
    try {
      const db=drizzle(client) as unknown as DbClient;
      expect((await client`SELECT current_user AS role,session_user AS session`)[0]).toEqual({role:peer.role,session:peer.role});
      await db.transaction(tx=>assertSupplierProactiveRefundReady(tx));
      const op=await seedOperation(db);await seedDecision(db,op);const id=await seedPayment(db,op);await seedCompletion(db,op);
      await client.unsafe(`UPDATE ${payment} SET provider_status='REQUESTING',attempts=1,updated_at=2 WHERE id=${id}`);
      for(const command of [`UPDATE ${operation} SET actor_id=22`,`DELETE FROM ${decision}`,`TRUNCATE ${completion}`,
        `UPDATE ${payment} SET request_amount=126`,`UPDATE ${payment} SET operation_id='${randomUUID()}'`,
        `DELETE FROM ${payment}`,`TRUNCATE ${payment}`,`SELECT ${immutable}`,`SELECT ${progress}`,
        `SELECT last_value FROM ${sequence}`,`SELECT setval('${sequence}',100)`]) {
        await expect(client.unsafe(command)).rejects.toMatchObject({code:'42501'});
      }
      expect(await f.db.transaction(tx=>installSupplierProactiveRefund(tx,{runtimeRole:peer.role}))).toEqual({applied:false});
      await f.exec(`REVOKE UPDATE(last_error) ON ${payment} FROM "${peer.role}"`);
      await expect(db.transaction(tx=>assertSupplierProactiveRefundReady(tx))).rejects.toMatchObject({httpStatus:503});
      await db.transaction(tx=>assertSupplierProactiveRefundReady(tx,'read'));
      await expect(f.db.transaction(tx=>installSupplierProactiveRefund(tx,{runtimeRole:peer.role}))).rejects.toThrow('grants');
      const [rights]=await f.db.execute<{restored:boolean}>(sql`SELECT has_column_privilege(${peer.role},'public.supplier_refund_money_payment_v1','last_error','UPDATE') AS restored`);
      expect(rights.restored).toBe(false);
    } finally {await client.end({timeout:5});}
  },30000);

  it('allows a separate SELECT-only proof reader without INSERT sequence or progress capability',async()=>{
    await f.db.transaction(tx=>installSupplierProactiveRefund(tx));const peer=await createRole();
    await f.exec(`GRANT SELECT ON ${operation},${decision},${payment},${completion} TO "${peer.role}"`);
    const client=login(peer.url);
    try {
      const db=drizzle(client) as unknown as DbClient;await db.transaction(tx=>assertSupplierProactiveRefundReady(tx,'read'));
      await expect(db.transaction(tx=>assertSupplierProactiveRefundReady(tx))).rejects.toMatchObject({httpStatus:503});
      await expect(seedOperation(db)).rejects.toMatchObject({cause:{code:'42501'}});
      for(const command of [`UPDATE ${payment} SET last_error='forged'`,`DELETE FROM ${operation}`,`TRUNCATE ${completion}`,`SELECT ${immutable}`])
        await expect(client.unsafe(command)).rejects.toMatchObject({code:'42501'});
      await f.exec(`REVOKE SELECT ON ${decision} FROM "${peer.role}"`);
      await expect(db.transaction(tx=>assertSupplierProactiveRefundReady(tx,'read'))).rejects.toMatchObject({httpStatus:503});
    } finally {await client.end({timeout:5});}
  },30000);

  it('rejects later public schema CREATE and replication-parameter SET or ALTER SYSTEM grants to the real runtime LOGIN',async()=>{
    const peer=await createRole();await f.db.transaction(tx=>installSupplierProactiveRefund(tx,{runtimeRole:peer.role}));
    const client=login(peer.url);
    try {
      const db=drizzle(client) as unknown as DbClient;await db.transaction(tx=>assertSupplierProactiveRefundReady(tx));
      for(const privilege of [
        {grant:`GRANT CREATE ON SCHEMA public TO "${peer.role}"`,revoke:`REVOKE CREATE ON SCHEMA public FROM "${peer.role}"`},
        {grant:`GRANT SET ON PARAMETER session_replication_role TO "${peer.role}"`,revoke:`REVOKE SET ON PARAMETER session_replication_role FROM "${peer.role}"`},
        {grant:`GRANT ALTER SYSTEM ON PARAMETER session_replication_role TO "${peer.role}"`,revoke:`REVOKE ALTER SYSTEM ON PARAMETER session_replication_role FROM "${peer.role}"`},
      ]) {
        await f.exec(privilege.grant);
        try { await expect(db.transaction(tx=>assertSupplierProactiveRefundReady(tx,'read'))).rejects.toMatchObject({httpStatus:503}); }
        finally {await f.exec(privilege.revoke);}
        await db.transaction(tx=>assertSupplierProactiveRefundReady(tx));
      }
      expect(await rows(f.db)).toEqual([[],[],[],[]]);
    } finally {await client.end({timeout:5});}
  },30000);
});
