import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { collectOrphanTestOrderSnapshot, configureOrphanInspection, snapshotHash } from '../src/migrations/orphanTestOrderSnapshot';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('private orphan snapshot on owned native PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async () => {
    f = await sequenceRunnerDatabase();
    await f.exec(`CREATE TABLE public."user"(uid integer PRIMARY KEY);
      CREATE TABLE public.store_order(id integer PRIMARY KEY,uid integer,pid integer,paid integer,is_del integer,
        refund_status integer,pay_price numeric(12,2),order_id text);
      CREATE TABLE public.candidate_link(id bigint PRIMARY KEY,oid integer,link_id text,payload jsonb);
      INSERT INTO public."user" VALUES (1);
      INSERT INTO public.store_order SELECT i,999,0,1,0,0,10.00,'synthetic_'||i FROM generate_series(201,212) i;
      INSERT INTO public.store_order VALUES(999,1,0,1,0,0,10,'unrelated');
      INSERT INTO public.candidate_link VALUES(9007199254740993,201,'0','{}'),(2,0,'212','{}'),(3,999,'0','{}');`);
  });
  afterEach(async () => { await f?.close(); });
  const snapshot = () => f.db.$client.begin('isolation level repeatable read read only', async tx => {
    await configureOrphanInspection(tx); return collectOrphanTestOrderSnapshot(tx);
  });
  it('runs real SQL with lossless values, exact targets and stable hashes without writes', async () => {
    const first = await snapshot();
    expect(first.orders.map(r => r.id)).toEqual(Array.from({length:12},(_,i)=>201+i));
    expect(first.related[0].rows).toHaveLength(2);
    expect(first.related[0].rows.join('')).toContain('9007199254740993');
    expect(first.related[0].rows.join('')).not.toContain('"oid": 999');
    expect(snapshotHash(await snapshot())).toBe(snapshotHash(first));
    const counts = await f.db.$client<{ n: number }[]>`SELECT count(*)::integer AS n FROM public.store_order`;
    expect(counts[0].n).toBe(13);
  });
  it('refuses a changed twelve-order set', async () => {
    await f.exec('UPDATE public.store_order SET paid=0 WHERE id=201');
    await expect(snapshot()).rejects.toThrow('twelve-order target has changed');
  });
  it('bounds candidate output on the server before transferring row JSON', async () => {
    await f.exec(`INSERT INTO public.candidate_link SELECT i,201,'0','{}' FROM generate_series(1000,2000) i`);
    await expect(snapshot()).rejects.toThrow('Reference row budget');
  });
  it('reports descendants for review but does not include them in the twelve-order target', async () => {
    await f.exec('UPDATE public.store_order SET pid=201 WHERE id=999');
    const result = await snapshot();
    expect(result.descendants.map(r=>r.id)).toEqual([999]); expect(result.orders).toHaveLength(12);
  });
  it('rejects unexpected quoted identifiers rather than interpolating catalog SQL', async () => {
    await f.exec('CREATE TABLE public."unsafe name"(order_id integer)');
    await expect(snapshot()).rejects.toThrow('identifier or table budget');
  });
});
