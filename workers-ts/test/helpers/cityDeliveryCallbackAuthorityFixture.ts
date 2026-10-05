/** Native callback ownership fixture. The small scenario installs the exact
 * ten-table production ACL slice; receipt scenarios use the registered full
 * migration fixture separately. Neither fixture substitutes business SQL. */
import { and, eq, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { expect } from 'vitest';
import type { Env, OrderMessage } from '../../src/env';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { CITY_DELIVERY_CALLBACK_PIPELINE_SQL } from '../../src/migrations/cityDeliveryCallbackPipeline';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { runtimeLockOnlyBoundaryBody } from '../../src/migrations/runtimeLockOnlyBoundary';
import { cityDeliveryCallbackEvent as eventTable, cityDeliveryCallbackOutbox as outboxTable,
  cityDeliveryCallbackWatermark as watermarkTable, cityDeliveryReconciliationCase, storeDeliveryOrder,
  storeOrder, storeOrderStatus, systemStore, systemSupplier, systemConfig } from '../../src/models/schema';
import { CityDeliveryCallbackService, isCityDeliveryCallbackOutboxMessage } from '../../src/services/delivery/CityDeliveryCallbackService';
import { dadaCallbackChecksum, normalizeDadaCityDeliveryQuery, verifyDadaCityDeliveryCallback,
  type CityDeliveryProvider, type VerifiedCityDeliveryEvent } from '../../src/services/delivery/DadaCityDeliveryCallback';
import { normalizeUuCityDeliveryQuery, verifyUuCityDeliveryCallback } from '../../src/services/delivery/UuCityDeliveryCallback';
import type { SystemConfigEnv } from '../../src/services/system/SystemConfigService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';

const DADA_TOKEN = 'owned-dada-authority-token-32-bytes', UU_TOKEN = 'owned-uu-authority-token-32-bytes';
const CLIENT = 'owned-dada-client', OPEN = 'owned-uu-open-id';
const identifier = (value: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned callback authority identifier');
  return `"${value}"`;
};
export type CallbackAuthoritySource = 'callback' | 'query';
export type CallbackAuthoritySubject = { id: number; oid: number; provider: CityDeliveryProvider; providerId: string; code: string };
export type CallbackAuthorityRuntimePeer = SequenceRunnerPeer & { role: string; connectionString: string };
type QueueEntry = Parameters<Env['ORDER_QUEUE']['sendBatch']>[0] extends Iterable<infer Entry> ? Entry : never;
type AuthorityBindings = Pick<Env, 'APP_KEY' | 'DADA_CALLBACK_TOKEN' | 'DADA_CLIENT_ID' | 'UU_CALLBACK_TOKEN' | 'UU_OPEN_ID'> &
  { CONFIG_KV?: SystemConfigEnv['CONFIG_KV']; NODE_ENV: 'test'; ORDER_QUEUE: {
    send: (body: Parameters<Env['ORDER_QUEUE']['send']>[0]) => Promise<void>;
    sendBatch: (entries: QueueEntry[]) => Promise<void>;
  } };

/** Actual provider verification/normalization; all credentials are finite test
 * constants. No network adapter, authenticator or projection is mocked. */
export function cityDeliveryAuthorityEvent(subject: CallbackAuthoritySubject, source: CallbackAuthoritySource,
  status: number, time: number): VerifiedCityDeliveryEvent {
  if (subject.provider === 'dada') {
    const body = { client_id: CLIENT, order_id: subject.providerId, order_status: status, update_time: time,
      cancel_from: 0, repeat_reason_type: 0, cancel_reason: 'owned authority regression', finish_code: '4321',
      dm_name: '新确认骑手', dm_mobile: '13800138000' };
    return source === 'callback'
      ? verifyDadaCityDeliveryCallback(JSON.stringify({ ...body, signature: dadaCallbackChecksum(CLIENT, subject.providerId, String(time)) }),
        { requestToken: DADA_TOKEN, callbackToken: DADA_TOKEN, expectedClientId: CLIENT })
      : normalizeDadaCityDeliveryQuery(body, { expectedClientId: CLIENT, providerOrderId: subject.providerId, observedAt: time });
  }
  const biz = { originId: subject.providerId, orderCode: subject.code, state: status, changeTime: time * 1000,
    stateText: 'owned authority state', driverName: '新确认跑男', driverMobile: '13900139000' };
  return source === 'callback'
    ? verifyUuCityDeliveryCallback(JSON.stringify({ openId: OPEN, timestamp: time * 1000,
      sign: '0123456789ABCDEF0123456789ABCDEF', biz: JSON.stringify(biz) }),
      { requestToken: UU_TOKEN, callbackToken: UU_TOKEN, expectedOpenId: OPEN })
    : normalizeUuCityDeliveryQuery(biz, { expectedOpenId: OPEN, originId: subject.providerId, observedAt: time });
}

export function callbackAuthorityHarness(db: DbClient, config?: SystemConfigEnv) {
  const messages: OrderMessage[] = [];
  // Only the checked callback/config/queue boundary is supplied. All other
  // bindings are disabled and every test installs a provider-fetch tripwire.
  const env = ({ APP_KEY: 'owned-callback-authority', NODE_ENV: 'test', DADA_CALLBACK_TOKEN: DADA_TOKEN,
    DADA_CLIENT_ID: CLIENT, UU_CALLBACK_TOKEN: UU_TOKEN, UU_OPEN_ID: OPEN,
    ...(config ? { CONFIG_KV: config.CONFIG_KV } : {}),
    ORDER_QUEUE: { send: async (body: OrderMessage) => { messages.push(body); },
      sendBatch: async (entries: { body: OrderMessage }[]) => { messages.push(...entries.map(entry => entry.body)); } } } satisfies AuthorityBindings) as unknown as Env;
  const service = new CityDeliveryCallbackService(createContainerFromDb(db), env);
  const process = async (evidence: VerifiedCityDeliveryEvent) => {
    const received = await service.receive(evidence);
    await service.dispatchById(received.outboxId);
    const message = messages.shift();
    if (!message || !isCityDeliveryCallbackOutboxMessage(message)) throw Error('Real authority dispatch did not enqueue callback');
    return { ...received, message, result: await service.processMessage(message) };
  };
  return { service, process, env, messages };
}

export async function callbackAuthorityRows(db: DbClient, received: { eventId: number; outboxId: number }) {
  return { event: (await db.select().from(eventTable).where(eq(eventTable.id, received.eventId)))[0],
    outbox: (await db.select().from(outboxTable).where(eq(outboxTable.id, received.outboxId)))[0] };
}
export const callbackAuthorityWatermark = (db: DbClient, evidence: VerifiedCityDeliveryEvent) => db.select().from(watermarkTable)
  .where(and(eq(watermarkTable.provider, evidence.provider), eq(watermarkTable.subjectKeyHash, evidence.subjectKeyHash)));

export async function cityDeliveryCallbackAuthorityFixture() {
  const f = await sequenceRunnerDatabase();
  if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) { await f.close(); throw Error('Authority tests require native PG16 independent LOGINs'); }
  try {
    const baseTables = [storeOrder, storeDeliveryOrder, storeOrderStatus, systemStore, systemSupplier, systemConfig];
    const dialect = new PgDialect();
    for (const table of baseTables) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        const initial = column.default === undefined ? '' : ` DEFAULT ${column.default instanceof SQL
          ? dialect.sqlToQuery(column.default).sql : dialect.sqlToQuery(sql`${column.default}`.inlineParams()).sql}`;
        return `${identifier(column.name)} ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);
    }
    await f.exec(CITY_DELIVERY_CALLBACK_PIPELINE_SQL);
    for (const [name, columns] of [['sdo_oid_id', 'oid,id'], ['sdo_uid_id', 'uid,id'], ['sdo_order_id', 'order_id'],
      ['sdo_delivery_no', 'delivery_no'], ['sdo_owner_status', 'type,relation_id,status,id'],
      ['sdo_status_time', 'status,add_time,id']]) {
      await f.exec(`CREATE INDEX ${identifier(name)} ON public.store_delivery_order (${columns.split(',').map(identifier).join(',')})`);
    }
    await f.db.insert(systemStore).values([{ id: 7, name: '本机履约门店', isShow: 1, isStore: 1 },
      { id: 8, name: '不同门店', isShow: 1, isStore: 1 }]);
    await f.db.insert(systemSupplier).values([{ id: 42, adminId: 42, supplierName: '本机供应商' },
      { id: 7, adminId: 7, supplierName: '供应商同ID不等于门店' }]);
    const tables = [...baseTables, eventTable, outboxTable, watermarkTable, cityDeliveryReconciliationCase];
    const withRuntimeRole = f.withRuntimeRole;
    const profiles = <T>(run: (app: CallbackAuthorityRuntimePeer, admin: CallbackAuthorityRuntimePeer) => Promise<T>) =>
      withRuntimeRole(app => withRuntimeRole(async admin => {
        await f.exec(`CREATE FUNCTION public.cinashop_runtime_lock_only_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $lock_boundary$${runtimeLockOnlyBoundaryBody(app.role, admin.role, 'promotion-gifts')}$lock_boundary$`);
        await f.exec('REVOKE ALL ON FUNCTION public.cinashop_runtime_lock_only_v1() FROM PUBLIC');
        for (const name of ['system_store', 'store_order_status']) await f.exec(`CREATE TRIGGER cinashop_runtime_lock_only_v1 BEFORE UPDATE ON public.${identifier(name)} FOR EACH ROW EXECUTE FUNCTION public.cinashop_runtime_lock_only_v1()`);
        for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
          const plan = runtimeBusinessPrivilegePlan(kind);
          for (const table of tables) {
            const definition = getTableConfig(table), privileges = plan.tables[definition.name];
            if (!privileges?.includes('SELECT')) throw Error('Missing authority production table ACL');
            await f.exec(`GRANT ${privileges.join(',')} ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
            const updates = plan.updateColumns[definition.name];
            if (updates?.length) await f.exec(`GRANT UPDATE(${updates.map(identifier).join(',')}) ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
            if (privileges.includes('INSERT')) for (const column of definition.columns) {
              if (!['serial', 'bigserial'].includes(column.getSQLType())) continue;
              const [sequence] = await f.exec(`SELECT pg_get_serial_sequence('public.${definition.name}','${column.name}') AS name`);
              const parts = String(sequence.name).split('.');
              if (parts.length !== 2 || parts[0] !== 'public') throw Error('Unexpected owned authority sequence');
              await f.exec(`GRANT USAGE ON SEQUENCE public.${identifier(parts[1])} TO ${identifier(peer.role)}`);
            }
          }
          expect((await peer.exec("SELECT current_user AS role,session_user AS session,has_schema_privilege(current_user,'public','CREATE') AS ddl"))[0])
            .toEqual({ role: peer.role, session: peer.role, ddl: false });
          expect((await peer.exec('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user'))[0])
            .toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
        }
        return run(app, admin);
      }));
    const seed = async (provider: CityDeliveryProvider, id: number,
      original: Partial<typeof storeOrder.$inferInsert> = {}, delivery: Partial<typeof storeDeliveryOrder.$inferInsert> = {}): Promise<CallbackAuthoritySubject> => {
      const providerId = `${provider}-auth-${id}`, code = `${providerId}-code`;
      await f.db.insert(storeOrder).values({ id, uid: 77, paid: 1, status: 1, shippingType: 1, deliveryType: 'city_delivery',
        orderId: `original-${id}`, deliveryName: '已登记骑手', deliveryId: '13700137000', deliveryUid: 91, ...original });
      await f.db.insert(storeDeliveryOrder).values({ id, oid: id, uid: 77, stationType: provider === 'dada' ? 1 : 2,
        type: 0, relationId: 0, orderId: providerId, deliveryNo: code, status: 0, addTime: 100, ...delivery });
      return { id, oid: id, provider, providerId, code };
    };
    const snapshot = async () => ({ orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
      deliveries: await f.db.select().from(storeDeliveryOrder).orderBy(storeDeliveryOrder.id),
      logs: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
      watermarks: await f.db.select().from(watermarkTable).orderBy(watermarkTable.provider, watermarkTable.subjectKeyHash),
      stores: await f.db.select().from(systemStore).orderBy(systemStore.id),
      suppliers: await f.db.select().from(systemSupplier).orderBy(systemSupplier.id) });
    return { ...f, profiles, seed, snapshot };
  } catch (error) { await f.close(); throw error; }
}
