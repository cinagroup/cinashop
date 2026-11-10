/** Explicit owner maintenance on disposable catalog-audit databases only.
 * Bare construction profiles and all complete pre/post catalogs remain visible.
 * No column normalization, runtime commissioning or application DDL fallback. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../../src/lib/di';
import { RECHARGE_REFUND_CATALOG_SQL, runRechargeRefundInstallation } from '../../src/migrations/rechargeRefund';
import { RECHARGE_REFUND_TABLES } from '../../src/migrations/rechargeRefundContract';
import { TABLE_CATALOG_COUNT, TABLE_CATALOG_FIELDS } from './table-catalog-contracts';
import { catalogKinds, compareCatalogs, readCatalog, type Catalog, type CatalogRow } from './postgres-catalog-audit';

export const RECHARGE_REFUND_AUDIT_PATHS = ['external', 'embedded', 'orm', 'orm_upgrade', 'orm_default_upgrade',
  'orm_constraints', 'orm_fk_names', 'orm_checks', 'orm_sequences'] as const;
const tables = RECHARGE_REFUND_TABLES.map(table => table.name).sort();
const tableSet = new Set(tables);
const sourceKey = 'user_recharge.refund_price';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Lossless full native rows, not a normalized/filtered catalog. Keep the
 * existing 32 MiB local diagnostic bound without serializing the same mature
 * realm three times. A reader verifies bytes/SHA256 after ordinary gunzip. */
export function rechargeRefundCatalogArtifact(catalogs: Record<string, Catalog>) {
  const raw = Buffer.from(JSON.stringify(catalogs), 'utf8');
  return { encoding: 'gzip+base64' as const, bytes: raw.byteLength, sha256: createHash('sha256').update(raw).digest('hex'),
    data: Buffer.from(gzipSync(raw)).toString('base64') };
}
const empty = (): Catalog => ({ tables: [], columns: [], indexes: [], constraints: [], sequences: [] });
function index(rows: CatalogRow[]) {
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length, 'Duplicate catalog row identity');
  return new Map(rows.map(row => [row.key, row]));
}
function initialType(path: string) {
  assert.ok(RECHARGE_REFUND_AUDIT_PATHS.some(value => value === path), 'Unreviewed recharge construction path');
  return path === 'external' || path === 'embedded' ? 'numeric(10,2)' : 'numeric(12,2)';
}
function sourceColumn(catalog: Catalog) {
  const rows = catalog.columns.filter(row => row.key === sourceKey);
  assert.equal(rows.length, 1, 'Recharge refund source column missing or ambiguous');
  return rows[0];
}
function assertBareColumn(catalog: Catalog, path: string) {
  assert.deepEqual(sourceColumn(catalog), { key: sourceKey, name: 'refund_price', table: 'user_recharge', type: initialType(path),
    notNull: true, default: '0.00', identity: '', generated: '', collation: null }, 'Unexpected bare recharge column profile');
}
const identities = sql`SELECT 'relation' AS kind,c.oid::text AS oid,c.relname AS name,c.relowner::text AS owner,c.relacl::text AS acl,
 NULL::text AS body FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace UNION ALL
 SELECT 'function',p.oid::text,p.proname,p.proowner::text,p.proacl::text,
 pg_catalog.pg_get_functiondef(p.oid) FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN('f','p') UNION ALL
 SELECT 'type',t.oid::text,t.typname,t.typowner::text,t.typacl::text,NULL FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace UNION ALL
 SELECT 'constraint',k.oid::text,k.conname,NULL,NULL,NULL FROM pg_catalog.pg_constraint k WHERE k.connamespace='public'::regnamespace UNION ALL
 SELECT 'trigger',g.oid::text,g.tgname,NULL,NULL,NULL FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid=g.tgrelid
 WHERE c.relnamespace='public'::regnamespace ORDER BY kind,oid`;
const sourceRows = sql`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb)::text AS rows FROM public.user_recharge r`;

/** Every retained row comes from the actual post-install read. The supplied
 * historical realm was already checked by the existing ERP/manual gates. New
 * protocol rows are kept separately and in the complete maintained comparison. */
export function reviewRechargeRefundTransition(before: Catalog, after: Catalog, historicalBefore: Catalog, path: string) {
  assertBareColumn(before, path);
  const historical = empty(), protocol = empty(), maintained = empty();
  for (const kind of catalogKinds) {
    const old = index(before[kind]), current = index(after[kind]), retained = index(historicalBefore[kind]);
    for (const [key, row] of old) {
      const expected = kind === 'columns' && key === sourceKey ? { ...row, type: 'numeric(12,2)' } : row;
      assert.deepEqual(current.get(key), expected, 'Recharge installation changed an existing catalog row: ' + key);
    }
    for (const [key, row] of retained) {
      assert.deepEqual(row, old.get(key), 'Historical realm is not the reviewed native input: ' + key);
      historical[kind].push(current.get(key)!);
    }
    for (const [key, row] of current) if (!old.has(key)) {
      const owner = kind === 'tables' ? row.name : row.table;
      assert.ok(kind !== 'sequences' && typeof owner === 'string' && tableSet.has(owner), 'Unreviewed recharge catalog addition: ' + key);
      protocol[kind].push(row);
    }
    maintained[kind] = [...historical[kind], ...protocol[kind]].sort((a, b) => a.key.localeCompare(b.key));
  }
  assert.deepEqual(protocol.tables.map(row => row.name).sort(), tables, 'Complete four-table recharge protocol is required');
  assert.deepEqual(protocol.sequences, [], 'UUID recharge protocol must not introduce a sequence');
  return { historical, protocol, maintained };
}

export async function composeReviewedRechargeRefundCatalog(db: DbClient, path: string, before: Catalog, historicalBefore: Catalog,
  owned: { database: string; databases: readonly string[] }) {
  initialType(path);
  assert.ok(owned.databases.includes(owned.database), 'Recharge catalog database is not owned by this audit');
  assert.ok(new RegExp(`^orm_audit_${path}_[a-f0-9]{32}$`).test(owned.database)
    || /^finance_fixture_[a-f0-9]{32}$/.test(owned.database), 'Unsafe recharge catalog database');
  const identity = await db.execute(sql`SELECT current_database() AS database,current_user AS role,session_user AS session,
    current_setting('server_version_num')::integer AS version`);
  assert.equal(identity.length, 1);
  assert.equal(identity[0].database, owned.database); assert.equal(identity[0].role, 'finance_test');
  assert.equal(identity[0].session, 'finance_test'); assert.equal(Math.floor(Number(identity[0].version) / 10000), 16);
  const query = async (text: string) => Array.from(await db.execute(sql.raw(text))) as CatalogRow[];
  const nativeBefore = await readCatalog(query);
  assert.deepEqual(nativeBefore, before, 'Bare catalog changed before recharge maintenance');
  // Validate the bare profile before any DDL. The installer independently
  // repeats its native ownership/shape/environment checks under the source lock.
  assertBareColumn(before, path);
  const inspect = async () => {
    const rows = await db.execute<Record<string, unknown>>(sql.raw(RECHARGE_REFUND_CATALOG_SQL));
    assert.equal(rows.length, 1); return rows[0];
  };
  const initial = await inspect();
  assert.equal(initial.present, false, 'Recharge maintenance must start genuinely absent');
  assert.equal(initial.source_safe, true, 'Unsafe original recharge source');
  const oldIdentities = Array.from(await db.execute(identities));
  const oldRows = Array.from(await db.execute(sourceRows));
  await runRechargeRefundInstallation(db);
  const installed = await inspect();
  for (const flag of ['present', 'structural', 'source_safe', 'owner_only', 'unbound']) assert.equal(installed[flag], true, 'Installed recharge ' + flag);
  assert.equal(installed.binding, null, 'Catalog audit must not commission runtime peers');
  assert.deepEqual(installed.source, { ...(initial.source as Record<string, unknown>), type: 'numeric(12,2)' }, 'Recharge source identity/metadata changed');
  const installedIdentities = Array.from(await db.execute(identities));
  assert.deepEqual(installedIdentities.filter(row => oldIdentities.some(old => old.kind === row.kind && old.oid === row.oid)),
    oldIdentities, 'Recharge maintenance changed an existing public identity/owner/ACL/function');
  assert.deepEqual(Array.from(await db.execute(sourceRows)), oldRows, 'Recharge maintenance changed existing recharge rows');
  const after = await readCatalog(query);
  const reviewed = reviewRechargeRefundTransition(before, after, historicalBefore, path);
  await runRechargeRefundInstallation(db);
  assert.deepEqual(await inspect(), installed, 'Recharge installation replay changed its native protocol');
  assert.deepEqual(await readCatalog(query), after, 'Recharge replay changed a complete catalog');
  assert.deepEqual(Array.from(await db.execute(identities)), installedIdentities, 'Recharge replay changed public identities/owners/ACLs/functions');
  assert.deepEqual(Array.from(await db.execute(sourceRows)), oldRows, 'Recharge replay changed recharge rows');
  return { ...reviewed, raw: after, verification: { initialType: initialType(path), installedType: 'numeric(12,2)',
    installedBy: 'runRechargeRefundInstallation', ownerOnly: true, commissioned: false, tables,
    completeBeforeSha256: digest(before), completeAfterSha256: digest(after), originalIdentities: oldIdentities.length,
    preservedSourceRowsSha256: digest(oldRows), sourceIdentityPreserved: true, replayCompleteCatalogAndIdentityPreserved: true } };
}

/** The mature 287-table gate still runs separately, unchanged. This additional
 * gate includes all four genuinely installed tables and every raw metadata row. */
export function assertRechargeRefundMaintainedCatalogsAligned(reference: Catalog, candidate: Catalog) {
  for (const catalog of [reference, candidate]) {
    assert.equal(catalog.tables.length, TABLE_CATALOG_COUNT + tables.length, 'Complete maintained table cohort changed');
    for (const kind of catalogKinds) index(catalog[kind]);
    for (const row of catalog.tables) assert.deepEqual(Object.keys(row).sort(), [...TABLE_CATALOG_FIELDS], 'Maintained table row fields changed');
    assert.deepEqual(catalog.tables.filter(row => tableSet.has(row.name)).map(row => row.name).sort(), tables);
  }
  const comparison = compareCatalogs(reference, candidate);
  for (const kind of catalogKinds) assert.ok(!Object.values(comparison[kind]).some(rows => rows.length), 'Full maintained recharge ' + kind + ' catalog differs');
}
