import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { SHIPPING_LIFECYCLE_FUNCTIONS, SHIPPING_LIFECYCLE_TRIGGERS } from './shippingLifecycleProtocol';

/** Catalog-only inspection inside a caller-owned snapshot/barrier. This pins
 * the candidate's current default EXECUTE ACL; it does not certify the runtime
 * role's table/DDL/replication privileges or a final least-privilege policy. */
export async function inspectShippingLifecycleProtocol(tx: Pick<DbClient, 'select'>) {
  const functions = await tx.select({ name: sql<string>`p.proname`, args: sql<string>`p.proargtypes::text`,
    argNames: sql<string[] | null>`p.proargnames`, returns: sql<number>`p.prorettype::int`,
    language: sql<string>`l.lanname`, volatility: sql<string>`p.provolatile`, strict: sql<boolean>`p.proisstrict`,
    body: sql<string>`p.prosrc`, config: sql<string[] | null>`p.proconfig`,
    common: sql<boolean>`p.prokind='f' AND NOT p.proretset AND NOT p.prosecdef AND NOT p.proleakproof
      AND p.proparallel='u' AND p.provariadic=0 AND p.prosupport=0 AND p.procost=100 AND p.prorows=0
      AND p.pronargdefaults=0 AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
      AND p.proargdefaults IS NULL AND p.protrftypes IS NULL AND p.probin IS NULL AND p.prosqlbody IS NULL
      AND p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
      AND ARRAY(SELECT a::text FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a ORDER BY a::text)
        =ARRAY(SELECT a::text FROM pg_catalog.aclexplode(pg_catalog.acldefault('f',p.proowner)) a ORDER BY a::text)`
  }).from(sql`pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND starts_with(p.proname,'shipping_lifecycle_')`);
  const triggers = await tx.select({ name: sql<string>`t.tgname`, table: sql<string>`c.relname`,
    schema: sql<string>`n.nspname`, function: sql<string>`p.proname`, type: sql<number>`t.tgtype`,
    common: sql<boolean>`pn.nspname='public' AND p.pronargs=0 AND t.tgenabled='O' AND NOT t.tgisinternal
      AND t.tgparentid=0 AND t.tgconstrrelid=0 AND t.tgconstrindid=0 AND t.tgconstraint=0
      AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgnargs=0 AND t.tgattr::text=''
      AND octet_length(t.tgargs)=0 AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)`
  }).from(sql`pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    WHERE (n.nspname='public' AND starts_with(t.tgname,'shipping_lifecycle_'))
      OR (pn.nspname='public' AND starts_with(p.proname,'shipping_lifecycle_'))`);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const functionsMatch = functions.length === SHIPPING_LIFECYCLE_FUNCTIONS.length && SHIPPING_LIFECYCLE_FUNCTIONS.every(spec => {
    const matches = functions.filter(row => row.name === spec.name);
    if (matches.length !== 1) return false;
    const { common, ...row } = matches[0];
    return common && Object.entries(spec).every(([key, value]) => same(row[key as keyof typeof row], value));
  });
  const triggersMatch = triggers.length === SHIPPING_LIFECYCLE_TRIGGERS.length && SHIPPING_LIFECYCLE_TRIGGERS.every(spec => {
    const matches = triggers.filter(row => row.schema === 'public' && row.table === spec.table && row.name === spec.name);
    return matches.length === 1 && matches[0].common && matches[0].function === spec.function && matches[0].type === spec.type;
  });
  return { state: functions.length === 0 && triggers.length === 0 ? 'absent' as const
    : functionsMatch && triggersMatch ? 'complete' as const : 'drift' as const,
    functionCount: functions.length, triggerCount: triggers.length,
    functionsMatch, triggersMatch, runtimePrivilegesVerified: false as const };
}
