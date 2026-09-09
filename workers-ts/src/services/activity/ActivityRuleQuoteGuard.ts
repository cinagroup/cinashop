import { and, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** Match the explicit receipt projection at the existing atomic reservation boundary.
 * Do not pass a whole activity row: inventory counters and cosmetic metadata are not rules.
 * Dates are encoded explicitly for the PostgreSQL driver; null remains null, not a wildcard.
 */
export function activityRuleQuoteGuard<T extends Record<string, string | number | boolean | Date | null>>(
  facts: T,
  columns: { [K in keyof T]: AnyPgColumn },
): SQL {
  const predicates: SQL[] = [];
  for (const key in facts) {
    if (!Object.hasOwn(facts, key)) continue;
    const value = facts[key];
    const column = columns[key];
    if (!column || value === undefined) throw new Error("Invalid activity rule quote projection");
    predicates.push(sql`${column} IS NOT DISTINCT FROM ${value instanceof Date ? value.toISOString() : value}`);
  }
  const guard = and(...predicates);
  if (!guard) throw new Error("Empty activity rule quote projection");
  return guard;
}
