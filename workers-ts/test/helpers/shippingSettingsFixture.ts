/** Owned native database with the exact existing production ACL slice. This is
 * deliberately not the 282-table commissioning/audit fixture. The city/store
 * triggers use the same full production function body on only these two tables. */
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb } from '../../src/lib/di';
import { cityArea, systemAdmin, systemConfig, systemLog, systemMenus, systemRole, systemStore } from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { runtimeLockOnlyBoundaryBody } from '../../src/migrations/runtimeLockOnlyBoundary';
import { AdminShippingSettingsService } from '../../src/services/admin/AdminShippingSettingsService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';

type Peer = SequenceRunnerPeer & { role: string; connectionString: string };
const identifier = (value: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned shipping fixture identifier');
  return `"${value}"`;
};
export const shippingPickupExample = { name: ' 城北提货点 ', phone: ' 13800138000 ', address_ids: [10, 11, 12, 13],
  detailed_address: ' 新路 1/2 号 ', day_time: ['22:00', '06:00'], latitude: '-0.000000', longitude: '121.230000' };
export const shippingSaveInput = (revision: string) => ({ request_id: crypto.randomUUID(), revision,
  whole_free_shipping: 1, store_free_postage: '100.10', offline_postage: 0, store_self_mention: 1, pickup: structuredClone(shippingPickupExample) });

export async function shippingSettingsFixture() {
  const f = await sequenceRunnerDatabase();
  if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) { await f.close(); throw Error('Shipping settings requires native PG16 and independent LOGINs'); }
  try {
    const tables = [cityArea, systemConfig, systemStore, systemLog, systemAdmin, systemRole, systemMenus];
    const dialect = new PgDialect();
    for (const table of tables) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        const value = column.default;
        const initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `${identifier(column.name)} ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);
    }
    await f.db.insert(cityArea).values([
      { id: 10, name: '甲省', level: 1 }, { id: 11, name: '乙市', parentId: 10, level: 2 },
      { id: 12, name: '丙区', parentId: 11, level: 3 }, { id: 13, name: '丁街道', parentId: 12, level: 4 },
      { id: 20, name: '其他省', level: 1 }, { id: 21, name: '其他市', parentId: 20, level: 2 },
    ]);
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'whole_free_shipping', value: '"0"', configTabId: 26 },
      { id: 2, menuName: 'store_free_postage', value: '"10000"', configTabId: 27 },
      { id: 3, menuName: 'offline_postage', value: '0', configTabId: 27 },
      { id: 4, menuName: 'store_self_mention', value: '1', configTabId: 27 },
      { id: 5, menuName: 'unrelated_setting', value: 'untouched' },
      { id: 6, menuName: 'whole_free_shipping', value: '1', isStore: 1, sort: 1000 },
    ]);
    await f.db.insert(systemStore).values([
      { id: 1, name: '较早门店', isStore: 1, isShow: 1 },
      { id: 2, name: '最新隐藏默认点', phone: '13800138000', address: '甲省乙市丙区丁街道', province: 10, city: 11, area: 12, street: 13,
        detailedAddress: '旧街1号', dayTime: '08:00 - 20:00', latitude: '31.2', longitude: '121.4',
        bankCode: 'keep-bank-code', image: '/keep-image.png', introduction: 'keep intro', isShow: 0, isStore: 0 },
      { id: 3, name: '已删除较新门店', isDel: 1 },
    ]);
    for (const table of [cityArea, systemConfig, systemStore]) {
      const name = getTableConfig(table).name;
      await f.exec(`SELECT setval(pg_get_serial_sequence('public.${name}','id'), (SELECT max(id) FROM public.${name}), true)`);
    }
    const cacheDeletes: string[] = [];
    const cache = new Map<string, string>();
    const env: ConstructorParameters<typeof AdminShippingSettingsService>[1] = { CONFIG_KV: {
      get: async (key: string) => cache.get(key) ?? null,
      put: async (key: string, value: string) => { cache.set(key, value); },
      delete: async (key: string) => { cacheDeletes.push(key); cache.delete(key); },
    } };
    const serviceFor = (db = f.db, settingsEnv = env) => new AdminShippingSettingsService(createContainerFromDb(db), settingsEnv);
    const installSlice = async (app: Peer, admin: Peer) => {
      await f.exec(`CREATE FUNCTION public.cinashop_runtime_lock_only_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $lock_boundary$${runtimeLockOnlyBoundaryBody(app.role, admin.role, 'promotion-gifts')}$lock_boundary$`);
      await f.exec('REVOKE ALL ON FUNCTION public.cinashop_runtime_lock_only_v1() FROM PUBLIC');
      for (const table of ['city_area', 'system_store']) await f.exec(`CREATE TRIGGER cinashop_runtime_lock_only_v1 BEFORE UPDATE ON public.${identifier(table)} FOR EACH ROW EXECUTE FUNCTION public.cinashop_runtime_lock_only_v1()`);
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
        const plan = runtimeBusinessPrivilegePlan(kind);
        for (const table of tables) {
          const definition = getTableConfig(table), privileges = plan.tables[definition.name];
          if (!privileges?.includes('SELECT')) throw Error(`Shipping table missing from ${kind} production plan`);
          await f.exec(`GRANT ${privileges.join(',')} ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
          const columns = plan.updateColumns[definition.name];
          if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(identifier).join(',')}) ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
          if (privileges.includes('INSERT')) for (const column of definition.columns) {
            if (!['serial', 'bigserial'].includes(column.getSQLType())) continue;
            const [row] = await f.exec(`SELECT pg_get_serial_sequence('public.${definition.name}','${column.name}') AS name`);
            const sequence = String(row.name).split('.');
            if (sequence.length !== 2 || sequence[0] !== 'public') throw Error('Unexpected shipping serial sequence');
            await f.exec(`GRANT USAGE ON SEQUENCE public.${identifier(sequence[1])} TO ${identifier(peer.role)}`);
          }
        }
      }
    };
    return { ...f, tables, env, cacheDeletes, serviceFor, installSlice, withRuntimeRole: f.withRuntimeRole, withPeer: f.withPeer };
  } catch (error) { await f.close(); throw error; }
}
