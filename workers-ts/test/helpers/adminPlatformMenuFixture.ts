import { sql } from 'drizzle-orm';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { createContainerFromDb } from '@/lib/di';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import { ADMIN_AUTHORITY_OPERATION_SQL } from '@/migrations/adminAuthorityOperation';
import { ADMIN_PLATFORM_MENU_OPERATION_SQL, ADMIN_PLATFORM_MENU_WRITE_SIGNATURE,
  adminPlatformMenuWriteDefinition, assertAdminPlatformMenuWriteReady } from '@/migrations/adminPlatformMenuWriteCapability';
import { financeMemoryPostgres } from './financePostgres';

/** Real catalog/function/trigger/role SQL in an isolated PGlite connection.
 * Session authorization is an explicit memory-driver port, NOT independently
 * authenticated LOGIN evidence. The separate native suite proves that gate.
 * No SQL/inspector/service is mocked and no full-shop schema is commissioned. */
export async function createAdminPlatformMenuFixture() {
  const f = await financeMemoryPostgres([systemAdmin, systemRole, systemMenus], { namespace: 'public' });
  const admin = 'platform_menu_admin_fixture', app = 'platform_menu_app_fixture', owner = 'platform_menu_owner_fixture';
  try {
    const [identity] = await f.db.execute(sql`SELECT current_user AS role,current_database() AS database`);
    const names = { database: String(identity.database), maintenance: String(identity.role), admin, app, owner };
    await f.exec(`CREATE ROLE ${admin} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE ROLE ${app} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE ROLE ${owner} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO ${admin},${app},${owner};
      GRANT SELECT,INSERT,UPDATE ON public.system_admin,public.system_role TO ${admin};
      GRANT SELECT ON public.system_menus TO ${admin};`);
    await f.exec(ADMIN_AUTHORITY_OPERATION_SQL);
    await f.exec(ADMIN_PLATFORM_MENU_OPERATION_SQL);
    await f.exec(`GRANT SELECT,INSERT ON public.admin_authority_operation,public.admin_platform_menu_operation TO ${admin};
      GRANT EXECUTE ON FUNCTION public.admin_authority_menu_lock_v1() TO ${admin};
      GRANT SELECT,INSERT,UPDATE ON public.system_menus TO ${owner};
      GRANT SELECT ON public.system_role TO ${owner};
      GRANT USAGE ON SEQUENCE public.system_menus_id_seq TO ${owner};
      GRANT CREATE ON SCHEMA public TO ${owner};`);
    await f.exec(adminPlatformMenuWriteDefinition(admin));
    await f.exec(`REVOKE ALL ON FUNCTION ${ADMIN_PLATFORM_MENU_WRITE_SIGNATURE} FROM PUBLIC;
      ALTER FUNCTION ${ADMIN_PLATFORM_MENU_WRITE_SIGNATURE} OWNER TO ${owner};
      REVOKE CREATE ON SCHEMA public FROM ${owner};
      GRANT EXECUTE ON FUNCTION ${ADMIN_PLATFORM_MENU_WRITE_SIGNATURE} TO ${admin};`);
    let inSession = false;
    async function asRole<T>(role: string, run: () => Promise<T>): Promise<T> {
      if (inSession) throw Error('Platform menu session fixture operations must be sequential');
      inSession = true;
      try { await f.exec(`SET SESSION AUTHORIZATION ${pricingIdentifier(role)}`); return await run(); }
      finally {
        try {
          // PGlite's RESET port can retain the last authorization baseline.
          // Explicitly restore the captured real fixture owner, then verify
          // both identifiers rather than treating a successful SET as proof.
          await f.exec(`SET SESSION AUTHORIZATION ${pricingIdentifier(names.maintenance)}`);
          const [restored] = await f.db.execute(sql`SELECT current_user AS role,session_user AS session`);
          if (restored?.role !== names.maintenance || restored?.session !== names.maintenance) throw Error('Platform menu memory session owner restoration failed');
        } finally { inSession = false; }
      }
    }
    const asAdmin = <T>(run: () => Promise<T>) => asRole(admin, run);
    await asAdmin(() => assertAdminPlatformMenuWriteReady(f.db));
    return { ...f, names, container: createContainerFromDb(f.db), asAdmin,
      asApp: <T>(run: () => Promise<T>) => asRole(app, run), memorySessionPort: true as const };
  } catch (error) { await f.close(); throw error; }
}

export async function withAdminPlatformMenuFixture<T>(run: (fixture: Awaited<ReturnType<typeof createAdminPlatformMenuFixture>>) => Promise<T>) {
  const fixture = await createAdminPlatformMenuFixture();
  try { return await run(fixture); } finally { await fixture.close(); }
}
