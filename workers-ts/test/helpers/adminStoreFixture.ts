import { getTableName, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { systemAdmin,systemRole,systemMenus,systemStore,systemStoreStaff,storeOrder,user,cityArea,
 systemAttachment,systemAttachmentCategory,systemConfig,storeConfig,systemLog } from '@/models/schema';
import { createContainerFromDb } from '@/lib/di';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import { ADMIN_AUTHORITY_OPERATION_SQL } from '@/migrations/adminAuthorityOperation';
import { ADMIN_STORE_OPERATION_SQL, assertAdminStoreOperationReady } from '@/migrations/adminStoreOperation';
import { financeMemoryPostgres } from './financePostgres';

/** Real PGlite tables, catalog/trigger/ACL inspector and restricted session port.
 * Independent LOGIN, concurrency and maintenance are native-suite evidence. */
export async function createAdminStoreFixture(extraTables: PgTable[] = []) {
  const tables = [...new Map([systemAdmin,systemRole,systemMenus,systemStore,systemStoreStaff,storeOrder,user,cityArea,
 systemAttachment,systemAttachmentCategory,systemConfig,storeConfig,systemLog,...extraTables].map(table=>[getTableName(table),table])).values()];
  const f = await financeMemoryPostgres(tables, { namespace: 'public' });
  const admin = 'store_admin_fixture', app = 'store_app_fixture';
  try {
    const [identity] = await f.db.execute(sql`SELECT current_user AS role,current_database() AS database`);
    const names = { database: String(identity.database), maintenance: String(identity.role), admin, app };
    await f.exec(`CREATE ROLE ${admin} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE ROLE ${app} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO ${admin},${app};
      GRANT SELECT,INSERT,UPDATE ON public.system_admin,public.system_role TO ${admin};
      GRANT SELECT ON public.system_menus,public.system_attachment,public.system_attachment_category,public.system_config,public.store_config TO ${admin};
      GRANT UPDATE(att_id) ON public.system_attachment TO ${admin};
      GRANT SELECT,INSERT,UPDATE ON public.system_store,public.system_store_staff,public."user" TO ${admin};
      GRANT SELECT ON public.city_area,public.store_order TO ${admin};
      GRANT UPDATE(id) ON public.city_area TO ${admin};
      GRANT UPDATE ON public.store_order TO ${admin};
      GRANT SELECT,INSERT ON public.system_log TO ${admin};
      GRANT SELECT ON public.system_store,public.system_store_staff,public.city_area TO ${app};`);
    // Only actual owned sequences for these explicit writable tables. Do not
    // grant all sequences belonging to optional catalogue/pricing fixtures.
    for (const [table, column] of [['system_store','id'],['system_store_staff','id'],['user','uid'],['system_log','id']] as const) {
      const [row] = await f.db.execute(sql`SELECT pg_get_serial_sequence(${`public.${table}`},${column}) AS sequence`);
      if (typeof row?.sequence === 'string') await f.exec(`GRANT USAGE ON SEQUENCE ${row.sequence} TO ${admin}`);
    }
    await f.exec(ADMIN_AUTHORITY_OPERATION_SQL);
    await f.exec(ADMIN_STORE_OPERATION_SQL);
    await f.exec(`GRANT SELECT,INSERT ON public.admin_authority_operation,public.admin_store_operation TO ${admin};
      GRANT EXECUTE ON FUNCTION public.admin_authority_menu_lock_v1() TO ${admin};`);
    let inSession = false;
    async function asRole<T>(role: string, run: () => Promise<T>): Promise<T> {
      if (inSession) throw Error('Store fixture session operations must be sequential');
      inSession = true;
      try { await f.exec(`SET SESSION AUTHORIZATION ${pricingIdentifier(role)}`); return await run(); }
      finally {
        try {
          await f.exec(`SET SESSION AUTHORIZATION ${pricingIdentifier(names.maintenance)}`);
          const [restored] = await f.db.execute(sql`SELECT current_user AS role,session_user AS session`);
          if (restored?.role !== names.maintenance || restored?.session !== names.maintenance) throw Error('Store memory session restoration failed');
        } finally { inSession = false; }
      }
    }
    const asAdmin = <T>(run: () => Promise<T>) => asRole(admin, run);
    await asAdmin(() => f.db.transaction(tx => assertAdminStoreOperationReady(tx)));
    return { ...f, names, container: createContainerFromDb(f.db), asAdmin,
      asApp: <T>(run: () => Promise<T>) => asRole(app, run), memorySessionPort: true as const };
  } catch (error) { await f.close(); throw error; }
}
