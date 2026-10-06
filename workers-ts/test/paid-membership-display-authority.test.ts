import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { cloneUserCenterDesign } from '../../view/common/userCenterDesign';
import type { Env } from '../src/env';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { agentLevel, divisionApply, promoterApply, storeCouponUser, storeOrder, storeOrderRefund,
  storeProductLog, storeService, systemConfig, systemDise, systemGroup, systemGroupData,
  systemMessage, systemUserLevel, user, userBill, userBrokerage, userExtract, userLevel,
  userMessage, userMoney, userRelation, wechatUser, systemStore, systemStoreStaff, deliveryService } from '../src/models/schema';
import { UserProfileService } from '../src/services/user/UserProfileService';
import { PublicCatalogService } from '../src/services/product/PublicCatalogService';
import { financePostgres } from './helpers/financePostgres';

// Full personal-home and menu consumers execute real SQL on a disposable
// column fixture, including their unchanged finance/order/message projections.
// This does not certify native roles, HTTP authentication or browser rendering.
describe('personal-home and membership-menu SQL flag authority', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let container: Container;
  let profile: UserProfileService;
  let catalogue: PublicCatalogService;
  let cachedFlag = '1';
  const vipUrl = '/pages/annex/vip_paid/index', otherUrl = '/pages/index/index';
  const menuItem = (name: string, url: string, type: 1 | 2) => ({ sourceId: null, name,
    pic: '/images/owned-membership.png', url, type });
  const design = () => {
    const value = cloneUserCenterDesign();
    value.menu.list = [menuItem('Member', vipUrl, 1),
      menuItem('Balance', '/pages/users/user_money/index', 1), menuItem('Browse', otherUrl, 1)];
    value.merMenu.list = [menuItem('Merchant member', vipUrl, 2)];
    value.poster.list = [{ sourceId: null, name: 'Unrelated banner', pic: '/images/owned-banner.png', url: otherUrl }];
    return value;
  };
  const get = vi.fn(async (key: string) => key === 'cfg_member_card_status' ? cachedFlag
    : key === 'cfg_balance_func_status' ? '1' : '0');
  const put = vi.fn(async () => undefined);
  const setFlag = async (value: string | null) => {
    await f.db.delete(systemConfig);
    if (value !== null) await f.db.insert(systemConfig).values({ menuName: 'member_card_status', value });
    // personalHome retains its existing KV interpretation; the current menu
    // independently requires its actual SQL balance authority.
    await f.db.insert(systemConfig).values({ menuName: 'balance_func_status', value: '1' });
  };
  const state = async () => ({ users: await f.db.select().from(user),
    configs: await f.db.select().from(systemConfig).orderBy(systemConfig.id),
    groups: await f.db.select().from(systemGroupData), diy: await f.db.select().from(systemDise),
    orders: await f.db.select().from(storeOrder), bills: await f.db.select().from(userBill) });
  const project = async (personalEnabled: boolean, menuEnabled: boolean, uid = 11) => {
    const before = await state();
    if (uid) {
      expect(await profile.personalHome(uid)).toMatchObject({ is_open_member: personalEnabled,
        svip_open: personalEnabled, pay_vip_status: true, now_money: '100.00', balance_func_status: 1 });
    }
    const menu = await catalogue.menuUser(uid);
    const publicItem = ({ sourceId: _sourceId, ...item }: ReturnType<typeof design>['menu']['list'][number]) => item;
    const fixture = design();
    const personal = fixture.menu.list.filter(item => menuEnabled || item.url !== vipUrl).map(publicItem);
    const merchant = menuEnabled ? fixture.merMenu.list.map(publicItem) : [];
    const poster = fixture.poster.list.map(({ sourceId: _sourceId, ...item }) => item);
    expect(menu.capabilities).toMatchObject({ paid_member: menuEnabled, balance: true });
    expect(menu.routine_my_menus).toEqual([...personal, ...merchant]);
    expect(menu.diy_data).toEqual({ ...fixture, menu: { ...fixture.menu, list: personal },
      merMenu: { ...fixture.merMenu, list: merchant }, poster: { ...fixture.poster, list: poster } });
    expect(menu.routine_my_banner).toEqual(poster);
    expect(JSON.stringify(menu)).not.toContain('sourceId');
    const designState = menu.user_center_design_state;
    if (!designState || typeof designState !== 'object' || Array.isArray(designState)
      || !('issues' in designState) || !Array.isArray(designState.issues)) {
      throw new Error('Current membership menu must expose a structured design state and issues array');
    }
    expect(designState.issues).not.toContain('user_center_picture_unavailable');
    expect(designState.issues).not.toContain('user_center_known_fields_invalid');
    expect(await state()).toEqual(before);
    expect(get.mock.calls.some(([key]) => key === 'cfg_member_card_status')).toBe(false);
    expect(get.mock.calls.some(([key]) => key === 'cfg_balance_func_status')).toBe(uid !== 0);
    expect(put).not.toHaveBeenCalled();
  };

  beforeAll(async () => {
    f = await financePostgres([agentLevel, divisionApply, promoterApply, storeCouponUser, storeOrder,
      storeOrderRefund, storeProductLog, storeService, systemConfig, systemDise, systemGroup,
      systemGroupData, systemMessage, systemUserLevel, user, userBill, userBrokerage, userExtract,
      userLevel, userMessage, userMoney, userRelation, wechatUser, systemStore, systemStoreStaff, deliveryService]);
    container = createContainerFromDb(f.db);
    const app = new Hono<{ Bindings: Env }>();
    app.get('/', c => {
      profile = new UserProfileService(container, c.env);
      catalogue = new PublicCatalogService(container, c.env);
      return c.body(null, 204);
    });
    expect((await app.request('/', {}, { CONFIG_KV: { get, put, delete: vi.fn(async () => undefined) } })).status).toBe(204);
    await f.db.insert(user).values({ uid: 11, account: 'local-membership-display', nickname: 'Local member',
      nowMoney: '100.00', isMoneyLevel: 1, overdueTime: Math.floor(Date.now() / 1000) + 86_400 });
    await f.db.insert(systemGroup).values([{ id: 1, configName: 'routine_my_menus' }, { id: 2, configName: 'routine_my_banner' }]);
    const fixture = design();
    await f.db.insert(systemGroupData).values([
      ...[...fixture.menu.list, ...fixture.merMenu.list].map((item, index) => ({ id: index + 1, gid: 1, status: 1,
        value: JSON.stringify({ url: { value: item.url }, name: { value: item.name }, pic: item.pic, type: item.type }) })),
      { id: 5, gid: 2, status: 1, value: JSON.stringify(fixture.poster.list[0]) },
    ]);
    await f.db.insert(systemDise).values({ id: 1, templateName: 'member', type: 3, status: 1,
      value: JSON.stringify(fixture) });
  }, 30_000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External requests forbidden'));
    get.mockClear(); put.mockClear(); cachedFlag = '1'; await setFlag('1');
  });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });
  afterAll(async () => { await f?.close(); });

  it.each([{ sql: '1', cached: '0', enabled: true }, { sql: '0', cached: '1', enabled: false }])(
    'follows SQL $sql despite cached $cached for full home and all three menu locations', async row => {
      await setFlag(row.sql); cachedFlag = row.cached; await project(row.enabled, row.enabled);
    });

  it.each([
    { label: 'missing', value: null, personal: false, menu: false },
    { label: 'empty', value: '', personal: false, menu: false },
    { label: 'quoted empty', value: '""', personal: false, menu: false },
    { label: 'malformed', value: 'not-a-flag', personal: false, menu: false },
    { label: 'unsafe integer', value: '9007199254740992', personal: false, menu: false },
    { label: 'quoted one', value: ' "1" ', personal: true, menu: true },
    { label: 'quoted zero', value: ' "0" ', personal: false, menu: false },
    { label: 'boolean text', value: 'true', personal: false, menu: true },
    { label: 'other integer', value: '2', personal: true, menu: false },
    { label: 'negative integer', value: '-1', personal: true, menu: false },
    { label: 'numeric notation', value: '1e0', personal: true, menu: false },
    { label: 'double-encoded one', value: JSON.stringify('"1"'), personal: true, menu: false },
  ])('preserves the distinct personal/menu historical semantics for $label', async row => {
    await setFlag(row.value); await project(row.personal, row.menu);
  });

  it('respects global sort/id precedence and hidden winners, ignoring the higher store flag', async () => {
    await f.db.delete(systemConfig);
    await f.db.insert(systemConfig).values([
      { id: 100, menuName: 'member_card_status', value: '1', sort: 9 },
      { id: 101, menuName: 'member_card_status', value: '1', sort: 10 },
      { id: 102, menuName: 'member_card_status', value: '0', sort: 10, status: 0 },
      { id: 103, menuName: 'member_card_status', value: '1', sort: 99, isStore: 1 },
      { id: 104, menuName: 'balance_func_status', value: '1' },
    ]);
    await project(false, false);
    await f.db.update(systemConfig).set({ value: '1' }).where(eq(systemConfig.id, 102));
    await project(true, true);
  });

  it('uses the same SQL menu policy for anonymous visitors', async () => {
    cachedFlag = '1'; await setFlag('0'); await project(false, false, 0);
    cachedFlag = '0'; await setFlag('1'); await project(true, true, 0);
  });

  it('does not access or refill an unavailable membership KV key', async () => {
    get.mockImplementation(async key => {
      if (key === 'cfg_member_card_status') throw Error('Membership KV unavailable');
      return key === 'cfg_balance_func_status' ? '1' : '0';
    });
    try {
      await project(true, true);
      await f.db.update(systemConfig).set({ value: '0' }).where(eq(systemConfig.menuName, 'balance_func_status'));
      const before = await state(), menu = await catalogue.menuUser(11);
      expect(menu.capabilities).toMatchObject({ balance: false });
      const menus = menu.routine_my_menus;
      if (!Array.isArray(menus)) throw new Error('Current membership menus must be an array');
      const names = menus.map((item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)
          || !('name' in item) || typeof item.name !== 'string') {
          throw new Error('Current membership menu items must expose string names');
        }
        return item.name;
      });
      expect(menus).toHaveLength(3);
      expect(names).toEqual(['Member', 'Browse', 'Merchant member']);
      expect(await profile.personalHome(11)).toMatchObject({ balance_func_status: 1, is_open_member: true });
      expect(await state()).toEqual(before);
      expect(get.mock.calls.some(([key]) => key === 'cfg_member_card_status')).toBe(false);
      expect(put).not.toHaveBeenCalled();
    }
    finally { get.mockImplementation(async key => key === 'cfg_member_card_status' ? cachedFlag : key === 'cfg_balance_func_status' ? '1' : '0'); }
  });

  it('propagates failed SQL authority reads instead of returning old enabled projections', async () => {
    await project(true, true);
    const before = await state();
    // Rename only this owned fixture table, so both original and freshly scoped
    // RR DAOs encounter an actual missing SQL authority rather than an old DAO spy.
    await f.exec('ALTER TABLE system_config RENAME TO owned_unavailable_membership_config');
    try {
      await expect(profile.personalHome(11)).rejects.toMatchObject({ cause: { code: '42P01' } });
      await expect(catalogue.menuUser(11)).rejects.toMatchObject({ cause: { code: '42P01' } });
    } finally {
      await f.exec('ALTER TABLE owned_unavailable_membership_config RENAME TO system_config');
    }
    expect(await state()).toEqual(before);
    expect(get.mock.calls.some(([key]) => key === 'cfg_member_card_status')).toBe(false);
  });
});
