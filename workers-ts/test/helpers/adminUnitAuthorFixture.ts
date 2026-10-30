import {sql} from 'drizzle-orm';
import {createContainerFromDb} from '@/lib/di';
import {pricingIdentifier} from '@/migrations/checkoutPricingLockCatalog';
import {ADMIN_AUTHORITY_OPERATION_SQL} from '@/migrations/adminAuthorityOperation';
import {ADMIN_UNIT_OPERATION_SQL,assertAdminUnitOperationReady} from '@/migrations/adminUnitOperation';
import {financeMemoryPostgres} from './financePostgres';
import {unitTables} from './adminProductUnits';

/** Actual PGlite catalog, ACL and SQL. Independent LOGIN/row-lock evidence
 * comes from the separate native PG16 suite, not this sequential session port. */
export async function createAdminUnitAuthorFixture(){
  const fixture=await financeMemoryPostgres(unitTables,{namespace:'public'});
  const admin='unit_author_admin_fixture',app='unit_author_app_fixture';
  try{
    const [identity]=await fixture.db.execute(sql`SELECT current_user AS role,current_database() AS database`);
    const names={database:String(identity.database),maintenance:String(identity.role),admin,app};
    await fixture.exec(`CREATE ROLE ${admin} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE ROLE ${app} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;GRANT USAGE ON SCHEMA public TO ${admin},${app};
      GRANT SELECT,UPDATE ON public.system_admin,public.system_role TO ${admin};
      GRANT SELECT ON public.system_menus,public.store_product TO ${admin};GRANT UPDATE(id) ON public.system_menus TO ${admin};
      GRANT SELECT,INSERT,UPDATE,DELETE ON public.store_product_unit TO ${admin};
      GRANT SELECT,INSERT ON public.system_log TO ${admin};
      GRANT SELECT ON public.store_product_unit TO ${app};GRANT SELECT,UPDATE ON public.store_product TO ${app};`);
    for(const table of ['store_product_unit','system_log']){
      const [row]=await fixture.db.execute(sql`SELECT pg_get_serial_sequence(${`public.${table}`},'id') AS sequence`);
      if(typeof row?.sequence==='string')await fixture.exec(`GRANT USAGE ON SEQUENCE ${row.sequence} TO ${admin}`);
    }
    await fixture.exec(ADMIN_AUTHORITY_OPERATION_SQL);await fixture.exec(ADMIN_UNIT_OPERATION_SQL);
    await fixture.exec(`GRANT SELECT,INSERT ON public.admin_authority_operation,public.admin_unit_operation TO ${admin};
      GRANT EXECUTE ON FUNCTION public.admin_authority_menu_lock_v1() TO ${admin};`);
    let inSession=false;
    async function asRole<T>(role:string,work:()=>Promise<T>):Promise<T>{
      if(inSession)throw Error('Unit memory fixture sessions must be sequential');inSession=true;
      try{await fixture.exec(`SET SESSION AUTHORIZATION ${pricingIdentifier(role)}`);return await work();}
      finally{try{await fixture.exec(`SET SESSION AUTHORIZATION ${pricingIdentifier(names.maintenance)}`);
        const [row]=await fixture.db.execute(sql`SELECT current_user AS role,session_user AS session`);
        if(row?.role!==names.maintenance||row?.session!==names.maintenance)throw Error('Unit fixture session restoration failed');
      }finally{inSession=false;}}
    }
    const asAdmin=<T>(work:()=>Promise<T>)=>asRole(admin,work);
    await asAdmin(()=>fixture.db.transaction(tx=>assertAdminUnitOperationReady(tx)));
    return {...fixture,names,container:createContainerFromDb(fixture.db),asAdmin,asApp:<T>(work:()=>Promise<T>)=>asRole(app,work)};
  }catch(error){await fixture.close();throw error;}
}
