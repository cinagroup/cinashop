import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DbClient } from '../src/lib/di';
import { SHIPPING_REFERENCE_EXPRESSION_SQL, SHIPPING_PACKAGE_REFERENCE_EXPRESSION_SQL, shippingReferenceExpression } from '../src/lib/shippingReferenceExpression';
import { assertShippingTemplateUnreferenced } from '../src/services/product/ShippingTemplateLifecycleService';
import { runShippingLifecycle } from '../src/migrations/runShippingLifecycle';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { shippingReferenceStatement } from './helpers/shippingReferenceStatement';

it.each([0, -1, 0.5, NaN, Infinity, 2147483648])('rejects invalid template ID %s before any SQL', async id => {
  const execute = vi.fn(), select = vi.fn();
  await expect(assertShippingTemplateUnreferenced({ execute, select } as unknown as DbClient, id)).rejects.toThrow('运费模板ID错误');
  expect(execute).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
});

it('uses identical unqualified CASE expressions for SQL and application construction', () => {
  const dialect = new PgDialect();
  expect(dialect.sqlToQuery(shippingReferenceExpression(sql.raw('temp_id'), sql.raw('freight'))).sql).toBe(SHIPPING_REFERENCE_EXPRESSION_SQL);
  expect(dialect.sqlToQuery(shippingReferenceExpression(sql.raw('temp_id'))).sql).toBe(SHIPPING_PACKAGE_REFERENCE_EXPRESSION_SQL);
});

it('captures all six real application predicates without the legacy OR/function wrapper', async () => {
  const statement = await shippingReferenceStatement(11);
  expect(statement.match(/CASE WHEN/g)).toHaveLength(6);
  for (const table of ['store_product','store_seckill','store_bargain','store_combination','store_integral','store_discounts_products']) expect(statement).toContain(`"${table}"`);
  expect(statement).not.toContain('shipping_lifecycle_ref(');
  expect(statement).not.toContain('<=');
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('reference expression real PG16 semantics', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
    await runShippingLifecycle(f.db);
  }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);

  it('matches the protocol and legacy positive-ID predicates on every non-null boundary combination', async () => {
    // NULL is deliberately outside this proof: installation requires NOT NULL
    // columns, and the old SQL function is STRICT whereas CASE is not.
    const rows = (await f.query(`WITH cases AS (
      SELECT temp_id,freight,id FROM unnest(ARRAY[-2147483648,-1,0,1,10,2147483647]::integer[]) temp_id
      CROSS JOIN unnest(ARRAY[-32768,-1,0,1,2,3,32767]::smallint[]) freight
      CROSS JOIN unnest(ARRAY[1,2,10,2147483647]::integer[]) id)
      SELECT count(*)::integer AS count,
      bool_and((${SHIPPING_REFERENCE_EXPRESSION_SQL})=public.shipping_lifecycle_ref(temp_id,freight)) AS protocol,
      bool_and(((${SHIPPING_REFERENCE_EXPRESSION_SQL})=id)=(temp_id=id OR (temp_id<=0 AND freight NOT IN(1,2) AND id=1))) AS application,
      bool_and((${SHIPPING_PACKAGE_REFERENCE_EXPRESSION_SQL})=public.shipping_lifecycle_ref(temp_id,2)) AS package_protocol,
      bool_and(((${SHIPPING_PACKAGE_REFERENCE_EXPRESSION_SQL})=id)=(temp_id=id)) AS package_application
      FROM cases`)).rows;
    expect(rows).toEqual([{ count: 168, protocol: true, application: true, package_protocol: true, package_application: true }]);
  });

  it('executes the captured application SELECT against the actual complete ORM', async () => {
    expect((await f.query(await shippingReferenceStatement(11))).rows).toEqual([{ used: false }]);
    await f.exec("INSERT INTO shipping_templates(id,name) VALUES(1,'default'),(11,'explicit'); INSERT INTO store_product(id,temp_id,freight) VALUES(1,11,3)");
    expect((await f.query(await shippingReferenceStatement(11))).rows).toEqual([{ used: true }]);
    await f.exec('UPDATE store_product SET temp_id=0');
    expect((await f.query(await shippingReferenceStatement(11))).rows).toEqual([{ used: false }]);
    expect((await f.query(await shippingReferenceStatement(1))).rows).toEqual([{ used: true }]);
  });
});
