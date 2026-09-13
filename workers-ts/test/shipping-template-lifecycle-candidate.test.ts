import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { installShippingTemplateLifecycleCandidate } from './helpers/shippingTemplateLifecycleCandidate';
import { shippingAdminApp } from './helpers/adminShippingFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

const refs = ['store_product', 'store_seckill', 'store_bargain', 'store_combination', 'store_integral', 'store_discounts_products'] as const;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('shipping lifecycle database candidate on full ORM PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
    await installShippingTemplateLifecycleCandidate(f.db);
    await f.exec("INSERT INTO store_order(id,order_id,pay_postage,cart_id) VALUES(999,'historical-lifecycle','12.34','[77]')");
  }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);
  beforeEach(async () => {
    // Owned fixture only. Unbind/delete dependents before removing their source.
    for (const table of refs.slice(1)) await f.exec(`DELETE FROM ${table}`);
    await f.exec('DELETE FROM store_product; DELETE FROM shipping_templates');
    await f.exec("INSERT INTO shipping_templates(id,name) VALUES(1,'default'),(10,'bound'),(11,'other'); INSERT INTO store_product(id,temp_id,freight) VALUES(1,0,1)");
  });
  const bindSql = (table: typeof refs[number], id = 2, template = 10) => table === 'store_product'
    ? `INSERT INTO store_product(id,temp_id,freight) VALUES(${id},${template},3)`
    : table === 'store_discounts_products'
      ? `INSERT INTO store_discounts_products(id,product_id,temp_id) VALUES(${id},1,${template})`
      : `INSERT INTO ${table}(id,product_id,temp_id,freight) VALUES(${id},1,${template},3)`;
  const snapshot = () => f.query(`SELECT jsonb_build_object(
    'templates',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM shipping_templates t),
    'products',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM store_product t),
    'bargains',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM store_bargain t),
    'orders',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM store_order t)) AS state`);

  it.each(refs)('rejects negative stored template IDs in every freight mode for %s', async table => {
    for (const freight of table === 'store_discounts_products' ? [2] : [1, 2, 3]) {
      const before = await snapshot(), rows = await f.query(`SELECT * FROM ${table} ORDER BY id`);
      const statement = bindSql(table, 2, -1).replace(',-1,3)', `,-1,${freight})`);
      await expect(f.exec(statement)).rejects.toMatchObject({ code: '23503' });
      expect(await snapshot()).toEqual(before);
      expect(await f.query(`SELECT * FROM ${table} ORDER BY id`)).toEqual(rows);
      await f.exec(bindSql(table));
      const bound = await f.query(`SELECT * FROM ${table} ORDER BY id`);
      await expect(f.exec(`UPDATE ${table} SET temp_id=-1${table === 'store_discounts_products' ? '' : `,freight=${freight}`} WHERE id=2`))
        .rejects.toMatchObject({ code: '23503' });
      expect(await f.query(`SELECT * FROM ${table} ORDER BY id`)).toEqual(bound);
      await f.exec(`DELETE FROM ${table} WHERE id=2`);
    }
  });

  it.each(refs)('rolls back the whole multirow binding update when one %s row is invalid', async table => {
    await f.exec(bindSql(table, 2)); await f.exec(bindSql(table, 3));
    const before = await snapshot(), rows = await f.query(`SELECT * FROM ${table} ORDER BY id`);
    await expect(f.exec(`UPDATE ${table} SET temp_id=CASE WHEN id=2 THEN 11 ELSE 99999 END WHERE id IN (2,3)`))
      .rejects.toMatchObject({ code: '23503' });
    expect(await snapshot()).toEqual(before);
    expect(await f.query(`SELECT * FROM ${table} ORDER BY id`)).toEqual(rows);
    await f.exec(`UPDATE ${table} SET temp_id=11 WHERE id IN (2,3)`);
    expect((await f.query(`SELECT temp_id FROM ${table} WHERE id IN (2,3) ORDER BY id`)).rows)
      .toEqual([{ temp_id: 11 }, { temp_id: 11 }]);
  });

  it('rolls back multi-template retirement including an unreferenced sibling', async () => {
    await f.exec(bindSql('store_bargain'));
    const before = await snapshot();
    await expect(f.exec('UPDATE shipping_templates SET status=0 WHERE id IN (10,11)'))
      .rejects.toMatchObject({ code: '23503' });
    expect(await snapshot()).toEqual(before);
  });

  it('source transfer first: activity admission refuses NOWAIT and validates the committed owner', async () => {
    await f.withPeer!(async editor => {
      await editor.exec('BEGIN; UPDATE store_product SET type=2,relation_id=20 WHERE id=1');
      try {
        await expect(f.exec(bindSql('store_bargain'))).rejects.toMatchObject({ code: '55P03' });
        await editor.exec('COMMIT');
        await expect(f.exec(bindSql('store_bargain'))).rejects.toMatchObject({ code: '23503' });
        await f.exec('UPDATE shipping_templates SET owner_type=2,relation_id=20 WHERE id=11');
        await f.exec(bindSql('store_bargain', 2, 11));
      } finally { await editor.exec('ROLLBACK'); }
    });
  }, 15000);

  it('activity admission first: source transfer waits then rejects the committed retained reference', async () => {
    await f.withPeer!(async binder => f.withPeer!(async editor => {
      await binder.exec('BEGIN');
      try {
        await binder.exec(bindSql('store_bargain'));
        const editing = outcome(editor.exec('UPDATE store_product SET type=2,relation_id=20 WHERE id=1'));
        await waitForFinanceBlock(f.db, editor.pid, binder.pid);
        await binder.exec('COMMIT');
        expect(await editing).toMatchObject({ ok: false, error: { code: '23503' } });
        expect((await f.query('SELECT type,relation_id FROM store_product WHERE id=1')).rows)
          .toEqual([{ type: 0, relation_id: 0 }]);
      } finally { await binder.exec('ROLLBACK'); }
    }));
  }, 15000);

  it.each(refs)('rejects actual admin retirement and direct hard deletion while %s still references the template', async table => {
    await f.exec(bindSql(table));
    const before = await snapshot(), rows = await f.query(`SELECT * FROM ${table} ORDER BY id`);
    const response = await shippingAdminApp(f.db).request('/delete/10', { method: 'DELETE' });
    expect((await response.json() as { status: number }).status).not.toBe(200);
    await expect(f.exec('DELETE FROM shipping_templates WHERE id=10')).rejects.toMatchObject({ code: '23503' });
    expect(await snapshot()).toEqual(before);
    expect(await f.query(`SELECT * FROM ${table} ORDER BY id`)).toEqual(rows);
  });
  it.each(['missing', 'deleted', 'disabled', 'foreign-owner'])('refuses a new %s template binding without inserting the child', async kind => {
    if (kind === 'missing') await f.exec('DELETE FROM shipping_templates WHERE id=10');
    if (kind === 'deleted') await f.exec('UPDATE shipping_templates SET is_del=1 WHERE id=10');
    if (kind === 'disabled') await f.exec('UPDATE shipping_templates SET status=0 WHERE id=10');
    if (kind === 'foreign-owner') await f.exec('UPDATE shipping_templates SET owner_type=2,relation_id=20 WHERE id=10');
    const before = await snapshot();
    await expect(f.exec(bindSql('store_product'))).rejects.toMatchObject({ code: '23503' });
    expect(await snapshot()).toEqual(before);
  });
  it('protects implicit template 1 and allows an explicit unbind before retirement without rewriting historical orders', async () => {
    const orders = await f.query('SELECT * FROM store_order ORDER BY id');
    await f.exec(bindSql('store_product', 2, 0));
    await expect(f.exec('UPDATE shipping_templates SET is_del=1 WHERE id=1')).rejects.toMatchObject({ code: '23503' });
    await f.exec('UPDATE store_product SET freight=1,temp_id=0 WHERE id=2');
    await f.exec('UPDATE shipping_templates SET is_del=1 WHERE id=1');
    expect(await f.query('SELECT * FROM store_order ORDER BY id')).toEqual(orders);
  });
  it('checks final BEFORE-trigger values even for an unrelated UPDATE column', async () => {
    await f.exec(`CREATE FUNCTION qa_shipping_rebind() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.store_name='rebind' THEN NEW.temp_id=99999; NEW.freight=3; END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_shipping_rebind BEFORE UPDATE ON store_product FOR EACH ROW EXECUTE FUNCTION qa_shipping_rebind()`);
    try {
      const before = await snapshot();
      await expect(f.exec("UPDATE store_product SET store_name='rebind' WHERE id=1")).rejects.toMatchObject({ code: '23503' });
      expect(await snapshot()).toEqual(before);
    } finally { await f.exec('DROP TRIGGER qa_shipping_rebind ON store_product; DROP FUNCTION qa_shipping_rebind()'); }
  });
  it('guards product and template ownership changes while a retained activity references the old owner', async () => {
    await f.exec(bindSql('store_bargain'));
    const before = await snapshot();
    await expect(f.exec('UPDATE store_product SET type=2,relation_id=20 WHERE id=1')).rejects.toMatchObject({ code: '23503' });
    await expect(f.exec('UPDATE shipping_templates SET owner_type=2,relation_id=20 WHERE id=10')).rejects.toMatchObject({ code: '23503' });
    await expect(f.exec('DELETE FROM store_product WHERE id=1')).rejects.toMatchObject({ code: '23503' });
    expect(await snapshot()).toEqual(before);
  });
  it('rejects TRUNCATE and stale repeatable-read binding instead of bypassing row guards', async () => {
    await expect(f.exec('TRUNCATE shipping_templates')).rejects.toMatchObject({ code: '23503' });
    await f.withPeer!(async peer => {
      await peer.exec('BEGIN ISOLATION LEVEL REPEATABLE READ');
      try { await expect(peer.exec(bindSql('store_product'))).rejects.toMatchObject({ code: '25000' }); }
      finally { await peer.exec('ROLLBACK'); }
    });
  });
  it('rejects source product TRUNCATE CASCADE without orphaning a retained activity', async () => {
    await f.exec(bindSql('store_bargain'));
    const before = await snapshot();
    await expect(f.exec('TRUNCATE store_product CASCADE')).rejects.toMatchObject({ code: '23503' });
    expect(await snapshot()).toEqual(before);
  });
  it('binding first: parent retirement waits, then rejects after seeing the newly committed reference', async () => {
    await f.withPeer!(async binder => f.withPeer!(async deleter => {
      await binder.exec('BEGIN');
      try {
        await binder.exec(bindSql('store_product'));
        const deleting = outcome(deleter.exec('UPDATE shipping_templates SET is_del=1 WHERE id=10'));
        await waitForFinanceBlock(f.db, deleter.pid, binder.pid);
        await binder.exec('COMMIT');
        expect(await deleting).toMatchObject({ ok: false, error: { code: '23503' } });
      } finally { await binder.exec('ROLLBACK'); }
    }));
  }, 15000);
  it.each(['COMMIT', 'ROLLBACK'])('retirement first: concurrent bind refuses NOWAIT, then honors %s outcome', async end => {
    await f.withPeer!(async deleter => f.withPeer!(async binder => {
      await deleter.exec('BEGIN');
      try {
        await deleter.exec('UPDATE shipping_templates SET is_del=1 WHERE id=10');
        await expect(binder.exec(bindSql('store_product'))).rejects.toMatchObject({ code: '55P03' });
        await deleter.exec(end);
        if (end === 'COMMIT') await expect(binder.exec(bindSql('store_product'))).rejects.toMatchObject({ code: '23503' });
        else await binder.exec(bindSql('store_product'));
      } finally { await deleter.exec('ROLLBACK'); }
    }));
  }, 15000);
  it('leaves ordinary stock/price changes independent of a template editor', async () => {
    await f.exec(bindSql('store_product'));
    await f.withPeer!(async editor => {
      await editor.exec('BEGIN; UPDATE shipping_templates SET name=\'editing\' WHERE id=10');
      try { await f.exec("UPDATE store_product SET stock=7,price='1.50' WHERE id=2"); }
      finally { await editor.exec('ROLLBACK'); }
    });
  });
  it('admits a genuine restricted LOGIN with explicit read/insert and only a non-identity template UPDATE grant', async () => {
    await f.withRuntimeRole!(async runtime => {
      await f.exec(`GRANT SELECT ON shipping_templates,${refs.join(',')} TO "${runtime.role}";
        GRANT INSERT ON store_product TO "${runtime.role}";
        GRANT UPDATE(stock) ON store_product TO "${runtime.role}";
        GRANT UPDATE(name) ON shipping_templates TO "${runtime.role}"`);
      await runtime.exec(bindSql('store_product'));
      await runtime.exec('UPDATE store_product SET stock=9 WHERE id=2');
      await expect(runtime.exec('UPDATE shipping_templates SET is_del=1 WHERE id=11')).rejects.toMatchObject({ code: '42501' });
      await expect(runtime.exec(bindSql('store_product', 3, 99999))).rejects.toMatchObject({ code: '23503' });
    });
  });
  it('fails closed if RLS would hide an existing child from the deleting LOGIN', async () => {
    await f.exec(bindSql('store_product'));
    const before = await snapshot();
    await f.exec('ALTER TABLE store_product ENABLE ROW LEVEL SECURITY; CREATE POLICY qa_hide_shipping ON store_product USING(false)');
    try {
      await f.withRuntimeRole!(async runtime => {
        await f.exec(`GRANT SELECT ON shipping_templates,${refs.join(',')} TO "${runtime.role}";
          GRANT UPDATE(is_del) ON shipping_templates TO "${runtime.role}"`);
        await expect(runtime.exec('UPDATE shipping_templates SET is_del=1 WHERE id=10')).rejects.toMatchObject({ code: '42501' });
      });
      expect(await snapshot()).toEqual(before);
    } finally { await f.exec('DROP POLICY qa_hide_shipping ON store_product; ALTER TABLE store_product DISABLE ROW LEVEL SECURITY'); }
  });
});
