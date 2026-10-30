import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createApp } from '@/app';
import { createContainerFromDb, withTx } from '@/lib/di';
import { systemConfig, storeProduct, user, storeBrand, storeProductLabel, storePromotions, systemUserLevel, systemAttachment } from '@/models/schema';
import { StoreProductDao } from '@/dao/product/StoreProductDao';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { PublicCatalogService } from '@/services/product/PublicCatalogService';
import { StoreProductService } from '@/services/product/StoreProductService';
import { WechatMiniProgramCodeService } from '@/services/wechat/WechatMiniProgramCodeService';
import { PcCompatibilityService } from '@/services/pc/PcCompatibilityService';
import { HomepageReadBudget } from '@/services/product/HomepageReadBudget';
import { PC_BASE_KEYS } from '../../view/common/pcBase';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

type F = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<F['withRuntimeRole']>>[0] extends (peer: infer P) => unknown ? P : never;
const FIRST = 910001, UID = 99101;
const ownedIds = Array.from({ length: 205 }, (_x, index) => FIRST + index);
const ordered = (ids: number[]) => [...ids].sort((left, right) => (right % 3) - (left % 3) || right - left);
const BRAND = 99201, LABEL = 99202, PROMOTION = 99203, LEVEL = 99204, IMAGE = 99205, FOREIGN_IMAGE = 99206, PREFIX_IMAGE = 992050;
const bestBoundary = ordered(ownedIds.slice(0, 151)).slice(98, 101);
const newBoundary = ordered(ownedIds.slice(104)).slice(98, 101);
const boundary = [...new Set([...bestBoundary, ...newBoundary])];
const keys = new Set(PC_BASE_KEYS.map(key => 'cfg_' + key));

async function fixture(work: (f: F, app: Peer, env: Env) => Promise<void>) {
  const f = await refundRuntimeFixture();
  try {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [owner] = await f.exec('SELECT current_database() AS database,current_user AS maintenance');
      await runRuntimeBusinessCommissioning(f.db, { database: String(owner.database), maintenance: String(owner.maintenance), app: app.role, admin: admin.role, pricingOwner: f.pricingOwner });
      const env = { APP_KEY: 'owned-pc-consumer-signing-key', HYPERDRIVE: { connectionString: app.connectionString }, HYPERDRIVE_ADMIN: { connectionString: admin.connectionString },
        CONFIG_KV: { get: async (key: string) => { if (keys.has(key)) throw Error('PC configuration must not use KV'); return null; }, put: async (key: string) => { if (keys.has(key)) throw Error('PC configuration must not populate KV'); }, delete: async () => {} } } as unknown as Env;
      try { await work(f, app, env); }
      finally { await f.exec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename='${app.role.replaceAll("'", "''")}' AND application_name='cinashop_api' AND pid<>pg_backend_pid()`); }
    }));
  } finally { await f.close(); }
}

async function seed(f: F) {
  await f.db.delete(systemConfig).where(inArray(systemConfig.menuName, [...PC_BASE_KEYS, 'site_url', 'site_name']));
  const values = { pc_logo: 'http://cdn.example.test/logo.png', bast_number: 151, first_number: 101,
    product_phone_buy_url: 1, contact_number: '4001234567', company_address: '原公司地址', copyright: '原版权',
    seo_title: '仅存储标题', site_keywords: '原关键词', site_description: '原文\r\n下一行', links_open: 1,
    links_list: [{ name: '乙', url: 'http://example.test/z', sort: 0.5 }, { name: '甲', url: '/terms', sort: 10 }],
    filing_list: [{ icon: 'http://cdn.example.test/filing.png', name: '', url: '', sort: 2.5 }],
    site_url: 'http://shop.example.test', site_name: 'PC测试商城' };
  await f.db.insert(systemConfig).values(Object.entries(values).map(([menuName, value]) => ({ menuName, value: JSON.stringify(value), sort: 10, configTabId: 74 })));
  // The owned DB can contain unrelated fixture products; they must not affect
  // this source-contract test's eligible best/new populations.
  await f.db.update(storeProduct).set({ isBest: 0, isNew: 0 });
  await f.db.insert(storeProduct).values(ownedIds.map((id, index) => ({ id, type: 0, relationId: 0, productType: 0, pid: 0,
    isShow: 1, isDel: 0, isVerify: 1, isVipProduct: 0, isBest: index < 151 ? 1 : 0, isNew: index >= 104 ? 1 : 0,
    sort: id % 3, storeName: '完整首页商品' + index, image: 'https://cdn.example.test/product.png', price: '12.00', stock: 100 })));
  await f.db.insert(storeProduct).values([
    { isShow: 0 }, { isDel: 1 }, { isVerify: 0 }, { pid: FIRST },
    { type: 2, relationId: 999991 }, { productType: 99 },
  ].map((invalid, index) => ({ id: FIRST + 2000 + index, type: 0, relationId: 0, productType: 0, pid: 0,
    isShow: 1, isDel: 0, isVerify: 1, isBest: 1, isNew: 1, sort: 1000, storeName: '必须排除' + index,
    price: '999.00', stock: 1, ...invalid })));
  await f.db.insert(storeBrand).values({ id: BRAND, brandName: '跨页真实品牌', isShow: 1, isDel: 0 });
  await f.db.insert(storeProductLabel).values({ id: LABEL, labelName: '跨页真实标签', color: '#123456', styleType: 1, isShow: 1, status: 1 });
  const now = Math.floor(Date.now() / 1000);
  await f.db.insert(storePromotions).values({ id: PROMOTION, name: '跨页真实促销', promotionsType: 2, productPartakeType: 1,
    type: 1, storeId: 0, pid: 0, status: 1, isDel: 0, discount: '20.00', startTime: now - 10, stopTime: now + 3600 });
  await f.db.update(storeProduct).set({ brandId: BRAND, storeLabelId: String(LABEL), isPresaleProduct: 1,
    presaleStartTime: now - 10, presaleEndTime: now + 3600 }).where(inArray(storeProduct.id, boundary));
  await f.db.insert(systemAttachment).values([
    { attId: IMAGE, name: 'attachments/admin/1/owned-pc.png', attDir: `/api/assets/${IMAGE}`, attType: 'image/png', type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8 },
    { attId: PREFIX_IMAGE, name: 'attachments/admin/1/owned-pc-prefix.png', attDir: `/api/assets/${PREFIX_IMAGE}`, attType: 'image/png', type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8 },
    { attId: FOREIGN_IMAGE, name: 'attachments/supplier/7/foreign-pc.png', attDir: `/api/assets/${FOREIGN_IMAGE}`, attType: 'image/png', type: 4, relationId: 7, moduleType: 1, fileType: 1, imageType: 8 },
  ]);
  await f.db.update(storeProduct).set({ image: `/api/assets/${IMAGE}` }).where(inArray(storeProduct.id, boundary));
  await f.db.update(storeProduct).set({ image: `/api/assets/${FOREIGN_IMAGE}` }).where(eq(storeProduct.id, ownedIds[1]!));


}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PC actual fresh company and complete configured homepage consumers', () => {
  afterEach(() => vi.restoreAllMocks());
  it('returns all151 best and101 new IDs in PHP order through real App LOGIN and both production homepage versions', async () => fixture(async (f, app, env) => {
    await seed(f);
    const catalog = new PublicCatalogService(createContainerFromDb(app.db), env);
    const expectedBest = ordered(ownedIds.slice(0, 151)), expectedNew = ordered(ownedIds.slice(104));
    const assertHome = (home: Record<string, any>) => {
      expect(home.info.bastList.map((row: any) => row.id)).toEqual(expectedBest);
      expect(home.info.firstList.map((row: any) => row.id)).toEqual(expectedNew);
      for (const row of [...home.info.bastList, ...home.info.firstList]) {
        expect(row).toHaveProperty('promotions'); expect(row).toHaveProperty('brand_name');
        expect(row).toHaveProperty('store_label'); expect(row).toHaveProperty('presale_pay_status');
      }
      for (const [rows, ids] of [[home.info.bastList, bestBoundary], [home.info.firstList, newBoundary]] as const) {
        for (const id of ids) {
          expect(rows.find((row: any) => row.id === id)).toMatchObject({ brand_name: '跨页真实品牌',
            store_label: [{ id: LABEL, label_name: '跨页真实标签', color: '#123456' }],
            promotions: { id: PROMOTION, name: '跨页真实促销' }, presale_pay_status: 2, cart_button: 0 });
          const image = rows.find((row: any) => row.id === id).image;
          expect(image.startsWith(`/api/assets/${IMAGE}?expires=`)).toBe(true);
          expect(image).toMatch(/&signature=[A-Za-z0-9_-]{43}$/u);

        }
      }
    };
    assertHome(await catalog.home(0));
    expect(((await catalog.home(0)) as any).info.bastList.find((row: any) => row.id === ownedIds[1]).image).toBe(''); assertHome(await catalog.homeV2(0));
    const http = createApp();
    for (const path of ['/api/index', '/api/v2/index']) {
      const response = await http.request(path, { headers: { 'X-Test-Owned': randomUUID() } }, env);
      const body = await response.json() as any; expect(body.status, body.msg).toBe(200); assertHome(body.data);
    }
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'member_func_status'));
    await f.db.insert(systemConfig).values({ menuName: 'member_func_status', value: '1' });
    await f.db.insert(systemUserLevel).values({ id: LEVEL, name: '跨页八折会员', discount: '80.00', isShow: 1, isDel: 0 });
    await f.db.insert(user).values({ uid: UID + 1, account: 'owned_pc_level', level: LEVEL, levelStatus: 1, isDel: 0 });
    const member = await catalog.home(UID + 1) as any;
    for (const rows of [member.info.bastList, member.info.firstList]) {
      for (const row of rows.slice(98, 101)) expect(row).toMatchObject({ price_type: 'level', level_name: '跨页八折会员', vip_price: '9.60' });
    }
    const ordinary = new StoreProductService(createContainerFromDb(app.db), env);
    expect((await ordinary.getGoodsList({ limit: 200 }, 0)).list).toHaveLength(100);
    await expect(ordinary.getGoodsList({ page: 2000, limit: 100 }, 0)).rejects.toThrow('分页');
    await expect(ordinary.getHomeRecommendProductsInTx(0, 151, { isBest: true })).rejects.toMatchObject({ code: 503 });
  }), 120000);

  it('keeps configured counts and every product chunk in one real read snapshot despite a committed concurrent edit', async () => fixture(async (f, app, env) => {
    await seed(f);
    const original = StoreProductDao.prototype.getSearchList;
    let changed = false;
    vi.spyOn(StoreProductDao.prototype, 'getSearchList').mockImplementation(async function (this: StoreProductDao, opts) {
      const result = await original.call(this, opts);
      if (!changed && opts.where.isBest === 1 && opts.page === 1) {
        changed = true;
        await f.db.update(systemConfig).set({ value: '101' }).where(eq(systemConfig.menuName, 'bast_number'));
        await f.db.delete(storeProduct).where(eq(storeProduct.id, ownedIds[0]!));
      }
      return result;
    });
    const catalog = new PublicCatalogService(createContainerFromDb(app.db), env);
    const first = await catalog.home(0) as any;
    expect(changed).toBe(true); expect(first.info.bastList.map((row: any) => row.id)).toEqual(ordered(ownedIds.slice(0, 151)));
    const next = await catalog.home(0) as any;
    expect(next.info.bastList.map((row: any) => row.id)).toEqual(ordered(ownedIds.slice(1, 151)).slice(0, 101));
    // An extreme valid authored target is bounded by actual eligibility,
    // never silently by100 or a second arbitrary authored-count cutoff.
    await f.db.update(systemConfig).set({ value: String(Number.MAX_SAFE_INTEGER) }).where(eq(systemConfig.menuName, 'bast_number'));
    await f.db.update(storeProduct).set({ isBest: 1 }).where(inArray(storeProduct.id, ownedIds.slice(1)));
    const complete = await catalog.homeV2(0) as any;
    expect(complete.info.bastList.map((row: any) => row.id)).toEqual(ordered(ownedIds.slice(1)));
    expect(complete.info.bastList.slice(200)).toHaveLength(4);
  }), 120000);

  it('rejects a whole homepage after a real sub-statement delay exhausts the shared total budget', async () => fixture(async (f, app, env) => {
    await seed(f);
    const original = StoreProductDao.prototype.getSearchList;
    let bestPages = 0;
    vi.spyOn(StoreProductDao.prototype, 'getSearchList').mockImplementation(async function (this: StoreProductDao, opts) {
      const result = await original.call(this, opts);
      if (opts.where.isBest === 1) {
        bestPages++;
        await f.exec('SELECT pg_sleep(0.6)');
      }
      return result;
    });
    const catalog = new PublicCatalogService(createContainerFromDb(app.db), env, new HomepageReadBudget(() => performance.now(), 500));
    await expect(catalog.home(0)).rejects.toMatchObject({ code: 503 });
    expect(bestPages).toBe(1);
    expect((await f.db.select().from(systemConfig).where(eq(systemConfig.menuName, 'bast_number')))[0]?.value).toBe('151');
  }), 120000);

  it('reads safe company and phone settings fresh with no PC KV, preserves HTTP and respects current paid membership eligibility', async () => fixture(async (f, app, env) => {
    await seed(f);
    const pc = new PcCompatibilityService(createContainerFromDb(app.db), env);
    const company = await pc.companyInfo();
    expect(company).toMatchObject({ pc_logo: 'http://cdn.example.test/logo.png', logoUrl: 'http://cdn.example.test/logo.png',
      copyright: '原版权', site_keywords: '原关键词', site_description: '原文\r\n下一行' });
    expect(company.links_list.map(row => row.name)).toEqual(['甲', '乙']);
    expect(company.filing_list[0]?.icon).toBe('http://cdn.example.test/filing.png');
    await f.db.update(systemConfig).set({ value: JSON.stringify([
      { name: '小写URL', url: '/a', sort: 2 }, { name: '大写URL', url: '/Z', sort: 2 },
      { name: '10', url: '/same', sort: 1 }, { name: '2', url: '/same', sort: 1 },
      { name: 'B', url: '/same', sort: 0 }, { name: 'A', url: '/same', sort: 0 },
    ]) }).where(eq(systemConfig.menuName, 'links_list'));
    // Historical JSON key insertion order participates in PHP's final row
    // comparison. Retaining only canonical icon-first objects changes this tie.
    await f.db.update(systemConfig).set({ value: JSON.stringify([
      { name: 'B', icon: 'http://cdn.example.test/a.png', url: '/filing', sort: 1 },
      { name: 'A', icon: 'http://cdn.example.test/z.png', url: '/filing', sort: 1 },
    ]) }).where(eq(systemConfig.menuName, 'filing_list'));
    const tied = await pc.companyInfo();
    expect(tied.links_list.map(row => row.name)).toEqual(['大写URL', '小写URL', '2', '10', 'A', 'B']);
    expect(tied.filing_list.map(row => row.name)).toEqual(['A', 'B']);
    await f.db.update(systemConfig).set({ value: JSON.stringify([
      { icon: `/api/assets/${PREFIX_IMAGE}`, name: '同名', url: '/same', sort: 1 },
      { icon: `/api/assets/${IMAGE}`, name: '同名', url: '/same', sort: 1 },
    ]) }).where(eq(systemConfig.menuName, 'filing_list'));
    // Signatures change the prefix ordering ('?' versus the next digit).
    // Public row ordering must therefore use canonical values before signing.
    expect((await pc.companyInfo()).filing_list.map(row => row.icon.split('?')[0])).toEqual([`/api/assets/${IMAGE}`, `/api/assets/${PREFIX_IMAGE}`]);


    expect(await pc.productPhoneBuy()).toEqual({ phone_buy: '1', sit_url: 'http://shop.example.test' });
    // Provider result transport is controlled; actual tenant/provider access
    // is not claimed. The real App SQL reader must select the fresh mode.
    const png = 'data:image/png;base64,YQ==';
    const productProvider = vi.spyOn(WechatMiniProgramCodeService.prototype, 'createProductDetailDataUrl').mockResolvedValue(png);
    const memberProvider = vi.spyOn(WechatMiniProgramCodeService.prototype, 'createPaidMembershipDataUrl').mockResolvedValue(png);
    expect(await pc.productCode(FIRST)).toEqual({ site_url: 'http://shop.example.test', routineCode: '' });
    const h5Vip = await pc.payVipCode(); expect(h5Vip.url).toMatch(/^data:image\/svg\+xml/);
    expect(productProvider).not.toHaveBeenCalled(); expect(memberProvider).not.toHaveBeenCalled();

    await f.db.update(systemConfig).set({ value: '2' }).where(eq(systemConfig.menuName, 'product_phone_buy_url'));
    expect(await pc.productPhoneBuy()).toEqual({ phone_buy: '2', sit_url: 'http://shop.example.test' });
    expect(await pc.productCode(FIRST)).toEqual({ site_url: 'http://shop.example.test', routineCode: png });
    expect(productProvider).toHaveBeenCalledWith(FIRST); expect(await pc.payVipCode()).toEqual({ url: png }); expect(memberProvider).toHaveBeenCalledTimes(1);
    const http = createApp();
    for (const [path, expected] of [
      [`/api/pc/get_product_phone_buy`, { phone_buy: '2', sit_url: 'http://shop.example.test' }],
      [`/api/pc/get_product_code/${FIRST}`, { site_url: 'http://shop.example.test', routineCode: png }],
      [`/api/pc/get_pay_vip_code`, { url: png }],
    ] as const) {
      const body = await (await http.request(path, {}, env)).json() as any;
      expect(body.status, body.msg).toBe(200); expect(body.data).toEqual(expected);
    }
    await f.db.update(systemConfig).set({ value: '1' }).where(eq(systemConfig.menuName, 'product_phone_buy_url'));
    await f.db.update(systemConfig).set({ value: JSON.stringify('http://changed-mobile.example.test') }).where(eq(systemConfig.menuName, 'site_url'));
    expect(await pc.productPhoneBuy()).toEqual({ phone_buy: '1', sit_url: 'http://changed-mobile.example.test' });
    expect(await pc.productCode(FIRST)).toEqual({ site_url: 'http://changed-mobile.example.test', routineCode: '' });
    expect((await pc.payVipCode()).url).not.toBe(h5Vip.url);
    await f.db.update(systemConfig).set({ value: JSON.stringify('http://shop.example.test') }).where(eq(systemConfig.menuName, 'site_url'));

    await f.db.update(systemConfig).set({ value: JSON.stringify('/uploads/logo.png') }).where(eq(systemConfig.menuName, 'pc_logo'));
    expect(await pc.companyInfo()).toMatchObject({ pc_logo: '/uploads/logo.png', logoUrl: 'http://shop.example.test/uploads/logo.png' });
    await f.db.update(systemConfig).set({ value: JSON.stringify('javascript:private-ticket') }).where(eq(systemConfig.menuName, 'pc_logo'));
    expect(JSON.stringify(await pc.companyInfo())).not.toContain('private-ticket');
    await f.db.insert(user).values({ uid: UID, account: 'owned_pc_consumer', isMoneyLevel: 1, isDel: 0 });
    await f.db.insert(storeProduct).values({ id: FIRST + 1000, type: 0, relationId: 0, productType: 0, pid: 0, isShow: 1, isDel: 0, isVerify: 1,
      isVipProduct: 1, isBest: 1, isNew: 1, sort: 100, storeName: '仅付费会员', price: '15.00', stock: 10 });
    const catalog = new PublicCatalogService(createContainerFromDb(app.db), env);
    expect((await catalog.home(0) as any).info.bastList.some((row: any) => row.id === FIRST + 1000)).toBe(false);
    expect((await catalog.home(UID) as any).info.bastList[0].id).toBe(FIRST + 1000);
    await withTx(createContainerFromDb(app.db), async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const list = await new StoreProductService(createContainerFromDb(tx), env).getHomeRecommendProductsInTx(0, 151, { isBest: true });
      expect(list).toHaveLength(151);
    });
  }), 120000);
});
