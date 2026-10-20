import { getTableConfig } from 'drizzle-orm/pg-core';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as erpModels from '../src/models/erp';
import type { DbClient } from '../src/lib/di';
import { ERP_AUDIT_ORM_PATHS, ERP_AUDIT_SOURCE_PINS, ERP_AUDIT_TABLE_NAMES, ReviewedErpAuditContext,
  assertReviewedErpAuditSources, reviewedErpAuditCatalogView } from '../scripts/data-migration/erp-bare-orm-catalog';
import { assertCashierAbandonHistoricalBasis, composeReviewedCashierAbandonCatalog } from '../scripts/data-migration/cashier-abandon-catalog';
import { catalogKinds, type Catalog, type CatalogQuery } from '../scripts/data-migration/postgres-catalog-audit';
import { completeConstructionTableNames, ERP_ORM_TABLE_NAMES } from './helpers/completeConstructionInventory';

const root = resolve(import.meta.dirname, '..');
const table = (name: string) => ({ key: name, name, kind: 'r', persistence: 'p', rowSecurity: false,
  forceRowSecurity: false, partition: false, partitionKey: null });
// Test input comes from actual Drizzle declarations, independently of the fixed
// expected catalog. Native audit:orm also reads these fields directly from PG16.
function bareFixture(): Catalog {
  const raw: Catalog = { tables: completeConstructionTableNames('orm').map(table), columns: [], constraints: [], indexes: [], sequences: [] };
  for (const model of Object.values(erpModels)) {
    const config = getTableConfig(model), name = config.name;
    expect(config.indexes).toEqual([]); expect(config.foreignKeys).toEqual([]); expect(config.checks).toEqual([]);
    const [primary] = config.columns.filter(column => column.primary);
    expect(primary).toBeDefined();
    for (const column of config.columns) {
      expect(column.default).toBeUndefined();
      const type = column.getSQLType().replace(/^varchar\(/, 'character varying(');
      raw.columns.push({ key: `${name}.${column.name}`, name: column.name, table: name, type, notNull: column.notNull,
        default: null, identity: '', generated: '', collation: type === 'text' || type.startsWith('character varying(') ? 'pg_catalog.default' : null });
    }
    const key = `${name}.${name}_pkey`;
    raw.constraints.push({ key, name: `${name}_pkey`, table: name, type: 'p', definition: `PRIMARY KEY (${primary.name})`,
      validated: true, deferrable: false, deferred: false, noInherit: true, local: true, inheritCount: 0 });
    raw.indexes.push({ key, name: `${name}_pkey`, table: name, definition: `public.${name} USING btree (${primary.name})`,
      unique: true, primary: true, valid: true, ready: true, nullsNotDistinct: false, replicaIdentity: false, constraintOwned: true });
  }
  for (const kind of catalogKinds) raw[kind].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return raw;
}
function reader(initial: Catalog) {
  let current = initial, offset = 0;
  const query = vi.fn(async () => current[catalogKinds[offset++ % catalogKinds.length]]);
  return { query: query as CatalogQuery & typeof query, replace: (next: Catalog) => { current = next; } };
}

describe('independent source-pinned bare ERP ORM realm', () => {
  it.each(ERP_AUDIT_ORM_PATHS)('preserves all raw metadata and passes only the verified non-ERP projection on %s', path => {
    const raw = bareFixture(), before = structuredClone(raw), reviewed = reviewedErpAuditCatalogView(raw, path, root);
    expect(ERP_AUDIT_TABLE_NAMES).toEqual(ERP_ORM_TABLE_NAMES);
    expect(reviewed.erp.tables.map(row => row.name)).toEqual([...ERP_ORM_TABLE_NAMES]);
    expect(catalogKinds.map(kind => reviewed.erp[kind].length)).toEqual([4, 79, 4, 4, 0]);
    expect(reviewed.sources).toEqual(ERP_AUDIT_SOURCE_PINS);
    expect(assertCashierAbandonHistoricalBasis(reviewed.nonErp.tables.map(row => row.name), path).historical).toHaveLength(286);
    expect(() => assertCashierAbandonHistoricalBasis(raw.tables.map(row => row.name), path)).toThrow();
    for (const kind of catalogKinds) expect([...reviewed.nonErp[kind], ...reviewed.erp[kind]].sort((a, b) => a.key.localeCompare(b.key)))
      .toEqual([...raw[kind]].sort((a, b) => a.key.localeCompare(b.key)));
    expect(raw).toEqual(before);
  });
  it.each(['external', 'embedded'])('requires the whole ERP realm to be absent on %s', path => {
    const full = bareFixture();
    expect(() => reviewedErpAuditCatalogView(full, path, root)).toThrow('must be absent');
    const absent = reviewedErpAuditCatalogView(full, 'orm', root).nonErp;
    expect(reviewedErpAuditCatalogView(absent, path, root).erp).toEqual({ tables: [], columns: [], constraints: [], indexes: [], sequences: [] });
    for (const kind of ['columns', 'constraints', 'indexes'] as const) {
      const orphan = structuredClone(absent); orphan[kind].push(full[kind][0]);
      expect(() => reviewedErpAuditCatalogView(orphan, path, root)).toThrow('must be absent');
    }
  });
  it.each([
    ['table RLS', 'tables', 'rowSecurity', true], ['table persistence', 'tables', 'persistence', 'u'],
    ['column type', 'columns', 'type', 'text'], ['column default', 'columns', 'default', "'wrong'::text"],
    ['column nullable', 'columns', 'notNull', true], ['column collation', 'columns', 'collation', 'public.foreign'],
    ['primary definition', 'constraints', 'definition', 'PRIMARY KEY (wrong)'], ['constraint inheritance', 'constraints', 'noInherit', false],
    ['index validity', 'indexes', 'valid', false], ['index owner', 'indexes', 'constraintOwned', false],
  ] as const)('refuses %s drift before excluding ERP metadata', (_reason, kind, field, value) => {
    const raw = bareFixture();
    const target = kind === 'columns' && field === 'notNull' ? raw.columns.find(row => !row.notNull)!
      : raw[kind].find(row => kind === 'tables' ? row.name.startsWith('erp_') : row.table?.startsWith('erp_'))!;
    target[field] = value;
    expect(() => reviewedErpAuditCatalogView(raw, 'orm', root)).toThrow('contract changed');
  });
  it('refuses missing or extra fields and duplicate/unknown identities, including orphan sequences', () => {
    const original = bareFixture();
    for (const kind of ['tables', 'columns', 'constraints', 'indexes'] as const) {
      const first = original[kind].find(row => kind === 'tables' ? row.name.startsWith('erp_') : row.table?.startsWith('erp_'))!;
      for (const transform of [
        (raw: Catalog) => { raw[kind] = raw[kind].filter(row => row.key !== first.key); },
        (raw: Catalog) => { raw[kind].push(structuredClone(first)); },
        (raw: Catalog) => { const row: Record<string, unknown> = raw[kind].find(row => row.key === first.key)!; delete row.name; },
        (raw: Catalog) => { raw[kind].find(row => row.key === first.key)!.unreviewed = false; },
      ]) {
        const raw = structuredClone(original); transform(raw);
        expect(() => reviewedErpAuditCatalogView(raw, 'orm', root)).toThrow();
      }
    }
    const rogue = structuredClone(original); rogue.tables.push(table('erp_unreviewed'));
    expect(() => reviewedErpAuditCatalogView(rogue, 'orm', root)).toThrow('Unreviewed ERP');
    for (const row of [{ key: 'foreign_sequence', name: 'foreign_sequence', ownedBy: 'public.erp_connection.id' },
      { key: 'erp_connection_seq', name: 'erp_connection_seq', ownedBy: null }]) {
      const raw = structuredClone(original); raw.sequences.push(row);
      expect(() => reviewedErpAuditCatalogView(raw, 'orm', root)).toThrow();
    }
    expect(() => reviewedErpAuditCatalogView(original, 'orm_unreviewed', root)).toThrow('Unreviewed ERP construction path');
  });
  it.each(Object.keys(ERP_AUDIT_SOURCE_PINS))('refuses changed complete source %s', file => {
    const temporary = mkdtempSync(join(tmpdir(), 'cinashop-erp-catalog-source-'));
    try {
      for (const name of Object.keys(ERP_AUDIT_SOURCE_PINS)) {
        mkdirSync(dirname(join(temporary, name)), { recursive: true });
        writeFileSync(join(temporary, name), readFileSync(join(root, name)));
      }
      writeFileSync(join(temporary, file), readFileSync(join(temporary, file), 'utf8') + '\n-- changed\n');
      expect(() => assertReviewedErpAuditSources(temporary)).toThrow('Complete reviewed ERP source changed');
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
  it('rereads all five categories on each projection and fences changed raw table names and paths', async () => {
    const raw = bareFixture(), io = reader(raw), context = await ReviewedErpAuditContext.read(io.query, 'orm', root);
    expect(io.query).toHaveBeenCalledTimes(5);
    const projected = await context.projectTableNames(raw.tables.map(row => row.name), 'orm');
    expect(io.query).toHaveBeenCalledTimes(10);
    expect(assertCashierAbandonHistoricalBasis(projected, 'orm').historical).toHaveLength(286);
    await expect(context.projectTableNames(raw.tables.map(row => row.name).slice(1), 'orm')).rejects.toThrow('between table-name');
    await expect(context.projectTableNames(raw.tables.map(row => row.name), 'orm_checks')).rejects.toThrow('another construction path');
    const drifted = structuredClone(raw); drifted.indexes[0].valid = false; io.replace(drifted);
    await expect(context.projectTableNames(raw.tables.map(row => row.name), 'orm')).rejects.toThrow('contract changed');
    expect(() => context.review(drifted, 'orm')).toThrow('contract changed');
  });
  it('retains a newly composed historical table while verifying ERP is unchanged', async () => {
    const raw = bareFixture(), io = reader(raw), context = await ReviewedErpAuditContext.read(io.query, 'orm', root);
    const installed = structuredClone(raw); installed.tables.push(table('cashier_second_card_abandon_v1'));
    installed.tables.sort((a, b) => a.name.localeCompare(b.name)); io.replace(installed);
    const projected = await context.projectTableNames(installed.tables.map(row => row.name), 'orm');
    expect(projected).toHaveLength(289); expect(projected).toContain('cashier_second_card_abandon_v1');
    expect(context.review(installed, 'orm').erp).toEqual(context.review(raw, 'orm').erp);
  });
  it('rejects an arbitrary filtering object before any cashier database operation', async () => {
    const execute = vi.fn(), db = { execute } as unknown as DbClient;
    await expect(composeReviewedCashierAbandonCatalog(db, 'orm', root,
      { projectTableNames: async () => [] } as unknown as ReviewedErpAuditContext)).rejects.toThrow('source-pinned live ERP audit context');
    expect(execute).not.toHaveBeenCalled();
  });
});
