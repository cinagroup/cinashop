import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCreateTables } from './schema-audit';
import { catalogKinds, readCatalog, type Catalog, type CatalogQuery, type CatalogRow } from './postgres-catalog-audit';

export const ERP_AUDIT_TABLE_NAMES = ['erp_auth_state', 'erp_connection', 'erp_credential', 'erp_operation'] as const;
export const ERP_AUDIT_ORM_PATHS = ['orm', 'orm_upgrade', 'orm_default_upgrade', 'orm_constraints', 'orm_fk_names', 'orm_checks', 'orm_sequences'] as const;
export const ERP_AUDIT_SOURCE_PINS = {
  'src/models/erp.ts': '553cde9f8091b14c5ffcd2046e20654466844a4837d341a79de2dba4860a22ec',
  'src/migrations/maintenance/0181_erp_connection_lifecycle.sql': '52bd7739a29c966a07b358c240f43898b4c51b21861d27152b1cf8573b433f64',
} as const;

// An independent fixed bare-ORM contract, not generated from the current model.
// '?' denotes nullable; every other field, including each primary key, is NOT NULL.
const columns = {
  erp_auth_state: [
    'state_hash:varchar(64)', 'connection_id:uuid', 'connection_revision:integer', 'capability_version:integer',
    'app_key:varchar(128)', 'credential_fingerprint:varchar(64)', 'actor_id:integer', 'actor_auth_version:varchar(32)',
    'actor_expires_at:bigint', 'required_permission:varchar(64)', 'created_at:bigint', 'expires_at:bigint',
    'state:varchar(16)', 'code_hash:varchar(64)?', 'exchange_lease_hash:varchar(64)?', 'lease_expires_at:bigint?',
    'consumed_at:bigint?', 'error_code:varchar(64)?',
  ],
  erp_connection: [
    'id:uuid', 'provider:varchar(16)', 'name:varchar(64)', 'state:varchar(16)', 'revision:integer',
    'app_key:varchar(128)', 'credential_fingerprint:varchar(64)', 'capability_hash:varchar(64)',
    'capability_version:integer', 'rotated_at:bigint', 'bindings:jsonb', 'scope_revision:integer',
    'shop_observation_hash:varchar(64)?', 'created_by:integer', 'updated_by:integer', 'created_at:bigint',
    'updated_at:bigint', 'revoked_at:bigint?', 'revoke_reason:varchar(255)?',
  ],
  erp_credential: [
    'connection_id:uuid', 'version:integer', 'app_key:varchar(128)', 'credential_fingerprint:varchar(64)',
    'access_token_sealed:text', 'refresh_token_sealed:text', 'issued_at:bigint', 'expires_at:bigint',
    'refresh_after:bigint', 'auth_state_hash:varchar(64)', 'shop_observation_hash:varchar(64)?',
    'refresh_lease_hash:varchar(64)?', 'refresh_lease_expires_at:bigint?', 'updated_at:bigint',
    'state:varchar(16)', 'error_code:varchar(64)?',
  ],
  erp_operation: [
    'id:uuid', 'connection_id:uuid', 'kind:varchar(24)', 'business_key:varchar(255)', 'provider_event_id:varchar(128)?',
    'request_hash:varchar(64)', 'source_ts:bigint', 'received_at:bigint', 'connection_revision:integer',
    'capability_version:integer', 'scope_revision:integer', 'credential_version:integer', 'state:varchar(24)',
    'lease_hash:varchar(64)?', 'lease_expires_at:bigint?', 'attempt_count:integer', 'scope:jsonb?',
    'observation_hash:varchar(64)?', 'observed_at:bigint?', 'provider_facts:jsonb?', 'business_result:jsonb?',
    'payment_admission_id:varchar(128)?', 'error_code:varchar(64)?', 'created_at:bigint', 'updated_at:bigint', 'completed_at:bigint?',
  ],
} as const;
const primaryKeys = { erp_auth_state: 'state_hash', erp_connection: 'id', erp_credential: 'connection_id', erp_operation: 'id' } as const;
const erpNames = new Set<string>(ERP_AUDIT_TABLE_NAMES);
const emptyCatalog = (): Catalog => ({ tables: [], columns: [], constraints: [], indexes: [], sequences: [] });
function ormPath(path: string): boolean {
  assert.ok(path === 'external' || path === 'embedded' || ERP_AUDIT_ORM_PATHS.some(value => value === path), 'Unreviewed ERP construction path');
  return ERP_AUDIT_ORM_PATHS.some(value => value === path);
}

export function assertReviewedErpAuditSources(root: string) {
  for (const [file, expected] of Object.entries(ERP_AUDIT_SOURCE_PINS)) {
    const source = readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(source).digest('hex'), expected, 'Complete reviewed ERP source changed: ' + file);
  }
  const parsed = parseCreateTables(readFileSync(resolve(root, 'src/migrations/maintenance/0181_erp_connection_lifecycle.sql'), 'utf8'), 'postgres');
  assert.deepEqual([...parsed.keys()].sort(), [...ERP_AUDIT_TABLE_NAMES], 'Reviewed ERP maintenance table identities changed');
  for (const table of ERP_AUDIT_TABLE_NAMES) {
    assert.deepEqual([...parsed.get(table)!.columns.keys()], columns[table].map(value => value.split(':')[0]), 'Reviewed complete ERP columns changed: ' + table);
    assert.deepEqual(parsed.get(table)!.primaryKey, [primaryKeys[table]], 'Reviewed ERP primary key changed: ' + table);
  }
  return { ...ERP_AUDIT_SOURCE_PINS };
}

function expectedBareCatalog(): Catalog {
  const expected = emptyCatalog();
  for (const table of ERP_AUDIT_TABLE_NAMES) {
    expected.tables.push({ key: table, name: table, kind: 'r', persistence: 'p', rowSecurity: false,
      forceRowSecurity: false, partition: false, partitionKey: null });
    for (const spec of columns[table]) {
      const [name, rawType] = spec.split(':'), nullable = rawType.endsWith('?');
      const type = (nullable ? rawType.slice(0, -1) : rawType).replace(/^varchar\(/, 'character varying(');
      expected.columns.push({ key: `${table}.${name}`, name, table, type, notNull: !nullable, default: null,
        identity: '', generated: '', collation: type === 'text' || type.startsWith('character varying(') ? 'pg_catalog.default' : null });
    }
    const name = `${table}_pkey`, key = `${table}.${name}`, column = primaryKeys[table];
    expected.constraints.push({ key, name, table, type: 'p', definition: `PRIMARY KEY (${column})`, validated: true,
      deferrable: false, deferred: false, noInherit: true, local: true, inheritCount: 0 });
    expected.indexes.push({ key, name, table, definition: `public.${table} USING btree (${column})`, unique: true,
      primary: true, valid: true, ready: true, nullsNotDistinct: false, replicaIdentity: false, constraintOwned: true });
  }
  for (const kind of catalogKinds) expected[kind].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return expected;
}

/** Classify only fixed reviewed ERP identities; an unknown ERP object is refused,
 * never discarded by prefix. All other raw catalog rows remain in the caller's view. */
function isErpRow(kind: typeof catalogKinds[number], row: CatalogRow): boolean {
  const owners = kind === 'tables' ? [row.name, row.key] : kind === 'sequences'
    ? [typeof row.ownedBy === 'string' ? row.ownedBy.split('.')[1] : undefined, row.name]
    : [row.table, row.key.split('.')[0]];
  for (const owner of owners) if (typeof owner === 'string' && owner.startsWith('erp_')) {
    assert.ok(erpNames.has(owner), 'Unreviewed ERP catalog identity: ' + owner);
    return true;
  }
  return owners.some(owner => typeof owner === 'string' && erpNames.has(owner));
}

/** Read-only complete five-category partition. Source pins and every bare field
 * must match before any ERP row can leave the historical comparison view. */
export function reviewedErpAuditCatalogView(raw: Catalog, path: string, root: string) {
  const orm = ormPath(path), sources = assertReviewedErpAuditSources(root);
  const nonErp = emptyCatalog(), erp = emptyCatalog();
  for (const kind of catalogKinds) {
    assert.equal(new Set(raw[kind].map(row => row.key)).size, raw[kind].length, 'Duplicate complete ' + kind + ' catalog identity');
    for (const row of raw[kind]) (isErpRow(kind, row) ? erp : nonErp)[kind].push(row);
  }
  assert.deepEqual(erp, orm ? expectedBareCatalog() : emptyCatalog(), orm
    ? 'Complete bare ERP table/column/constraint/index/sequence contract changed' : 'ERP realm must be absent on external/embedded paths');
  return { nonErp, erp, sources };
}

/** A restricted, live-read context, not a caller-provided filtering predicate.
 * Every table-name projection rereads all five actual categories and proves that
 * the source-pinned ERP realm is unchanged. The original raw names stay intact. */
export class ReviewedErpAuditContext {
  readonly #query: CatalogQuery;
  readonly #path: string;
  readonly #root: string;
  readonly #baseline: Catalog;
  private constructor(query: CatalogQuery, path: string, root: string, baseline: Catalog) {
    this.#query = query; this.#path = path; this.#root = root; this.#baseline = structuredClone(baseline);
  }
  static async read(query: CatalogQuery, path: string, root: string): Promise<ReviewedErpAuditContext> {
    const reviewed = reviewedErpAuditCatalogView(await readCatalog(query), path, root);
    return new ReviewedErpAuditContext(query, path, root, reviewed.erp);
  }
  review(raw: Catalog, path: string) {
    assert.equal(path, this.#path, 'ERP context belongs to another construction path');
    const reviewed = reviewedErpAuditCatalogView(raw, path, this.#root);
    assert.deepEqual(reviewed.erp, this.#baseline, 'ERP catalog changed during historical audit composition');
    return reviewed;
  }
  async projectTableNames(rawNames: readonly string[], path: string): Promise<string[]> {
    const raw = await readCatalog(this.#query), reviewed = this.review(raw, path);
    assert.deepEqual(raw.tables.map(row => row.name), [...rawNames], 'Complete catalog changed between table-name and five-category reads');
    return reviewed.nonErp.tables.map(row => row.name);
  }
}
