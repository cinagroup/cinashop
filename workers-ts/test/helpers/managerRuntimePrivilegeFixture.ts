import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { checkoutPricingMigrationDatabase } from './checkoutPricingMigrationDatabase';
import { ownsSequenceRunnerEndpoint, validateSequenceRunnerTestUrl } from './kefuSequenceRunnerDatabase';
import { createContainerFromDb } from '../../src/lib/di';
import { MigrationService } from '../../src/services/MigrationService';
import { runManagerOrderOperation } from '../../src/migrations/runManagerOrderOperation';
import { installManagerScopeLock } from '../../src/migrations/runManagerScopeLock';
import { inspectManagerRuntimeCatalogPrerequisites } from '../../src/migrations/auditManagerRuntimePrivileges';
import { MANAGER_RUNTIME_ROLE } from '../../src/migrations/managerRuntimePrivilegePlan';
import { installManagerRuntimeCapabilities } from '../../src/migrations/managerRuntimeCapabilities';

/** Owned native PG16 only; creates no manager runtime LOGIN. Callers must mark
 * a successfully created role's OID before this fixture may remove it. */
export async function managerRuntimePrivilegeFixture() {
  if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Explicit owned native PG16 manager fixture required');
  const base = validateSequenceRunnerTestUrl(process.env.TEST_FINANCE_POSTGRES_URL);
  // The fixed production role is cluster-wide. Serialize only these owned
  // fixtures on the validated coordinator DB; other tests keep random roles.
  const coordinator = postgres(base.href, { max: 1, prepare: false, connect_timeout: 5,
    connection: { options: '-c statement_timeout=180000 -c lock_timeout=3000' } });
  try {
    const [guard] = await coordinator`SELECT current_database() AS database,current_user AS role,
      current_setting('server_version_num')::integer/10000=16 AS pg16`;
    if (guard.database !== 'cinashop_finance_test' || guard.role !== 'finance_test' || guard.pg16 !== true) throw Error('Owned manager coordinator changed');
    await coordinator`SELECT pg_advisory_lock(731626,913)`;
  } catch (error) { await coordinator.end({ timeout: 5 }); throw error; }
  let f: Awaited<ReturnType<typeof checkoutPricingMigrationDatabase>>;
  try { f = await checkoutPricingMigrationDatabase(); }
  catch (error) { await coordinator.end({ timeout: 5 }); throw error; }
  if (f.format !== 'pg16') {
    try { await f.close(); } finally { await coordinator.end({ timeout: 5 }); }
    throw Error('Native manager fixture required');
  }
  let identity:{database:string;role:string;host:string;port:number}|undefined;
  try {[identity]=await f.db.execute<{ database: string; role: string; host: string; port: number }>(sql`
    SELECT current_database() AS database,current_user AS role,host(inet_server_addr()) AS host,inet_server_port() AS port`);}
  catch(error){try{await f.close();}finally{await coordinator.end({timeout:5});}throw error;}
  if (!identity || identity.role !== 'finance_test'
    || !ownsSequenceRunnerEndpoint(identity.database, 'public', base.href, identity.host, identity.port)) {
    try { await f.close(); } finally { await coordinator.end({ timeout: 5 }); }
    throw Error('Manager fixture target is not owned');
  }
  const trustedIdentity=identity;
  const scopeOwner = `manager_scope_${randomUUID().replaceAll('-', '')}`;
  const capabilityOwners:string[]=[];
  let scopeCreated = false, managerOid: string | null = null, closed = false;
  const markManagerRoleOwned = async () => {
    const rows = await f.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${MANAGER_RUNTIME_ROLE}`);
    if (rows.length !== 1 || managerOid && managerOid !== rows[0].oid) throw Error('Owned manager role identity changed');
    managerOid = rows[0].oid;
  };
  const close = async () => {
    if (closed) return; closed = true;
    try {
      const [current] = await f.db.execute(sql`SELECT current_database() AS database,current_user AS role`);
      if (current?.database !== trustedIdentity.database || current.role !== trustedIdentity.role) throw Error('Owned manager cleanup target changed');
      const rows = await f.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${MANAGER_RUNTIME_ROLE}`);
      if (rows.length) {
        if (rows.length !== 1 || rows[0].oid !== managerOid) throw Error('Unmarked manager role is not authorized for fixture cleanup');
        await f.exec(`DROP OWNED BY "${MANAGER_RUNTIME_ROLE}"; DROP ROLE "${MANAGER_RUNTIME_ROLE}"`);
      }
      for(const name of capabilityOwners)await f.exec(`DROP OWNED BY "${name}"; DROP ROLE "${name}"`);
      if (scopeCreated) await f.exec(`DROP OWNED BY "${scopeOwner}"; DROP ROLE "${scopeOwner}"`);
    } finally {
      try { await f.close(); }
      finally { await coordinator.end({ timeout: 5 }); }
    }
  };
  try {
    const prior = await f.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${MANAGER_RUNTIME_ROLE}`);
    if (prior.length) throw Error('Fixed manager role already exists in the owned cluster');
    const result = await new MigrationService(createContainerFromDb(f.db)).runAll();
    if (result.errors.length) throw Error('Canonical manager fixture migration failed');
    await runManagerOrderOperation(f.db);
    await f.exec(`CREATE ROLE "${scopeOwner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    scopeCreated = true; await installManagerScopeLock(f.db, scopeOwner);
    const waybillOwner=`manager_waybill_${randomUUID().replaceAll('-','')}`,promotionOwner=`manager_promotion_${randomUUID().replaceAll('-','')}`;
    for(const name of [waybillOwner,promotionOwner]){await f.exec(`CREATE ROLE "${name}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);capabilityOwners.push(name);}
    await f.db.transaction(tx=>installManagerRuntimeCapabilities(tx,{waybillOwner,promotionOwner}),{isolationLevel:'read committed',accessMode:'read write'});
    const state = await inspectManagerRuntimeCatalogPrerequisites(f.db);
    if (!state.ready) throw Error(`Canonical manager fixture prerequisites failed: ${state.failures.join(',')}`);
    return { ...f, database: identity.database, scopeOwner, markManagerRoleOwned, close };
  } catch (error) { await close(); throw error; }
}
