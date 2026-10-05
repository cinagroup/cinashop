/** Fresh owned PG16 database. Only the SELECT intersection of the actual
 * production Admin/app privilege plans is granted on these seven tables.
 * This fixture deliberately does not claim full runtime commissioning. */
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { storeDeliveryOrder, storeOrder, systemStore, systemSupplier, systemAdmin, systemRole, systemMenus } from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { AdminCityDeliveryRecordService } from '../../src/services/admin/AdminCityDeliveryRecordService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';

const identifier = (value: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned city-record identifier');
  return `"${value}"`;
};
type Peer = SequenceRunnerPeer & { role: string; connectionString: string };
/** Hooks run only after genuine SQL has executed on the original transaction.
 * They never supply fabricated query results or replace the restricted LOGIN. */
export function observeCityDeliveryRecordDb(db: DbClient, observe: (tx: DbClient, command: string) => Promise<void>): DbClient {
  const builder = (target: object, tx: DbClient): object => new Proxy(target, { get(object, key, receiver) {
    const method: unknown = Reflect.get(object, key, receiver);
    if (typeof method !== 'function') return method;
    if (key === 'then') return (fulfilled: (value: unknown) => unknown, rejected: (error: unknown) => unknown) =>
      Reflect.apply(method, object, [async (rows: unknown) => {
        const statement = Reflect.get(object, 'toSQL') as () => { sql: string };
        await observe(tx, Reflect.apply(statement, object, []).sql);
        return fulfilled ? fulfilled(rows) : rows;
      }, rejected]);
    return (...args: unknown[]) => {
      const result: unknown = Reflect.apply(method, object, args);
      return result && typeof result === 'object' && typeof Reflect.get(result, 'then') === 'function' ? builder(result, tx) : result;
    };
  } });
  return new Proxy(db, { get(target, key, receiver) {
    const method: unknown = Reflect.get(target, key, receiver);
    if (typeof method !== 'function') return method;
    if (key !== 'transaction') return method.bind(target);
    return (callback: (tx: DbClient) => unknown, ...options: unknown[]) => Reflect.apply(method, target, [(tx: DbClient) =>
      callback(new Proxy(tx, { get(transaction, property, transactionReceiver) {
        const operation: unknown = Reflect.get(transaction, property, transactionReceiver);
        if (typeof operation !== 'function') return operation;
        if (property === 'select') return (...args: unknown[]) => builder(Reflect.apply(operation, transaction, args), transaction);
        if (property === 'execute') return async (...args: unknown[]) => {
          const result: unknown = await Reflect.apply(operation, transaction, args); await observe(transaction, 'execute'); return result;
        };
        return operation.bind(transaction);
      } })), ...options]);
  } });
}
export async function cityDeliveryRecordFixture() {
  const f = await sequenceRunnerDatabase();
  if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) { await f.close(); throw Error('City delivery records require native PG16 independent LOGINs'); }
  try {
    const tables = [storeDeliveryOrder, storeOrder, systemStore, systemSupplier, systemAdmin, systemRole, systemMenus];
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
    for (const [name, columns] of [['sdo_oid_id', 'oid,id'], ['sdo_uid_id', 'uid,id'], ['sdo_order_id', 'order_id'],
      ['sdo_delivery_no', 'delivery_no'], ['sdo_owner_status', 'type,relation_id,status,id'], ['sdo_status_time', 'status,add_time,id'],
      ['sdo_dada_reconcile_scan', 'station_type,status,id']]) await f.exec(`CREATE INDEX ${identifier(name)} ON public.store_delivery_order (${columns.split(',').map(identifier).join(',')})`);
    await f.db.insert(systemStore).values([
      { id: 7, name: '北区门店 %_\\', image: '/store-seven.png', isShow: 1, isStore: 1, bankCode: 'private-store-bank' },
      { id: 8, name: '历史隐藏门店', image: '/store-eight.png', isShow: 0, isDel: 1, isStore: 0 },
      { id: 42, name: '不同类型同ID门店', isShow: 1 },
    ]);
    await f.db.insert(systemSupplier).values([{ id: 42, adminId: 42, supplierName: '供应商四十二', avatar: '/supplier.png', isShow: 0, isDel: 1, bankCode: 'private-supplier-bank' }]);
    await f.db.insert(storeOrder).values([
      { id: 100, uid: 77, orderId: 'origin-platform', type: 3 },
      { id: 101, uid: 77, orderId: 'origin-store%_\\', storeId: 7, supplierId: 42, type: 2, pid: 100 },
      { id: 102, uid: 77, orderId: 'origin-supplier', supplierId: 42 },
      { id: 103, uid: 77, orderId: 'origin-deleted', storeId: 8, isDel: 1 },
      { id: 104, uid: 77, orderId: 'foreign-uid-order', storeId: 7 },
      { id: 105, uid: 77, orderId: 'foreign-owner-order', supplierId: 42 },
    ]);
    const common = { uid: 77, stationType: 1, distance: 1320.5, cargoPrice: '100.01', fee: '2.10', deductFee: '0.00',
      userName: '快照收件人', receiverPhone: '13800138000', fromAddress: '发货快照', toAddress: '收货快照', mark: '本地备注',
      finishCode: 'private-finish-code', fromLat: 'private-coordinate', cityCode: '旧城市', merId: 9 };
    await f.db.insert(storeDeliveryOrder).values([
      { ...common, id: 1, oid: 100, type: 0, relationId: 0, orderId: 'provider-platform', status: 0, addTime: 100 },
      { ...common, id: 2, oid: 101, type: 1, relationId: 7, orderId: 'provider-store', deliveryNo: 'provider%_\\', status: 2, addTime: 200 },
      { ...common, id: 3, oid: 102, type: 2, relationId: 42, stationType: 2, orderId: 'provider-supplier', status: 3, addTime: 300 },
      { ...common, id: 4, oid: 103, type: 1, relationId: 8, orderId: 'provider-deleted', status: 4, addTime: 400 },
      { ...common, id: 5, oid: 999, type: 1, relationId: 999, orderId: 'provider-orphan', status: -1, addTime: 500 },
      { ...common, id: 6, oid: 104, uid: 88, type: 1, relationId: 7, orderId: 'provider-uid-conflict', status: 1, addTime: 600 },
      { ...common, id: 7, oid: 105, type: 1, relationId: 7, orderId: 'provider-owner-conflict', status: 9, addTime: 700 },
      { ...common, id: 8, oid: 100, type: 9, relationId: 42, stationType: 9, orderId: 'provider-unknown', status: 32767, distance: Number.NaN, fee: 'NaN', addTime: 800 },
      { ...common, id: 9, oid: 100, type: 0, relationId: 42, orderId: 'provider-relation-conflict', status: 10, distance: -1, addTime: 800 },
      { ...common, id: 10, oid: 101, type: 1, relationId: 7, orderId: 'provider-store', status: 100, addTime: 200 },
    ]);
    const serviceFor = (db = f.db) => new AdminCityDeliveryRecordService(createContainerFromDb(db));
    const installReadSlice = async (app: Peer, admin: Peer) => {
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
        const plan = runtimeBusinessPrivilegePlan(kind);
        for (const table of tables) {
          const name = getTableConfig(table).name;
          if (!plan.tables[name]?.includes('SELECT')) throw Error(`${kind} production plan cannot read ${name}`);
          await f.exec(`GRANT SELECT ON public.${identifier(name)} TO ${identifier(peer.role)}`);
        }
      }
    };
    const snapshot = async () => ({ records: await f.db.select().from(storeDeliveryOrder).orderBy(storeDeliveryOrder.id),
      orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id), stores: await f.db.select().from(systemStore).orderBy(systemStore.id),
      suppliers: await f.db.select().from(systemSupplier).orderBy(systemSupplier.id) });
    return { ...f, tables, serviceFor, installReadSlice, snapshot, withRuntimeRole: f.withRuntimeRole, withPeer: f.withPeer };
  } catch (error) { await f.close(); throw error; }
}
