/** Current production privilege intersection over 19 actual ORM tables.
 * Independent LOGINs, no ownership/DDL; this is not full commissioning. */
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import type { Env, OrderMessage } from '../../src/env';
import { systemConfig, systemLog, systemAdmin, systemRole, systemMenus, systemDise, systemGroup, systemGroupData,
  storeOrder, storeDeliveryOrder, storeOrderStatus, user, systemStore, systemStoreStaff, storeConfig,
  cityDeliveryCallbackEvent, cityDeliveryCallbackOutbox, cityDeliveryCallbackWatermark, cityDeliveryReconciliationCase } from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { CITY_DELIVERY_CALLBACK_PIPELINE_SQL } from '../../src/migrations/cityDeliveryCallbackPipeline';
import { AdminCityDeliverySettingsService } from '../../src/services/admin/AdminCityDeliverySettingsService';
import { CityDeliverySettingsResolver, type CityDeliverySettingsEnv } from '../../src/services/delivery/CityDeliverySettingsResolver';
import { CityDeliveryCallbackService } from '../../src/services/delivery/CityDeliveryCallbackService';
import { StoreMobileOrderService } from '../../src/services/store/StoreMobileOrderService';
import { CITY_DELIVERY_CREDENTIAL_KEYS, CITY_DELIVERY_FLAG_KEYS, type CityDeliveryPrepareInput } from '../../../view/common/cityDeliverySettings';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';
import { observeFabDb } from './fabSettingsFixture';

export const citySettingsActor = { id: 7 };
export const citySettingsBindings = {
  CITY_DELIVERY_CONFIG_KEY: Buffer.alloc(32, 29).toString('base64url'),
  DADA_APP_KEY: 'owned-dada-key-old', DADA_APP_SECRET: 'owned-dada-secret-old', DADA_SOURCE_ID: 'owned-dada-source-old', DADA_CLIENT_ID: 'owned-dada-client',
  DADA_CALLBACK_TOKEN: 'owned-dada-callback-token-at-least-32', UU_APP_ID: 'owned-uu-app-id-old', UU_APP_KEY: 'owned-uu-key-old', UU_OPEN_ID: 'owned-uu-open-id-old',
  UU_CALLBACK_TOKEN: 'owned-uu-callback-token-at-least-32', UU_API_TIMESTAMP_UNIT: 'seconds',
} satisfies CityDeliverySettingsEnv;
export const citySettingsTables = [systemConfig, systemLog, systemAdmin, systemRole, systemMenus, systemDise, systemGroup, systemGroupData,
  storeOrder, storeDeliveryOrder, storeOrderStatus, user, systemStore, systemStoreStaff, storeConfig,
  cityDeliveryCallbackEvent, cityDeliveryCallbackOutbox, cityDeliveryCallbackWatermark, cityDeliveryReconciliationCase];
const identifier = (value: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned city settings identifier'); return `"${value}"`; };
type Peer = SequenceRunnerPeer & { role: string; connectionString: string };
export const observeCitySettingsDb = observeFabDb;
export function citySettingsInput(revision: string, patch: Partial<CityDeliveryPrepareInput> = {}): CityDeliveryPrepareInput {
  return { request_id: crypto.randomUUID(), client_nonce: crypto.randomUUID(), revision,
    flags: { city_delivery_status: 0, self_delivery_status: 1, dada_delivery_status: 1, uu_delivery_status: 1 },
    credentials: Object.fromEntries(CITY_DELIVERY_CREDENTIAL_KEYS.map(key => [key, { action: 'keep' as const }])) as CityDeliveryPrepareInput['credentials'], ...patch };
}
export async function cityDeliverySettingsFixture(options: { missing?: boolean } = {}) {
  const f = await sequenceRunnerDatabase();
  if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) { await f.close(); throw Error('City settings fixture requires independent PG16 LOGINs'); }
  try {
    const dialect = new PgDialect(), callbackTables = new Set(['city_delivery_callback_event', 'city_delivery_callback_outbox', 'city_delivery_callback_watermark', 'city_delivery_reconciliation_case']);
    for (const table of citySettingsTables) {
      const definition = getTableConfig(table);
      if (callbackTables.has(definition.name)) continue;
      const columns = definition.columns.map(column => { const value = column.default;
        const initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `${identifier(column.name)} ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`; });
      await f.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);
      // Provider DDL owns the delivery reconcile-scan index below.
      for (const index of definition.indexes) {
        const config = index.config;
        if (config.name === 'sdo_dada_reconcile_scan') continue;
        const columns = config.columns.map(column => { if (!('name' in column) || typeof column.name !== 'string') throw Error('Unexpected city settings expression index'); return identifier(column.name); });
        await f.exec(`CREATE ${config.unique ? 'UNIQUE ' : ''}INDEX ${identifier(config.name!)} ON public.${identifier(definition.name)} (${columns.join(',')})`);
      }
    }
    await f.exec(CITY_DELIVERY_CALLBACK_PIPELINE_SQL);
    if (!options.missing) await f.db.insert(systemConfig).values([
      ...CITY_DELIVERY_FLAG_KEYS.map((menuName, index) => ({ menuName, value: index ? '1' : '0', info: `preserve ${menuName}`, sort: 20, status: 0 })),
      ...CITY_DELIVERY_CREDENTIAL_KEYS.map(menuName => ({ menuName, value: '""', info: `preserve ${menuName}`, sort: 20, status: 0 })),
    ]);
    await f.db.insert(user).values({ uid: 77, account: 'owned-city-staff', nickname: '门店店员', status: 1, isDel: 0 });
    await f.db.insert(systemStore).values({ id: 7, name: '本机门店', isStore: 1, isShow: 1, isDel: 0 });
    await f.db.insert(systemStoreStaff).values({ id: 7, uid: 77, storeId: 7, status: 1, verifyStatus: 1, isDel: 0 });
    await f.db.insert(storeOrder).values({ id: 91, uid: 77, orderId: 'owned-settings-order', storeId: 7, paid: 1, status: 1, shippingType: 1 });
    const installSlice = async (app: Peer, admin: Peer) => {
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
        const plan = runtimeBusinessPrivilegePlan(kind);
        for (const table of citySettingsTables) {
          const definition = getTableConfig(table), privileges = plan.tables[definition.name];
          if (!privileges?.includes('SELECT')) throw Error(`${kind} profile cannot read ${definition.name}`);
          await f.exec(`GRANT ${privileges.join(',')} ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
          const columns = plan.updateColumns[definition.name];
          if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(identifier).join(',')}) ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
          if (privileges.includes('INSERT')) for (const column of definition.columns) { if (!['serial', 'bigserial'].includes(column.getSQLType())) continue;
            const [row] = await f.exec(`SELECT pg_get_serial_sequence('public.${definition.name}','${column.name}') AS name`), parts = String(row.name).split('.');
            if (parts.length !== 2 || parts[0] !== 'public') throw Error('Unexpected city settings sequence');
            await f.exec(`GRANT USAGE ON SEQUENCE public.${identifier(parts[1])} TO ${identifier(peer.role)}`); }
        }
      }
    };
    const runtimeFor = (db: DbClient = f.db, settings: CityDeliverySettingsEnv = citySettingsBindings) => {
      const messages: OrderMessage[] = [], bindings = { ...settings, APP_KEY: 'owned-city-runtime-key', CONFIG_KV: { get: async () => '1', put: async () => {}, delete: async () => {} },
        ORDER_QUEUE: { send: async (message: OrderMessage) => { messages.push(message); }, sendBatch: async (entries: { body: OrderMessage }[]) => { messages.push(...entries.map(entry => entry.body)); } } } satisfies
        CityDeliverySettingsEnv & Pick<Env, 'APP_KEY'> & { CONFIG_KV: { get: (key: string) => Promise<string>; put: () => Promise<void>; delete: () => Promise<void> }; ORDER_QUEUE: { send: (message: OrderMessage) => Promise<void>; sendBatch: (entries: { body: OrderMessage }[]) => Promise<void> } };
      // Only this explicitly checked SQL/config/queue boundary is enabled.
      const env = bindings as unknown as Env, container = createContainerFromDb(db);
      return { messages, env, callback: new CityDeliveryCallbackService(container, env), store: new StoreMobileOrderService(container, env) };
    };
    return { ...f, tables: citySettingsTables, installSlice, withRuntimeRole: f.withRuntimeRole, withPeer: f.withPeer,
      serviceFor: (db: DbClient = f.db, env: CityDeliverySettingsEnv = citySettingsBindings) => new AdminCityDeliverySettingsService(createContainerFromDb(db), env),
      resolverFor: (db: DbClient = f.db, env: CityDeliverySettingsEnv = citySettingsBindings) => new CityDeliverySettingsResolver(createContainerFromDb(db), env), runtimeFor,
      snapshot: async () => ({ configs: await f.db.select().from(systemConfig).orderBy(systemConfig.id), logs: await f.db.select().from(systemLog).orderBy(systemLog.id),
        deliveries: await f.db.select().from(storeDeliveryOrder).orderBy(storeDeliveryOrder.id), events: await f.db.select().from(cityDeliveryCallbackEvent).orderBy(cityDeliveryCallbackEvent.id),
        outboxes: await f.db.select().from(cityDeliveryCallbackOutbox).orderBy(cityDeliveryCallbackOutbox.id), reconciliation: await f.db.select().from(cityDeliveryReconciliationCase).orderBy(cityDeliveryReconciliationCase.id) }),
    };
  } catch (error) { await f.close(); throw error; }
}
