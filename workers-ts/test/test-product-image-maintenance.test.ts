import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { maintainTestImages, IMAGE_A, IMAGE_B, OLD_IMAGE } from '../scripts/test-product-image-maintenance';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('fixed product image maintenance on isolated PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeAll(async () => { f = await sequenceRunnerDatabase();
    await f.exec(`CREATE TABLE store_product(id int PRIMARY KEY, store_name text, image text,
      price numeric DEFAULT 99.00, stock int DEFAULT 0, slider_image text DEFAULT '[]');`);
  });
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    await f.exec(`DROP TRIGGER IF EXISTS image_side_effect ON store_product;
      ALTER TABLE store_product DROP CONSTRAINT IF EXISTS reject_last;
      TRUNCATE store_product;
      INSERT INTO store_product(id,store_name,image) SELECT n,
        CASE WHEN n%2=0 THEN '测试商品A' ELSE '会员专享商品B' END,
        'https://via.placeholder.com/300' FROM generate_series(1,71) n WHERE n NOT IN (5,6,7);
      INSERT INTO store_product(id,store_name,image) VALUES (5,'other',''),(6,'other',''),(7,'other','');`);
  });
  async function withDb(work: (url: string) => Promise<void>) {
    await f.withRuntimeRole!(async r => {
      await f.exec(`GRANT SELECT,UPDATE ON store_product TO "${r.role}"`);
      await work(r.connectionString);
      expect(await f.exec(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE usename='${r.role}' AND application_name='cinashop_test_image_maintenance'`)).toEqual([{count:0}]);
    });
  }
  it('inspects without writing and changes exactly 68 image fields; replay rejected', async () => withDb(async url => {
    const plan = await maintainTestImages(url);
    expect(plan.rows).toHaveLength(68); expect(plan.rows.every(r => r.image === OLD_IMAGE)).toBe(true);
    const done = await maintainTestImages(url, plan.fingerprint);
    expect(done).toMatchObject({ mode:'applied', updated:68, nonImageFieldsUnchanged:true });
    expect(done.rows.filter(r=>r.image===IMAGE_A)).toHaveLength(34);
    expect(done.rows.filter(r=>r.image===IMAGE_B)).toHaveLength(34);
    expect(await f.exec("SELECT image FROM store_product WHERE id IN (5,6,7)")).toEqual([{image:''},{image:''},{image:''}]);
    await expect(maintainTestImages(url, plan.fingerprint)).rejects.toThrow();
  }));
  it.each([
    "UPDATE store_product SET stock=1 WHERE id=1",
    "UPDATE store_product SET store_name='real product' WHERE id=1",
    "UPDATE store_product SET image='' WHERE id=1",
    "DELETE FROM store_product WHERE id=1",
  ])('rejects drift without applying: %s', async statement => withDb(async url => {
    const plan = await maintainTestImages(url); await f.exec(statement);
    await expect(maintainTestImages(url, plan.fingerprint)).rejects.toThrow();
    expect(await f.exec("SELECT count(*)::int AS count FROM store_product WHERE image LIKE '%cinaseek.ai%'")).toEqual([{count:0}]);
  }));
  it('rejects active image triggers before mutation', async () => withDb(async url => {
    await f.exec(`CREATE OR REPLACE FUNCTION fixture_image_trigger() RETURNS trigger LANGUAGE plpgsql AS
      $$BEGIN NEW.stock=100; RETURN NEW; END$$;
      CREATE TRIGGER image_side_effect BEFORE UPDATE OF image ON store_product
      FOR EACH ROW EXECUTE FUNCTION fixture_image_trigger()`);
    const plan = await maintainTestImages(url);
    expect(plan.imageUpdateTriggers).toHaveLength(1);
    await expect(maintainTestImages(url, plan.fingerprint)).rejects.toThrow();
    expect(await f.exec("SELECT max(stock)::int AS stock FROM store_product")).toEqual([{stock:0}]);
  }));
  it('rolls back the entire update if a later row fails a database constraint', async () => withDb(async url => {
    await f.exec(`ALTER TABLE store_product ADD CONSTRAINT reject_last CHECK(id<>71 OR image='https://via.placeholder.com/300')`);
    const plan = await maintainTestImages(url);
    await expect(maintainTestImages(url, plan.fingerprint)).rejects.toThrow();
    expect((await maintainTestImages(url)).fingerprint).toBe(plan.fingerprint);
  }));
});
