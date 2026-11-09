/** Actual App SQL routing only. All inserted rows are explicitly controlled
 * outbox specimens, not accepted payment/refund/provider or notice authority.
 * The local Queue mock observes dispatch; no consumer or remote send runs. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrderMessage } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { rechargeRefundNoticeStorageRuntimeFixture } from './helpers/rechargeRefundNoticeStorageRuntimeNative';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual App passive recharge refund notice routing', () => {
  type Fixture = Awaited<ReturnType<typeof rechargeRefundNoticeStorageRuntimeFixture>>;
  let f: Fixture, setup: Promise<void> | undefined, pending: Promise<unknown> | undefined, busy = false;
  const sendBatch = vi.fn(async (messages: unknown[]) => { void messages; });
  const queue = { send: vi.fn(async () => undefined), sendBatch } as unknown as Queue<OrderMessage>;
  const service = () => new OrderOutboxService(createContainerFromDb(f.appRuntime.db), { ORDER_QUEUE: queue });
  const start = <T>(run: () => Promise<T>) => {
    if (busy) throw Error('Previous passive routing case still pending');
    busy = true;
    const work = run().finally(() => { busy = false; });
    pending = work;
    void work.catch(() => undefined);
    return work;
  };
  beforeAll(async () => {
    setup = (async () => {
      f = await rechargeRefundNoticeStorageRuntimeFixture();
      await f.appRuntime.db.execute(sql`SELECT
        pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',false),
        pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',false),
        pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',false)`);
      const [identity] = await f.appRuntime.db.execute<{ role: string; session: string; backend: string }>(sql`SELECT
        current_user AS role, session_user AS session,
        (SELECT pg_catalog.pg_get_userbyid(usesysid) FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()) AS backend`);
      expect(identity).toMatchObject({ role: f.appRuntime.role, session: f.appRuntime.role, backend: f.appRuntime.role });
      // A clean catalog fixture is a prerequisite, never silently delete or
      // relabel unrelated business events to manufacture a passing batch.
      const [eligible] = await f.appRuntime.db.execute<{ count: string }>(sql`SELECT count(*)::text AS count
        FROM public.store_order_outbox
        WHERE status IN ('PENDING','FAILED') AND available_time <= floor(extract(epoch FROM pg_catalog.clock_timestamp()))
          OR status IN ('ENQUEUING','ENQUEUED','PROCESSING') AND lease_until <= floor(extract(epoch FROM pg_catalog.clock_timestamp()))`);
      expect(eligible?.count).toBe('0');
    })();
    await setup;
  }, 240000);
  afterAll(async () => {
    try {
      if (setup) await Promise.allSettled([setup]);
      if (pending) await Promise.allSettled([pending]);
    } finally {
      await f?.close();
      vi.restoreAllMocks();
    }
  }, 30000);

  async function passive(status = 'PENDING') {
    const [row] = await f.appRuntime.db.execute<{ id: number }>(sql`INSERT INTO public.store_order_outbox
      (event_key,aggregate_type,aggregate_id,event_type,payload,status,available_time,lease_until)
      VALUES(${'recharge.refund.success.notice:' + randomUUID()},'recharge',531000001,'recharge.refund.success.notice',
        '{"catalog_routing_specimen":true}'::jsonb,${status},0,0) RETURNING id`);
    if (!row || !Number.isInteger(row.id) || row.id < 1) throw Error('Actual controlled passive row missing');
    return row.id;
  }
  async function legacy(orderId: number) {
    const [row] = await f.appRuntime.db.execute<{ id: number; event_key: string }>(sql`INSERT INTO public.store_order_outbox
      (event_key,aggregate_type,aggregate_id,event_type,payload,status,available_time)
      VALUES(${'order.paid:' + orderId},'order',${orderId},'order.paid',
        ${JSON.stringify({ orderId, orderNo: 'catalog-routing-' + orderId })}::jsonb,'PENDING',0) RETURNING id,event_key`);
    if (!row || !Number.isInteger(row.id) || row.id < 1) throw Error('Actual controlled old row missing');
    return row;
  }
  async function snapshot(ids: readonly number[]) {
    const [row] = await f.appRuntime.db.execute<{ rows: unknown }>(sql`SELECT
      jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) AS rows
      FROM public.store_order_outbox t WHERE id IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)})`);
    return JSON.stringify(row.rows);
  }

  it('excludes the earlier new row before LIMIT and enqueues the eligible old row alone', () => start(async () => {
    sendBatch.mockClear();
    const held = await passive(), old = await legacy(531000001), before = await snapshot([held]);
    expect(held).toBeLessThan(old.id);
    expect(await service().dispatchPending(1)).toEqual({ claimed: 1, enqueued: 1 });
    expect(sendBatch).toHaveBeenCalledExactlyOnceWith([{
      body: { action: 'processOrderPaidOutbox', outboxId: old.id, eventKey: old.event_key }, contentType: 'json',
    }]);
    expect(await snapshot([held])).toBe(before);
    const [oldState] = await f.appRuntime.db.execute(sql`SELECT status,dispatch_count FROM public.store_order_outbox WHERE id=${old.id}`);
    expect(oldState).toMatchObject({ status: 'ENQUEUED', dispatch_count: 1 });
  }), 5000);

  it('keeps an explicitly selected passive row unchanged without Queue IO', () => start(async () => {
    sendBatch.mockClear();
    const held = await passive(), before = await snapshot([held]);
    expect(await service().dispatchById(held)).toEqual({ claimed: 0, enqueued: 0 });
    expect(await snapshot([held])).toBe(before);
    expect(sendBatch).not.toHaveBeenCalled();
  }), 5000);

  it('never claims new pending, retry or expired-lease specimens and preserves every row xmin', () => start(async () => {
    sendBatch.mockClear();
    const ids: number[] = [];
    for (const status of ['PENDING', 'FAILED', 'ENQUEUING', 'ENQUEUED', 'PROCESSING']) ids.push(await passive(status));
    const before = await snapshot(ids);
    expect(await service().dispatchPending(100)).toEqual({ claimed: 0, enqueued: 0 });
    expect(await snapshot(ids)).toBe(before);
    expect(sendBatch).not.toHaveBeenCalled();
  }), 5000);

  it('retains the passive row when a claimed old event experiences a real Queue rejection', () => start(async () => {
    sendBatch.mockClear();
    const held = await passive(), old = await legacy(531000002), before = await snapshot([held]);
    sendBatch.mockRejectedValueOnce(Error('controlled local Queue rejection'));
    await expect(service().dispatchPending(100)).rejects.toThrow('controlled local Queue rejection');
    expect(sendBatch).toHaveBeenCalledExactlyOnceWith([{
      body: { action: 'processOrderPaidOutbox', outboxId: old.id, eventKey: old.event_key }, contentType: 'json',
    }]);
    expect(await snapshot([held])).toBe(before);
    const [oldState] = await f.appRuntime.db.execute(sql`SELECT status,dispatch_count,lease_token,lease_until
      FROM public.store_order_outbox WHERE id=${old.id}`);
    expect(oldState).toMatchObject({ status: 'FAILED', dispatch_count: 1, lease_token: '', lease_until: 0 });
  }), 5000);
});
