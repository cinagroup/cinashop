import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { storeCouponIssue, storeCouponProduct } from '../src/models/schema';
import { COUPON_PRODUCT_SCOPE_FENCE_BODY, COUPON_PRODUCT_SCOPE_FENCE_SQL } from '../src/migrations/couponProductScopeFence';
import { runCouponProductScopeFence } from '../src/migrations/runCouponProductScopeFence';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';

it('mirrors the standalone coupon relation SQL exactly', () => {
  expect(readFileSync(new NodeURL('../migrations/0151_coupon_product_scope_fence.sql', import.meta.url), 'utf8').trim())
    .toBe(COUPON_PRODUCT_SCOPE_FENCE_SQL.trim());
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('coupon relation fence on independent PostgreSQL 16', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let schema: string;
  beforeEach(async () => {
    f = await financePostgres([storeCouponIssue, storeCouponProduct]);
    const [row] = await f.db.select({ schema: sql<string>`current_schema()` }).from(sql`(values (1)) as probe(n)`);
    schema = row.schema;
    await f.db.insert(storeCouponIssue).values([-1, 0, 11, 22, 33].map(id => ({ id, couponType: 2 })));
    await f.db.insert(storeCouponProduct).values([{ couponId: 11, productId: 70 }, { couponId: 22, productId: 80 }]);
  });
  afterEach(async () => { await f?.close(); });
  const install = () => runCouponProductScopeFence(f.db, schema);
  const state = async () => ({
    templates: await f.db.select().from(storeCouponIssue).orderBy(storeCouponIssue.id),
    relations: await f.db.select().from(storeCouponProduct).orderBy(storeCouponProduct.couponId, storeCouponProduct.productId),
  });
  const catalog = () => f.db.select({ oid: sql<number>`t.oid::int`, name: sql<string>`t.tgname`, enabled: sql<string>`t.tgenabled`,
    functionOid: sql<number>`p.oid::int`, body: sql<string>`p.prosrc`, config: sql<string[]>`p.proconfig` })
    .from(sql`pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid`)
    .where(sql`t.tgrelid='store_coupon_product'::regclass AND t.tgname LIKE 'coupon_product_%'`).orderBy(sql`t.tgname`);
  const errorText = (error: unknown) => {
    const messages: string[] = []; let current = error;
    for (let i = 0; i < 8 && current && typeof current === 'object'; i++) {
      if ('message' in current) messages.push(String(current.message));
      if (!('cause' in current) || current.cause === current) break;
      current = current.cause;
    }
    return messages.join('\n');
  };

  it('records the baseline gap: a template lock cannot stop a nonparticipating SQL insert', async () => {
    await withFinancePeers(f.db, async ([reader, writer]) => {
      await reader.exec('BEGIN; SELECT id FROM store_coupon_issue WHERE id=11 FOR SHARE');
      await writer.exec('INSERT INTO store_coupon_product VALUES (11,71)');
      expect((await state()).relations).toContainEqual({ couponId: 11, productId: 71 });
      await reader.exec('COMMIT');
    });
  });
  it('preserves business rows and matching function/trigger identities on repeated installation', async () => {
    const before = await state(); await install(); const first = await catalog();
    expect(first.map(row => row.name)).toEqual(['coupon_product_delete_0151', 'coupon_product_insert_0151', 'coupon_product_update_0151']);
    expect(first.every(row => row.body === COUPON_PRODUCT_SCOPE_FENCE_BODY && row.enabled === 'O')).toBe(true);
    expect(first.every(row => JSON.stringify(row.config) === '["search_path=pg_catalog"]')).toBe(true);
    await install(); expect(await catalog()).toEqual(first); expect(await state()).toEqual(before);
  });

  // SQL is intentionally noncooperative: none of these writers explicitly locks a template.
  const changes = [
    ['insert', 'INSERT INTO store_coupon_product VALUES(11,71)', 11, true, [[11,70],[11,71],[22,80]]],
    ['first-relation', 'INSERT INTO store_coupon_product VALUES(33,71)', 33, true, [[11,70],[22,80],[33,71]]],
    ['last-delete', 'DELETE FROM store_coupon_product WHERE coupon_id=11', 11, true, [[22,80]]],
    ['product-change', 'UPDATE store_coupon_product SET product_id=71 WHERE coupon_id=11', 11, true, [[11,71],[22,80]]],
    ['transfer-old', 'UPDATE store_coupon_product SET coupon_id=33 WHERE coupon_id=11', 11, true, [[22,80],[33,70]]],
    ['transfer-new', 'UPDATE store_coupon_product SET coupon_id=33 WHERE coupon_id=11', 33, true, [[22,80],[33,70]]],
    ['duplicate', 'INSERT INTO store_coupon_product VALUES(11,70)', 11, true, [[11,70],[11,70],[22,80]]],
    ['zero-product', 'INSERT INTO store_coupon_product VALUES(11,0)', 11, true, [[11,0],[11,70],[22,80]]],
    ['negative-product', 'INSERT INTO store_coupon_product VALUES(11,-1)', 11, true, [[11,-1],[11,70],[22,80]]],
    ['zero-template', 'INSERT INTO store_coupon_product VALUES(0,70)', 0, true, [[0,70],[11,70],[22,80]]],
    ['negative-template', 'INSERT INTO store_coupon_product VALUES(-1,70)', -1, true, [[-1,70],[11,70],[22,80]]],
    ['unrelated-template', 'INSERT INTO store_coupon_product VALUES(22,81)', 11, false, [[11,70],[22,80],[22,81]]],
    ['same-values', 'UPDATE store_coupon_product SET product_id=product_id', 11, false, [[11,70],[22,80]]],
    ['empty-update', 'UPDATE store_coupon_product SET product_id=1 WHERE false', 11, false, [[11,70],[22,80]]],
    ['empty-delete', 'DELETE FROM store_coupon_product WHERE false', 11, false, [[11,70],[22,80]]],
    ['empty-insert', 'INSERT INTO store_coupon_product SELECT 11,71 WHERE false', 11, false, [[11,70],[22,80]]],
  ] as const;
  it.each(changes)('fences only affected parent multisets: %s', async (_name, statement, parent, blocks, expected) => {
    await install(); const before = await state();
    await withFinancePeers(f.db, async ([reader, writer]) => {
      await reader.exec(`BEGIN; SELECT id FROM store_coupon_issue WHERE id=${parent} FOR SHARE`);
      const writing = outcome(writer.exec(statement));
      if (blocks) {
        await waitForFinanceBlock(f.db, writer.pid, reader.pid);
        expect(await state()).toEqual(before); await reader.exec('COMMIT');
      }
      expect((await writing).ok).toBe(true);
      if (!blocks) await reader.exec('COMMIT');
    });
    const after = await state(); expect(after.templates).toEqual(before.templates);
    expect(after.relations.map(row => [row.couponId, row.productId])).toEqual(expected);
  }, 15_000);

  it.each([true, false])('compares pair multiplicities rather than totals; exact net zero=%s', async netZero => {
    await f.exec('INSERT INTO store_coupon_product VALUES(11,72)'); await install();
    await withFinancePeers(f.db, async ([reader, writer]) => {
      await reader.exec('BEGIN; SELECT id FROM store_coupon_issue WHERE id=11 FOR SHARE');
      const writing = outcome(writer.exec(netZero
        ? 'UPDATE store_coupon_product SET product_id=142-product_id WHERE coupon_id=11'
        : 'UPDATE store_coupon_product SET product_id=71 WHERE coupon_id=11'));
      if (!netZero) { await waitForFinanceBlock(f.db, writer.pid, reader.pid); await reader.exec('COMMIT'); }
      expect((await writing).ok).toBe(true); if (netZero) await reader.exec('COMMIT');
    });
    expect((await state()).relations.filter(row => row.couponId === 11).map(row => row.productId)).toEqual(netZero ? [70,72] : [71,71]);
  }, 15_000);
  it('locks batch parents in ascending order despite reversed input', async () => {
    await install();
    await withFinancePeers(f.db, async ([higher, writer, lower]) => {
      await higher.exec('BEGIN; SELECT id FROM store_coupon_issue WHERE id=22 FOR SHARE');
      const writing = outcome(writer.exec('INSERT INTO store_coupon_product VALUES(22,81),(11,71)'));
      await waitForFinanceBlock(f.db, writer.pid, higher.pid);
      const editing = outcome(lower.exec("UPDATE store_coupon_issue SET title='probe' WHERE id=11"));
      await waitForFinanceBlock(f.db, lower.pid, writer.pid);
      await higher.exec('COMMIT'); expect((await writing).ok).toBe(true); expect((await editing).ok).toBe(true);
    });
    expect((await state()).relations).toHaveLength(4);
  }, 15_000);
  it.each(['COMMIT', 'ROLLBACK'] as const)('holds a writer parent lock until %s, then a new reader statement sees the right set', async finish => {
    await install();
    await withFinancePeers(f.db, async ([writer, reader]) => {
      await writer.exec('BEGIN; INSERT INTO store_coupon_product VALUES(11,71)');
      await reader.exec('BEGIN; LOCK TABLE store_coupon_product IN ACCESS SHARE MODE');
      const reading = outcome(reader.exec('SELECT id FROM store_coupon_issue WHERE id=11 FOR SHARE'));
      await waitForFinanceBlock(f.db, reader.pid, writer.pid);
      await writer.exec(finish); expect((await reading).ok).toBe(true);
      const rows = await reader.db.select().from(storeCouponProduct).where(sql`coupon_id=11`).orderBy(storeCouponProduct.productId);
      expect(rows.map(row => row.productId)).toEqual(finish === 'COMMIT' ? [70,71] : [70]); await reader.exec('COMMIT');
    });
  }, 15_000);
  it('uses final BEFORE-trigger values rather than the original insert target', async () => {
    await f.exec(`CREATE FUNCTION fixture_redirect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.coupon_id:=11; RETURN NEW; END $$;
      CREATE TRIGGER fixture_redirect BEFORE INSERT ON store_coupon_product FOR EACH ROW EXECUTE FUNCTION fixture_redirect()`);
    await install();
    await withFinancePeers(f.db, async ([reader, writer]) => {
      await reader.exec('BEGIN; SELECT id FROM store_coupon_issue WHERE id=11 FOR SHARE');
      const writing = outcome(writer.exec('INSERT INTO store_coupon_product VALUES(22,71)'));
      await waitForFinanceBlock(f.db, writer.pid, reader.pid); await reader.exec('COMMIT'); expect((await writing).ok).toBe(true);
    });
    expect((await state()).relations).toContainEqual({ couponId: 11, productId: 71 });
  }, 15_000);
  it('does not self-deadlock when an admin already owns the template and replaces relations', async () => {
    await install();
    await withFinancePeers(f.db, async ([writer]) => {
      await writer.exec('BEGIN; SELECT id FROM store_coupon_issue WHERE id=11 FOR UPDATE; DELETE FROM store_coupon_product WHERE coupon_id=11; INSERT INTO store_coupon_product VALUES(11,71); COMMIT');
    });
    expect((await state()).relations).toEqual([{ couponId: 11, productId: 71 }, { couponId: 22, productId: 80 }]);
  });
  it('rejects an orphan within a mixed batch and rolls back every inserted row', async () => {
    await install(); const before = await state();
    await expect(f.exec('INSERT INTO store_coupon_product VALUES(11,71),(99,71)')).rejects.toMatchObject({ code: '23503' });
    expect(await state()).toEqual(before);
  });
  it('fences removal of one duplicate even when the effective ID set is unchanged', async () => {
    await f.exec('INSERT INTO store_coupon_product VALUES(11,70)'); await install();
    await withFinancePeers(f.db, async ([reader, writer]) => {
      await reader.exec('BEGIN; SELECT id FROM store_coupon_issue WHERE id=11 FOR SHARE');
      const writing = outcome(writer.exec('DELETE FROM store_coupon_product WHERE ctid IN (SELECT ctid FROM store_coupon_product WHERE coupon_id=11 LIMIT 1)'));
      await waitForFinanceBlock(f.db, writer.pid, reader.pid); await reader.exec('COMMIT'); expect((await writing).ok).toBe(true);
    });
    expect((await state()).relations).toEqual([{ couponId: 11, productId: 70 }, { couponId: 22, productId: 80 }]);
  }, 15_000);
  it('fences both parents when a batch exchanges product scopes', async () => {
    await install();
    await withFinancePeers(f.db, async ([reader, writer, probe]) => {
      await reader.exec('BEGIN; SELECT id FROM store_coupon_issue WHERE id=22 FOR SHARE');
      const writing = outcome(writer.exec('UPDATE store_coupon_product SET coupon_id=33-coupon_id'));
      await waitForFinanceBlock(f.db, writer.pid, reader.pid);
      const probing = outcome(probe.exec("UPDATE store_coupon_issue SET title='held by transfer' WHERE id=11"));
      await waitForFinanceBlock(f.db, probe.pid, writer.pid);
      await reader.exec('COMMIT'); expect((await writing).ok).toBe(true); expect((await probing).ok).toBe(true);
    });
    expect((await state()).relations).toEqual([{ couponId: 11, productId: 80 }, { couponId: 22, productId: 70 }]);
  }, 15_000);
  it('permits creating the parent and replacing the relation set within the same transaction', async () => {
    await install();
    await withFinancePeers(f.db, async ([writer]) => {
      await writer.exec('BEGIN; INSERT INTO store_coupon_issue(id,coupon_type) VALUES(44,2); INSERT INTO store_coupon_product VALUES(44,70); DELETE FROM store_coupon_product WHERE coupon_id=44; INSERT INTO store_coupon_product VALUES(44,71); COMMIT');
    });
    expect((await state()).relations).toContainEqual({ couponId: 44, productId: 71 });
  });
  it('rolls back installed objects if a late trigger definition drifts', async () => {
    await f.exec(`CREATE FUNCTION fixture_wrong_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER coupon_product_delete_0151 AFTER DELETE ON store_coupon_product FOR EACH STATEMENT EXECUTE FUNCTION fixture_wrong_trigger()`);
    const before = await catalog(); const result = await outcome(install());
    expect(result.ok).toBe(false); if (!result.ok) expect(errorText(result.error)).toContain('existing fence trigger drift');
    expect(await catalog()).toEqual(before);
    const [row] = await f.db.select({ present: sql<boolean>`to_regprocedure('coupon_product_scope_fence_0151()') IS NOT NULL` }).from(sql`(values (1)) as probe(n)`);
    expect(row.present).toBe(false);
  });
  it.each([false, true])('TRUNCATE needs a relation lock, not merely the parent lock: relation lock=%s', async guarded => {
    await install();
    await withFinancePeers(f.db, async ([reader, writer]) => {
      await reader.exec('BEGIN');
      if (guarded) await reader.exec('LOCK TABLE store_coupon_product IN ACCESS SHARE MODE');
      await reader.exec('SELECT id FROM store_coupon_issue WHERE id=11 FOR SHARE');
      const truncating = outcome(writer.exec('TRUNCATE store_coupon_product'));
      if (guarded) { await waitForFinanceBlock(f.db, writer.pid, reader.pid); await reader.exec('COMMIT'); }
      expect((await truncating).ok).toBe(true); if (!guarded) await reader.exec('COMMIT');
    });
    expect((await state()).relations).toEqual([]);
  }, 15_000);
  it.each(['disabled', 'body', 'security-definer', 'rls', 'column-type', 'nullable', 'orphan', 'inheritance', 'deferred-pk'] as const)(
    'refuses drift with no installation/data side effects: %s', async drift => {
      if (['disabled', 'body', 'security-definer'].includes(drift)) await install();
      if (drift === 'disabled') await f.exec('ALTER TABLE store_coupon_product DISABLE TRIGGER coupon_product_update_0151');
      if (drift === 'body') await f.exec('CREATE OR REPLACE FUNCTION coupon_product_scope_fence_0151() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RETURN NULL; END $$');
      if (drift === 'security-definer') await f.exec('ALTER FUNCTION coupon_product_scope_fence_0151() SECURITY DEFINER');
      if (drift === 'rls') await f.exec('ALTER TABLE store_coupon_product ENABLE ROW LEVEL SECURITY');
      if (drift === 'column-type') await f.exec('ALTER TABLE store_coupon_product ALTER COLUMN coupon_id TYPE bigint');
      if (drift === 'nullable') await f.exec('ALTER TABLE store_coupon_product ALTER COLUMN product_id DROP NOT NULL');
      if (drift === 'orphan') await f.exec('INSERT INTO store_coupon_product VALUES(99,70)');
      if (drift === 'inheritance') await f.exec('CREATE TABLE fixture_child() INHERITS (store_coupon_product)');
      if (drift === 'deferred-pk') await f.exec('ALTER TABLE store_coupon_issue DROP CONSTRAINT store_coupon_issue_pkey; ALTER TABLE store_coupon_issue ADD PRIMARY KEY(id) DEFERRABLE');
      const before = await state(), beforeCatalog = await catalog(); const result = await outcome(install());
      expect(result.ok).toBe(false); if (!result.ok) expect(errorText(result.error)).toContain('0151');
      expect(await state()).toEqual(before); expect(await catalog()).toEqual(beforeCatalog);
    });
  it('bounds maintenance lock waits and leaves no partial function or triggers', async () => {
    const before = await state();
    await withFinancePeers(f.db, async ([holder, migrator]) => {
      await holder.exec('BEGIN; UPDATE store_coupon_issue SET title=title WHERE id=11');
      const installing = outcome(runCouponProductScopeFence(migrator.db, schema));
      await waitForFinanceBlock(f.db, migrator.pid, holder.pid); const result = await installing;
      expect(result.ok).toBe(false); if (!result.ok) expect(errorText(result.error)).toContain('lock timeout');
      expect(await catalog()).toEqual([]);
      const [row] = await f.db.select({ present: sql<boolean>`to_regprocedure('coupon_product_scope_fence_0151()') IS NOT NULL` }).from(sql`(values (1)) as probe(n)`);
      expect(row.present).toBe(false); await holder.exec('ROLLBACK');
    });
    expect(await state()).toEqual(before);
  }, 15_000);
  it('rejects invalid schema and transaction clients before running migration SQL', async () => {
    await expect(runCouponProductScopeFence(f.db, 'public; SELECT 1')).rejects.toThrow('Invalid coupon scope fence schema');
    await expect(runCouponProductScopeFence({ transaction: f.db.transaction.bind(f.db) }, schema)).rejects.toThrow('requires a root database');
    expect(await catalog()).toEqual([]);
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('coupon relation full ORM and actual nonowner permissions', () => {
  it('installs over complete ORM, preserves physical tables, and requires template UPDATE privilege for an actual login', async () => {
    const f = await sequenceRunnerDatabase();
    try {
      if (!f.withRuntimeRole || !f.withPeer) throw new Error('Independent PostgreSQL is required');
      const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
      await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
      await f.exec('INSERT INTO store_coupon_issue(id,coupon_type) VALUES(11,2),(22,2); INSERT INTO store_coupon_product VALUES(11,70)');
      const physical = () => f.query("SELECT oid::int,relfilenode::int FROM pg_class WHERE oid IN ('store_coupon_issue'::regclass,'store_coupon_product'::regclass) ORDER BY oid");
      const before = await physical(); await runCouponProductScopeFence(f.db); await runCouponProductScopeFence(f.db);
      expect(await physical()).toEqual(before);
      await f.withRuntimeRole(async runtime => {
        await f.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON store_coupon_product TO "${runtime.role}"; GRANT SELECT ON store_coupon_issue TO "${runtime.role}"`);
        await expect(runtime.exec('INSERT INTO store_coupon_product VALUES(11,71)')).rejects.toMatchObject({ code: '42501' });
        expect((await f.db.select().from(storeCouponProduct))).toEqual([{ couponId: 11, productId: 70 }]);
        await f.exec(`GRANT UPDATE(title) ON store_coupon_issue TO "${runtime.role}"`);
        await f.withPeer!(async reader => {
          expect(reader.pid).not.toBe(runtime.pid);
          await reader.exec('BEGIN; SELECT id FROM store_coupon_issue WHERE id=11 FOR SHARE');
          const writing = outcome(runtime.exec('INSERT INTO store_coupon_product VALUES(11,71)'));
          await waitForFinanceBlock(f.db, runtime.pid, reader.pid); await reader.exec('COMMIT'); expect((await writing).ok).toBe(true);
        });
        await runtime.exec('UPDATE store_coupon_product SET coupon_id=22 WHERE product_id=71; DELETE FROM store_coupon_product WHERE coupon_id=22');
        await expect(runtime.exec('ALTER TABLE store_coupon_product DISABLE TRIGGER USER')).rejects.toMatchObject({ code: '42501' });
        await expect(runtime.exec('TRUNCATE store_coupon_product')).rejects.toMatchObject({ code: '42501' });
        await expect(runtime.exec("SET session_replication_role='replica'")).rejects.toMatchObject({ code: '42501' });
      });
      expect((await f.db.select().from(storeCouponProduct))).toEqual([{ couponId: 11, productId: 70 }]);
    } finally { await f.close(); }
  }, 120_000);
});
