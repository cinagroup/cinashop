import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../src/models/schema';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import type { RuntimePrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { runRuntimeBusinessCommissioning } from '../../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../../src/migrations/auditRuntimeBusinessPrivileges';
import { upgradeRuntimeAppCashierOriginReader } from '../../src/migrations/upgradeRuntimeAppCashierOriginReader';
import { runRoutinePaymentRuntimeInstallation, type RoutinePaymentRuntimeTarget } from '../../src/migrations/routinePaymentRuntime';
import { runCustomerWorkOperation } from '../../src/migrations/runCustomerWorkOperation';
import { runCustomerProductOperation } from '../../src/migrations/runCustomerProductOperation';
import { runCustomerUserOperation } from '../../src/migrations/runCustomerUserOperation';
import { runCustomerFinancialOperation } from '../../src/migrations/runCustomerFinancialOperation';
import { runCustomerWriteoffOperation } from '../../src/migrations/runCustomerWriteoffOperation';
import { runCustomerWaybillActor } from '../../src/migrations/runCustomerWaybillActor';
import { installCustomerCityDelivery } from '../../src/migrations/customerCityDelivery';
import { installCustomerWorkScopeLock } from '../../src/migrations/runCustomerWorkScopeLock';
import { installCustomerProductCatalogLock } from '../../src/migrations/runCustomerProductCatalogLock';
import { installCustomerUserCatalogLock } from '../../src/migrations/runCustomerUserCatalogLock';
import { installCashierSecondCardPromotionLock } from '../../src/migrations/cashierSecondCardPromotionLock';
import { runCashierSecondCardOrigin } from '../../src/migrations/runCashierSecondCardOrigin';
import { installCashierSecondCardAbandon, cashierSecondCardAbandonReadiness } from '../../src/migrations/runCashierSecondCardAbandon';
import { cashierSecondCardRuntimeGrantSql, cashierSecondCardRuntimePrivilegePlan } from '../../src/migrations/cashierSecondCardRuntimePlan';
import { installCustomerManualRefund } from '../../src/migrations/runCustomerManualRefund';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from '../../src/migrations/customerFinancialRuntimePlan';
import { provisionCustomerFinancialRuntime, customerFinancialRuntimeSuccessor } from '../../src/migrations/provisionCustomerFinancialRuntime';
import { upgradeCustomerFinancialManualRefundRuntime } from '../../src/migrations/upgradeCustomerFinancialManualRefundRuntime';
import { upgradeCustomerFinancialOriginalPaymentReaders } from '../../src/migrations/upgradeCustomerFinancialOriginalPaymentReaders';
import { auditCustomerFinancialRuntimePrivileges } from '../../src/migrations/auditCustomerFinancialRuntimePrivileges';
import { runManagerOrderOperation } from '../../src/migrations/runManagerOrderOperation';
import { installManagerScopeLock } from '../../src/migrations/runManagerScopeLock';
import { installManagerRuntimeCapabilities } from '../../src/migrations/managerRuntimeCapabilities';
import { MANAGER_RUNTIME_ROLE } from '../../src/migrations/managerRuntimePrivilegePlan';
import { provisionManagerRuntime } from '../../src/migrations/provisionManagerRuntime';
import { managerRoutinePaymentSuccessor } from '../../src/migrations/managerRoutinePaymentRuntime';
import { auditManagerRuntimePrivileges } from '../../src/migrations/auditManagerRuntimePrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges } from '../../src/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import type { RuntimeGiftPeerDeclarations } from '../../src/migrations/customerRuntimeGiftPeers';
import { installSupplierOrderEditOperation } from '../../src/migrations/supplierOrderEditOperation';
import { installLegacyOrderGainPartition } from '../../src/migrations/legacyOrderGainPartition';
import { customerFinancialCanonicalFixtureDatabase } from './customerFinancialCanonicalFixtureDatabase';
import { createPcCheckoutQuoteFixture } from './pcCheckoutQuoteFixture';
import { validateFinanceFixtureUrl } from './financePostgres';

const ident = (name: string) => {
  if (!/^[a-z_][a-z_0-9]{0,62}$/u.test(name)) throw Error('Unsafe original payment fixture identity');
  return '"' + name + '"';
};
const credential = () => Array.from(randomBytes(32), byte => byte.toString(16).padStart(2, '0')).join('');

/** Full canonical registered DB and genuinely distinct App/Admin/Financial/
 * Manager/cashier LOGINs. All role installation is explicit maintenance, before
 * business acceptance. No paid order, immutable payment fact or consumer result
 * is manufactured here. The original suite supplies real producers/consumers. */
export async function customerOriginalPaymentRuntimeFixture() {
  const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  const coordinator = postgres(base.href, { max: 1, prepare: false, connect_timeout: 5 });
  try {
    const [peer] = await coordinator`SELECT current_database() AS database,current_user AS role,current_setting('server_version_num')::integer/10000 AS version`;
    if (peer.database !== 'cinashop_finance_test' || peer.role !== 'finance_test' || peer.version !== 16) throw Error('Original payment coordinator changed');
    await coordinator`SELECT pg_advisory_lock(731626,913),pg_advisory_lock(731626,914)`;
  } catch (error) { await coordinator.end({ timeout: 5 }); throw error; }
  let whole: Awaited<ReturnType<typeof customerFinancialCanonicalFixtureDatabase>>;
  try { whole = await customerFinancialCanonicalFixtureDatabase(); }
  catch (error) { await coordinator.end({ timeout: 5 }); throw error; }
  const owned: Array<{ name: string; oid: string }> = [], pools: Array<ReturnType<typeof postgres>> = [];
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    const failures: unknown[] = [];
    for (const item of await Promise.allSettled(pools.map(pool => pool.end({ timeout: 5 })))) if (item.status === 'rejected') failures.push(item.reason);
    for (const role of [...owned].reverse()) try {
      const rows = await whole.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${role.name}`);
      if (rows.length !== 1 || rows[0].oid !== role.oid) throw Error('Original payment cleanup role OID changed');
      await whole.exec(`DROP OWNED BY ${ident(role.name)}; DROP ROLE ${ident(role.name)}`);
      if ((await whole.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${role.name}`)).length) throw Error('Original role cleanup unconfirmed');
    } catch (error) { failures.push(error); }
    try { await whole.close(); } catch (error) { failures.push(error); }
    try { await coordinator.end({ timeout: 5 }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Original payment fixture cleanup incomplete');
  };
  const mark = async (name: string) => {
    const rows = await whole.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${name}`);
    if (rows.length !== 1 || owned.some(role => role.name === name)) throw Error('Original role creation not uniquely observed');
    owned.push({ name, oid: rows[0].oid });
  };
  const createRole = async (kind: string, login = false) => {
    ident(kind); const role = 'original_' + kind + '_' + randomUUID().replaceAll('-', ''), password = credential();
    await whole.exec(`CREATE ROLE ${ident(role)} ${login ? 'LOGIN' : 'NOLOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS${login ? ` PASSWORD '${password}' CONNECTION LIMIT 15` : ''}`);
    await mark(role);
    if (login) await whole.exec(`GRANT CONNECT ON DATABASE ${ident(whole.database)} TO ${ident(role)};GRANT USAGE ON SCHEMA public TO ${ident(role)}`);
    return { role, password };
  };
  const connect = (role: string, password: string) => {
    const target = new URL(base.href); target.pathname = '/' + whole.database; target.username = role; target.password = password;
    const openClient = () => {
      const client = postgres(target.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
        connection: { options: '-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=1000' } });
      pools.push(client); return client;
    };
    const client = openClient(), db = drizzle(client) as unknown as DbClient;
    const verify = async (connection: DbClient = db) => {
      const [identity] = await connection.execute<{ pid: number; ready: boolean }>(sql`SELECT pg_backend_pid() AS pid,
        current_database()=${whole.database} AND current_user=${role} AND current_user=session_user
        AND EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid() AND r.rolname=current_user
          AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)) AS ready`);
      if (identity?.ready !== true) throw Error('Actual original-payment LOGIN identity differs');
      return identity.pid;
    };
    const withPeer = async <T>(callback: (peer: DbClient, pid: number) => Promise<T>): Promise<T> => {
      const peerClient = openClient(), peer = drizzle(peerClient) as unknown as DbClient;
      try { return await callback(peer, await verify(peer)); }
      finally { await peerClient.end({ timeout: 5 }); }
    };
    return { role, db, connectionString: target.href, verify, withPeer };
  };
  const withMaintenancePeer = async <T>(callback: (peer: DbClient, pid: number) => Promise<T>): Promise<T> => {
    const client = postgres(whole.connectionString, { max: 1, prepare: false, connect_timeout: 5,
      connection: { options: '-c search_path=public,pg_temp -c statement_timeout=5000 -c lock_timeout=1000' } });
    pools.push(client); const peer = drizzle(client) as unknown as DbClient;
    try {
      const [identity] = await peer.execute<{ pid: number; ready: boolean }>(sql`SELECT pg_backend_pid() AS pid,
        current_database()=${whole.database} AND current_user='finance_test' AND current_user=session_user
        AND current_setting('server_version_num')::integer/10000=16
        AND EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid
          WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper) AS ready`);
      if(identity?.ready!==true)throw Error('Owned original-payment maintenance peer identity changed');
      return await callback(peer,identity.pid);
    } finally { await client.end({ timeout: 5 }); }
  };
  try {
    for (const role of [CUSTOMER_FINANCIAL_RUNTIME_ROLE, MANAGER_RUNTIME_ROLE])
      if ((await whole.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${role}`)).length) throw Error('Fixed original payment role collision');
    const f = await createPcCheckoutQuoteFixture([], async () => ({ ...whole, close: async () => {} }));
    await runCustomerWaybillActor(whole.db); await installCustomerCityDelivery(whole.db, { maintenance: true });
    await runCustomerWorkOperation(whole.db); await runCustomerProductOperation(whole.db); await runCustomerUserOperation(whole.db);
    await runCustomerFinancialOperation(whole.db); await runCustomerWriteoffOperation(whole.db); await runCashierSecondCardOrigin(whole.db);
    await installCashierSecondCardAbandon(whole.db);
    const scope = await createRole('scope'), products = await createRole('products'), users = await createRole('users');
    await installCustomerWorkScopeLock(whole.db, scope.role);
    await installCustomerProductCatalogLock(whole.db, products.role); await installCustomerUserCatalogLock(whole.db, users.role);
    const appIdentity = await createRole('app', true), adminIdentity = await createRole('admin', true), cashierIdentity = await createRole('cashier', true);
    const app = connect(appIdentity.role, appIdentity.password), admin = connect(adminIdentity.role, adminIdentity.password), cashier = connect(cashierIdentity.role, cashierIdentity.password);
    const commission = { database: whole.database, maintenance: 'finance_test', pricingOwner: whole.pricingOwner, app: app.role, admin: admin.role };
    await runRuntimeBusinessCommissioning(whole.db, commission);
    for (const kind of ['app', 'admin'] as const) {
      const result = await auditRuntimeBusinessPrivileges(kind === 'app' ? app.db : admin.db, kind, commission);
      if (!result.ready) throw Error('Initial complete ' + kind + ' profile refused: ' + JSON.stringify(result));
    }
    await installCashierSecondCardPromotionLock(whole.db, cashier.role);
    const plan: RuntimePrivilegePlan = cashierSecondCardRuntimePrivilegePlan(), sequences: Array<{ name: string; table: string }> = [];
    for (const value of Object.values(schema)) if (is(value, PgTable)) {
      const table = getTableConfig(value); if (!plan.tables[table.name]?.includes('INSERT')) continue;
      for (const column of table.columns) if (column.generatedIdentity || ['serial', 'bigserial', 'smallserial'].includes(column.getSQLType())) {
        const name = column.generatedIdentity?.sequenceName ?? `${table.name}_${column.name}_seq`;
        const [actual] = await whole.db.execute<{ name: string }>(sql`SELECT pg_get_serial_sequence(${`public.${table.name}`},${column.name}) AS name`);
        if (actual?.name !== 'public.' + name) throw Error('Cashier source-derived sequence differs');
        sequences.push({ name, table: table.name });
      }
    }
    for (const grant of cashierSecondCardRuntimeGrantSql(cashier.role, sequences)) await whole.exec(grant);
    // The separately published durable abandonment addon is part of this
    // producer scenario, and stays separate from Financial's source reader.
    await whole.exec(`GRANT SELECT,INSERT ON public.cashier_second_card_abandon_v1 TO ${ident(cashier.role)}`);
    if (!(await cashierSecondCardAbandonReadiness(cashier.db)).ready) throw Error('Complete actual cashier abandonment addon refused');
    const initial: RoutinePaymentRuntimeTarget = { ...commission, local: [cashier.role] };
    const installed = await runRoutinePaymentRuntimeInstallation(whole.db, initial);
    if (!installed.after.ready) throw Error('Original App/Admin/cashier routine binding refused');
    const financialPassword = credential();
    await provisionCustomerFinancialRuntime(whole.db, financialPassword, initial); await mark(CUSTOMER_FINANCIAL_RUNTIME_ROLE);
    const financial = connect(CUSTOMER_FINANCIAL_RUNTIME_ROLE, financialPassword), financialTarget = customerFinancialRuntimeSuccessor(initial);
    const manualOwner = await createRole('manual');
    await whole.db.execute(sql`SELECT set_config('statement_timeout','5000ms',false),set_config('lock_timeout','1000ms',false),set_config('idle_in_transaction_session_timeout','5000ms',false)`);
    await installCustomerManualRefund(whole.db, manualOwner.role); await runManagerOrderOperation(whole.db);
    const manual = { promotionOwner: manualOwner.role }, readers = { secondCard: true as const };
    await upgradeCustomerFinancialManualRefundRuntime(whole.db, financialTarget, manual);
    await whole.db.transaction(async tx => { await installSupplierOrderEditOperation(tx); await installLegacyOrderGainPartition(tx); });
    await upgradeCustomerFinancialOriginalPaymentReaders(whole.db, financialTarget, manual, readers);
    const managerScope = await createRole('manager_scope'), waybillOwner = await createRole('waybill'), caseOwner = await createRole('case');
    await installManagerScopeLock(whole.db, managerScope.role);
    await whole.db.transaction(tx => installManagerRuntimeCapabilities(tx, { waybillOwner: waybillOwner.role, promotionOwner: manualOwner.role }),
      { isolationLevel: 'read committed', accessMode: 'read write' });
    const managerPassword = credential(), forward = { previous: financialTarget, caseLockOwner: caseOwner.role };
    await provisionManagerRuntime(whole.db, managerPassword, { database: whole.database, maintenanceRole: 'finance_test' }, forward); await mark(MANAGER_RUNTIME_ROLE);
    const manager = connect(MANAGER_RUNTIME_ROLE, managerPassword), target = managerRoutinePaymentSuccessor(forward);
    const peers: RuntimeGiftPeerDeclarations = { target, financial: { manualRefund: manual, originalPaymentReaders: readers },
      cashierSecondCard: { role: cashier.role, abandon: true }, manager: true };
    const appReaders = { cashierOrigin: true as const };
    await upgradeRuntimeAppCashierOriginReader(whole.db, target, appReaders, peers);
    const audits = {
      app: await auditRuntimeBusinessPrivileges(app.db, 'app', target, undefined, peers, appReaders), admin: await auditRuntimeBusinessPrivileges(admin.db, 'admin', target, undefined, peers),
      financial: await auditCustomerFinancialRuntimePrivileges(financial.db, target, manual, readers),
      manager: await auditManagerRuntimePrivileges(manager.db, target),
      cashier: await auditCustomerCashierSecondCardRuntimePrivileges(cashier.db, cashier.role, target, { abandon: true }),
    };
    if (Object.values(audits).some(result => !result.ready)) throw Error('Complete original payment profiles do not coexist: ' + JSON.stringify(audits));
    const pids = await Promise.all([app.verify(), admin.verify(), cashier.verify(), financial.verify(), manager.verify()]);
    if (new Set(pids).size !== pids.length) throw Error('Original payment LOGIN backends are not distinct');
    return { ...f, close, maintenanceDb: whole.db, withMaintenancePeer, exec: whole.exec, database: whole.database, target, manual, readers, appReaders,
      appRuntime: app, adminRuntime: admin, cashierRuntime: cashier, financialRuntime: financial, managerRuntime: manager,
      db: financial.db, role: financial.role, container: createContainerFromDb(financial.db),
      connectionString: financial.connectionString, withPeer: financial.withPeer, connect, createOwnedRole: createRole, audits, peers };
  } catch (error) { await close(); throw error; }
}
