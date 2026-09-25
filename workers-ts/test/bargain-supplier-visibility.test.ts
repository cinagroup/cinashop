import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ActivityJoinService } from '../src/services/activity/ActivityJoinService';
import { SupplierProductManagementService } from '../src/services/supplier/SupplierProductManagementService';
import { storeBargain, storeBargainUser, storeProduct, storeProductRelation, user } from '../src/models/schema';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';

describe('supplier source visibility contract for bargain admission on isolated SQL', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;

  beforeEach(async () => {
    f = await createBargainSelectionFixture([storeProductRelation]);
    await f.db.update(storeProduct).set({ type: 2, relationId: 7, isShow: 1, isVerify: 1 })
      .where(eq(storeProduct.id, 70));
    await f.db.update(storeBargain).set({ people: 1 }).where(eq(storeBargain.id, 40));
    await f.db.update(storeBargainUser).set({ price: '0.00', status: 1 }).where(eq(storeBargainUser.id, 81));
    await f.db.insert(user).values({ uid: 30, account: 'visibility-contract-owner', nickname: '可见性契约参与者' });
  }, 30_000);

  afterEach(async () => { await f?.close(); });

  const join = () => new ActivityJoinService(f.container);
  const supplier = () => new SupplierProductManagementService(f.container);

  it('rejects fresh start and help after supplier hide while keeping old participation history', async () => {
    await supplier().setProductShow(7, 70, 0);
    const before = await f.snapshot();
    expect(before.products.find(row => row.id === 70)).toMatchObject({ isShow: 0, isVerify: 1, isDel: 0 });
    await expect(join().startBargain(30, 40)).rejects.toThrow('砍价关联商品不可见或未审核');
    await expect(join().helpBargain(11, 81)).rejects.toThrow('砍价关联商品不可见或未审核');
    expect(await f.snapshot()).toEqual(before);
    expect(before.participations.some(row => row.id === 81)).toBe(true);
    expect(before.helps).toHaveLength(0);
  });

  it('rejects fresh start and help when supplier source review is revoked', async () => {
    await f.db.update(storeProduct).set({ isVerify: 0 }).where(eq(storeProduct.id, 70));
    const before = await f.snapshot();
    await expect(join().startBargain(30, 40)).rejects.toThrow('砍价关联商品不可见或未审核');
    await expect(join().helpBargain(11, 81)).rejects.toThrow('砍价关联商品不可见或未审核');
    expect(await f.snapshot()).toEqual(before);
  });

  it('allows fresh start and help after the approved source is shown again', async () => {
    await supplier().setProductShow(7, 70, 0);
    await supplier().setProductShow(7, 70, 1);
    await expect(join().startBargain(30, 40)).resolves.toMatchObject({ id: expect.any(Number) });
    await expect(join().helpBargain(11, 81)).resolves.toEqual({ price: '8.00' });
    const after = await f.snapshot();
    expect(after.products.find(row => row.id === 70)).toMatchObject({ isShow: 1, isVerify: 1, isDel: 0 });
    expect(after.participations.filter(row => row.uid === 30)).toMatchObject([{ uid: 30, bargainId: 40, status: 1 }]);
    expect(after.helps.filter(row => row.bargainUserId === 81)).toMatchObject([{ uid: 11, bargainUserId: 81, price: '8.00' }]);
  });
});
