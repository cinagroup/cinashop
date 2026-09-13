import assert from 'node:assert/strict';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DbClient } from '../../src/lib/di';
import { assertShippingTemplateUnreferenced } from '../../src/services/product/ShippingTemplateLifecycleService';

// Capture the real application's SELECT shape without executing SQL. The
// capacity audit separately exercises the real transaction and retirement.
// Inline only the fixed synthetic ID for EXPLAIN; never accept caller SQL.
export async function shippingReferenceStatement(id: number): Promise<string> {
  let statement: SQL | undefined;
  const capture = {
    execute: async () => [],
    select: (fields: { value?: SQL; used?: SQL }) => ({
      from: (from: SQL) => {
        if (fields.value) return [{ value: 'read committed' }];
        assert.ok(fields.used, 'Expected reference SELECT');
        assert.equal(statement, undefined, 'Unexpected second reference SELECT');
        statement = sql`SELECT ${fields.used} AS used FROM ${from}`;
        return [{ used: false }];
      },
    }),
  } as unknown as DbClient;
  await assertShippingTemplateUnreferenced(capture, id);
  assert.ok(statement, 'Application did not issue a reference SELECT');
  return new PgDialect().sqlToQuery(statement.inlineParams()).sql;
}
