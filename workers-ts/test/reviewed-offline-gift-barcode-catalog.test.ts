import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../src/lib/di';
import { OFFLINE_BARCODE_CATALOG_VERSIONS, OFFLINE_CATALOG_VERSIONS } from '../src/migrations/offlineOrderCatalog';
import { inspectReviewedOfflineGiftCatalog } from '../src/migrations/reviewedOfflineGiftCatalog';

const gift = vi.hoisted(() => vi.fn());
vi.mock('../src/migrations/orderPromotionGiftReceipt', () => ({ inspectOrderPromotionGiftReceiptCatalog: gift }));

function rows(version = OFFLINE_BARCODE_CATALOG_VERSIONS.v1) {
  return Object.entries(version).map(([name, fingerprint]) => ({ name, fingerprint, present: true, safe: true, owned: true }));
}
function reader(original: ReturnType<typeof rows>, absent: boolean, normalized = original) {
  const execute = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce([{ absent }]).mockResolvedValueOnce(normalized);
  return { execute, tx: { execute } as unknown as Pick<DbClient, 'execute'> };
}

describe('offline gift compatibility after the reviewed member barcode index', () => {
  beforeEach(() => gift.mockReset());

  it.each([OFFLINE_CATALOG_VERSIONS.v1, OFFLINE_BARCODE_CATALOG_VERSIONS.v1])('accepts the complete reviewed legacy or barcode catalog', async version => {
    const f = reader(rows(version), true);
    expect(await inspectReviewedOfflineGiftCatalog(f.tx, { requireOwner: true })).toEqual({ state: 'v1', rows: rows(version) });
    expect(gift).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it('accepts the barcode catalog with the gift index only after exact gift readiness', async () => {
    const normalized = rows(), original = normalized.map(row => row.name === 'user_bill' ? { ...row, fingerprint: 'gift-index-shape' } : row);
    const f = reader(original, false, normalized);
    const options = { requireOwner: true, maintenance: 'fixture_owner', runtime: { app: 'fixture_app', admin: 'fixture_admin' } };
    gift.mockResolvedValue({ ready: true });
    expect(await inspectReviewedOfflineGiftCatalog(f.tx, options)).toEqual({ state: 'v1-gift-index', rows: normalized });
    expect(gift).toHaveBeenCalledWith(f.tx, options.maintenance, options.runtime);
    expect(f.execute).toHaveBeenCalledTimes(3);
  });

  it('refuses to mask a gift index when its complete protocol is not ready', async () => {
    const f = reader(rows(), false);
    gift.mockResolvedValue({ ready: false });
    expect(await inspectReviewedOfflineGiftCatalog(f.tx)).toEqual({ state: 'drift', rows: rows() });
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it.each(['fingerprint', 'owner', 'missing', 'duplicate'] as const)('rejects %s drift even when gift readiness is true', async mutation => {
    const changed = rows();
    if (mutation === 'fingerprint') changed.find(row => row.name === 'user')!.fingerprint = 'unreviewed';
    if (mutation === 'owner') changed.find(row => row.name === 'user')!.owned = false;
    if (mutation === 'missing') changed.pop();
    if (mutation === 'duplicate') changed[changed.length - 1] = { ...changed[0] };
    const f = reader(changed, true, changed);
    gift.mockResolvedValue({ ready: true });
    expect(await inspectReviewedOfflineGiftCatalog(f.tx, { requireOwner: true })).toEqual({ state: 'drift', rows: changed });
  });
});
