import { sql } from 'drizzle-orm';
import type { DbClient } from '../../src/lib/di';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { pricingIdentifier } from '../../src/migrations/checkoutPricingLockCatalog';

/** TEST ONLY: never exposed by a Worker/CLI. Grants the exact draft profile in
 * a verified, test-owned loopback database, without widening on SQL errors. */
export async function grantRuntimeBusinessFixture(db: DbClient, role: string, kind: 'app'|'admin') {
  const [identity]=await db.execute(sql`SELECT current_database() AS database,current_user AS role,
    host(inet_server_addr()) AS host, current_setting('server_version_num')::int AS version`);
  if(!/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(String(identity?.database)) || identity?.role!=='finance_test'
    || !['127.0.0.1','::1'].includes(String(identity?.host)) || Math.floor(Number(identity?.version)/10000)!==16
    || !/^cinashop_runtime_[a-f0-9]{32}$/.test(role))throw Error('Business grants require an owned test target');
  const target=pricingIdentifier(role),plan=runtimeBusinessPrivilegePlan(kind);
  await db.transaction(async tx=>{
    for(const [table,privileges] of Object.entries(plan.tables))
      await tx.execute(sql.raw(`GRANT ${privileges.join(',')} ON public.${pricingIdentifier(table)} TO ${target}`));
    for(const [table,columns] of Object.entries(plan.updateColumns))
      await tx.execute(sql.raw(`GRANT UPDATE(${columns.map(pricingIdentifier).join(',')}) ON public.${pricingIdentifier(table)} TO ${target}`));
    const inserted=Object.entries(plan.tables).filter(([,p])=>p.includes('INSERT')).map(([t])=>t);
    const sequences=await tx.execute(sql`SELECT DISTINCT s.relname AS name FROM pg_catalog.pg_class s
      JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.oid
        AND d.refclassid='pg_catalog.pg_class'::regclass AND d.deptype IN('a','i')
      JOIN pg_catalog.pg_class t ON t.oid=d.refobjid
      WHERE s.relkind='S' AND s.relnamespace='public'::regnamespace AND t.relnamespace=s.relnamespace
        AND t.relname IN (${sql.join(inserted.map(t=>sql`${t}`),sql`, `)})`);
    for(const sequence of [...sequences.map(s=>String(s.name)),...plan.standaloneSequences])
      await tx.execute(sql.raw(`GRANT USAGE ON SEQUENCE public.${pricingIdentifier(sequence)} TO ${target}`));
    for(const signature of plan.functions){
      if(!/^[a-z_]+[a-z_0-9]*\(\)$/.test(signature))throw Error('Unexpected test routine');
      await tx.execute(sql.raw(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${target}`));
    }
  });
}
