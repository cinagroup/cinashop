import { is, eq, sql } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import type { Env, AppVariables } from '../../src/env';
import type { DbClient } from '../../src/lib/di';
import * as schema from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { runManagerOrderOperation } from '../../src/migrations/runManagerOrderOperation';
import { customerManualManagerOriginReadiness, runCustomerManualManagerOriginRead } from '../../src/migrations/customerManualOfflineOriginCatalog';
import { customerWorkWriteoffFixture } from './customerWorkWriteoffFixture';
import { createMerchantManagerRuntime } from './merchantManagerRuntime';
import { validateFinanceFixtureUrl, ownsFinanceFixtureEndpoint } from './financePostgres';
import { requireStoreManagerScope, merchantOrderRevision } from '../../src/services/store/StoreManagerScope';
import { MANAGER_OPERATION_VERSION, type ManagerOperationInput } from '../../src/services/store/ManagerOrderOperationRequest';
import { errorHandler } from '../../src/middleware/error';
import { v1Routes } from '../../src/routes/v1';
import { createToken, md5 } from '../../src/utils/jwt';

export type OfflineNativeProducer = 'manager' | 'admin';
const identifier = (name: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Invalid owned offline-origin fixture identifier');
  return `"${name}"`;
};

/** Management uses the published independent Admin profile. Assisted checkout
 * stays on the applicationContainer through the real route boundary. This
 * independent LOGIN gets the actual Admin plan, without manager-ledger
 * INSERT, manager-scope EXECUTE, maintenance membership or SET ROLE. */
async function createAdminApplicationRuntime(owner: DbClient, tables: PgTable[]) {
  const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  const [origin] = await owner.execute<{ database: string; role: string; session: string; host: string; port: number; version: number }>(sql`
    SELECT current_database() AS database,current_user AS role,session_user AS session,
      host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('server_version_num')::integer AS version`);
  if (!origin || origin.role !== 'finance_test' || origin.session !== origin.role || Math.floor(origin.version / 10000) !== 16
    || !ownsFinanceFixtureEndpoint(origin.database, 'public', base.href, origin.host, origin.port)) {
    throw Error('Offline admin runtime requires the registered owned PG16 database');
  }
  const role = `offline_admin_runtime_${crypto.randomUUID().replaceAll('-', '')}`, password = crypto.randomUUID().replaceAll('-', '');
  let created = false, client: ReturnType<typeof postgres> | undefined;
  const execute = (statement: string) => owner.execute(sql.raw(statement));
  const target = new URL(base.href); target.pathname = '/' + origin.database; target.username = role; target.password = password;
  const connect = () => postgres(target.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
    connection: { options: '-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=3000' } });
  const verify = async (connection: ReturnType<typeof postgres>) => {
    const [row] = await connection`SELECT current_database() AS database,current_user AS role,session_user AS session,
      pg_backend_pid() AS pid,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls
      FROM pg_roles WHERE rolname=current_user) AS elevated,
      has_table_privilege(current_user,'public.manager_order_operation_request','INSERT,UPDATE,DELETE,TRUNCATE') AS manager_write`;
    if (row.database !== origin.database || row.role !== role || row.session !== role || row.elevated !== false || row.manager_write !== false) {
      throw Error('Independent admin application LOGIN acquired unreviewed authority');
    }
    return Number(row.pid);
  };
  const close = async () => {
    await client?.end({ timeout: 5 });
    if (created) { await execute(`DROP OWNED BY ${identifier(role)};DROP ROLE ${identifier(role)}`); created = false; }
  };
  try {
    await execute(`CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    created = true;
    await execute(`GRANT CONNECT ON DATABASE ${identifier(origin.database)} TO ${identifier(role)};GRANT USAGE ON SCHEMA public TO ${identifier(role)}`);
    const plan = runtimeBusinessPrivilegePlan('admin');
    for (const table of tables) {
      const definition = getTableConfig(table), privileges = plan.tables[definition.name];
      if (!privileges?.includes('SELECT')) continue;
      await execute(`GRANT ${privileges.join(',')} ON public.${identifier(definition.name)} TO ${identifier(role)}`);
      const columns = plan.updateColumns[definition.name];
      if (columns?.length) await execute(`GRANT UPDATE(${columns.map(identifier).join(',')}) ON public.${identifier(definition.name)} TO ${identifier(role)}`);
      if (privileges.includes('INSERT')) for (const column of definition.columns) if (['serial', 'bigserial'].includes(column.getSQLType())) {
        const rows = await owner.execute<{ name: string }>(sql`SELECT pg_get_serial_sequence(${`public.${definition.name}`},${column.name}) AS name`);
        const parts = rows[0]?.name?.split('.');
        if (parts?.length !== 2 || parts[0] !== 'public') throw Error('Owned app sequence identity is unreviewed');
        await execute(`GRANT USAGE ON SEQUENCE public.${identifier(parts[1])} TO ${identifier(role)}`);
      }
    }
    client = connect(); await verify(client);
    return { db: drizzle(client) as unknown as DbClient, role, connectionString: target.href, close, withPeer: async <T>(callback: (db: DbClient, pid: number) => Promise<T>) => {
      const peer = connect(); try { return await callback(drizzle(peer) as unknown as DbClient, await verify(peer)); }
      finally { await peer.end({ timeout: 5 }); }
    } };
  } catch (error) { await close(); throw error; }
}

/** Only inputs/authority/config are seeded by the owned maintenance connection.
 * New roots, cart ownership, pricing, paid transitions, primary audits, manager
 * original-UUID rows and paid consumers are produced by the actual services. */
export async function customerWorkOfflineOriginRefundFixture() {
  const f = await customerWorkWriteoffFixture([schema.systemAdmin, schema.systemRole, schema.userAddress, schema.storeConfig]);
  let manager: Awaited<ReturnType<typeof createMerchantManagerRuntime>> | undefined;
  let admin: Awaited<ReturnType<typeof createAdminApplicationRuntime>> | undefined;
  let sequence = 0;
  const close = async () => {
    try { await admin?.close(); } finally { try { await manager?.close(); } finally { await f.close(); } }
  };
  try {
    await runManagerOrderOperation(f.maintenanceDb);
    const rows = await f.maintenanceDb.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'`);
    const names = new Set(rows.map(row => row.name)), plan = runtimeBusinessPrivilegePlan('app');
    const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable))
      .filter(table => names.has(getTableConfig(table).name) && plan.tables[getTableConfig(table).name]?.includes('SELECT'));
    manager = await createMerchantManagerRuntime(f.maintenanceDb, tables, { installScopeLocks: true });
    await f.exec(`GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO ${identifier(manager.role)}`);
    admin = await createAdminApplicationRuntime(f.maintenanceDb, tables);
    await runCustomerManualManagerOriginRead(f.maintenanceDb, f.role);
    const ready = await customerManualManagerOriginReadiness(f.db);
    console.log('CUSTOMER_OFFLINE_ORIGIN_READER_COMMISSION ' + JSON.stringify(ready));
    if (!ready.ready) throw Error('Actual customer manager-origin read-only LOGIN was not commissioned');
    const managerRuntime = manager, adminRuntime = admin;
    const env: Env = { ...f.env,
      HYPERDRIVE: { connectionString: f.connectionString } as Env['HYPERDRIVE'],
      HYPERDRIVE_MANAGER: { connectionString: managerRuntime.connectionString } as Env['HYPERDRIVE'],
      HYPERDRIVE_ADMIN: { connectionString: adminRuntime.connectionString } as Env['HYPERDRIVE_ADMIN'],
      SEQUENCE: {
      idFromName: () => ({}), get: () => ({ fetch: async () => new Response(`modern-offline-${++sequence}`) }),
    } as unknown as Env['SEQUENCE'] };
    const managerActor = () => ({ uid: 103, authVersion: md5('owned-financial-password'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    const order = async (id: number) => (await f.db.select().from(schema.storeOrder).where(eq(schema.storeOrder.id, id)))[0];
    const managerInput = async (id: number): Promise<ManagerOperationInput> => {
      const current = await order(id), scope = await requireStoreManagerScope(managerRuntime.db, 103, 1);
      return { version: MANAGER_OPERATION_VERSION, store_id: 1, scope_key: scope.scope_key, order_id: id,
        expected_order_revision: await merchantOrderRevision(current), payload: {} };
    };
    const app = () => {
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.use('*', async (c, next) => { c.set('container', f.container); await next(); });
      app.onError(errorHandler); app.route('/api', v1Routes); return app;
    };
    interface HttpBody { status: number; msg: string; data: unknown }
    const request = async (path: string, body: unknown, actor: number, realm: 'admin' | 'api', key?: string, bindings = env) => {
      const password = realm === 'admin' ? 'offline-native-admin-password' : 'owned-financial-password';
      const token = (await createToken(actor, realm, md5(password), env.APP_KEY)).token;
      const response = await app().request('/api' + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, bindings);
      return { response, body: await response.json() as HttpBody };
    };
    const adminOffline = async (id: number, actor = 1, realm: 'admin' | 'api' = 'admin') => {
      const current = await order(id);
      return request('/admin/order/offline', { order_id: current.orderId }, actor, realm);
    };
    const managerOffline = (input: ManagerOperationInput, key = crypto.randomUUID(), actor = 103, realm: 'api' | 'admin' = 'api', bindings = env) =>
      request('/store/manager/order/financial/offline', input, actor, realm, key, bindings);
    const reset = async () => {
      await f.reset();
      await f.exec('TRUNCATE public.manager_order_operation_request');
      await f.maintenanceDb.delete(schema.systemStoreStaff).where(eq(schema.systemStoreStaff.uid, 103));
      await f.maintenanceDb.insert(schema.systemStoreStaff).values({ id: 901, uid: 103, storeId: 1, status: 1, isManager: 1, isAdmin: 0, isDel: 0, orderStatus: 1 });
      await f.maintenanceDb.update(schema.storeService).set({ customer: 1 }).where(eq(schema.storeService.uid, 102));
      await f.maintenanceDb.delete(schema.systemAdmin);
      await f.maintenanceDb.insert(schema.systemAdmin).values({ id: 1, account: 'offline-native-admin', pwd: 'offline-native-admin-password',
        adminType: 1, level: 0, status: 1, isDel: 0, roles: '' });
      await f.maintenanceDb.update(schema.systemStore).set({ isStore: 1, isShow: 1, isDel: 0 }).where(eq(schema.systemStore.id, 1));
      await f.maintenanceDb.update(schema.storeProduct).set({ systemFormId: 0, productType: 0 }).where(eq(schema.storeProduct.id, 70));
    };
    const unpaid = async (buyer = 11, price = '7.00', quantity = 3) => {
      await f.maintenanceDb.update(schema.storeProductAttrValue).set({ price }).where(eq(schema.storeProductAttrValue.id, 1));
      const tourist = buyer ? '' : 'modern_offline_guest';
      const added = await request('/admin/order/cart/add/' + buyer, { tourist_uid: tourist, productId: 70, uniqueId: 'qared001', cartNum: quantity, new: 1 }, 1, 'admin');
      if (added.body.status !== 200) throw Error('Actual assisted cart route rejected: ' + added.body.msg);
      const cart = added.body.data as { cartId: string };
      const selection = { cartId: [cart.cartId], tourist_uid: tourist, new: 1, shipping_type: 2, store_id: 1, real_name: '原生线下退款来源',
        // Assisted checkout accepts the published cash selection. This only
        // creates an unpaid root; the actual manager/Admin offline producer
        // below owns the paid transition and the root's final payment method.
        phone: '00000000000', payType: 'cash', useIntegral: false, couponId: 0, from: 'pc' };
      const confirmed = await request('/admin/order/confirm/' + buyer, selection, 1, 'admin');
      if (confirmed.body.status !== 200) throw Error('Actual assisted confirmation route rejected: ' + confirmed.body.msg);
      const quote = confirmed.body.data as { orderKey: string; quoteToken: string };
      const submitted = await request('/admin/order/create/' + quote.orderKey + '/' + buyer, { ...selection, quoteToken: quote.quoteToken }, 1, 'admin');
      if (submitted.body.status !== 200) throw Error('Actual assisted creation route rejected: ' + submitted.body.msg);
      const created = (submitted.body.data as { result: { order_id: string } }).result;
      const current = await f.container.storeOrderDao.findByOrderId(created.order_id);
      if (!current || current.paid !== 0 || current.uid !== buyer || current.staffId !== 1) throw Error('Actual assisted creation did not persist the unpaid scoped root');
      return { order: current, cart, quote, created };
    };
    const paid = async (producer: OfflineNativeProducer, buyer = 11, price = '7.00', quantity = 3, delayMs = 0) => {
      const source = await unpaid(buyer, price, quantity);
      const key = crypto.randomUUID(), input = producer === 'manager' ? await managerInput(source.order.id) : null;
      const result = producer === 'manager' ? await managerOffline(input!, key) : await adminOffline(source.order.id);
      if (result.body.status !== 200) throw Error('Actual offline producer did not complete its payment: ' + result.body.msg);
      const events = await f.db.select().from(schema.storeOrderOutbox).where(sql`${schema.storeOrderOutbox.aggregateId}=${source.order.id} AND ${schema.storeOrderOutbox.eventType}='order.paid'`);
      if (events.length !== 1) throw Error('Actual offline producer did not persist one original paid event');
      if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 5000) throw Error('Invalid owned consumer delay');
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      const consumed = await f.consume({ id: events[0].id, eventKey: events[0].eventKey });
      return { ...source, producer, key, input, result, order: await order(source.order.id), event: events[0], ...consumed };
    };
    await reset();
    return { ...f, env, close, reset, unpaid, paid, order, manager: managerRuntime, admin: adminRuntime, managerActor, managerInput, adminOffline, managerOffline, request };
  } catch (error) { await close(); throw error; }
}
