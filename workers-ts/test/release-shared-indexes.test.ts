import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { offlinePredecessorSchemaSql } from './helpers/offlinePredecessorSchema';
import { OFFLINE_BARCODE_CATALOG_VERSIONS, OFFLINE_CATALOG_SQL, OFFLINE_CATALOG_VERSIONS } from '../src/migrations/offlineOrderCatalog';
import { RELEASE_SHARED_INDEXES, RELEASE_PRE_INDEX_HASHES, inspectReleaseSharedIndexes, installReleaseSharedIndexes } from '../src/migrations/releaseSharedIndexes';
import { runMemberBarcodeIndex } from '../src/migrations/runMemberBarcodeIndex';

describe('canonical PG16 release shared index predecessor', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  afterEach(async () => { await f?.close(); }, 30000);
  it('derives the exact legacy shape from canonical DDL without learning production fingerprints', async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Owned native PG16 required');
    f = await sequenceRunnerDatabase(); await f.exec(await offlinePredecessorSchemaSql());
    // This predecessor contract predates the member-code index, whereas fresh
    // ORM DDL now creates it. Recreate the exact historical stage explicitly.
    await f.exec('DROP INDEX public.user_bar_code_uq');
    const wanted = Object.keys(RELEASE_SHARED_INDEXES);
    const inspect = async () => (await f.db.execute(sql.raw(OFFLINE_CATALOG_SQL))).filter(row => wanted.includes(String(row.name)));
    const before = await inspect();
    for (const row of before) expect(row).toMatchObject({ present: true, owned: true, safe: true,
      fingerprint: OFFLINE_CATALOG_VERSIONS.fresh[String(row.name)] });
    for (const indexes of Object.values(RELEASE_SHARED_INDEXES))
      for (const name of Object.keys(indexes)) await f.exec('DROP INDEX public."' + name + '"');
    expect(Object.fromEntries((await inspect()).map(row => [row.name, row.fingerprint]))).toEqual(RELEASE_PRE_INDEX_HASHES);
    expect((await inspectReleaseSharedIndexes(f.db)).tables.every(row => row.state === 'missing-reviewed-indexes')).toBe(true);
    expect(await installReleaseSharedIndexes(f.db)).toMatchObject({ ready: true, created: 19 });
    expect(await inspect()).toEqual(before);
    expect(await installReleaseSharedIndexes(f.db)).toMatchObject({ ready: true, created: 0 });
    await runMemberBarcodeIndex(f.db);
    expect((await inspect()).find(row => row.name === 'user')?.fingerprint)
      .toBe(OFFLINE_BARCODE_CATALOG_VERSIONS.fresh.user);
    expect((await inspectReleaseSharedIndexes(f.db)).tables.every(row => row.state === 'ready')).toBe(true);
    expect(await installReleaseSharedIndexes(f.db)).toMatchObject({ ready: true, created: 0 });
    await f.exec('ALTER TABLE public.system_config ADD COLUMN unexpected text');
    await expect(installReleaseSharedIndexes(f.db)).rejects.toThrow('drift');
  }, 60000);
});
