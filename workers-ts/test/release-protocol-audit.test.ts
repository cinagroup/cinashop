import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { auditReleaseProtocols } from '../src/migrations/auditReleaseProtocols';
import { OFFLINE_BARCODE_CATALOG_VERSIONS, OFFLINE_CATALOG_VERSIONS } from '../src/migrations/offlineOrderCatalog';
import { RELEASE_PRE_INDEX_HASHES } from '../src/migrations/releaseSharedIndexes';

const mocks = vi.hoisted(() => ({ operation: vi.fn(), creation: vi.fn(), pricing: vi.fn(), predecessor: vi.fn() }));
vi.mock('../src/migrations/runAdminRefundOperation', () => ({ inspectAdminRefundOperation: mocks.operation }));
vi.mock('../src/migrations/runAdminRefundCreation', () => ({ inspectAdminRefundCreation: mocks.creation }));
vi.mock('../src/migrations/checkoutPricingLock', () => ({ inspectCheckoutPricingLock: mocks.pricing }));
vi.mock('../src/migrations/runTestReleaseSchemaUpgrade', () => ({ inspectTestReleaseSchemaUpgrade: mocks.predecessor }));

function fixture() {
  const rows: unknown[][] = [[], [{ database: 'synthetic', role: 'synthetic', read_only: 'on', server_version: 160014 }],
    [{ state: 'fresh' }], [{ state: 'fresh' }], [{ state: 'fresh' }],
    Object.entries(OFFLINE_CATALOG_VERSIONS.fresh).map(([name, fingerprint]) => ({ name, fingerprint, present: true, owned: true, safe: true })), []];
  const queries: string[] = [];
  const tx = { execute: vi.fn(async (query) => {
    queries.push(new PgDialect().sqlToQuery(query).sql);
    return rows[queries.length - 1];
  }) };
  const transaction = vi.fn(async (callback) => callback(tx));
  const db = { transaction, $client: {} } as unknown as Parameters<typeof auditReleaseProtocols>[0];
  return { db, rows, queries, transaction, tx };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.operation.mockResolvedValue({ present: false, complete: false });
  mocks.creation.mockResolvedValue({ present: false, complete: false });
  mocks.pricing.mockResolvedValue({ absent: true });
  mocks.predecessor.mockResolvedValue({ supported: true, ready: true, withinBudget: true,
    diagnostics: { dangling_paid_users: 0 }, fingerprint: { rows: 0 }, catalog: { internal: 'not returned' } });
});

describe('fixed release protocol read-only inventory', () => {
  it('uses bounded read-only catalog checks and never infers readiness from successful observations', async () => {
    const f = fixture(), result = await auditReleaseProtocols(f.db);
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'repeatable read', accessMode: 'read only' });
    expect(f.queries).toHaveLength(7);
    expect(f.queries[0]).toContain("'public,pg_temp'");
    for (const timeout of ['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout'])
      expect(f.queries[0]).toContain(timeout);
    expect(f.queries[0]).toContain('LEAST(NULLIF');
    expect(f.queries.at(-1)).toContain('LIMIT 101');
    expect(f.queries.at(-1)).toContain('definition_hash');
    expect(mocks.operation).toHaveBeenCalledWith(f.tx);
    expect(mocks.creation).toHaveBeenCalledWith(f.tx);
    expect(mocks.pricing).toHaveBeenCalledWith(f.tx);
    expect(result.ready).toBe(false);
    expect(result.protocols.offlinePredecessor).toHaveLength(10);
    expect(result.protocols.offlinePredecessor.every(row => row.fingerprintMatches)).toBe(true);
    expect(result.protocols.offlinePredecessor.every(row => !row.reviewedPreIndexMatches)).toBe(true);
    expect(result.predecessor).not.toHaveProperty('catalog');
    expect(mocks.predecessor).toHaveBeenCalledWith(f.db);
  });
  it('recognizes the exact reviewed member index fingerprint in the read-only inventory', async () => {
    const f = fixture();
    f.rows[5] = Object.entries(OFFLINE_BARCODE_CATALOG_VERSIONS.fresh)
      .map(([name, fingerprint]) => ({ name, fingerprint, present: true, owned: true, safe: true }));
    const result = await auditReleaseProtocols(f.db);
    expect(result.protocols.offlinePredecessor.every(row => row.fingerprintMatches)).toBe(true);
    expect(result.ready).toBe(false);
  });
  it.each([undefined, null, 'invalid', 160000.5, 150014, 170000])('rejects an unsupported or malformed server version %s', async version => {
    const f = fixture(); f.rows[1] = [{ read_only: 'on', server_version: version }];
    await expect(auditReleaseProtocols(f.db)).rejects.toThrow('Unsupported');
    expect(mocks.operation).not.toHaveBeenCalled(); expect(mocks.predecessor).not.toHaveBeenCalled();
  });
  it('requires a root client before starting any transaction', async () => {
    const f = fixture(); delete (f.db as { $client?: unknown }).$client;
    await expect(auditReleaseProtocols(f.db)).rejects.toThrow('root database');
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each([{ identity: [] }, { identity: [{ read_only: 'off', server_version: 160014 }] }])('fails closed on missing identity or non-read-only state', async ({ identity }) => {
    const f = fixture(); f.rows[1] = identity;
    await expect(auditReleaseProtocols(f.db)).rejects.toThrow('Unsupported');
  });
  it.each([2, 3, 4])('rejects unknown protocol state at query %s', async position => {
    const f = fixture(); f.rows[position] = [{ state: 'unknown' }];
    await expect(auditReleaseProtocols(f.db)).rejects.toThrow('invalid state');
    expect(mocks.predecessor).not.toHaveBeenCalled();
  });
  it('reports missing, duplicate, unsafe and mismatched components without accepting a learned hash', async () => {
    const f = fixture();
    f.rows[5] = [{ name: 'user', present: true, owned: true, safe: false, fingerprint: 'unreviewed' },
      ...[1, 2].map(() => ({ name: 'system_config', present: true, owned: true, safe: true,
        fingerprint: OFFLINE_CATALOG_VERSIONS.fresh.system_config }))];
    const result = await auditReleaseProtocols(f.db);
    expect(result.protocols.offlinePredecessor.find(row => row.name === 'user')).toMatchObject({ present: true, safe: false, fingerprintMatches: false });
    expect(result.protocols.offlinePredecessor.find(row => row.name === 'system_config')).toMatchObject({ present: false, fingerprintMatches: false });
    expect(result.protocols.offlinePredecessor.find(row => row.name === 'member_right')).toMatchObject({ present: false, fingerprintMatches: false });
    expect(JSON.stringify(result)).not.toContain('unreviewed');
  });
  it('rejects index inventory overflow and does not run the later predecessor snapshot', async () => {
    const f = fixture(); f.rows[6] = Array.from({ length: 101 }, () => ({}));
    await expect(auditReleaseProtocols(f.db)).rejects.toThrow('budget exceeded');
    expect(mocks.predecessor).not.toHaveBeenCalled();
  });
  it('identifies only the independently reviewed pre-index baseline without approving installation', async () => {
    const f = fixture();
    f.rows[5] = Object.entries(RELEASE_PRE_INDEX_HASHES).map(([name, fingerprint]) =>
      ({ name, fingerprint, present: true, owned: true, safe: true }));
    const result = await auditReleaseProtocols(f.db);
    expect(result.protocols.offlinePredecessor.filter(row => row.reviewedPreIndexMatches).map(row => row.name).sort())
      .toEqual(Object.keys(RELEASE_PRE_INDEX_HASHES).sort());
    expect(result.protocols.offlinePredecessor.every(row => !row.fingerprintMatches)).toBe(true);
    expect(result.ready).toBe(false);
  });
  it('propagates a failed separate predecessor snapshot instead of returning a partial success', async () => {
    mocks.predecessor.mockRejectedValue(Error('predecessor unavailable'));
    await expect(auditReleaseProtocols(fixture().db)).rejects.toThrow('predecessor unavailable');
  });
});
