import { sql } from 'drizzle-orm';
import { systemAdmin, systemRole, systemMenus, expressCompany, orderWaybillJob,
  storeOrder, systemConfig, storeConfig } from '@/models/schema';
import { createContainerFromDb } from '@/lib/di';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import { ADMIN_AUTHORITY_OPERATION_SQL } from '@/migrations/adminAuthorityOperation';
import { ADMIN_EXPRESS_OPERATION_SQL, assertAdminExpressOperationReady } from '@/migrations/adminExpressOperation';
import { financeMemoryPostgres } from './financePostgres';

/** Actual PGlite schema, catalog, immutable triggers and restricted roles.
 * Session authorization is only a memory-driver port. Independent PG16 LOGIN,
 * concurrency and commissioning are proved by admin-express-native.test.ts. */
export async function createAdminExpressFixture() {
  const f = await financeMemoryPostgres([systemAdmin, systemRole, systemMenus, expressCompany,
    orderWaybillJob, storeOrder, systemConfig, storeConfig], { namespace: 'public' });
  const admin = 'express_admin_fixture', app = 'express_app_fixture';
  try {
    const [identity] = await f.db.execute(sql`SELECT current_user AS role,current_database() AS database`);
    const names = { database: String(identity.database), maintenance: String(identity.role), admin, app };
    await f.exec(`CREATE ROLE ${admin} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE ROLE ${app} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO ${admin},${app};
      GRANT SELECT,INSERT,UPDATE ON public.system_admin,public.system_role TO ${admin};
      GRANT SELECT ON public.system_menus,public.order_waybill_job,public.store_order TO ${admin};
      GRANT SELECT,UPDATE ON public.system_config,public.store_config TO ${admin};
      GRANT SELECT,INSERT,UPDATE,DELETE ON public.express_company TO ${admin};
      GRANT USAGE ON SEQUENCE public.express_company_id_seq TO ${admin};
      GRANT SELECT ON public.express_company TO ${app};`);
    await f.exec(ADMIN_AUTHORITY_OPERATION_SQL);
    await f.exec(ADMIN_EXPRESS_OPERATION_SQL);
    await f.exec(`GRANT SELECT,INSERT ON public.admin_authority_operation,public.admin_express_operation TO ${admin};
      GRANT EXECUTE ON FUNCTION public.admin_authority_menu_lock_v1() TO ${admin};`);
    let inSession = false;
    async function asRole<T>(role: string, run: () => Promise<T>): Promise<T> {
      if (inSession) throw Error('Express fixture session operations must be sequential');
      inSession = true;
      try { await f.exec(`SET SESSION AUTHORIZATION ${pricingIdentifier(role)}`); return await run(); }
      finally {
        try {
          await f.exec(`SET SESSION AUTHORIZATION ${pricingIdentifier(names.maintenance)}`);
          const [restored] = await f.db.execute(sql`SELECT current_user AS role,session_user AS session`);
          if (restored?.role !== names.maintenance || restored?.session !== names.maintenance) throw Error('Express memory session restoration failed');
        } finally { inSession = false; }
      }
    }
    const asAdmin = <T>(run: () => Promise<T>) => asRole(admin, run);
    await asAdmin(() => f.db.transaction(tx => assertAdminExpressOperationReady(tx)));
    return { ...f, names, container: createContainerFromDb(f.db), asAdmin,
      asApp: <T>(run: () => Promise<T>) => asRole(app, run), memorySessionPort: true as const };
  } catch (error) { await f.close(); throw error; }
}
export async function withAdminExpressFixture<T>(run: (fixture: Awaited<ReturnType<typeof createAdminExpressFixture>>) => Promise<T>) {
  const f = await createAdminExpressFixture();
  try { return await run(f); } finally { await f.close(); }
}
