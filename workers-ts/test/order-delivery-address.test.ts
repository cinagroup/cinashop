import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { StoreOrderCreateService, type CreateOrderParams } from '../src/services/order/StoreOrderCreateService';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { AdminAssistedOrderService } from '../src/services/admin/AdminAssistedOrderService';
import { cityArea, userAddress, storeCart, storeProduct, storeOrderCartInfo, storeOrderStatus, printDocument, systemStore } from '../src/models/schema';
import { registerDeliveryAddressAuthTests } from './helpers/orderDeliveryAddressAuth';

registerDeliveryAddressAuthTests();

describe('delivery address authority at the actual order core', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([storeOrderCartInfo, storeOrderStatus, printDocument]);
    f.app.post('/api/order/create/:key', orderCreate);
    // Only the sequence response is synthetic; controller, core and SQL are real.
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'local-sequence', get: () => ({ fetch: async () => new Response('address_http') }) } });
    for (const key of Object.keys(f.config)) f.config[key] = '0';
    await f.db.update(systemStore).set({ isStore: 1 }).where(eq(systemStore.id, 1));
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const input = () => ({ uid: 11, key: 'address_core', cartIds: [1], shippingType: 1, addressId: 11,
    realName: '本地地址甲', userPhone: '00000000000', province: '本地省', cityId: 101,
    userAddress: '本地省 测试甲市 测试甲区 隔离样本一号', userIp: '127.0.0.1' });
  const create = (params: CreateOrderParams = input(), change?: () => Promise<unknown>) => StoreOrderCreateService.createWithRuntime(f.container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => { await change?.(); return params.key; } }, params);

  it('rejects physical creation without a selected saved address and without writes', async () => {
    const before = await f.snapshot();
    await expect(create({ ...input(), addressId: 0, cityId: 0, province: '', userAddress: '' })).rejects.toThrow('收货地址');
    expect(await f.snapshot()).toEqual(before);
  });
  it('ignores client overrides and uses the owned saved address for both pricing and order fields', async () => {
    await create({ ...input(), cityId: 102, province: '客户端省', realName: '客户端姓名', userPhone: '123', userAddress: '客户端地址' });
    expect((await f.snapshot()).orders[0]).toMatchObject({ realName: '本地地址甲', userPhone: '00000000000',
      province: '本地省', userAddress: '本地省 测试甲市 测试甲区 隔离样本一号', payPostage: '6.00' });
  });
  it.each(['missing', 'deleted', 'foreign', 'incomplete', 'region'] as const)('rejects a %s saved address', async kind => {
    if (kind === 'missing') await f.db.delete(userAddress).where(eq(userAddress.id, 11));
    if (kind === 'deleted') await f.db.update(userAddress).set({ isDel: 1 }).where(eq(userAddress.id, 11));
    if (kind === 'foreign') await f.db.update(userAddress).set({ uid: 22 }).where(eq(userAddress.id, 11));
    if (kind === 'incomplete') await f.db.update(userAddress).set({ district: '' }).where(eq(userAddress.id, 11));
    if (kind === 'region') await f.db.update(userAddress).set({ cityId: 102 }).where(eq(userAddress.id, 11));
    const before = await f.snapshot(); await expect(create()).rejects.toThrow('收货地址'); expect(await f.snapshot()).toEqual(before);
  });
  it('rejects address changes after pricing and rolls back the actual order', async () => {
    const before = await f.snapshot();
    await expect(create(input(), async () => { await f.db.update(userAddress).set({ detail: '已变更' }).where(eq(userAddress.id, 11)); })).rejects.toThrow('收货地址');
    expect(await f.snapshot()).toEqual(before);
  });
  it('retains an existing order when its source address is later deleted', async () => {
    const result = await create(); await f.db.update(userAddress).set({ isDel: 1 }).where(eq(userAddress.id, 11));
    const before = await f.snapshot(); expect(await create()).toEqual(result); expect(await f.snapshot()).toEqual(before);
  });
  it('allows address-free physical preview before selection but not creation', async () => {
    expect((await new StoreOrderCreateService(f.container, f.env).quoteOrder({ uid: 11, cartIds: [1], shippingType: 1 })).payPostageCents).toBe(0);
    expect((await f.snapshot()).orders).toEqual([]);
  });
  it('preserves virtual address-free creation', async () => {
    await f.db.update(storeProduct).set({ productType: 2 }); await f.db.update(storeCart).set({ productType: 2 });
    await create({ ...input(), addressId: 0, cityId: 0, province: '', userAddress: '' });
    expect((await f.snapshot()).orders[0]).toMatchObject({ productType: 2, payPostage: '0.00' });
  });
  const request = async (body: Record<string, unknown>, path = '/api/order/create/address_http') => {
    const response = await f.app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(body) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: { orderId?: string } }>;
  };
  it.each(['oops', -1, 1.5, null, {}, [], true, '1e1', ' 11'].map(addressId => ({ addressId })))('rejects malformed HTTP address ID $addressId before writes', async ({ addressId }) => {
    const before = await f.snapshot(); expect((await request({ cartIds: [1], addressId })).status).toBe(400); expect(await f.snapshot()).toEqual(before);
  });
  it('rejects conflicting address aliases in creation and preview', async () => {
    for (const path of ['/api/order/create/address_http', '/api/order/confirm']) {
      expect(await request({ cartIds: [1], addressId: 11, address_id: 12 }, path)).toMatchObject({ status: 400, msg: expect.stringContaining('冲突') });
    }
    expect((await f.snapshot()).orders).toEqual([]);
  });
  it('creates through HTTP from the saved address, then replays after address deletion', async () => {
    const body = { cartIds: [1], address_id: '11', cityId: 102, userAddress: '客户端地址', realName: '客户端姓名' };
    expect((await request(body)).status).toBe(200);
    expect((await f.snapshot()).orders[0]).toMatchObject({ realName: '本地地址甲', payPostage: '6.00' });
    await f.db.update(userAddress).set({ isDel: 1 }).where(eq(userAddress.id, 11));
    const before = await f.snapshot(); expect((await request(body)).status).toBe(200); expect(await f.snapshot()).toEqual(before);
  });
  it('allows physical pickup without consulting an invalid delivery address', async () => {
    await create({ ...input(), shippingType: 2, storeId: 1, addressId: 999 });
    expect((await f.snapshot()).orders[0]).toMatchObject({ shippingType: 2, realName: '本地地址甲', userAddress: '', payPostage: '0.00' });
  });
  it('requires pickup contacts in the shared core', async () => {
    await expect(create({ ...input(), shippingType: 2, storeId: 1, realName: '', userPhone: '' })).rejects.toThrow('姓名和电话');
  });
  it.each([100, 101])('enforces the persisted address limit at %i characters without truncation', async length => {
    const prefix = '本地省 测试甲市 测试甲区 ';
    const detail = '址'.repeat(length - prefix.length);
    await f.db.update(userAddress).set({ detail }).where(eq(userAddress.id, 11));
    const before = await f.snapshot();
    if (length === 100) {
      await create();
      expect((await f.snapshot()).orders[0].userAddress).toBe(prefix + detail);
    } else {
      await expect(create()).rejects.toThrow('收货地址长度');
      expect(await f.snapshot()).toEqual(before);
    }
  });
  it('keeps order contact capacity for pickup without applying the narrower address-book phone limit', async () => {
    await create({ ...input(), shippingType: 2, storeId: 1, addressId: 0, userPhone: '1'.repeat(18) });
    expect((await f.snapshot()).orders[0].userPhone).toBe('1'.repeat(18));
  });
  it('allows default metadata changes without changing delivery fields or caller input', async () => {
    const params = input(), original = structuredClone(params);
    await create(params, async () => { await f.db.update(userAddress).set({ isDefault: 0 }).where(eq(userAddress.id, 11)); });
    expect(params).toEqual(original);
    expect((await f.snapshot()).orders[0].userAddress).toBe(original.userAddress);
  });
  it.each(['name', 'path', 'parent'] as const)('rejects a changed region %s after pricing and rolls back order writes', async kind => {
    const before = await f.snapshot();
    await expect(create(input(), async () => {
      await f.db.update(cityArea).set(kind === 'name' ? { name: '变更后的区' } : kind === 'path' ? { path: '/' } : { parentId: 903 }).where(eq(cityArea.id, 101));
    })).rejects.toThrow('收货地址区域');
    expect(await f.snapshot()).toEqual(before);
  });
  it('does not permit a regular order to use an assisted manual address', async () => {
    const before = await f.snapshot();
    await expect(create({ ...input(), addressId: 0, manualAddress: { realName: '手填' } })).rejects.toThrow('来源冲突');
    expect(await f.snapshot()).toEqual(before);
  });
  it('preserves complete manual delivery for an exact assisted cart owner', async () => {
    await f.db.update(storeCart).set({ staffId: 7 });
    await create({ ...input(), addressId: 0, assisted: { adminId: 7, touristUid: '' }, manualAddress: {
      realName: '手填收货人', phone: '00000000000', province: '本地省', city: '测试乙市', district: '测试乙区', cityId: 102, detail: '手填详细地址',
    } });
    expect((await f.snapshot()).orders[0]).toMatchObject({ staffId: 7, isChannel: 2, realName: '手填收货人', payPostage: '12.00' });
  });
  it.each(['saved', 'manual', 'guest', 'pickup', 'virtual'] as const)('uses the actual assisted confirm/computed/create path for %s orders', async kind => {
    const uid = kind === 'guest' ? 0 : 11;
    await f.db.update(storeCart).set({ uid, staffId: 7, touristUid: uid === 0 ? 'guest_address' : '' });
    if (kind === 'virtual') {
      await f.db.update(storeProduct).set({ productType: 2 });
      await f.db.update(storeCart).set({ productType: 2 });
      await f.db.update(userAddress).set({ isDel: 1 });
    }
    const service = new AdminAssistedOrderService(f.container, f.env);
    const body = { cartId: [1], new: 1, shipping_type: kind === 'pickup' ? 2 : 1,
      store_id: kind === 'pickup' ? 1 : 0, real_name: '自提联系人', phone: '00000000000',
      ...(kind === 'saved' ? { addressId: 11 } : {}),
      ...(['manual', 'guest'].includes(kind) ? { manualAddress: {
        realName: '手填收货人', phone: '00000000000', province: '本地省', city: '测试乙市',
        district: '测试乙区', cityId: 102, detail: '手填详细地址',
      } } : {}),
    };
    const before = await f.snapshot();
    const confirmed = await service.confirm(7, uid, body);
    expect(confirmed.orderKey).toMatch(/^[a-f0-9]{32}$/);
    expect((await service.computed(7, uid, confirmed.orderKey, body)).extended).toBe(false);
    expect(await f.snapshot()).toEqual(before);
    const created = await service.create(7, uid, confirmed.orderKey, body, '127.0.0.1');
    expect(created.extended).toBe(false);
    expect((await f.snapshot()).orders[0]).toMatchObject({ uid, staffId: 7, isChannel: 2,
      payPostage: ['manual', 'guest'].includes(kind) ? '12.00' : kind === 'saved' ? '6.00' : '0.00' });
    await f.db.update(userAddress).set({ isDel: 1 });
    const after = await f.snapshot();
    expect((await service.create(7, uid, confirmed.orderKey, { ...body, addressId: 'invalid' }, '127.0.0.1')).extended).toBe(true);
    expect(await f.snapshot()).toEqual(after);
  });
  it.each(['foreign', 'guest_saved', 'conflict', 'incomplete', 'null_camel', 'null_snake'] as const)('rejects an invalid assisted %s address before storing a quote', async kind => {
    const uid = kind === 'guest_saved' ? 0 : 11;
    await f.db.update(storeCart).set({ uid, staffId: 7, touristUid: uid === 0 ? 'guest_address' : '' });
    if (kind === 'foreign') await f.db.update(userAddress).set({ uid: 22 });
    const before = await f.snapshot();
    const body = { cartId: [1], new: 1, addressId: kind === 'incomplete' ? 0 : 11,
      ...(['conflict', 'incomplete'].includes(kind) ? { manualAddress: { detail: '不完整' } } : {}),
      ...(kind === 'null_camel' ? { manualAddress: null } : {}),
      ...(kind === 'null_snake' ? { manual_address: null } : {}),
    };
    await expect(new AdminAssistedOrderService(f.container, f.env).confirm(7, uid, body)).rejects.toThrow('收货地址');
    expect(f.writes).toEqual([]);
    expect(await f.snapshot()).toEqual(before);
  });
});
