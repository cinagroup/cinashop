/** Full schema, actual HTTP/JWT and commissioned independent PG16 LOGINs. */
import { describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { createContainerFromDb } from '@/lib/di';
import { storeOrder, storeOrderStatus, user, workClient, workClientCurrent, workClientFollow, workMember } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { StoreDeliveryOrderService } from '@/services/order/StoreDeliveryOrderService';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { withEditScenario, type EditScenario } from './helpers/adminOrderEdit';
import { orderCreationClient } from './helpers/orderCreationHistory';
import { orderTimelineWork } from './helpers/orderTimelineWork';

const id = 820001, number = 'TimelineOwned';
const empty = { create: '', pay: '', delivery: '', take: '', complete: '' };
const state = async (s: EditScenario) => ({ business: await s.f.state(), sequences: await s.f.exec("SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename") });
const record = (s: EditScenario, changeType: string, changeTime: number, oid = id) => s.f.db.insert(storeOrderStatus).values({ oid, changeType, changeTime, changeMessage: 'Declared historical test record' });
const detail = (s: EditScenario, token: string, key = number) => s.request('GET', '/api/order/detail/' + key, undefined, token);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('buyer, city and Work order lifecycle records through native App', () => {
  it('reads the actual unpaid checkout creation through both buyer contracts without business or sequence writes', async () => withEditScenario(async s => {
    const client = await orderCreationClient(s), { order } = await client.checkout(), before = await state(s);
    const result = await detail(s, client.token, order.orderId);
    expect(result.status, result.msg).toBe(200); expect(result.data.order_log).toEqual({ ...empty, create: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(result.headers.get('cache-control')).toContain('no-store');
    const city = await s.request('GET', '/api/delivery_order/detail/' + order.id, undefined, client.token);
    expect(city.status, city.msg).toBe(200); expect(city.data.order_log).toEqual({ create: result.data.order_log.create, pay: '', city_delivery: [], take: '', complete: '' });
    expect(await state(s)).toEqual(before);
  }), 120000);

  it('does not synthesize dates from a paid/completed header or unrelated history', async () => withEditScenario(async s => {
    const client = await orderCreationClient(s); await s.seed(id, number);
    await s.f.db.update(storeOrder).set({ paid: 1, status: 2, addTime: 1700000000, payTime: 1700000010 }).where(eq(storeOrder.id, id));
    await record(s, 'split_create_order', 1700000000); const before = await state(s);
    const result = await detail(s, client.token); expect(result.status, result.msg).toBe(200); expect(result.data.order_log).toEqual(empty);
    expect(await state(s)).toEqual(before);
  }), 120000);

  it('uses exact event types, delivery priority, Shanghai DST and latest recorded time', async () => withEditScenario(async s => {
    const client = await orderCreationClient(s); await s.seed(id, number);
    for (const [kind, time] of [['cache_key_create_order', -1], ['pay_success', 86400], ['pay_success', 0],
      ['delivery', 0], ['delivery_goods', 172800], ['delivery_fictitious', 259200],
      ['take_delivery', Date.UTC(1988, 6, 1, 15, 30) / 1000], ['check_order_over', 2147483647]] as const) await record(s, kind, time);
    const before = await state(s), result = await detail(s, client.token);
    expect(result.status, result.msg).toBe(200); expect(result.data.order_log).toEqual({ create: '1970-01-01', pay: '1970-01-02', delivery: '1970-01-01', take: '1988-07-02', complete: '2038-01-19' });
    expect(await state(s)).toEqual(before);
  }), 120000);

  it('bounds city types after deduplication and keeps PHP substring/fallback behavior', async () => withEditScenario(async s => {
    const client = await orderCreationClient(s); await s.seed(id, number);
    await s.f.db.execute(sql`INSERT INTO store_order_status(oid,change_type,change_time) SELECT ${id},'city_delivery_2',n FROM generate_series(0,10001) n`);
    await record(s, 'prefix_city_delivery_100', 10002); const before = await state(s);
    const result = await s.request('GET', '/api/delivery_order/detail/' + id, undefined, client.token);
    expect(result.status, result.msg).toBe(200); expect(result.data.order_log.city_delivery).toEqual([
      { time: '1970-01-01 10:46:41', label: '待取货' }, { time: '1970-01-01 10:46:42', label: '配送中' }]);
    expect(await state(s)).toEqual(before);
    await s.f.db.execute(sql`INSERT INTO store_order_status(oid,change_type,change_time) SELECT ${id},'city_delivery_unknown_'||n,n FROM generate_series(1,10001) n`);
    const failed = await s.request('GET', '/api/delivery_order/detail/' + id, undefined, client.token);
    expect(failed.status).not.toBe(200); expect(failed.data).toBeNull(); expect(failed.msg).toContain('记录类型过多');
  }), 120000);

  it('enforces buyer ownership/deletions and never shares lifecycle dates between parent and child', async () => withEditScenario(async s => {
    const client = await orderCreationClient(s); await s.seed(id, number); await s.seed(id + 1, 'TimelineChild');
    await s.f.db.update(storeOrder).set({ pid: id }).where(eq(storeOrder.id, id + 1));
    await record(s, 'delivery', 86400, id + 1);
    expect((await detail(s, client.token)).data.order_log).toEqual(empty);
    expect((await detail(s, client.token, 'TimelineChild')).data.order_log.delivery).toBe('1970-01-02');
    const [other] = await s.f.db.select().from(user).where(eq(user.uid, 22));
    const foreign = (await createToken(22, 'api', md5(other.pwd), s.env.APP_KEY)).token;
    for (const token of [foreign, s.token('root'), s.token('supplier'), null]) {
      for (const path of ['/api/order/detail/' + number, '/api/delivery_order/detail/' + id]) {
        const denied = await s.request('GET', path, undefined, token); expect(denied.status).not.toBe(200); expect(denied.headers.get('cache-control')).toContain('no-store');
      }
    }
    await s.f.db.update(storeOrder).set({ isSystemDel: 1 }).where(eq(storeOrder.id, id));
    expect((await detail(s, client.token)).status).not.toBe(200);
    // PHP city contract checks is_del only; retain its distinct visibility rule.
    expect((await s.request('GET', '/api/delivery_order/detail/' + id, undefined, client.token)).status).toBe(200);
    await s.f.db.update(storeOrder).set({ isDel: 1 }).where(eq(storeOrder.id, id));
    expect((await s.request('GET', '/api/delivery_order/detail/' + id, undefined, client.token)).status).not.toBe(200);
  }), 120000);

  it.each(['buyer', 'city', 'work'] as const)('keeps %s physical reads in one read-only repeatable-read snapshot under a committed peer event', async kind => withEditScenario(async s => {
    const work = kind === 'work' ? await orderTimelineWork(s) : null;
    const client = await orderCreationClient(s); await s.seed(id, number); let reached = false;
    const actual = PostgresJsSession.prototype.prepareQuery;
    const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
      const prepared = actual.apply(this, args);
      if (/from "store_order" where/i.test(args[0].sql)) {
        const execute = prepared.execute.bind(prepared);
        prepared.execute = async values => {
          const result = await execute(values);
          if (!reached) { reached = true;
            const [settings] = await this.client.unsafe("SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation,current_setting('statement_timeout') AS timeout");
            expect(settings).toEqual({ readonly: 'on', isolation: 'repeatable read', timeout: '5s' });
            await record(s, 'delivery', 86400); await record(s, 'city_delivery_2', 86400);
          }
          return result;
        };
      }
      return prepared;
    });
    const read = () => kind === 'work' ? s.request('GET', '/api/work/order/info/' + id, undefined, work!.context.token)
      : kind === 'city' ? s.request('GET', '/api/delivery_order/detail/' + id, undefined, client.token) : detail(s, client.token);
    try { const result = await read(); expect(result.status, result.msg).toBe(200); const log = kind === 'work' ? result.data.orderInfo.order_log : result.data.order_log;
      expect(kind === 'city' ? log.city_delivery : log.delivery).toEqual(kind === 'city' ? [] : '');
    } finally { spy.mockRestore(); }
    expect(reached).toBe(true); const fresh = await read(); expect(fresh.status, fresh.msg).toBe(200);
    expect(kind === 'city' ? fresh.data.order_log.city_delivery.length : kind === 'work' ? fresh.data.orderInfo.order_log.delivery : fresh.data.order_log.delivery).toBe(kind === 'city' ? 1 : '1970-01-02');
  }), 120000);

  it('reads with SELECT-only LOGINs and restores connection settings', async () => withEditScenario(async s => {
    await s.seed(id, number); await record(s, 'delivery', 0);
    await s.f.withRuntimeRole!(async role => {
      await s.f.db.execute(sql.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role.role}"`));
      const settings = () => role.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`), before = await settings();
      const container = createContainerFromDb(role.db);
      expect((await new StoreOrderCreateService(container, s.env).detail(11, number)).order_log.delivery).toBe('1970-01-01');
      expect((await new StoreDeliveryOrderService(container).detail(11, id)).order_log.city_delivery).toEqual([]);
      expect(await settings()).toEqual(before);
      const [rights] = await role.db.execute(sql`SELECT has_table_privilege(current_user,'store_order_status','INSERT,UPDATE,DELETE') AS writes`); expect(rights.writes).toBe(false);
    });
  }), 120000);

  it.each(['member', 'follow', 'binding', 'current-sentinel'] as const)('rejects a previously issued Work context after %s changes', async kind => withEditScenario(async s => {
    const work = await orderTimelineWork(s); await s.seed(id, number); await record(s, 'delivery', 0);
    const path = '/api/work/order/info/' + id, result = await s.request('GET', path, undefined, work.context.token);
    expect(result.status, result.msg).toBe(200); expect(result.data.orderInfo.order_log).toEqual({ ...empty, delivery: '1970-01-01' });
    expect(result.headers.get('cache-control')).toContain('no-store');
    if (kind === 'member') await s.f.db.update(workMember).set({ enable: 0 }).where(eq(workMember.userid, work.userid));
    if (kind === 'follow') await s.f.db.update(workClientFollow).set({ isDelUser: 1 }).where(eq(workClientFollow.id, work.follow.id));
    if (kind === 'binding') await s.f.db.update(workClient).set({ uid: 22 }).where(eq(workClient.id, work.client.id));
    if (kind === 'current-sentinel') await s.f.db.insert(workClientCurrent).values({ corpId: work.corpId, externalUserid: work.externalUserid, uid: 11 });
    const before = await state(s), denied = await s.request('GET', path, undefined, work.context.token);
    expect(denied.status).not.toBe(200); expect(denied.data).toBeNull(); expect(await state(s)).toEqual(before);
  }), 120000);

  it('rechecks Work authorization after the snapshot instead of returning revoked customer data', async () => withEditScenario(async s => {
    const work = await orderTimelineWork(s); await s.seed(id, number); let revoked = false;
    const actual = PostgresJsSession.prototype.prepareQuery;
    const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
      const prepared = actual.apply(this, args);
      if (args[0].sql.includes('distinct on ("store_order_status"."change_type")')) {
        const execute = prepared.execute.bind(prepared); prepared.execute = async values => {
          const result = await execute(values); if (!revoked) { revoked = true; await s.f.db.update(workClientFollow).set({ isDelUser: 1 }).where(eq(workClientFollow.id, work.follow.id)); } return result;
        };
      } return prepared;
    });
    try { const result = await s.request('GET', '/api/work/order/info/' + id, undefined, work.context.token); expect(result.status).not.toBe(200); expect(result.data).toBeNull(); }
    finally { spy.mockRestore(); } expect(revoked).toBe(true);
  }), 120000);
});
