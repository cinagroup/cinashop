import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../../src/lib/di';
import { inspectCashierSecondCardAbandon, installCashierSecondCardAbandon } from '../../src/migrations/runCashierSecondCardAbandon';
import { inspectInvoiceManualRedNote, INVOICE_MANUAL_RED_NOTE_PINS } from '../../src/migrations/invoiceManualRedNoteCatalog';
import { completeConstructionTableNames, ERP_ORM_TABLE_NAMES, MANUAL_RED_NOTE_ORM_TABLE_NAMES } from '../../test/helpers/completeConstructionInventory';
import { catalogKinds, type Catalog } from './postgres-catalog-audit';
import { ReviewedErpAuditContext } from './erp-bare-orm-catalog';

export const CASHIER_ABANDON_EXTERNAL_FILE = '0174_customer_cashier_abandon.sql';
export const CASHIER_ABANDON_TABLE = 'cashier_second_card_abandon_v1';
export const CASHIER_ABANDON_SOURCE_SHA256 = '49bc46205953c28e482f76d3e62d044bf719b98466077f22401a69ed375c8899';
export const CASHIER_ABANDON_DECLARATION_SHA256 = 'e91f303bc1786c4eb32da38932eb2b1485aaa3e5ccd63696b570f5ccab856c0c';
export function assertReviewedCashierAbandonSources(root: string) {
  for (const [file, expected] of [
    ['migrations/' + CASHIER_ABANDON_EXTERNAL_FILE, CASHIER_ABANDON_SOURCE_SHA256],
    ['src/migrations/cashierSecondCardAbandon.ts', CASHIER_ABANDON_DECLARATION_SHA256],
  ]) {
    const source = readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(source).digest('hex'), expected, 'Complete reviewed abandonment source changed: ' + file);
  }
}

const objectIdentities = sql`SELECT 'relation' AS kind,oid::text,relfilenode::text,relowner::text,relacl::text AS acl
 FROM pg_class WHERE relnamespace='public'::regnamespace UNION ALL
 SELECT 'function',oid::text,NULL,proowner::text,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace UNION ALL
 SELECT 'constraint',oid::text,NULL,NULL,NULL FROM pg_constraint WHERE connamespace='public'::regnamespace UNION ALL
 SELECT 'trigger',oid::text,NULL,NULL,NULL FROM pg_trigger WHERE tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
 ORDER BY kind,oid`;

const ormPaths = ['orm','orm_upgrade','orm_default_upgrade','orm_constraints','orm_fk_names','orm_checks','orm_sequences'] as const;
const manualTables = new Set<string>(MANUAL_RED_NOTE_ORM_TABLE_NAMES);
const erpTables = new Set<string>(ERP_ORM_TABLE_NAMES);
function isOrmPath(path: string) {
  assert.ok(path === 'external' || path === 'embedded' || ormPaths.some(name => name === path), 'Unreviewed construction path');
  return ormPaths.some(name => name === path);
}
/** The fixed historical cohort is never regenerated from current models. Only
 * the two independently reviewed bare ORM tables may be additional objects. */
export function assertCashierAbandonHistoricalBasis(names: readonly string[], path: string) {
  const orm = isOrmPath(path), mature = completeConstructionTableNames('orm').filter(name => !manualTables.has(name) && !erpTables.has(name));
  const prior=mature.filter(name=>name!=='store_order_purchase_physical_origin');
  assert.equal(prior.length,285,'Frozen pre-physical-origin table inventory changed');
  assert.equal(mature.length,286,'Reviewed physical-origin table inventory changed');
  assert.deepEqual(mature,[...prior,'store_order_purchase_physical_origin'].sort());
  assert.equal(new Set(names).size, names.length, 'Duplicate complete table identity');
  const extras = names.filter(name => manualTables.has(name));
  assert.deepEqual(extras, orm ? [...MANUAL_RED_NOTE_ORM_TABLE_NAMES] : [], 'Only the exact two bare manual ORM tables are reviewed');
  const historical = names.filter(name => !manualTables.has(name));
  assert.equal(historical.length, path === 'external' ? 287 : 286, 'Historical complete table basis changed');
  assert.deepEqual(historical, path === 'external' ? [...mature, CASHIER_ABANDON_TABLE].sort() : mature,
    'Complete historical table names changed');
  return { historical, manualTables: extras, actualTables: names.length };
}
/** Full pinned table metadata includes every column, constraint, index and
 * trigger; a named/partial pair or installed manual protection is not bare ORM. */
export function assertCashierAuditManualRedNoteCatalog(rows: readonly Record<string, unknown>[], path: string) {
  const orm = isOrmPath(path), names = [...MANUAL_RED_NOTE_ORM_TABLE_NAMES,'guard_invoice_manual_red_note','protect_invoice_manual_red_note'];
  assert.equal(rows.length, 4, 'Incomplete manual ORM catalog probe');
  assert.deepEqual(rows.map(row => row.name).sort(), [...names].sort(), 'Unknown or duplicate manual ORM catalog object');
  for (const row of rows) {
    const table = typeof row.name === 'string' && manualTables.has(row.name);
    assert.equal(row.kind, table ? 'table' : 'function', 'Manual catalog object kind changed');
    if (orm && table) {
      assert.equal(row.present, true); assert.equal(row.owned, true); assert.equal(row.safe, true);
      assert.equal(row.fingerprint, row.name === MANUAL_RED_NOTE_ORM_TABLE_NAMES[0]
        ? INVOICE_MANUAL_RED_NOTE_PINS.bareRecord : INVOICE_MANUAL_RED_NOTE_PINS.bareReview,
      'Complete manual ORM table/column/constraint/index contract changed');
    } else assert.equal(row.present, false, 'Manual maintenance objects must remain absent on this path');
  }
}
/** Called only after the actual complete bare/fresh pin probe. Preserve raw
 * catalogs independently; all five historical gates use this exact cohort view. */
export function reviewedCashierAuditCatalogView(raw: Catalog, path: string, rows: readonly Record<string, unknown>[]) {
  assertCashierAuditManualRedNoteCatalog(rows, path);
  const before = raw.tables.map(row => row.name).filter(name => name !== CASHIER_ABANDON_TABLE);
  if (path === 'external') before.push(CASHIER_ABANDON_TABLE);
  assertCashierAbandonHistoricalBasis(before.sort(), path);
  assert.equal(raw.tables.filter(row => row.name === CASHIER_ABANDON_TABLE).length, 1, 'Composed abandonment table is missing or ambiguous');
  const historical: Catalog = { tables: [], columns: [], constraints: [], indexes: [], sequences: [] };
  const manual: Catalog = { tables: [], columns: [], constraints: [], indexes: [], sequences: [] };
  for (const kind of catalogKinds) for (const row of raw[kind]) {
    const owner = kind === 'tables' ? row.name : kind === 'sequences'
      ? typeof row.ownedBy === 'string' ? row.ownedBy.split('.')[1] : undefined : row.table;
    (typeof owner === 'string' && manualTables.has(owner) ? manual : historical)[kind].push(row);
  }
  assert.equal(manual.tables.length, isOrmPath(path) ? 2 : 0);
  assert.equal(manual.sequences.length, 0, 'Bare manual tables do not own sequences');
  return { historical, manual };
}

/** Explicit composition on an owned, empty audit fixture only. This does not
 * register the table in runAll or alter the frozen 285-table historical base. */
export async function composeReviewedCashierAbandonCatalog(db: DbClient, path: string, root: string, erpContext?: ReviewedErpAuditContext) {
  assertReviewedCashierAbandonSources(root);
  if (erpContext !== undefined) assert.ok(erpContext instanceof ReviewedErpAuditContext, 'Expected a source-pinned live ERP audit context');
  const initial = await inspectCashierSecondCardAbandon(db);
  assert.ok(path === 'external' ? initial.complete : !initial.present, 'Unexpected abandonment registration on ' + path);
  const beforeNames = await db.execute(sql`SELECT relname AS name FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY relname COLLATE "C"`);
  const rawBeforeNames = beforeNames.map(row => String(row.name));
  const projectedBeforeNames = erpContext ? await erpContext.projectTableNames(rawBeforeNames, path) : rawBeforeNames;
  const basis = assertCashierAbandonHistoricalBasis(projectedBeforeNames, path);
  const manualBefore = await inspectInvoiceManualRedNote(db);
  assertCashierAuditManualRedNoteCatalog(manualBefore.rows, path);
  const before = await db.execute(objectIdentities);
  if (path !== 'external') await installCashierSecondCardAbandon(db);
  assert.ok((await inspectCashierSecondCardAbandon(db)).complete, 'Composed abandonment catalog differs');
  const installed = await db.execute(objectIdentities);
  assert.deepEqual(Array.from(installed).filter(row => before.some(old => old.kind === row.kind && old.oid === row.oid)), Array.from(before), 'Abandonment composition changed an existing identity/owner/ACL');
  const afterNames = await db.execute(sql`SELECT relname AS name FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY relname COLLATE "C"`);
  assert.deepEqual(afterNames.map(row => row.name), path === 'external' ? beforeNames.map(row => row.name)
    : [...beforeNames.map(row => row.name), CASHIER_ABANDON_TABLE].sort(), 'Unexpected table composition difference');
  if (erpContext) assert.deepEqual(await erpContext.projectTableNames(afterNames.map(row => String(row.name)), path),
    path === 'external' ? projectedBeforeNames : [...projectedBeforeNames, CASHIER_ABANDON_TABLE].sort(),
    'Verified non-ERP table composition changed');
  const [count] = await db.execute(sql`SELECT count(*)::integer AS count FROM public.cashier_second_card_abandon_v1`);
  assert.equal(count.count, 0, 'Abandonment audit fixture must remain empty');
  await assert.rejects(installCashierSecondCardAbandon(db), error => {
    // Drizzle preserves the PostgreSQL refusal as a cause of its query error.
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === 'P0001' && 'message' in cause
        && cause.message === 'Existing cashier abandonment protocol requires exact catalog review, no reinstall') return true;
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    return false;
  });
  assert.ok((await inspectCashierSecondCardAbandon(db)).complete);
  assert.deepEqual(Array.from(await db.execute(objectIdentities)), Array.from(installed), 'Refused abandonment reinstall changed identities');
  const manualAfter = await inspectInvoiceManualRedNote(db);
  assertCashierAuditManualRedNoteCatalog(manualAfter.rows, path);
  assert.deepEqual(Array.from(manualAfter.rows), Array.from(manualBefore.rows), 'Abandonment composition changed manual ORM objects');
  return { initial: initial.present ? 'exact-catalog' : 'absent', explicitInstallation: path !== 'external',
    complete: true, existingObjectsPreserved: true, repeatRefused: true, noBackfill: true,
    historicalTables: path === 'external' ? basis.historical.length : basis.historical.length + 1,
    manualOrmTables: basis.manualTables, manualCatalogBefore: manualBefore.rows, manualCatalogAfter: manualAfter.rows,
    tables: afterNames.length };
}
