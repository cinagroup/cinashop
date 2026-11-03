/** Storage-budget specimens only. They are not signed business/effect
 * positives; the three actual Queue suites cover those separately. */
import type postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { collectRoutineOwnershipInventory } from '../scripts/routine-ownership-inventory';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
const KEY='62'.repeat(32);
async function fixture(work:(client:postgres.Sql,target:{database:string;maintenance:string},f:Awaited<ReturnType<typeof sequenceRunnerDatabase>>)=>Promise<void>){
  const f=await sequenceRunnerDatabase();
  try{
    expect(f.format).toBe('pg16');const client=f.db.$client as unknown as postgres.Sql;
    const [target]=await client.unsafe<{database:string;maintenance:string;version:string}[]>(
      "SELECT current_database() AS database,current_user AS maintenance,current_setting('server_version_num') AS version");
    expect(target.version).toBe('160014');await work(client,target,f);
  }finally{await f.close();}
}
const collect=(client:postgres.Sql,target:{database:string;maintenance:string})=>collectRoutineOwnershipInventory(client,target,KEY);
const refused=(work:Promise<unknown>)=>expect(work).rejects.toThrow('Routine ownership database inventory incomplete');
const metadata=(client:postgres.Sql,name:string)=>client.unsafe<{method:string|null;physical:number;raw:number;text_bytes:number}[]>(
  `SELECT pg_column_compression(payload) AS method,pg_column_size(payload) AS physical,
    pg_column_size(pg_catalog.jsonb_set_lax(payload,'{}'::text[],NULL::jsonb,false,'return_target')) AS raw,
    octet_length(pg_catalog.textin(pg_catalog.jsonb_out(payload))) AS text_bytes FROM public."${name}"`);
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16.14 bounded notification JSON reader',()=>{
  it.each(['store_order_outbox','order_notification_delivery'])('preserves the complete physical row of genuine pglz storage in named %s',async name=>fixture(async(client,target)=>{
    await client.unsafe(`CREATE TABLE public."${name}"(id integer,payload jsonb)`);
    await client.unsafe(`INSERT INTO public."${name}" VALUES(1,jsonb_build_object('text',repeat('owned-budget-value',700),'n',1.25))`);
    const [size]=await metadata(client,name);expect(size.method).toBe('pglz');expect(size.physical).toBeLessThan(32768);expect(size.raw).toBeLessThanOrEqual(32768);
    const before=await client.unsafe(`SELECT xmin::text,ctid::text,to_jsonb(t)::text AS value FROM public."${name}" t`);
    const report=await collect(client,target);expect(report.rowCount).toBe('1');expect(report.relations).toHaveLength(1);
    expect(report.activationAllowed).toBe(false);expect(report.ownership).toBe('not_evaluated');
    expect(await client.unsafe(`SELECT xmin::text,ctid::text,to_jsonb(t)::text AS value FROM public."${name}" t`)).toEqual(before);
    expect(JSON.stringify(report)).not.toContain('owned-budget-value');
  }),30000);
  it('keeps pglz scalar and array JSON as raw history instead of failing an object-only identity',async()=>fixture(async(client,target)=>{
    await client.unsafe('CREATE TABLE public.store_order_outbox(id integer,payload jsonb)');
    await client.unsafe("INSERT INTO public.store_order_outbox VALUES(1,to_jsonb(repeat('scalar',2000))),(2,jsonb_build_array(repeat('array',2000),true,NULL))");
    const before=await client.unsafe('SELECT payload::text AS value FROM public.store_order_outbox ORDER BY id');
    expect((await metadata(client,'store_order_outbox')).every(r=>r.method==='pglz'&&r.raw<=32768)).toBe(true);
    expect((await collect(client,target)).rowCount).toBe('2');
    expect(await client.unsafe('SELECT payload::text AS value FROM public.store_order_outbox ORDER BY id')).toEqual(before);
  }),30000);
  it('rejects the same compressed JSON in an unreviewed relation or in a different named column',async()=>fixture(async(client,target)=>{
    await client.unsafe('CREATE TABLE public.unreviewed_notification(payload jsonb)');
    await client.unsafe("INSERT INTO public.unreviewed_notification VALUES(jsonb_build_object('v',repeat('x',12000)))");
    expect((await metadata(client,'unreviewed_notification'))[0].method).toBe('pglz');await refused(collect(client,target));
    await client.unsafe('ALTER TABLE public.unreviewed_notification RENAME TO store_order_outbox; ALTER TABLE public.store_order_outbox RENAME COLUMN payload TO other');
    await refused(collect(client,target));
  }),30000);
  it('keeps the binary and whole-row budgets independent at the 32KiB boundary',async()=>fixture(async(client,target)=>{
    await client.unsafe('CREATE TABLE public.order_notification_delivery(payload jsonb)');
    await client.unsafe("INSERT INTO public.order_notification_delivery VALUES(jsonb_build_object('v',repeat('x',32768-pg_column_size(jsonb_build_object('v',''::text)))))");
    const [boundary]=await metadata(client,'order_notification_delivery');expect(boundary.method).toBe('pglz');expect(boundary.raw).toBe(32768);
    // 8*32768 plus row/key overhead exceeds the separate final-row budget.
    // Reaching the binary gate is not a promise that the whole row is safe.
    await refused(collect(client,target));
    await client.unsafe("UPDATE public.order_notification_delivery SET payload=jsonb_build_object('v',repeat('x',32700-pg_column_size(jsonb_build_object('v',''::text))))");
    expect((await metadata(client,'order_notification_delivery'))[0].raw).toBe(32700);
    expect((await collect(client,target)).rowCount).toBe('1');
    await client.unsafe("UPDATE public.order_notification_delivery SET payload=jsonb_build_object('v',repeat('x',40000))");
    const [size]=await metadata(client,'order_notification_delivery');expect(size.method).toBe('pglz');expect(size.physical).toBeLessThan(32768);expect(size.raw).toBeGreaterThan(32768);
    await refused(collect(client,target));
  }),30000);
  it('rejects compressed physical size above the gate and small raw JSON with excessive numeric output',async()=>fixture(async(client,target)=>{
    await client.unsafe('CREATE TABLE public.store_order_outbox(payload jsonb)');
    await client.unsafe("INSERT INTO public.store_order_outbox SELECT jsonb_build_object('v',string_agg(md5(n::text)||md5(n::text),'')) FROM generate_series(1,2500)n");
    const [large]=await metadata(client,'store_order_outbox');expect(large.method).toBe('pglz');expect(large.physical).toBeGreaterThan(32768);await refused(collect(client,target));
    await client.unsafe('TRUNCATE public.store_order_outbox');
    await client.unsafe("INSERT INTO public.store_order_outbox VALUES(jsonb_build_object('v',repeat('x',5000),'a',1e100000::numeric,'b',1e100000::numeric,'c',1e100000::numeric))");
    const [numeric]=await metadata(client,'store_order_outbox');expect(numeric.method).toBe('pglz');expect(numeric.raw).toBeLessThan(32768);expect(numeric.text_bytes).toBeGreaterThan(262144);
    await refused(collect(client,target));
  }),30000);
  it('keeps explicit builtin I/O on the new pglz path when a real peer adds a late JSONB-to-text cast',async()=>fixture(async(client,target,f)=>{
    if(!f.withPeer)throw Error('Actual independent PG peer required');
    await client.unsafe('CREATE TABLE public.store_order_outbox(payload jsonb)');
    await client.unsafe("INSERT INTO public.store_order_outbox VALUES(jsonb_build_object('v',repeat('x',12000)))");
    expect((await metadata(client,'store_order_outbox'))[0].method).toBe('pglz');
    await f.withPeer(async peer=>{
      let installed=false;
      const observed=new Proxy(client,{get(owner,key,receiver){
        if(key!=='begin')return Reflect.get(owner,key,receiver);
        return(mode:string,action:(tx:postgres.TransactionSql)=>Promise<unknown>)=>client.begin(mode,tx=>action(new Proxy(tx,{get(bound,property,inner){
          if(property!=='unsafe')return Reflect.get(bound,property,inner);
          return(text:string,...args:unknown[])=>(async()=>{
            if(!installed&&text.startsWith('DECLARE routine_inventory_cursor')&&text.includes('LEFT JOIN ONLY "public"."store_order_outbox"')){
              await peer.exec(`CREATE FUNCTION public.notification_cast(jsonb) RETURNS text LANGUAGE plpgsql AS $$BEGIN
                RAISE EXCEPTION 'owned_notification_json_cast_executed'; END$$;
                CREATE CAST(jsonb AS text) WITH FUNCTION public.notification_cast(jsonb)`);installed=true;
            }
            return Reflect.apply(bound.unsafe,bound,[text,...args]);
          })();
        }})));
      }});
      try{
        expect((await collect(observed,target)).rowCount).toBe('1');expect(installed).toBe(true);
        await expect(client.unsafe('SELECT payload::text FROM public.store_order_outbox')).rejects.toThrow('owned_notification_json_cast_executed');
      }finally{if(installed)await peer.exec('DROP CAST(jsonb AS text); DROP FUNCTION public.notification_cast(jsonb)');}
    });
  }),30000);
});
