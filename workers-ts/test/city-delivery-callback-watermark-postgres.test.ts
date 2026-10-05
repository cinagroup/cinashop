import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import type { Env, OrderMessage } from '../src/env';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { CITY_DELIVERY_CALLBACK_PIPELINE_SQL } from '../src/migrations/cityDeliveryCallbackPipeline';
import { runtimeBusinessPrivilegePlan } from '../src/migrations/runtimeBusinessPrivilegePlan';
import { cityDeliveryCallbackEvent as eventTable, cityDeliveryCallbackOutbox as outboxTable, cityDeliveryCallbackWatermark as watermarkTable,
  cityDeliveryReconciliationCase, storeDeliveryOrder, storeOrder, storeOrderStatus, systemConfig } from '../src/models/schema';
import { CityDeliveryCallbackService, isCityDeliveryCallbackOutboxMessage } from '../src/services/delivery/CityDeliveryCallbackService';
import { dadaCallbackChecksum, normalizeDadaCityDeliveryQuery, verifyDadaCityDeliveryCallback,
  type CityDeliveryProvider, type VerifiedCityDeliveryEvent } from '../src/services/delivery/DadaCityDeliveryCallback';
import { normalizeUuCityDeliveryQuery, verifyUuCityDeliveryCallback } from '../src/services/delivery/UuCityDeliveryCallback';
import { cityDeliveryRecordFixture } from './helpers/cityDeliveryRecordFixture';

const DADA_TOKEN = 'owned-dada-watermark-token-32-bytes', UU_TOKEN = 'owned-uu-watermark-token-32-bytes';
const CLIENT = 'owned-dada-client', OPEN = 'owned-uu-open-id';
const identifier = (value: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned callback identifier');
  return `"${value}"`;
};
type Source = 'callback' | 'query';
type CallbackQueueEntry = Parameters<Env['ORDER_QUEUE']['sendBatch']>[0] extends Iterable<infer Entry> ? Entry : never;
type CallbackWatermarkTestBindings = Pick<Env, 'APP_KEY' | 'DADA_CALLBACK_TOKEN' | 'DADA_CLIENT_ID' | 'UU_CALLBACK_TOKEN' | 'UU_OPEN_ID'> & {
  NODE_ENV: 'test';
  // This enqueue-only double records the actual producer's array calls.
  // Cloudflare metrics/metadata are unused and intentionally not fabricated.
  ORDER_QUEUE: { send: (body: Parameters<Env['ORDER_QUEUE']['send']>[0]) => Promise<void>;
    sendBatch: (entries: CallbackQueueEntry[]) => Promise<void> };
};
type Subject = { id: number; provider: CityDeliveryProvider; providerId: string; code: string };
function verified(subject: Subject, source: Source, status: number, time: number): VerifiedCityDeliveryEvent {
  if (subject.provider === 'dada') {
    const body = { client_id: CLIENT, order_id: subject.providerId, order_status: status, update_time: time,
      cancel_from: 0, repeat_reason_type: 0, cancel_reason: 'owned regression reason', finish_code: '4321', dm_name: '确认骑手', dm_mobile: '13800138000' };
    return source === 'callback'
      ? verifyDadaCityDeliveryCallback(JSON.stringify({ ...body, signature: dadaCallbackChecksum(CLIENT, subject.providerId, String(time)) }),
        { requestToken: DADA_TOKEN, callbackToken: DADA_TOKEN, expectedClientId: CLIENT })
      : normalizeDadaCityDeliveryQuery(body, { expectedClientId: CLIENT, providerOrderId: subject.providerId, observedAt: time });
  }
  const biz = { originId: subject.providerId, orderCode: subject.code, state: status, changeTime: time * 1000,
    stateText: 'owned regression state', driverName: '确认跑男', driverMobile: '13900139000' };
  return source === 'callback'
    ? verifyUuCityDeliveryCallback(JSON.stringify({ openId: OPEN, timestamp: time * 1000, sign: '0123456789ABCDEF0123456789ABCDEF', biz: JSON.stringify(biz) }),
      { requestToken: UU_TOKEN, callbackToken: UU_TOKEN, expectedOpenId: OPEN })
    : normalizeUuCityDeliveryQuery(biz, { expectedOpenId: OPEN, originId: subject.providerId, observedAt: time });
}
async function fixture() {
  const f = await cityDeliveryRecordFixture();
  try {
    // Exact migrated callback DDL, including durable constraints/indexes/FKs;
    // no ad-hoc replacement table shape and no runtime DDL capability.
    await f.exec(CITY_DELIVERY_CALLBACK_PIPELINE_SQL);
    const dialect = new PgDialect();
    for (const table of [storeOrderStatus, systemConfig]) {
    const definition = getTableConfig(table), columns = definition.columns.map(column => {
      const initial = column.default === undefined ? '' : ` DEFAULT ${column.default instanceof SQL
        ? dialect.sqlToQuery(column.default).sql : dialect.sqlToQuery(sql`${column.default}`.inlineParams()).sql}`;
      return `${identifier(column.name)} ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
    });
    await f.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);
    }
    const callbackTables = [eventTable, outboxTable, watermarkTable, cityDeliveryReconciliationCase, storeDeliveryOrder, storeOrder, storeOrderStatus, systemConfig];
    const messages: OrderMessage[] = [];
    // Only the checked callback/queue test boundary is supplied. Other Worker
    // bindings are disabled; provider fetches are forbidden by the tripwire.
    const env = ({ APP_KEY: 'owned-watermark-test', NODE_ENV: 'test', DADA_CALLBACK_TOKEN: DADA_TOKEN, DADA_CLIENT_ID: CLIENT,
      UU_CALLBACK_TOKEN: UU_TOKEN, UU_OPEN_ID: OPEN,
      ORDER_QUEUE: { send: async (body: OrderMessage) => { messages.push(body); },
        sendBatch: async (entries: { body: OrderMessage }[]) => { messages.push(...entries.map(entry => entry.body)); } } } satisfies CallbackWatermarkTestBindings) as unknown as Env;
    const profiles = async <T>(run: (app: DbClient, admin: DbClient) => Promise<T>) => f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
      await f.installReadSlice(app, admin);
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
        const plan = runtimeBusinessPrivilegePlan(kind);
        for (const table of callbackTables) {
          const tableConfig = getTableConfig(table), privileges = plan.tables[tableConfig.name];
          if (!privileges?.includes('SELECT')) throw Error('Missing callback production privileges');
          await f.exec(`GRANT ${privileges.join(',')} ON public.${identifier(tableConfig.name)} TO ${identifier(peer.role)}`);
          const updates = plan.updateColumns[tableConfig.name];
          if (updates?.length) await f.exec(`GRANT UPDATE(${updates.map(identifier).join(',')}) ON public.${identifier(tableConfig.name)} TO ${identifier(peer.role)}`);
          if (privileges.includes('INSERT')) for (const column of tableConfig.columns) {
            if (!['serial', 'bigserial'].includes(column.getSQLType())) continue;
            const [sequence] = await f.exec(`SELECT pg_get_serial_sequence('public.${tableConfig.name}','${column.name}') AS name`);
            const parts = String(sequence.name).split('.');
            if (parts.length !== 2 || parts[0] !== 'public') throw Error('Unexpected owned callback sequence');
            await f.exec(`GRANT USAGE ON SEQUENCE public.${identifier(parts[1])} TO ${identifier(peer.role)}`);
          }
        }
        const [identity] = await peer.exec("SELECT current_user AS role,session_user AS session,has_schema_privilege(current_user,'public','CREATE') AS ddl");
        expect(identity).toEqual({ role: peer.role, session: peer.role, ddl: false });
      }
      return run(app.db, admin.db);
    }));
    const service = (db: DbClient) => new CityDeliveryCallbackService(createContainerFromDb(db), env);
    const seed = async (provider: CityDeliveryProvider, id: number, orderStatus = 1): Promise<Subject> => {
      const providerId = `${provider}-wm-${id}`, code = `${providerId}-code`;
      await f.db.insert(storeOrder).values({ id, uid: 77, paid: 1, status: orderStatus, deliveryType: 'city_delivery', orderId: `original-${id}` });
      await f.db.insert(storeDeliveryOrder).values({ id, oid: id, uid: 77, stationType: provider === 'dada' ? 1 : 2,
        type: 0, relationId: 0, orderId: providerId, deliveryNo: code });
      return { id, provider, providerId, code };
    };
    const process = async (consumer: CityDeliveryCallbackService, evidence: VerifiedCityDeliveryEvent) => {
      const received = await consumer.receive(evidence);
      await consumer.dispatchById(received.outboxId);
      const message = messages.shift();
      if (!message || !isCityDeliveryCallbackOutboxMessage(message)) throw Error('Real dispatch did not enqueue the expected callback');
      const result = await consumer.processMessage(message);
      return { ...received, message, result };
    };
    const watermark = (evidence: VerifiedCityDeliveryEvent) => f.db.select().from(watermarkTable).where(and(eq(watermarkTable.provider, evidence.provider), eq(watermarkTable.subjectKeyHash, evidence.subjectKeyHash)));
    const business = async (subject: Subject) => ({ order: (await f.db.select().from(storeOrder).where(eq(storeOrder.id, subject.id)))[0],
      delivery: (await f.db.select().from(storeDeliveryOrder).where(eq(storeDeliveryOrder.id, subject.id)))[0],
      logs: await f.db.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, subject.id)).orderBy(storeOrderStatus.id) });
    const terminal = async (received: { eventId: number; outboxId: number }) => ({
      event: (await f.db.select().from(eventTable).where(eq(eventTable.id, received.eventId)))[0],
      outbox: (await f.db.select().from(outboxTable).where(eq(outboxTable.id, received.outboxId)))[0],
    });
    return { ...f, profiles, service, seed, process, watermark, business, terminal, messages };
  } catch (error) { await f.close(); throw error; }
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native callback UNKNOWN evidence never changes confirmed watermark authority', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const clock = Math.floor(Date.now() / 1000);
  beforeEach(async () => { f = await fixture(); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider network I/O')); }, 30_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30_000);
  const matrix = [['dada', 'callback'], ['dada', 'query'], ['uu', 'callback'], ['uu', 'query']] as const;
  it.each(matrix)('%s/%s preserves picked-up authority across newer and older UNKNOWN, blocking cancellation or superseding stale callback cancellation', async (provider, source) => f.profiles(async (app, admin) => {
    const consumer = f.service(provider === 'dada' ? app : admin);
    for (const [id, unknownTime, cancelTime] of [[1001, clock - 90, clock - 80], [1002, clock - 200, clock - 150]]) {
      const subject = await f.seed(provider, id), confirmed = verified(subject, source, provider === 'dada' ? 3 : 5, clock - 100);
      await f.process(consumer, confirmed);
      const authority = await f.watermark(confirmed), before = await f.business(subject);
      const unknown = verified(subject, source, 777, unknownTime), ignored = await f.process(consumer, unknown);
      const unknownAuthority = await f.watermark(confirmed), afterUnknown = await f.business(subject);
      const cancellation = await f.process(consumer, verified(subject, source, provider === 'dada' ? 5 : -1, cancelTime));
      const after = await f.business(subject), ignoredState = await f.terminal(ignored), cancelState = await f.terminal(cancellation);
      const expectedCancel = source === 'callback' && cancelTime < confirmed.providerUpdateTime ? 'SUPERSEDED' : 'CONFLICT';
      // Execute the entire vulnerable SQL sequence before asserting, so the
      // baseline red run shows the erroneous business rollback, not only rank.
      expect({ order: after.order.status, delivery: after.delivery.status, cancel: cancelState.event.status, cancelLogs: after.logs.filter(row => row.changeType === 'city_delivery_cancel').length })
        .toEqual({ order: 1, delivery: 3, cancel: expectedCancel, cancelLogs: 0 });
      expect(unknownAuthority).toEqual(authority); expect(afterUnknown).toEqual(before); expect(after).toEqual(before);
      expect(ignoredState.event).toMatchObject({ status: 'IGNORED', providerStatus: '777', providerUpdateTime: unknown.providerUpdateTime,
        finishCode: '', riderName: '', riderMobile: '', reasonText: '', leaseToken: '', leaseUntil: 0 });
      expect(ignoredState.outbox).toMatchObject({ status: 'COMPLETED', leaseToken: '', leaseUntil: 0 });
      const duplicate = await consumer.receive(unknown); expect(duplicate).toMatchObject({ duplicate: true, eventId: ignored.eventId, outboxId: ignored.outboxId, replayKey: ignored.replayKey });
      expect(await consumer.processMessage(ignored.message)).toBe('already-completed');
      expect(await f.terminal(ignored)).toEqual(ignoredState); expect(await f.watermark(confirmed)).toEqual(authority);
    }
  }));
  it.each(['dada', 'uu'] as const)('%s first UNKNOWN remains durable without inventing a confirmed cursor or blocking an older first-known callback', async provider => f.profiles(async (app, admin) => {
    for (const [index, source] of ['callback', 'query'].entries()) {
      const subject = await f.seed(provider, 1101 + index), consumer = f.service(provider === 'dada' ? app : admin);
      const unknown = verified(subject, source as Source, 777, clock - 50), ignored = await f.process(consumer, unknown);
      const afterUnknown = await f.watermark(unknown);
      const known = verified(subject, source as Source, provider === 'dada' ? 2 : 3, clock - 100), applied = await f.process(consumer, known);
      const current = await f.business(subject), appliedState = await f.terminal(applied);
      expect(afterUnknown).toEqual([]); expect(current.delivery.status).toBe(2); expect(appliedState.event.status).toBe('APPLIED');
      expect((await f.watermark(known))[0]).toMatchObject({ lastEventId: applied.eventId, lastEventKey: known.eventKey, lastState: 'WAITING_PICKUP', lastRank: 20, terminal: 0, providerUpdateTime: known.providerUpdateTime });
      expect((await f.terminal(ignored)).event.status).toBe('IGNORED'); expect((await f.terminal(ignored)).outbox.status).toBe('COMPLETED');
    }
  }));
  it.each(['dada', 'uu'] as const)('%s keeps known completion terminal/rank/time/key unchanged after UNKNOWN from either source', async provider => f.profiles(async (app, admin) => {
    for (const [index, source] of ['callback', 'query'].entries()) {
      // Already completed orders use the real APPLIED_NOOP projection branch;
      // this exercises terminal authority without substituting receipt logic.
      const subject = await f.seed(provider, 1201 + index, 2), consumer = f.service(provider === 'dada' ? app : admin);
      const completed = verified(subject, source as Source, provider === 'dada' ? 4 : 10, clock - 100);
      const receipt = await f.process(consumer, completed), authority = await f.watermark(completed), before = await f.business(subject);
      expect((await f.terminal(receipt)).event.status).toBe('APPLIED_NOOP'); expect(authority[0]).toMatchObject({ lastState: 'DELIVERED', lastRank: 60, terminal: 1 });
      for (const time of [clock - 50, clock - 150]) {
        const ignored = await f.process(consumer, verified(subject, source as Source, 777, time));
        expect((await f.terminal(ignored)).event.status).toBe('IGNORED'); expect((await f.terminal(ignored)).outbox.status).toBe('COMPLETED');
        expect(await f.watermark(completed)).toEqual(authority); expect(await f.business(subject)).toEqual(before);
      }
      const late = await f.process(consumer, verified(subject, source as Source, provider === 'dada' ? 5 : -1, clock - 40));
      expect((await f.terminal(late)).event.status).toBe('CONFLICT'); expect(await f.watermark(completed)).toEqual(authority); expect(await f.business(subject)).toEqual(before);
    }
  }));
  it('preserves the one permitted UU pre-pickup rider cancellation after ignored UNKNOWN while clearing the registered rider', async () => f.profiles(async (_app, admin) => {
    const consumer = f.service(admin), subject = await f.seed('uu', 1301), accepted = verified(subject, 'callback', 3, clock - 100);
    await f.process(consumer, accepted); const authority = await f.watermark(accepted);
    const ignored = await f.process(consumer, verified(subject, 'callback', 777, clock - 80));
    const afterUnknown = await f.watermark(accepted);
    const riderCancelled = verified(subject, 'callback', 2, clock - 90), processed = await f.process(consumer, riderCancelled);
    const after = await f.business(subject);
    expect((await f.terminal(ignored)).event.status).toBe('IGNORED'); expect(afterUnknown).toEqual(authority);
    expect((await f.terminal(processed)).event.status).toBe('APPLIED'); expect(after.order).toMatchObject({ status: 1, deliveryType: 'city_delivery', deliveryName: '', deliveryId: '' });
    expect(after.delivery.status).toBe(0); expect((await f.watermark(riderCancelled))[0]).toMatchObject({ lastState: 'RIDER_CANCELLED', lastRank: 10, terminal: 0, providerUpdateTime: riderCancelled.providerUpdateTime });
  }));
});
