import { sql, type SQLWrapper } from 'drizzle-orm';

// These expressions apply to the protocol's NOT NULL integer/smallint columns.
// Keep the SQL/index shape visible to the planner; do not wrap the predicate
// in a STRICT SQL function whose per-row invocation can prevent index matching.
export const SHIPPING_REFERENCE_EXPRESSION_SQL = 'CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END';
export const SHIPPING_PACKAGE_REFERENCE_EXPRESSION_SQL = 'CASE WHEN temp_id>0 THEN temp_id ELSE 0 END';

export function shippingReferenceExpression(temp: SQLWrapper, freight?: SQLWrapper) {
  return freight
    ? sql`CASE WHEN ${temp}>0 THEN ${temp} WHEN ${freight} NOT IN(1,2) THEN 1 ELSE 0 END`
    : sql`CASE WHEN ${temp}>0 THEN ${temp} ELSE 0 END`;
}
