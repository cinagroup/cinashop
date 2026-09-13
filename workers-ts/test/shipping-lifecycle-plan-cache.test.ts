import { describe, expect, it } from 'vitest';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { shippingLifecycleNestedPlans } from './helpers/shippingLifecycleNestedPlans';
import { runShippingLifecycle } from '../src/migrations/runShippingLifecycle';
import { inspectShippingLifecycleProtocol } from '../src/migrations/inspectShippingLifecycleProtocol';
import { SHIPPING_LIFECYCLE_INDEXES } from '../src/migrations/shippingLifecycleIndexes';
import { inspectShippingLifecycleIndexes } from '../src/migrations/runShippingLifecycleIndexes';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual shipping parent plans after hot-key warmup', () => {
  it('keeps absent-template UPDATE and DELETE selective with formal ORM indexes and default auto planning', async () => {
    const f = await sequenceRunnerDatabase();
    try {
      const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
      await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
      await f.exec("INSERT INTO shipping_templates(id,name) VALUES(1,'default'),(10,'common'),(11,'absent'),(12,'rare')");
      const tables = ['store_product','store_seckill','store_bargain','store_combination','store_integral','store_discounts_products'];
      for (const [i,table] of tables.entries()) {
        const packageTable = i === 5;
        await f.exec(`INSERT INTO public.${table}(id,temp_id${i ? ',product_id' : ''}${packageTable ? '' : ',freight'})
          SELECT n,CASE WHEN n=5000 THEN 12 WHEN n%20=0 THEN 0 ELSE 10 END${i ? ',n' : ''}${packageTable ? '' : ',3'} FROM generate_series(1,5000) n`);
        await f.exec(`ANALYZE public.${table}`);
      }
      await runShippingLifecycle(f.db);
      expect((await inspectShippingLifecycleIndexes(f.db)).complete).toBe(true);
      const fingerprint = async () => Promise.all([...tables,'shipping_templates'].map(async table => (await f.query(
        `SELECT count(*)::integer AS count,md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id)) AS digest FROM public.${table} t`)).rows));
      const before = await fingerprint();
      const records = await shippingLifecycleNestedPlans(f);
      expect(records).toHaveLength(16);
      expect(await fingerprint()).toEqual(before);
      expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('complete');
      const absent = records.filter(r => r.id === 11);
      expect(absent).toHaveLength(2);
      for (const record of absent) {
        expect(record.mode).toBe('auto');
        expect(record.filtered, JSON.stringify({ action: record.action, scans: record.scans })).toBe(0);
        const scans = record.scans as Array<{type: string; index?: string; loops: number}>;
        expect(scans.filter(s => s.loops > 0)).toHaveLength(6);
        expect(scans.filter(s => s.loops > 0).map(s => s.index).sort()).toEqual(SHIPPING_LIFECYCLE_INDEXES.slice(0,6).map(s=>s.name).sort());
      }
    } finally { await f.close(); }
  }, 120000);
});
