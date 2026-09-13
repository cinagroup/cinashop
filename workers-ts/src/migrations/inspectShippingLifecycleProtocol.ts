import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { SHIPPING_LIFECYCLE_FUNCTIONS_SQL, SHIPPING_LIFECYCLE_TRIGGERS_SQL } from './shippingLifecycleProtocolQueries';
import { SHIPPING_LIFECYCLE_FUNCTIONS, SHIPPING_LIFECYCLE_TRIGGERS } from './shippingLifecycleProtocol';

/** Catalog-only inspection inside a caller-owned snapshot/barrier. This pins
 * the candidate's current default EXECUTE ACL; it does not certify the runtime
 * role's table/DDL/replication privileges or a final least-privilege policy. */
export async function inspectShippingLifecycleProtocol(tx: Pick<DbClient, 'execute'>) {
  const functions = Array.from(await tx.execute(sql.raw(SHIPPING_LIFECYCLE_FUNCTIONS_SQL)));
  const triggers = Array.from(await tx.execute(sql.raw(SHIPPING_LIFECYCLE_TRIGGERS_SQL)));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const functionsMatch = functions.length === SHIPPING_LIFECYCLE_FUNCTIONS.length && SHIPPING_LIFECYCLE_FUNCTIONS.every(spec => {
    const matches = functions.filter(row => row.name === spec.name);
    if (matches.length !== 1) return false;
    const { common, ...row } = matches[0];
    return common === true && Object.entries(spec).every(([key, value]) => same(row[key as keyof typeof row], value));
  });
  const triggersMatch = triggers.length === SHIPPING_LIFECYCLE_TRIGGERS.length && SHIPPING_LIFECYCLE_TRIGGERS.every(spec => {
    const matches = triggers.filter(row => row.schema === 'public' && row.table === spec.table && row.name === spec.name);
    return matches.length === 1 && matches[0].common === true && matches[0].function === spec.function && matches[0].type === spec.type;
  });
  return { state: functions.length === 0 && triggers.length === 0 ? 'absent' as const
    : functionsMatch && triggersMatch ? 'complete' as const : 'drift' as const,
    functionCount: functions.length, triggerCount: triggers.length,
    functionsMatch, triggersMatch, runtimePrivilegesVerified: false as const };
}
