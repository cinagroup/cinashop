import { ADMIN_ORDER_GAIN_PARTITION_SQL, ADMIN_ORDER_GAIN_PARTITION_CONSTRAINTS_SHA256, inspectAdminOrderGainPartition } from '@/migrations/adminOrderGainPartition';
import { installAdminOrderEditRuntime } from '@/migrations/adminOrderEditRuntime';
import { installSupplierOrderEditOperation } from '@/migrations/supplierOrderEditOperation';
import { storeOrderOutbox } from '@/models/schema';
import { PRODUCT_SAVE_EFFECTS_EVENTS } from '@/migrations/productSaveEffects';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { financePostgres } from './helpers/financePostgres';
import { ADMIN_ORDER_EDIT_OPERATION_SQL, ADMIN_ORDER_EDIT_OPERATION_CONSTRAINTS_SHA256, inspectAdminOrderEditOperation, installAdminOrderEditOperation, assertAdminOrderEditOperationReady, assertAdminOrderEditOperationReadable } from '@/migrations/adminOrderEditOperation';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Admin desktop edit immutable receipt PG16 catalog', () => {
  it('pins the independently installed PG16 physical contract', async () => {
    const f = await financePostgres([], { namespace: 'public' });
    try {
      await f.exec(ADMIN_ORDER_EDIT_OPERATION_SQL);
      await f.exec(ADMIN_ORDER_GAIN_PARTITION_SQL);
      const partition = await inspectAdminOrderGainPartition(f.db);
      const state = await inspectAdminOrderEditOperation(f.db);
      console.log('OWNED_PG16_CATALOG_PINS', JSON.stringify({operation:state.constraints_hash,partition:partition.constraints_hash}));
      expect(partition.constraints_hash).toBe(ADMIN_ORDER_GAIN_PARTITION_CONSTRAINTS_SHA256);
      expect(partition).toMatchObject({ supported:true,safe:true,constraint_count:true,indexes:true,triggers:true,function:true,privileges:true });
      expect(state.constraints_hash).toBe(ADMIN_ORDER_EDIT_OPERATION_CONSTRAINTS_SHA256);
      expect(state).toMatchObject({ supported: true, safe: true, constraint_count: true, indexes: true, triggers: true, function: true, privileges: true });
    } finally { await f.close(); }
  });
  it('commissions a separate restricted LOGIN and refuses grant drift without repair', async () => {
    const f=await financePostgres([],{namespace:'public'}),role='edit_catalog_'+randomUUID().replaceAll('-',''),password=randomUUID();
    let client:ReturnType<typeof postgres>|undefined;
    try {
      await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'; GRANT USAGE ON SCHEMA public TO "${role}"`);
      await expect(installAdminOrderEditOperation(f.db,role)).rejects.toThrow('maintenance transaction');
      const install=()=>withTx(createContainerFromDb(f.db),tx=>installAdminOrderEditOperation(tx,role));
      expect(await install()).toEqual({applied:true});expect(await install()).toEqual({applied:false});
      const [database]=await f.db.execute(sql`SELECT current_database() AS name`),url=new URL(process.env.TEST_FINANCE_POSTGRES_URL!);
      url.pathname='/'+String(database.name);url.username=role;url.password=password;
      client=postgres(url.href,{max:1,prepare:false,connect_timeout:5,idle_timeout:0,max_lifetime:0,connection:{options:'-c search_path=public -c statement_timeout=5000'}});
      const db=drizzle(client) as unknown as DbClient;
      expect(await db.execute(sql`SELECT current_user=session_user AS direct,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS owner,
        has_table_privilege(current_user,'public.admin_order_edit_operation_v1','SELECT') AS readable,
        has_table_privilege(current_user,'public.admin_order_edit_operation_v1','INSERT') AS append,
        has_table_privilege(current_user,'public.admin_order_edit_operation_v1','UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') AS mutate`)).toEqual([{direct:true,owner:false,readable:true,append:true,mutate:false}]);
      await assertAdminOrderEditOperationReady(db);
      await expect(withTx(createContainerFromDb(db),tx=>installAdminOrderEditOperation(tx))).rejects.toThrow('explicit PG16 owner maintenance');
      const id=randomUUID(),evidence={version:'admin-unpaid-gain-edit-v1',operation_id:id,lines:[]},result={id:1,order_id:'catalog-order',pay_price:'1.00',change_price:'0.00',gain_integral:'0.50',changed:true};
      await db.execute(sql`INSERT INTO public.admin_order_edit_operation_v1 VALUES(${id}::uuid,1,0,1,${'a'.repeat(64)},'committed',${'b'.repeat(64)},${'c'.repeat(64)},${JSON.stringify(evidence)}::jsonb,${JSON.stringify(result)}::jsonb,1)`);
      for(const statement of ['UPDATE public.admin_order_edit_operation_v1 SET actor_id=2','DELETE FROM public.admin_order_edit_operation_v1','TRUNCATE public.admin_order_edit_operation_v1']) {
        await expect(db.execute(sql.raw(statement))).rejects.toThrow();
        await expect(f.exec(statement)).rejects.toThrow('immutable');
      }
      expect(await db.execute(sql`SELECT actor_id FROM public.admin_order_edit_operation_v1`)).toEqual([{actor_id:1}]);
      await f.exec(`REVOKE INSERT ON public.admin_order_edit_operation_v1 FROM "${role}"`);
      await assertAdminOrderEditOperationReadable(db);
      await expect(assertAdminOrderEditOperationReady(db)).rejects.toThrow('尚未就绪');
      await expect(install()).rejects.toThrow('grants require review');
      expect(await db.execute(sql`SELECT has_table_privilege(current_user,'public.admin_order_edit_operation_v1','INSERT') AS writable`)).toEqual([{writable:false}]);
    } finally {await client?.end({timeout:5});await f.exec(`DROP OWNED BY "${role}";DROP ROLE "${role}"`);await f.close();}
  },30000);

  it('rejects physical catalog drift without changing the reviewed table',async()=>{
    const f=await financePostgres([],{namespace:'public'});
    try{
      await withTx(createContainerFromDb(f.db),tx=>installAdminOrderEditOperation(tx));
      await f.exec('ALTER TABLE public.admin_order_edit_operation_v1 ADD COLUMN unreviewed integer');
      await expect(assertAdminOrderEditOperationReady(f.db)).rejects.toThrow('尚未就绪');
      await expect(withTx(createContainerFromDb(f.db),tx=>installAdminOrderEditOperation(tx))).rejects.toThrow('尚未就绪');
      expect(await f.db.execute(sql`SELECT count(*)::integer AS n FROM pg_attribute WHERE attrelid='public.admin_order_edit_operation_v1'::regclass AND attnum>0`)).toEqual([{n:12}]);
    }finally{await f.close();}
  });

  it('refuses a partial existing catalog and unsafe runtime names without auto-installation',async()=>{
    const f=await financePostgres([],{namespace:'public'});
    try{
      await expect(withTx(createContainerFromDb(f.db),tx=>installAdminOrderEditOperation(tx,'invalid-name'))).rejects.toThrow('Invalid');
      expect(await f.db.execute(sql`SELECT to_regclass('public.admin_order_edit_operation_v1') IS NULL AS absent`)).toEqual([{absent:true}]);
      await f.exec('CREATE TABLE public.admin_order_edit_operation_v1(unreviewed integer)');
      await expect(withTx(createContainerFromDb(f.db),tx=>installAdminOrderEditOperation(tx))).rejects.toThrow('Partial');
      expect(await f.db.execute(sql`SELECT to_regprocedure('public.admin_order_edit_operation_immutable_v1()') IS NULL AS absent`)).toEqual([{absent:true}]);
    }finally{await f.close();}
  });

  it('commissions the known outbox successor and explicit reader list atomically without repairing missing reader grants',async()=>{
    const f=await financePostgres([storeOrderOutbox],{namespace:'public'}),suffix=randomUUID().replaceAll('-',''),admin='price_admin_'+suffix,reader='price_reader_'+suffix;
    try{
      await f.exec(`CREATE ROLE "${admin}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
        CREATE ROLE "${reader}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
        ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK(event_type IN (${PRODUCT_SAVE_EFFECTS_EVENTS.map(event=>"'"+event+"'").join(',')}))`);
      await withTx(createContainerFromDb(f.db),tx=>installSupplierOrderEditOperation(tx));
      const install=()=>withTx(createContainerFromDb(f.db),tx=>installAdminOrderEditRuntime(tx,{admin,financial:[reader]}));
      expect(await install()).toEqual({applied:true});expect(await install()).toEqual({applied:false});
      expect(await f.db.execute(sql`SELECT has_table_privilege(${reader},'public.admin_order_edit_operation_v1','SELECT') AS readable,
        has_table_privilege(${reader},'public.admin_order_edit_operation_v1','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writable`)).toEqual([{readable:true,writable:false}]);
      for(const name of [admin,reader])expect(await f.db.execute(sql`SELECT
        has_table_privilege(${name},'public.supplier_order_edit_operation_v1','SELECT') AS readable,
        has_table_privilege(${name},'public.supplier_order_edit_operation_v1','INSERT,UPDATE,DELETE,TRUNCATE') AS writable`)).toEqual([{readable:true,writable:false}]);
      await f.exec(`REVOKE SELECT ON public.admin_order_edit_operation_v1 FROM "${reader}"`);
      await expect(install()).rejects.toThrow('financial grants require review');
      expect(await f.db.execute(sql`SELECT has_table_privilege(${reader},'public.admin_order_edit_operation_v1','SELECT') AS readable`)).toEqual([{readable:false}]);
    }finally{await f.exec(`DROP OWNED BY "${admin}","${reader}";DROP ROLE "${admin}","${reader}"`);await f.close();}
  },30000);

});
