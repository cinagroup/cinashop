import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { sequenceRunnerDatabase, validateSequenceRunnerTestUrl } from '../test/helpers/kefuSequenceRunnerDatabase';
import { createContainerFromDb } from '../src/lib/di';
import type { AppVariables, Env } from '../src/env';
import { adminShippingTemplateDel } from '../src/controllers/api/v1/AdminCrudController';
import { SupplierShippingTemplateService } from '../src/services/supplier/SupplierShippingTemplateService';
import * as schema from '../src/models/schema';
import { installShippingTemplateLifecycleCandidate } from '../test/helpers/shippingTemplateLifecycleCandidate';

// This is a red acceptance probe, not a passing characterization of a defect.
// It creates only an owned random local PG16 database, never uses production.
// Exit 1 means lifecycle protection is still missing; exit 2 is an audit error.
async function main() {
  assert.equal(process.argv.length, 2, 'No arguments accepted');
  assert.ok(process.env.SHIPPING_LIFECYCLE_CANDIDATE === undefined || process.env.SHIPPING_LIFECYCLE_CANDIDATE === '1', 'Invalid candidate selector');
  validateSequenceRunnerTestUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  const f = await sequenceRunnerDatabase();
  try {
    const api = await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
    if (process.env.SHIPPING_LIFECYCLE_CANDIDATE === '1') await installShippingTemplateLifecycleCandidate(f.db);
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', createContainerFromDb(f.db)); await next(); });
    app.onError((_error, c) => c.json({ status: 400, data: null }));
    app.delete('/delete/:id', adminShippingTemplateDel);
    const results: Array<{ name: string; protected: boolean; mutationObserved: boolean }> = [];
    const deleteAdmin = async (id: number) => {
      const response = await app.request(`/delete/${id}`, { method: 'DELETE' });
      return await response.json() as { status: number };
    };
    // All six binding-bearing tables have a positive, deliberately retained
    // template reference. Isolate cases by template ID; do not copy PHP's
    // automatic rewrite-to-template-1 behavior.
    const targets = [schema.storeProduct, schema.storeSeckill, schema.storeBargain,
      schema.storeCombination, schema.storeIntegral, schema.storeDiscountsProducts] as const;
    for (const [index, table] of targets.entries()) {
      const id = 100 + index;
      await f.db.insert(schema.shippingTemplates).values({ id, name: 'isolated lifecycle fixture' });
      if (table === schema.storeProduct) await f.db.insert(table).values({ id, tempId: id, freight: 3 });
      else if (table === schema.storeDiscountsProducts) {
        await f.db.insert(schema.storeDiscounts).values({ id, isDel: 0, status: 1 });
        await f.db.insert(table).values({ id, discountId: id, productId: 100, tempId: id });
      } else if (table === schema.storeSeckill) await f.db.insert(schema.storeSeckill).values({ id, productId: 100, tempId: id, freight: 3 });
      else if (table === schema.storeBargain) await f.db.insert(schema.storeBargain).values({ id, productId: 100, tempId: id, freight: 3 });
      else if (table === schema.storeCombination) await f.db.insert(schema.storeCombination).values({ id, productId: 100, tempId: id, freight: 3 });
      else if (table === schema.storeIntegral) await f.db.insert(schema.storeIntegral).values({ id, productId: 100, tempId: id, freight: 3 });
      else throw new Error('Unexpected lifecycle fixture table');
      const before = await f.db.select().from(table);
      const result = await deleteAdmin(id);
      const [parent] = await f.db.select().from(schema.shippingTemplates).where(eq(schema.shippingTemplates.id, id));
      assert.deepEqual(await f.db.select().from(table), before, 'Deletion rewrote a reference row');
      results.push({ name: `admin-reference-${['product', 'seckill', 'bargain', 'combination', 'integral', 'package'][index]}`,
        protected: result.status !== 200 && parent.isDel === 0, mutationObserved: parent.isDel !== 0 });
    }
    // Supplier delete does check active products, but not a retained independent
    // activity reference after the source product has been deliberately unbound.
    await f.db.insert(schema.shippingTemplates).values({ id: 200, name: 'supplier fixture', ownerType: 2, relationId: 20 });
    await f.db.insert(schema.storeProduct).values({ id: 200, type: 2, relationId: 20, tempId: 0, freight: 1 });
    await f.db.insert(schema.storeBargain).values({ id: 200, productId: 200, tempId: 200, freight: 3 });
    const activityBefore = await f.db.select().from(schema.storeBargain).where(eq(schema.storeBargain.id, 200));
    let rejected = false;
    try { await new SupplierShippingTemplateService(createContainerFromDb(f.db)).delete(20, 200); }
    catch (error) {
      // A missing-table/SQL/runtime error cannot be mistaken for protection.
      const { ValidateException } = await import('../src/utils/errors');
      let cause: unknown = error;
      for (let depth = 0; depth < 8 && cause && typeof cause === 'object' && 'cause' in cause && cause.cause; depth++) cause = cause.cause;
      if (!(error instanceof ValidateException) && !(cause && typeof cause === 'object' && 'code' in cause && cause.code === '23503')) throw error;
      rejected = true;
    }
    const [supplierParent] = await f.db.select().from(schema.shippingTemplates).where(eq(schema.shippingTemplates.id, 200));
    assert.deepEqual(await f.db.select().from(schema.storeBargain).where(eq(schema.storeBargain.id, 200)), activityBefore);
    results.push({ name: 'supplier-retained-bargain-reference', protected: rejected && supplierParent.isDel === 0,
      mutationObserved: supplierParent.isDel !== 0 });
    // Reader's established implicit default reference must be included in the
    // eventual policy, not just positive temp_id foreign-key-like edges.
    await f.db.insert(schema.shippingTemplates).values({ id: 1, name: 'default fixture' });
    await f.db.insert(schema.storeProduct).values({ id: 300, tempId: 0, freight: 3 });
    const fallback = await deleteAdmin(1);
    const [defaultParent] = await f.db.select().from(schema.shippingTemplates).where(eq(schema.shippingTemplates.id, 1));
    results.push({ name: 'admin-implicit-default-template', protected: fallback.status !== 200 && defaultParent.isDel === 0,
      mutationObserved: defaultParent.isDel !== 0 });
    return { scope: 'shipping-template-lifecycle-red-acceptance', ready: results.every(result => result.protected),
      candidateInstalled: process.env.SHIPPING_LIFECYCLE_CANDIDATE === '1',
      fullOrm: true, genuinePostgres16: true, remoteConnection: false, results };
  } finally { await f.close(); }
}
try {
  const result = await main();
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.ready ? 0 : 1;
} catch {
  process.stderr.write('Isolated shipping lifecycle audit failed to execute or clean up. No production connection was requested.\n');
  process.exitCode = 2;
}
