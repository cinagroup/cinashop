import { sql, getTableName } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import type { DbClient } from '@/lib/di';
import { createDbFromConnectionString } from '@/lib/di';
import { deliveryService, storeOrder, storeOrderCartInfo, storeOrderRefund, storePink,
  storeService, systemStore, systemStoreStaff, user } from '@/models/schema';
import { runMemberBarcodeIndex } from '@/migrations/runMemberBarcodeIndex';
import type { SystemConfigEnv } from '@/services/system/SystemConfigService';
import { financePostgres, ownsFinanceFixtureEndpoint, validateFinanceFixtureUrl } from './financePostgres';

export const PRIVATE_SCAN_TABLES = [user, storeOrder, storeOrderCartInfo, storeOrderRefund,
  storePink, systemStore, systemStoreStaff, deliveryService, storeService];
export const MEMBER_CODE = '123456789';
export const ORDER_CODE = '001122334455';
export type PrivateScanFixture = Awaited<ReturnType<typeof financePostgres>>;
const configValues = new Map<string, string>();
export const PRIVATE_SCAN_READ_ENV: SystemConfigEnv = { CONFIG_KV: {
  get: async key => configValues.get(key) ?? null,
  put: async (key, value) => { configValues.set(key, value); },
  delete: async key => { configValues.delete(key); },
} };

export async function seedPrivateScan(f: PrivateScanFixture) {
  await isolatePrivateScanMaintenanceScheduling(f);
  await f.reset();
  await f.db.insert(user).values([
    { uid: 11, barCode: MEMBER_CODE, status: 1 }, { uid: 12, barCode: '987654321', status: 1 },
    { uid: 101, status: 1 }, { uid: 102, status: 1 }, { uid: 201, status: 1 },
    { uid: 202, status: 1 }, { uid: 301, status: 1 }, { uid: 302, status: 1 },
  ]);
  await f.db.insert(systemStore).values([
    { id: 1, name: '甲店', isStore: 1, isShow: 1 }, { id: 2, name: '乙店', isStore: 1, isShow: 1 },
  ]);
  await f.db.insert(systemStoreStaff).values([
    { id: 1, uid: 101, storeId: 1, status: 1, verifyStatus: 1 },
    { id: 2, uid: 102, storeId: 2, status: 1, verifyStatus: 1 },
  ]);
  await f.db.insert(deliveryService).values([
    { id: 1, uid: 201, type: 0, relationId: 0, status: 1 },
    { id: 2, uid: 202, type: 0, relationId: 0, status: 1 },
  ]);
  await f.db.insert(storeService).values([
    { id: 1, uid: 301, accountStatus: 1, customer: 1, status: 0, merId: 99 },
    { id: 2, uid: 302, accountStatus: 1, customer: 0 },
  ]);
  await f.db.insert(storeOrder).values([
    { id: 401, uid: 11, orderId: 'owned-pickup-1', storeId: 1, shippingType: 2,
      paid: 1, status: 0, verifyCode: ORDER_CODE, totalNum: 1, payPrice: '10.00', payTime: 100 },
    { id: 402, uid: 12, orderId: 'foreign-pickup-2', storeId: 2, shippingType: 2,
      paid: 1, status: 0, verifyCode: '223344556677', totalNum: 1, payPrice: '10.00', payTime: 90 },
    { id: 403, uid: 11, orderId: 'owned-delivery', shippingType: 1, deliveryType: 'send', deliveryUid: 201,
      paid: 1, status: 1, verifyCode: '334455667788', totalNum: 1, payPrice: '10.00', payTime: 80 },
  ]);
  await f.db.insert(storeOrderCartInfo).values([
    { id: 501, oid: 401, uid: 11, cartId: 'cart-1', cartNum: 1, writeTimes: 1, writeSurplusTimes: 1,
      cartInfo: JSON.stringify({ sku: { price: '10.00' } }) },
    { id: 502, oid: 402, uid: 12, cartId: 'cart-2', cartNum: 1, writeTimes: 1, writeSurplusTimes: 1,
      cartInfo: JSON.stringify({ sku: { price: '10.00' } }) },
    { id: 503, oid: 403, uid: 11, cartId: 'cart-3', cartNum: 1, writeTimes: 1, writeSurplusTimes: 1,
      cartInfo: JSON.stringify({ sku: { price: '10.00' } }) },
  ]);
  // PGlite has no postgres.js begin or PG16 maintenance environment. Ordinary
  // tests install the exact identity fence; native proof runs its real installer.
  if (f.db.$client instanceof PGlite) {
    await f.exec('CREATE UNIQUE INDEX IF NOT EXISTS user_bar_code_uq ON public."user" USING btree (bar_code) WHERE bar_code <> \'\'');
  } else await runMemberBarcodeIndex(f.db);
}

/** Repeated fixture reset/seed can invite background maintenance. Keep that
 * scheduling out of positive request cases without changing production NOWAIT.
 * The historical CI error did not record the blocker identity. */
async function isolatePrivateScanMaintenanceScheduling(f: PrivateScanFixture) {
  if (f.db.$client instanceof PGlite) return;
  const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  type Scheduling = { database: string; schema: string; host: string; port: number; version: number; role: string;
    table_oid: string; owner: string; kind: string; options: string[] | null };
  const capture = () => f.db.execute<Scheduling>(sql`SELECT current_database() AS database,current_schema() AS schema,
    host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('server_version_num')::integer AS version,
    current_user AS role,c.oid::text AS table_oid,pg_get_userbyid(c.relowner) AS owner,c.relkind::text AS kind,c.reloptions AS options
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='user'`);
  const before = await capture(), row = before[0];
  if (before.length !== 1 || !row || row.schema !== 'public' || row.role !== 'finance_test' || row.owner !== row.role
    || row.kind !== 'r' || !/^[1-9]\d*$/.test(row.table_oid) || Math.floor(row.version / 10000) !== 16
    || !ownsFinanceFixtureEndpoint(row.database, row.schema, base.href, row.host, row.port)
    || row.options !== null && JSON.stringify(row.options) !== '["autovacuum_enabled=false"]')
    throw Error('Private scan seed requires its exact owned native user table');
  if (row.options !== null) return;
  await f.db.$client.begin('isolation level read committed', async tx => {
    await tx.unsafe("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'");
    await tx.unsafe('ALTER TABLE public."user" SET (autovacuum_enabled=false)');
  });
  const after = await capture();
  if (after.length !== 1 || JSON.stringify({ ...after[0], options: row.options }) !== JSON.stringify(row)
    || JSON.stringify(after[0].options) !== '["autovacuum_enabled=false"]')
    throw Error('Private scan fixture user identity or scheduling changed unexpectedly');
  console.log('PRIVATE_SCAN_FIXTURE_MAINTENANCE_SCHEDULING ' + JSON.stringify({ before, after, historical_blocker_identified: false }));
}

/** Uses only this process's owned disposable native fixture. No DSN/password
 * reaches output; role/client are removed before the fixture is closed. */
export async function withPrivateScanReadRole<T>(f: PrivateScanFixture, run: (db: DbClient) => Promise<T>) {
  const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  const [identity] = await f.db.execute<{ database: string; schema: string; host: string; port: number }>(sql`
    SELECT current_database() AS database,current_schema() AS schema,
      host(inet_server_addr()) AS host,inet_server_port() AS port`);
  if (!identity || identity.schema !== 'public'
    || !ownsFinanceFixtureEndpoint(identity.database, identity.schema, base.href, identity.host, identity.port)) {
    throw Error('Private scan role proof requires its owned native fixture endpoint');
  }
  const role = `private_scan_${crypto.randomUUID().replaceAll('-', '')}`;
  const password = crypto.randomUUID().replaceAll('-', '');
  const client = f.db.$client;
  let db: DbClient | undefined;
  let created = false;
  try {
    await client.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    created = true;
    await client.unsafe(`GRANT CONNECT ON DATABASE "${identity.database}" TO "${role}"`);
    await client.unsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.unsafe(`GRANT SELECT ON ${PRIVATE_SCAN_TABLES.map(t => `public."${getTableName(t)}"`).join(',')} TO "${role}"`);
    const target = new URL(base.href);
    target.pathname = `/${identity.database}`; target.username = role; target.password = password;
    db = createDbFromConnectionString(target.href, 2, { searchPath: 'public', applicationName: 'legacy_private_scan_proof' });
    const [proof] = await db.execute<{ role: string; session: string; elevated: boolean }>(sql`
      SELECT current_user AS role,session_user AS session,
      (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS elevated
      FROM pg_roles WHERE rolname=current_user`);
    if (!proof || proof.role !== role || proof.session !== role || proof.elevated) throw Error('Unexpected private scan runtime role');
    for (const table of PRIVATE_SCAN_TABLES) {
      const name = `public."${getTableName(table)}"`;
      const [grants] = await db.execute<{ read: boolean; write: boolean }>(sql`
        SELECT has_table_privilege(current_user,${name},'SELECT') AS read,
        (has_table_privilege(current_user,${name},'INSERT') OR has_table_privilege(current_user,${name},'UPDATE')
        OR has_table_privilege(current_user,${name},'DELETE')) AS write`);
      if (!grants?.read || grants.write) throw Error('Private scan proof role must have only SELECT on its business tables');
    }
    return await run(db);
  } finally {
    await db?.$client.end({ timeout: 5 });
    if (created) {
      await client.unsafe(`DROP OWNED BY "${role}"`);
      await client.unsafe(`DROP ROLE "${role}"`);
      if ((await client`SELECT rolname FROM pg_roles WHERE rolname=${role}`).length) throw Error('Private scan runtime role cleanup not confirmed');
    }
  }
}

/** Observe the real transaction without replacing fixture/adapter methods. */
export function afterFirstPrivateScanSnapshot(db: DbClient, change: () => Promise<unknown>): DbClient {
  let calls = 0;
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key !== 'transaction') return Reflect.get(target, key, receiver);
      return async (read: (tx: DbClient) => Promise<unknown>, config?: Parameters<DbClient['transaction']>[1]) => {
        const value = await target.transaction(tx => read(tx as unknown as DbClient), config);
        if (++calls === 1) await change();
        return value;
      };
    },
  });
}

export function sqlErrorCode(error: unknown): string | undefined {
  for (let n = 0; n < 6 && error && typeof error === 'object'; n++) {
    const e = error as { code?: string; cause?: unknown };
    if (e.code) return e.code;
    error = e.cause;
  }
}
