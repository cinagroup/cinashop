import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { cleanupFingerprint,cleanupOrphanRows } from '../src/migrations/orphanTestOrderCleanup';
import { collectOrphanTestOrderSnapshot,snapshotHash } from '../src/migrations/orphanTestOrderSnapshot';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('exact backed-up orphan cleanup on isolated PG16',()=>{
  let f:Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async()=>{
    f=await sequenceRunnerDatabase();
    await f.exec(`CREATE TABLE public."user"(uid integer PRIMARY KEY,balance numeric);
      INSERT INTO public."user" VALUES(1,100);
      CREATE TABLE public.store_order(id integer PRIMARY KEY,uid integer,pid integer,paid integer,is_del integer,
        refund_status integer,pay_price numeric,order_id text,pay_type text);
      INSERT INTO public.store_order SELECT i,999,0,1,0,0,10,'test_'||i,'yue' FROM generate_series(201,212) i;
      INSERT INTO public.store_order VALUES(999,1,0,1,0,0,10,'retained','yue');
      CREATE TABLE public.store_order_cart_info(id integer PRIMARY KEY,oid integer,uid integer);
      INSERT INTO public.store_order_cart_info SELECT i,i,999 FROM generate_series(201,212) i;
      CREATE TABLE public.store_order_refund(id integer PRIMARY KEY,store_order_id integer,uid integer,refund_type integer,refunded_price numeric,apply_type integer);
      INSERT INTO public.store_order_refund VALUES(2,203,999,0,0,1),(3,204,999,0,0,1);
      CREATE TABLE public.store_order_status(id integer PRIMARY KEY,oid integer);
      INSERT INTO public.store_order_status SELECT i,201 FROM generate_series(1,14) i;
      CREATE TABLE public.store_product_reply(id integer PRIMARY KEY,oid integer,uid integer,order_cart_info_id integer);
      INSERT INTO public.store_product_reply VALUES(1,201,999,201),(2,202,999,202);
      ALTER TABLE public.store_product_reply ADD CONSTRAINT spr_order_cart_info_fk FOREIGN KEY(order_cart_info_id) REFERENCES public.store_order_cart_info(id) NOT VALID;
      CREATE TABLE public.user_bill(id integer PRIMARY KEY,uid integer,link_id text,type text,category text,pm integer,status integer);
      INSERT INTO public.user_bill SELECT i,999,'test_'||(200+i),'pay_product','now_money',0,1 FROM generate_series(1,12) i;
      CREATE TABLE public.user_brokerage(id integer PRIMARY KEY,uid integer,link_id text,type text,category text,pm integer,status integer);
      INSERT INTO public.user_brokerage SELECT i,1000,'test_205','order_brokerage','one_brokerage',1,1 FROM generate_series(1,4) i;
      INSERT INTO public.user_brokerage VALUES(7,1000,'201','extract','extract',0,-1);
      CREATE TABLE public.store_product_reply_comment(id integer,reply_id integer);`);
  });
  afterEach(async()=>{await f?.close();});
  const digest=()=>f.db.$client.begin('read only',async tx=>snapshotHash(await collectOrphanTestOrderSnapshot(tx)));
  const run=(expected:string)=>f.db.$client.begin(async tx=>cleanupOrphanRows(tx,expected));
  const fingerprint=()=>f.db.$client.begin('read only',tx=>cleanupFingerprint(tx));
  it('deletes exactly 58 backed-up rows, preserves collision and all remaining rows',async()=>{
    const result=await run(await digest());
    expect(result.deleted.reduce((n,r)=>n+r.rows,0)).toBe(58);
    expect(result.preservedCandidateRows).toBe(1);
    expect(await fingerprint()).toEqual(result.retained);
    expect(await f.db.$client`SELECT id FROM public.store_order`).toEqual([{id:999}]);
    expect(await f.db.$client`SELECT id FROM public.user_brokerage`).toEqual([{id:7}]);
    expect(result.remainingOrphans).toBe(0);
  });
  it('refuses stale backup before any deletion',async()=>{
    const old=await digest(); await f.exec('UPDATE public.store_order SET pay_price=11 WHERE id=201');
    const before=await fingerprint(); await expect(run(old)).rejects.toThrow('Backup snapshot changed');
    expect(await fingerprint()).toEqual(before);
  });
  it('refuses an active writer immediately with NOWAIT and leaves rows untouched',async()=>{
    const old=await digest(),before=await fingerprint();
    await f.withPeer!(async peer=>peer.db.$client.begin(async tx=>{
      await tx`LOCK TABLE public.user_bill IN ROW EXCLUSIVE MODE`;
      await expect(run(old)).rejects.toMatchObject({code:'55P03'});
    }));
    expect(await fingerprint()).toEqual(before);
  });
  it('refuses unreviewed indirect references even when the direct snapshot is unchanged',async()=>{
    const old=await digest(); await f.exec('INSERT INTO public.store_product_reply_comment VALUES(1,1)');
    const before=await fingerprint(); await expect(run(old)).rejects.toThrow('Unsafe cleanup dependencies');
    expect(await fingerprint()).toEqual(before);
  });
  it('refuses user triggers without disabling them',async()=>{
    await f.exec(`CREATE FUNCTION public.refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN OLD; END$$;
      CREATE TRIGGER custom_delete BEFORE DELETE ON public.store_order FOR EACH ROW EXECUTE FUNCTION public.refuse_delete();`);
    const before=await fingerprint(); await expect(run(await digest())).rejects.toThrow('Unsafe cleanup dependencies');
    expect(await fingerprint()).toEqual(before);
  });
  it('refuses changed business-domain ownership despite a freshly supplied digest',async()=>{
    await f.exec("UPDATE public.user_bill SET type='recharge' WHERE id=1");
    const before=await fingerprint(); await expect(run(await digest())).rejects.toThrow('scope or ownership');
    expect(await fingerprint()).toEqual(before);
  });
  it('rolls the real transaction back on a later SQL failure after earlier deletions',async()=>{
    const old=await digest(),before=await fingerprint();
    await expect(f.db.$client.begin(async tx=>{
      const wrapped=new Proxy(tx,{get(target,key,receiver){
        if(key==='unsafe') return (statement:string,params:Parameters<typeof tx.unsafe>[1])=>
          statement.startsWith('DELETE FROM ONLY public."user_bill"') ? target.unsafe('SELECT 1/0') : target.unsafe(statement,params);
        return Reflect.get(target,key,receiver);
      }});
      return cleanupOrphanRows(wrapped,old);
    })).rejects.toThrow();
    expect(await fingerprint()).toEqual(before);
  });
});
