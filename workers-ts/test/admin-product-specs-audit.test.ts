import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legacyCategory, storeProductSpecs, storeProduct, storeProductRelation, systemLog } from '@/models/schema';
import { productSpecsFixture, specsActor, specsBody } from './helpers/adminProductSpecs';

describe('parameter-template business receipts after the atomic audit insert', () => {
  let f: Awaited<ReturnType<typeof productSpecsFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Audit fixture forbids external I/O'));
    f = await productSpecsFixture();
  }, 30000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);

  async function snapshot() {
    return { parents: await f.db.select().from(legacyCategory).orderBy(legacyCategory.id),
      children: await f.db.select().from(storeProductSpecs).orderBy(storeProductSpecs.id),
      products: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
      relations: await f.db.select().from(storeProductRelation).orderBy(storeProductRelation.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id) };
  }

  async function auditTrigger(statement: string) {
    await f.exec(`CREATE FUNCTION change_specs_after_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.type='product_specs_catalog' THEN ${statement} END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER change_specs_after_receipt BEFORE INSERT ON system_log
      FOR EACH ROW EXECUTE FUNCTION change_specs_after_receipt()`);
  }

  it.each([
    ['parent', "UPDATE category SET name='审计改写父行' WHERE id=(NEW.action::jsonb->>'id')::integer;"],
    ['child', "UPDATE store_product_specs SET value='审计改写子值' WHERE temp_id=(NEW.action::jsonb->>'id')::integer;"],
  ])('rolls back create and edit when the audit rewrites a %s after the core readback', async (_name, statement) => {
    await auditTrigger(statement);
    const before = await snapshot();
    for (const id of [0, 11]) {
      await expect(f.service.save(id, specsBody({ name: `审计不得改写${id}` }), specsActor()))
        .rejects.toThrow('审计后保存核验');
      expect(await snapshot()).toEqual(before);
    }
  });

  it.each([
    ['parent', "INSERT INTO category(id,\"group\",name) VALUES ((NEW.action::jsonb->>'id')::integer,3,'审计重建父行');"],
    ['child', "INSERT INTO store_product_specs(temp_id,name,value) VALUES ((NEW.action::jsonb->>'id')::integer,'审计重建子行','孤儿参数');"],
  ])('rolls back delete when the audit recreates a %s after the core absence check', async (_name, statement) => {
    await auditTrigger(statement);
    const before = await snapshot();
    await expect(f.service.remove(11, new URLSearchParams(), specsActor()))
      .rejects.toThrow('审计后删除核验');
    expect(await snapshot()).toEqual(before);
  });
});
