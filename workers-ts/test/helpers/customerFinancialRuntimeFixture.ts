import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../../src/env';
import { createContainerFromDb, createDbFromConnectionString, type DbClient } from '../../src/lib/di';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from '../../src/migrations/customerFinancialRuntimePlan';
import { inspectCustomerFinancialRuntimeCatalogPrerequisites } from '../../src/migrations/auditCustomerFinancialRuntimePrivileges';
import { provisionCustomerFinancialRuntime, customerFinancialRuntimeSuccessor } from '../../src/migrations/provisionCustomerFinancialRuntime';
import { runRoutinePaymentRuntimeInstallation, auditRoutinePaymentRuntime, type RoutinePaymentRuntimeTarget } from '../../src/migrations/routinePaymentRuntime';
import { runCustomerWorkOperation } from '../../src/migrations/runCustomerWorkOperation';
import { runCustomerProductOperation } from '../../src/migrations/runCustomerProductOperation';
import { runCustomerUserOperation } from '../../src/migrations/runCustomerUserOperation';
import { runCustomerFinancialOperation } from '../../src/migrations/runCustomerFinancialOperation';
import { installCustomerWorkScopeLock } from '../../src/migrations/runCustomerWorkScopeLock';
import { installCustomerProductCatalogLock } from '../../src/migrations/runCustomerProductCatalogLock';
import { installCustomerUserCatalogLock } from '../../src/migrations/runCustomerUserCatalogLock';
import { runCustomerWaybillActor } from '../../src/migrations/runCustomerWaybillActor';
import { installCustomerCityDelivery } from '../../src/migrations/customerCityDelivery';
import { storeService, systemConfig, user, storeOrder } from '../../src/models/schema';
import { StoreCartService } from '../../src/services/order/StoreCartService';
import { StoreOrderCreateService } from '../../src/services/order/StoreOrderCreateService';
import { errorHandler } from '../../src/middleware/error';
import { v1Routes } from '../../src/routes/v1';
import { createToken, md5 } from '../../src/utils/jwt';
import { refundRuntimeFixture } from './refundRuntimeFixture';
import { ownsSequenceRunnerEndpoint, validateSequenceRunnerTestUrl } from './kefuSequenceRunnerDatabase';

const identifier = (name: string) => {
  if (!/^[a-z_][a-z_0-9]{0,62}$/u.test(name)) throw Error('Invalid owned Customer runtime fixture identity');
  return '"' + name + '"';
};
export const customerFinancialFixturePassword = md5('owned-customer-financial-user-password');
export const customerFinancialCredential = () => Array.from(randomBytes(32), byte => byte.toString(16).padStart(2, '0')).join('');
const businessTables = ['store_order', 'store_order_cart_info', 'store_order_status', 'store_order_outbox',
  'store_order_refund', 'store_order_refund_payment', 'store_order_refund_split', 'store_order_fulfillment_branch',
  'user', 'user_bill', 'user_brokerage', 'supplier_flowing_water', 'supplier_transactions'] as const;

/** One owned native PG16 database with all185 canonical migrations (283 base
 * relations), real quote seeds and explicit existing Customer protocols. No
 * grant-on-error or substitute protocol tables. Fresh fixed-role commission
 * is deliberately left to callers so refusal and caller rollback can run
 * before the one successful commission. No production binding is accepted. */
export async function customerFinancialRuntimeFixture() {
  if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Owned native PG16 is required');
  const base = validateSequenceRunnerTestUrl(process.env.TEST_FINANCE_POSTGRES_URL);
  const coordinator = postgres(base.href, { max: 1, prepare: false, connect_timeout: 5,
    connection: { options: '-c statement_timeout=180000 -c lock_timeout=3000' } });
  try {
    const [identity] = await coordinator`SELECT current_database() AS database,current_user AS role,
      current_setting('server_version_num')::integer/10000=16 AS pg16`;
    if (identity.database !== 'cinashop_finance_test' || identity.role !== 'finance_test' || identity.pg16 !== true)
      throw Error('Owned Customer financial coordinator changed');
    await coordinator`SELECT pg_advisory_lock(731626,914)`;
  } catch (error) { await coordinator.end({ timeout: 5 }); throw error; }
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  try { f = await refundRuntimeFixture(); }
  catch (error) { await coordinator.end({ timeout: 5 }); throw error; }
  const owned: { name: string; oid: string }[] = [], clients: DbClient[] = [];
  let fixedOid: string | undefined, closed = false;
  let origin: { database: string; role: string; session: string; host: string; port: number } | undefined;
  try {
    [origin] = await f.db.execute<typeof origin & {}>(sql`SELECT current_database() AS database,current_user AS role,session_user AS session,
      host(inet_server_addr()) AS host,inet_server_port() AS port`);
  } catch (error) { try { await f.close(); } finally { await coordinator.end({ timeout: 5 }); } throw error; }
  const markFixedRoleOwned = async () => {
    const rows = await f.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${CUSTOMER_FINANCIAL_RUNTIME_ROLE}`);
    if (rows.length !== 1 || fixedOid && fixedOid !== rows[0].oid) throw Error('Fixed Customer role OID changed');
    fixedOid = rows[0].oid;
  };
  const close = async () => {
    if (closed) return; closed = true;
    const failures: unknown[] = [];
    for (const result of await Promise.allSettled(clients.splice(0).map(db => db.$client.end({ timeout: 5 }))))
      if (result.status === 'rejected') failures.push(result.reason);
    try {
      const [current] = await f.db.execute(sql`SELECT current_database() AS database,current_user AS role`);
      if (!origin || current?.database !== origin.database || current.role !== origin.role) throw Error('Owned Customer cleanup target changed');
      const fixed = await f.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${CUSTOMER_FINANCIAL_RUNTIME_ROLE}`);
      if (fixed.length) {
        if (fixed.length !== 1 || !fixedOid || fixed[0].oid !== fixedOid) throw Error('Unmarked fixed Customer role cannot be cleaned');
        await f.exec(`DROP OWNED BY ${identifier(CUSTOMER_FINANCIAL_RUNTIME_ROLE)}; DROP ROLE ${identifier(CUSTOMER_FINANCIAL_RUNTIME_ROLE)}`);
      }
      for (const role of [...owned].reverse()) {
        const rows = await f.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${role.name}`);
        if (rows.length !== 1 || rows[0].oid !== role.oid) throw Error('Owned Customer companion/owner OID changed');
        await f.exec(`DROP OWNED BY ${identifier(role.name)}; DROP ROLE ${identifier(role.name)}`);
      }
    } catch (error) { failures.push(error); }
    try { await f.close(); } catch (error) { failures.push(error); }
    try { await coordinator.end({ timeout: 5 }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Customer native fixture cleanup was not fully confirmed');
  };
  try {
    if (!origin || origin.role !== 'finance_test' || origin.session !== origin.role
      || !ownsSequenceRunnerEndpoint(origin.database, 'public', base.href, origin.host, origin.port))
      throw Error('Customer runtime fixture endpoint is not owned');
    const trustedOrigin = origin;
    if ((await f.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${CUSTOMER_FINANCIAL_RUNTIME_ROLE}`)).length)
      throw Error('Fixed Customer financial role already exists in owned cluster');
    const createOwnedRole = async (kind: string, login = false) => {
      identifier(kind);
      const name = `cfr12_${kind}_${randomUUID().replaceAll('-', '')}`, password = randomUUID();
      await f.exec(`CREATE ROLE ${identifier(name)} ${login ? 'LOGIN' : 'NOLOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOINHERIT NOREPLICATION NOBYPASSRLS${login ? ` PASSWORD '${password}' CONNECTION LIMIT 2` : ''}`);
      const rows = await f.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${name}`);
      if (rows.length !== 1) throw Error('Owned Customer role creation was not observed');
      owned.push({ name, oid: rows[0].oid });
      if (login) await f.exec(`GRANT CONNECT ON DATABASE ${identifier(trustedOrigin.database)} TO ${identifier(name)}; GRANT USAGE ON SCHEMA public TO ${identifier(name)}`);
      return { role: name, password };
    };
    const connect = (role: string, password: string) => {
      identifier(role); const url = new URL(base.href); url.pathname = '/' + trustedOrigin.database; url.username = role; url.password = password;
      const db = createDbFromConnectionString(url.href, 1, { searchPath: 'public,pg_temp', applicationName: 'customer_financial_native' });
      clients.push(db); return { db, connectionString: url.href };
    };
    await runCustomerWaybillActor(f.db);
    await runCustomerWorkOperation(f.db); await runCustomerProductOperation(f.db);
    await runCustomerUserOperation(f.db); await runCustomerFinancialOperation(f.db);
    await installCustomerCityDelivery(f.db, { maintenance: true });
    const scope = await createOwnedRole('scope'), product = await createOwnedRole('product'), users = await createOwnedRole('users');
    await installCustomerWorkScopeLock(f.db, scope.role);
    await installCustomerProductCatalogLock(f.db, product.role);
    // Read-only evidence of the actual current maintenance session's temp
    // namespace. No protocol SQL/body/assertion is rewritten or bypassed.
    const [tempContext] = await f.db.execute(sql`SELECT current_database() AS database,current_user AS role,
      pg_backend_pid() AS pid,pg_my_temp_schema()::text AS temp_oid,
      (SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema()) AS temp_schema`);
    const schemaAuthority = await f.db.execute(sql`SELECT n.oid::text AS oid,n.nspname AS schema,
      pg_get_userbyid(n.nspowner) AS owner,n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=${users.role}) AS owns,
      has_schema_privilege(${users.role},n.oid,'CREATE') AS create,
      has_schema_privilege(${users.role},n.oid,'USAGE') AS usage,n.oid=pg_my_temp_schema() AS current_temp
      FROM pg_namespace n WHERE n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=${users.role})
        OR(n.nspname NOT IN('pg_catalog','information_schema','pg_toast') AND has_schema_privilege(${users.role},n.oid,'CREATE'))
      ORDER BY n.nspname`);
    const userCatalogContext = { context: tempContext, owner_role: users.role, schema_authority: Array.from(schemaAuthority) };
    console.log('CUSTOMER_FINANCIAL_USER_CATALOG_TEMP_CONTEXT ' + JSON.stringify(userCatalogContext));
    await installCustomerUserCatalogLock(f.db, users.role);
    const prerequisites = await inspectCustomerFinancialRuntimeCatalogPrerequisites(f.db, 'finance_test');
    if (!prerequisites.ready) throw Error('Complete Customer source prerequisites refused: ' + prerequisites.failures.join(','));
    const appRole = await createOwnedRole('app', true), adminRole = await createOwnedRole('admin', true);
    // Only the ordinary UserJWT lookup needs this extra companion base read.
    // It has no Customer financial ledger or business mutation privileges.
    await f.exec(`GRANT SELECT ON public."user" TO ${identifier(appRole.role)}`);
    const app = { ...appRole, ...connect(appRole.role, appRole.password) }, admin = { ...adminRole, ...connect(adminRole.role, adminRole.password) };
    const previous: RoutinePaymentRuntimeTarget = { database: trustedOrigin.database, maintenance: 'finance_test', app: app.role, admin: admin.role };
    const installation = await runRoutinePaymentRuntimeInstallation(f.db, previous);
    if (!installation.applied || !installation.after.ready) throw Error('Fresh previous routine binding did not install');
    for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
      const audit = await auditRoutinePaymentRuntime(peer.db, kind, previous);
      if (!audit.ready || !audit.realLogin) throw Error('Independent Customer companion addon LOGIN audit failed');
    }
    // Denial-only immutable legacy presence, never a provider success/witness.
    await f.db.execute(sql`INSERT INTO public.routine_payment_attempt VALUES('customer_native_old','INITIATION','{"fixture_denial_presence_only":true}',1,${'a'.repeat(64)})`);
    await f.db.execute(sql`INSERT INTO public.routine_identity_witness VALUES(${randomUUID()},7,9,1,'{"fixture_history_only":true}',1,${'b'.repeat(64)})`);
    await f.db.insert(user).values([{ uid: 101, account: 'native-financial-owner', pwd: customerFinancialFixturePassword, status: 1 },
      { uid: 102, account: 'native-other-owner', pwd: customerFinancialFixturePassword, status: 1 }]);
    await f.db.insert(storeService).values({ id: 901, uid: 101, account: 'native-financial', customer: 1, accountStatus: 1, status: 0 });
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'offline_pay_status'));
    await f.db.insert(systemConfig).values({ menuName: 'offline_pay_status', value: '1' });
    // Explicit quote seed ids must not collide with later real cart additions.
    await f.exec("SELECT setval(pg_get_serial_sequence('public.store_cart','id'),(SELECT MAX(id) FROM public.store_cart),true)");
    const password = customerFinancialCredential(), target = customerFinancialRuntimeSuccessor(previous), financialUrl = new URL(base.href);
    financialUrl.pathname = '/' + trustedOrigin.database; financialUrl.username = CUSTOMER_FINANCIAL_RUNTIME_ROLE; financialUrl.password = password;
    const environment = { ...f.env, APP_KEY: 'owned-native-customer-financial-jwt', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      HYPERDRIVE: { connectionString: app.connectionString }, HYPERDRIVE_ADMIN: { connectionString: admin.connectionString },
      HYPERDRIVE_CUSTOMER_FINANCIAL: { connectionString: financialUrl.href }, ORDER_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    } as unknown as Env;
    const application = createContainerFromDb(app.db);
    const http = new Hono<{ Bindings: Env; Variables: AppVariables }>(); http.onError(errorHandler);
    http.use('*', async (c, next) => { c.set('container', application); try { await next(); }
      finally { if (c.get('container') !== application) throw Error('Financial HTTP did not restore ordinary App container'); } });
    http.route('/api', v1Routes);
    const request = async (path: string, body?: unknown, key?: string, bindings = environment, uid = 101) => {
      const token = (await createToken(uid, 'api', md5(customerFinancialFixturePassword), environment.APP_KEY)).token;
      const response = await http.request('/api' + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, bindings);
      return { response, body: await response.json() as { status: number; msg: string; data: unknown } };
    };
    const businessState = async () => {
      const value: Record<string, unknown> = {};
      for (const table of businessTables) value[table] = await f.db.execute(sql.raw(`SELECT to_jsonb(t) AS row FROM public.${identifier(table)} t ORDER BY to_jsonb(t)::text`));
      return value;
    };
    const history = () => f.db.execute(sql`SELECT * FROM (SELECT 'attempt' AS kind,to_jsonb(t) AS payload FROM public.routine_payment_attempt t
      UNION ALL SELECT 'witness',to_jsonb(t) FROM public.routine_identity_witness t) old ORDER BY kind,payload::text`);
    const rawAcl = () => f.db.execute(sql`SELECT c.relname,c.relowner::text AS owner,c.relacl::text,
      ARRAY(SELECT a.attacl::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 ORDER BY a.attnum) AS columns
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN('routine_identity_witness','routine_payment_attempt','payment_reconciliation_action') ORDER BY c.relname`);
    const newOrder = async (runtime: DbClient) => {
      const container = createContainerFromDb(runtime), cart = await new StoreCartService(container, environment).add({ uid: 11, productId: 70, unique: 'qared001', cartNum: 1, isNew: 1 });
      const created = await StoreOrderCreateService.createWithRuntime(container,
        { CONFIG_KV: environment.CONFIG_KV, nextOrderId: async () => 'cfr_' + randomUUID().replaceAll('-', '').slice(0, 25) },
        { uid: 11, key: randomUUID(), cartIds: [cart.id], addressId: 11, userIp: '127.0.0.1', useIntegral: false });
      const rows = await runtime.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
      if (rows.length !== 1 || rows[0].paid !== 0 || rows[0].pid !== 0 || rows[0].type !== 0) throw Error('Real fixed Customer checkout did not persist an unpaid ordinary root');
      return rows[0];
    };
    return { ...f, close, database: trustedOrigin.database, previous, target, password, app, admin, environment, request,
      scopeOwner: scope.role, productOwner: product.role, userOwner: users.role, userCatalogContext, createOwnedRole, markFixedRoleOwned,
      connect, login: () => connect(CUSTOMER_FINANCIAL_RUNTIME_ROLE, password).db, businessState, history, rawAcl, newOrder,
      commission: async () => { const result = await provisionCustomerFinancialRuntime(f.db, password, previous); await markFixedRoleOwned(); return result; } };
  } catch (error) { await close(); throw error; }
}
