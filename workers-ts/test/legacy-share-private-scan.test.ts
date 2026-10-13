import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import { deliveryService, storeOrder, storeOrderCartInfo, storeOrderRefund, storePink, storeService, systemStoreStaff, user } from '@/models/schema';
import { assertLegacyPrivateScanViewer, readLegacyPrivateScanTarget } from '@/services/other/LegacyPrivateScanTarget';
import { financePostgres } from './helpers/financePostgres';
import { afterFirstPrivateScanSnapshot, MEMBER_CODE, ORDER_CODE, PRIVATE_SCAN_READ_ENV, PRIVATE_SCAN_TABLES, seedPrivateScan, sqlErrorCode, type PrivateScanFixture } from './helpers/legacyPrivateScanFixture';

describe('legacy share private scan SQL authority', () => {
  let f: PrivateScanFixture;
  beforeAll(async () => { f = await financePostgres(PRIVATE_SCAN_TABLES, { namespace: 'public' }); });
  beforeEach(async () => { await seedPrivateScan(f); });
  afterAll(async () => { await f?.close(); });
  const container = () => createContainerFromDb(f.db);

  it('returns actual owner member and physical order descriptors, preserving leading zero codes', async () => {
    expect(await readLegacyPrivateScanTarget(container(), 11, 90)).toEqual({ kind: 'member', code: MEMBER_CODE, uid: 11 });
    expect(await readLegacyPrivateScanTarget(container(), 11, 91, 'owned-pickup-1')).toEqual({
      kind: 'order', code: ORDER_CODE, uid: 11, physicalOrderId: 401, orderNo: 'owned-pickup-1',
    });
  });
  it('never allocates a missing member code and requires the actual migrated unique index', async () => {
    await f.db.update(user).set({ barCode: '' }).where(eq(user.uid, 11));
    await expect(readLegacyPrivateScanTarget(container(), 11, 90)).rejects.toThrow(/先生成会员码/);
    expect((await f.db.select({ code: user.barCode }).from(user).where(eq(user.uid, 11)))[0].code).toBe('');
    await f.exec('DROP INDEX public.user_bar_code_uq');
    await f.db.update(user).set({ barCode: MEMBER_CODE }).where(eq(user.uid, 11));
    await expect(readLegacyPrivateScanTarget(container(), 11, 90)).rejects.toThrow(/索引未就绪/);
  });
  it.each(['001122334455', ' undefined', 'undefined', 'x\n'])('rejects member namespace collision/malformed historic code %j', async code => {
    await f.db.update(user).set({ barCode: code }).where(eq(user.uid, 11));
    await expect(readLegacyPrivateScanTarget(container(), 11, 90)).rejects.toThrow(/会员码格式/);
  });
  it('preserves valid legacy 32-character codes while the real schema rejects oversized persisted values', async () => {
    const code = 'x'.repeat(32);
    await f.db.update(user).set({ barCode: code }).where(eq(user.uid, 11));
    expect((await readLegacyPrivateScanTarget(container(), 11, 90)).code).toBe(code);
    const failure = await f.db.update(user).set({ barCode: 'x'.repeat(33) }).where(eq(user.uid, 11)).then(() => undefined, error => error);
    expect(sqlErrorCode(failure)).toBe('22001');
  });
  it.each([0, -1, 2147483648, NaN])('rejects guests and invalid uid %s before returning private data', async uid => {
    await expect(readLegacyPrivateScanTarget(container(), uid, 90)).rejects.toThrow(/请登录/);
  });
  it('rejects cross-owner lookup and does not accept numeric physical ID as business number', async () => {
    await expect(readLegacyPrivateScanTarget(container(), 11, 91, 'foreign-pickup-2')).rejects.toThrow(/本人订单/);
    await expect(readLegacyPrivateScanTarget(container(), 11, 91, '401')).rejects.toThrow(/本人订单/);
  });
  it.each(['0', '../owned-pickup-1', ' owned-pickup-1', 'x'.repeat(33)])('rejects malformed/sentinel order number %j', async orderNo => {
    await expect(readLegacyPrivateScanTarget(container(), 11, 91, orderNo)).rejects.toThrow();
  });
  it.each([{ paid: 0 }, { status: 3 }, { refundStatus: 1 }, { pid: -1 }, { supplierAllocationStatus: 1 }, { isDel: 1 }, { isSystemDel: 1 }])('rejects current nonredeemable order state %j', async state => {
    await f.db.update(storeOrder).set(state).where(eq(storeOrder.id, 401));
    await expect(readLegacyPrivateScanTarget(container(), 11, 91, 'owned-pickup-1')).rejects.toThrow();
  });
  it('rejects live duplicate code, pending refund, uncompleted pink and forged store-zero cashier origin', async () => {
    await f.db.update(storeOrder).set({ verifyCode: ORDER_CODE }).where(eq(storeOrder.id, 402));
    await expect(readLegacyPrivateScanTarget(container(), 11, 91, 'owned-pickup-1')).rejects.toThrow(/绑定不唯一/);
    await seedPrivateScan(f);
    await f.db.insert(storeOrderRefund).values({ id: 1, storeOrderId: 401, uid: 11, refundType: 1 });
    await expect(readLegacyPrivateScanTarget(container(), 11, 91, 'owned-pickup-1')).rejects.toThrow(/待处理售后/);
    await seedPrivateScan(f);
    await f.db.update(storeOrder).set({ type: 3, pinkId: 1 }).where(eq(storeOrder.id, 401));
    await f.db.insert(storePink).values({ id: 1, status: 1 });
    await expect(readLegacyPrivateScanTarget(container(), 11, 91, 'owned-pickup-1')).rejects.toThrow(/拼团尚未成功/);
    await seedPrivateScan(f);
    await f.db.update(storeOrder).set({ storeId: 0, productType: 4, staffId: 301, isChannel: 2 }).where(eq(storeOrder.id, 401));
    await expect(readLegacyPrivateScanTarget(container(), 11, 91, 'owned-pickup-1')).rejects.toThrow(/真实收银次卡来源/);
  });
  it.each([{ writeSurplusTimes: 0 }, { writeEnd: 1 }, { writeStart: 2147483647 }, { uid: 12 }])('rejects unavailable/foreign cart fact %j', async state => {
    await f.db.update(storeOrderCartInfo).set(state).where(eq(storeOrderCartInfo.id, 501));
    await expect(readLegacyPrivateScanTarget(container(), 11, 91, 'owned-pickup-1')).rejects.toThrow();
  });
  it('requires active owner and refuses a changed owner code after snapshot commit', async () => {
    const observed = afterFirstPrivateScanSnapshot(f.db, () => f.db.update(user).set({ barCode: 'changed-member' }).where(eq(user.uid, 11)));
    await expect(readLegacyPrivateScanTarget(createContainerFromDb(observed), 11, 90)).rejects.toThrow(/对象已变化/);
    await f.db.update(user).set({ status: 0 }).where(eq(user.uid, 11));
    await expect(readLegacyPrivateScanTarget(container(), 11, 91, 'owned-pickup-1')).rejects.toThrow(/账号/);
  });
  it('allows owner or genuine matching store/delivery preview and denies ordinary accounts/cross scopes', async () => {
    const pickup = await readLegacyPrivateScanTarget(container(), 11, 91, 'owned-pickup-1');
    for (const uid of [11, 101, 301]) await expect(assertLegacyPrivateScanViewer(container(), uid, pickup, PRIVATE_SCAN_READ_ENV)).resolves.toBe(uid === 11 ? 'owner' : uid === 101 ? 'staff' : 'customer');
    for (const uid of [0, 12, 102, 201, 302]) await expect(assertLegacyPrivateScanViewer(container(), uid, pickup, PRIVATE_SCAN_READ_ENV)).rejects.toThrow();
    const delivery = await readLegacyPrivateScanTarget(container(), 11, 91, 'owned-delivery');
    await expect(assertLegacyPrivateScanViewer(container(), 201, delivery, PRIVATE_SCAN_READ_ENV)).resolves.toBe('delivery');
    await expect(assertLegacyPrivateScanViewer(container(), 202, delivery, PRIVATE_SCAN_READ_ENV)).rejects.toThrow();
  });
  it('requires a nonempty genuine scoped member preview, not merely some staff/delivery role', async () => {
    const target = await readLegacyPrivateScanTarget(container(), 11, 90);
    for (const uid of [11, 101, 201, 301]) await expect(assertLegacyPrivateScanViewer(container(), uid, target, PRIVATE_SCAN_READ_ENV)).resolves.toBe(uid === 11 ? 'owner' : uid === 101 ? 'staff' : uid === 201 ? 'delivery' : 'customer');
    for (const uid of [12, 102, 202, 302]) await expect(assertLegacyPrivateScanViewer(container(), uid, target, PRIVATE_SCAN_READ_ENV)).rejects.toThrow();
  });
  it('rejects duplicated or revoked current role and forged/stale target binding', async () => {
    const target = await readLegacyPrivateScanTarget(container(), 11, 91, 'owned-pickup-1');
    await f.db.insert(systemStoreStaff).values({ id: 3, uid: 101, storeId: 1, status: 1, verifyStatus: 1 });
    await expect(assertLegacyPrivateScanViewer(container(), 101, target, PRIVATE_SCAN_READ_ENV)).rejects.toThrow(/无权/);
    await f.db.insert(storeService).values({ id: 3, uid: 301, accountStatus: 1, customer: 1 });
    await expect(assertLegacyPrivateScanViewer(container(), 301, target, PRIVATE_SCAN_READ_ENV)).rejects.toThrow(/无权/);
    await expect(assertLegacyPrivateScanViewer(container(), 11, { ...target, code: '998877665544' }, PRIVATE_SCAN_READ_ENV)).rejects.toThrow(/对象已变化/);
  });
  it('uses persisted presale dispatch facts without acquiring a lock in the read-only snapshot', async () => {
    await f.db.update(storeOrder).set({ type: 6 }).where(eq(storeOrder.id, 401));
    const snapshot = (endsAt: number) => JSON.stringify({ sku: { price: '10.00' }, presale: {
      version: 'presale-full-payment-v1', productId: 1, startsAt: 0, endsAt,
      shippingDaysAfterEnd: 0, paidMemberOnly: false, perOrderLimit: null,
    } });
    await f.db.update(storeOrderCartInfo).set({ productId: 1, cartInfo: snapshot(2147483647) }).where(eq(storeOrderCartInfo.id, 501));
    await expect(readLegacyPrivateScanTarget(container(), 11, 91, 'owned-pickup-1')).rejects.toThrow(/预售活动尚未结束/);
    await f.db.update(storeOrderCartInfo).set({ cartInfo: snapshot(1) }).where(eq(storeOrderCartInfo.id, 501));
    expect((await readLegacyPrivateScanTarget(container(), 11, 91, 'owned-pickup-1')).code).toBe(ORDER_CODE);
  });
  it('rechecks genuine current viewer role after first read snapshot', async () => {
    const target = await readLegacyPrivateScanTarget(container(), 11, 91, 'owned-delivery');
    const observed = afterFirstPrivateScanSnapshot(f.db, () => f.db.update(deliveryService).set({ status: 0 }).where(eq(deliveryService.uid, 201)));
    await expect(assertLegacyPrivateScanViewer(createContainerFromDb(observed), 201, target, PRIVATE_SCAN_READ_ENV)).rejects.toThrow(/无权/);
  });
  it('rejects a replaced SQL staff identity even when the same uid is still an eligible staff realm', async () => {
    const target = await readLegacyPrivateScanTarget(container(), 11, 91, 'owned-pickup-1');
    const observed = afterFirstPrivateScanSnapshot(f.db, () => f.db.update(systemStoreStaff).set({ id: 9 }).where(eq(systemStoreStaff.id, 1)));
    await expect(assertLegacyPrivateScanViewer(createContainerFromDb(observed), 101, target, PRIVATE_SCAN_READ_ENV)).rejects.toThrow(/读取资格已变化/);
    await expect(assertLegacyPrivateScanViewer(container(), 101, target, PRIVATE_SCAN_READ_ENV)).resolves.toBe('staff');
  });
});
