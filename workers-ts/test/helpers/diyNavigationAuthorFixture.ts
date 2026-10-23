import { eq, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { vi } from 'vitest';
import { pageCategory, pageLink, storeProductWords, storeProduct, storeProductCategory, storeProductRelation, storeSeckill, storeBargain,
  storeCombination, storeIntegral, systemArticle, articleCategory, systemDise, systemRole, systemAdmin, systemConfig, systemSupplier } from '@/models/schema';
import { AttachmentService, supplierAttachmentScope } from '@/services/system/AttachmentService';
import { SystemConfigService } from '@/services/system/SystemConfigService';
import { createToken, md5 } from '@/utils/jwt';
import { diyPageSettingsFixture } from './diyPageSettingsFixture';
import { diyFooterBlock } from './diyFooterFixture';
import { sortedDiyState, type DiyStateRow as Row, type DiyStateSnapshot } from './diyStateFixture';
import defaults from '../fixtures/diy-navigation-author-defaults.json';

// Literal defaults pinned by the fresh-contract extraction to immutable PHP
// 8ed2a5b139f9170dd11b0dff91803f2fd59e40a5; no PHP is executed by this fixture.
export const DIY_NAVIGATION_AUTHOR_IDS = { categoryRoot: 84021, categoryChild: 84022, product: 84031, presale: 84032, supplier: 84061, micro: 2 } as const;
export const DIY_NAVIGATION_AUTHOR_NAMES = ['headerSerch', 'tabNav', 'menus', 'pictureCube'] as const;
export function navigationAuthorBlock(kind: keyof typeof defaults, timestamp: number): Row {
  const block: Row = structuredClone(defaults[kind]); block.timestamp = timestamp; block.authorExtra = { zero: 0, empty: [], keep: `${kind}-unknown` };
  if (kind === 'pictureCube') block.picStyle.picList = Array.from({ length: 2 }, () => ({ image: '', link: '', slotUnknown: 'retain' }));
  return block;
}
type Images = { platformImage: { url: string }; secondIcon: { url: string } };
export function navigationAuthorBlocks(f: Images, micro = false): Row[] {
  const header = navigationAuthorBlock('headerSerch', 0), tabs = navigationAuthorBlock('tabNav', 1), menus = navigationAuthorBlock('menus', 30), cube = navigationAuthorBlock('pictureCube', 40);
  header.logoConfig.url = f.platformImage.url; header.hotWords.list = [{ val: '原始热词', imported: true }];
  tabs.tabListConfig.list = tabs.tabListConfig.list.slice(0, 2);
  tabs.tabListConfig.list.forEach((item: Row, index: number) => { item.authorExtra = index; item.microPage.dormantUnknown = 'keep-micro'; item.classPage.dormantUnknown = 'keep-category'; });
  menus.menuConfig.list = Array.from({ length: 6 }, (_, index) => ({ ...structuredClone(menus.menuConfig.list[0]), img: f.platformImage.url, show: true,
    info: [{ title: '标题', value: ['菜单一','菜单二','菜单三','菜单四','菜单五','菜单六'][index], max: 4, keep: 'caption' }, { title: '链接', value: '/pages/index/index', max: 100, keep: 'link' }], authorExtra: index }));
  cube.picStyle.picList.forEach((item: Row) => { item.image = f.platformImage.url; item.link = '/pages/index/index'; });
  cube.menuConfig.list[0].img = f.platformImage.url; cube.menuConfig.list[0].info[0].value = '/pages/index/index';
  if (micro) {
    header.numConfig.val = 0; header.styleConfig.tabVal = 2; header.styleSearchConfig.tabVal = 1;
    menus.topConfig.val = '1e30'; menus.prConfig.val = ' 12.5 '; menus.fillet.type = true;
    menus.fillet.valList = [{ val: ' 1.25 ' }, { val: '2e0' }, { val: 3.5 }, { val: ' 4.75 ' }];
    cube.styleConfig = { ...cube.styleConfig, tabVal: 11, count: 16 };
    cube.picStyle.docPicList = [{ img: f.platformImage.url, link: '/pages/index/index', doc: { startX: 0, startY: 0, w: 0.0005, h: 93.75 }, unknown: 'tiny-kept' },
      { img: f.secondIcon.url, link: '/pages/index/index', doc: { startX: '1e1', startY: ' 0.25 ', w: ' 93.75 ', h: '1.875e2' }, unknown: 'string-kept' }];
    cube.picStyle.picList[1].image = f.secondIcon.url;
  }
  const title = { name: 'titles', timestamp: 10, titleConfig: { value: micro ? '导航作者导入微页正文' : '导航作者首页正文' }, fontSize: { val: 18 }, unknown: { retain: true } };
  const footer = diyFooterBlock(f.platformImage.url), neighbor = { name: 'unsupported-navigation-neighbor', timestamp: 35, opaque: { zero: 0, list: [] }, preserve: 'whole-object' };
  const duplicate = navigationAuthorBlock('headerSerch', 25); duplicate.isHide = true; duplicate.numConfig.val = 101;
  return [header, tabs, title, menus, cube, ...(micro ? [duplicate] : []), neighbor, footer];
}
export function expectedNavigationRootEdit(f: Images, baseline = navigationAuthorBlocks(f)): Row[] {
  const value = structuredClone(baseline), by = (name: string) => value.find(row => row.name === name)!;
  const header = by('headerSerch'); header.tipConfig.value = '作者迁移搜索'; header.logoConfig.url = f.secondIcon.url; header.hotWords.list[0].val = '作者热词25';
  const tabs = by('tabNav'); Object.assign(tabs.tabListConfig.list[0].text, { val: '作者微页' });
  Object.assign(tabs.tabListConfig.list[0].microPage, { id: 2, name: '导航作者微页' });
  tabs.tabListConfig.list[1].text.val = '作者分类'; tabs.tabListConfig.list[1].dataType.tabVal = 1;
  Object.assign(tabs.tabListConfig.list[1].classPage, { id: DIY_NAVIGATION_AUTHOR_IDS.categoryChild, name: '作者子分类' });
  const menus = by('menus'); menus.showConfig.tabVal = 1; menus.menuConfig.list[0].info[0].value = '作者菜单'; menus.menuConfig.list[0].img = f.secondIcon.url;
  menus.menuConfig.list[0].info[1].value = `/pages/goods_details/index?id=${DIY_NAVIGATION_AUTHOR_IDS.product}`; menus.menuConfig.list[1].show = false;
  const cube = by('pictureCube'); cube.styleConfig.tabVal = 1; cube.styleConfig.count = 2; cube.picStyle.tabVal = 0;
  cube.picStyle.picList = cube.picStyle.picList.slice(0, 2); cube.picStyle.picList[0].image = f.secondIcon.url;
  cube.menuConfig.list[0].img = f.secondIcon.url; cube.imgConfig.val = 2;
  return value;
}
export function expectedNavigationCustomEdit(f: Images, baseline = expectedNavigationRootEdit(f)): Row[] {
  const value = structuredClone(baseline), cube = value.find(row => row.name === 'pictureCube')!;
  cube.styleConfig.tabVal = 11; cube.styleConfig.count = 16;
  while (cube.picStyle.picList.length < 16) cube.picStyle.picList.push({ image: '', link: '' });
  cube.picStyle.docPicList = [{ img: f.platformImage.url, link: '/pages/index/index', doc: { startX: 0.25, startY: 0.5, w: 93.75, h: 187.25 } }];
  cube.picStyle.picList[0].image = f.platformImage.url; cube.menuConfig.list[0].img = f.platformImage.url; cube.picStyle.tabVal = 0;
  return value;
}

/** Extends the old full fixture without modifying its defaults. All additions
 * are test-only ORM DDL in a newly owned database; final inventory is dynamic. */
export async function diyNavigationAuthorFixture(now = new Date(), options: { namespace?: 'public' } = {}) {
  const f = await diyPageSettingsFixture(now, options);
  try {
    const setupBefore = await f.snapshot(), beforeResources = f.resources(), dialect = new PgDialect(), added: string[] = [];
    for (const table of [pageCategory, pageLink, storeProductWords]) {
      const definition = getTableConfig(table); if (f.tables.includes(definition.name)) continue;
      const columns = definition.columns.map(column => { const value = column.default,
        initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`; });
      await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`); added.push(definition.name);
    }
    await f.db.insert(pageCategory).values([{ id: 84001, pid: 0, type: 'link', name: '作者目录根' }, { id: 84002, pid: 84001, type: 'link', name: '作者基础目录' }, { id: 84003, pid: 84001, type: 'marketing_link', name: '作者营销目录' }]);
    await f.db.insert(pageLink).values([{ id: 84011, cateId: 84002, type: 1, name: '作者首页链接', url: '/pages/index/index' },
      { id: 84012, cateId: 84002, type: 3, name: '作者个人中心链接', url: '/pages/user/index' },
      { id: 84013, cateId: 84002, type: 2, name: '作者分销链接', url: '/pages/users/user_spread_code/index' },
      { id: 84014, cateId: 84003, type: 4, name: '作者营销链接', url: '/pages/activity/points_mall/index' },
      { id: 84015, cateId: 84002, type: 1, name: '作者坏历史链接', url: 'javascript:author-must-not-execute' }]);
    await f.db.insert(storeProductWords).values([...Array.from({ length: 25 }, (_, i) => ({ id: 84100 + i, name: `作者热词${i + 1}`, isShow: 1, isSearch: i % 2, sort: i })),
      { id: 84201, name: '作者隐藏热词', isShow: 0 }, { id: 84202, name: '作者供应商热词', type: 2, relationId: 84061, isShow: 1 }]);
    await f.db.insert(storeProductCategory).values([{ id: 84021, pid: 0, cateName: '作者父分类', type: 0, relationId: 0 }, { id: 84022, pid: 84021, cateName: '作者子分类', type: 0, relationId: 0 },
      { id: 84023, pid: 0, cateName: '作者隐藏分类', isShow: 0 }, { id: 84024, pid: 999999, cateName: '作者孤儿分类' }, { id: 84025, pid: 0, cateName: '作者供应商分类', type: 2, relationId: 84061 }]);
    await f.db.insert(systemSupplier).values({ id: 84061, name: '作者可见供应商', isShow: 1, isDel: 0 });
    const supplierImage = await new AttachmentService(f.container, f.env).uploadImage(supplierAttachmentScope(84061), new File([f.png], 'navigation-author-supplier.png', { type: 'image/png' }), 0);
    await f.db.insert(storeProduct).values([{ id: 84031, storeName: '作者目录商品', isVerify: 1, image: f.platformImage.url, price: '9.50', keyword: 'never-serialize-author-keyword', storeInfo: 'never-serialize-author-info', barCode: 'AUTHOR84031' },
      { id: 84032, storeName: '作者目录预售', isVerify: 1, image: f.platformImage.url, isPresaleProduct: 1, price: '19.00' },
      { id: 84033, storeName: '作者供应商商品', isVerify: 1, type: 2, relationId: 84061, image: supplierImage.url, price: '29.00' }]);
    await f.db.insert(storeProductRelation).values({ productId: 84031, type: 1, relationId: 84022, relationPid: 84021 });
    await f.db.insert(storeSeckill).values({ id: 84041, productId: 84031, storeName: '作者目录秒杀', image: f.platformImage.url, price: '5.00' });
    await f.db.insert(storeBargain).values({ id: 84042, productId: 84031, title: '作者目录砍价', image: f.platformImage.url, price: '6.00' });
    await f.db.insert(storeCombination).values({ id: 84043, productId: 84031, storeName: '作者目录拼团', image: f.platformImage.url, price: '7.00' });
    await f.db.insert(storeIntegral).values({ id: 84044, productId: 84031, storeName: '作者目录积分', image: f.platformImage.url, price: '0.00' });
    await f.db.insert(articleCategory).values({ id: 84082, title: '作者文章分类' });
    await f.db.insert(systemArticle).values({ id: 84081, cid: 84082, title: '作者目录文章', imageInput: f.platformImage.url, content: 'never-serialize-author-article-body' });
    await f.db.insert(systemDise).values([{ id: 84051, name: '作者空微页', title: '作者空微页', type: 2, isDiy: 1, status: 1, value: '[]' },
      { id: 84052, name: '作者非DIY专题', type: 2, isDiy: 0, status: 1, value: '[]' },
      { id: 84053, name: '作者损坏微页', type: 2, isDiy: 1, status: 1, value: '{"private":' }, { id: 84054, name: '作者草稿微页', type: 2, isDiy: 1, status: 0, value: '[]' }]);
    const minimalRules = ['dise.view', 'dise.manage'];
    await f.db.insert(systemRole).values({ id: 903, roleName: '作者最小权限', rules: minimalRules.join(','), status: 1, type: 1 });
    const password = 'owned-navigation-author-minimal';
    await f.db.insert(systemAdmin).values({ id: 903, account: 'owned-navigation-author-minimal', pwd: password, roles: '903', level: 1, adminType: 1, relationId: 0, status: 1 });
    const minimalToken = (await createToken(903, 'admin', md5(password), f.env.APP_KEY)).token;
    const minimalSession = { userInfo: { id: 903, account: 'owned-navigation-author-minimal', real_name: '作者最小权限', level: 1, roles: '903' }, menus: [{ id: 1, pid: 0, path: '/content/dise', name: 'DIY装修' }], uniqueAuth: minimalRules };
    const readerSession = { userInfo: { id: 902, account: 'owned-customer-reader', real_name: '作者只读权限', level: 1, roles: '902' }, menus: [{ id: 1, pid: 0, path: '/content/dise', name: 'DIY装修' }], uniqueAuth: ['dise.view', 'attachment.view'] };
    for (const id of [1, 2]) await f.db.update(systemDise).set({ name: id === 1 ? '导航作者首页' : '导航作者微页', title: id === 1 ? '导航作者首页' : '导航作者导入微页',
      value: JSON.stringify(navigationAuthorBlocks(f, id === 2)), content: `independent-navigation-author-content-${id}`, version: 'navigation-author-initial' }).where(eq(systemDise.id, id));
    await f.db.execute(sql`SELECT setval(pg_get_serial_sequence('system_dise','id'),(SELECT MAX(id) FROM system_dise),true)`);
    const tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row => row.name);
    const sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row => row.name);
    async function snapshot(): Promise<DiyStateSnapshot> {
      const state: DiyStateSnapshot = {};
      const rows = await f.db.execute<{ name: string; rows: Row[] }>(sql.join(tables.map(name => sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `));
      for (const row of rows) state[row.name] = row.rows;
      state.__sequences = await f.db.execute(sql.join(sequences.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `));
      return sortedDiyState(state);
    }
    const kv = f.env.CONFIG_KV;
    const measuredKv = { get: vi.fn(kv.get.bind(kv)), put: vi.fn(kv.put.bind(kv)), delete: vi.fn(kv.delete.bind(kv)) };
    f.env.CONFIG_KV = measuredKv as unknown as typeof f.env.CONFIG_KV;
    const resources = () => ({ ...f.resources(), kv_put: measuredKv.put.mock.calls.length, kv_delete: measuredKv.delete.mock.calls.length, kv_state: [...f.cache].sort((a, b) => a[0].localeCompare(b[0])) });
    const cacheBefore = resources();
    const configRows = await f.db.select({ name: systemConfig.menuName }).from(systemConfig).where(eq(systemConfig.isStore, 0));
    await new SystemConfigService(f.container, f.env).getMany([...new Set([...configRows.map(row => row.name), 'navigation_open', 'product_category_level', 'product_video_status', 'store_user_mobile', 'copyright_context', 'copyright_image', 'image_site_url'])]);
    return { ...f, now, supplierImage, minimalToken, minimalSession, readerSession, tables, sequences, snapshot, resources,
      rootBlocks: navigationAuthorBlocks(f), microBlocks: navigationAuthorBlocks(f, true),
      navigationAuthorSetup: { phase: 'owned full-schema catalog/words/real supplier image/role/component rows and config-cache warm setup; not GUI business writes or measured GET',
        before: setupBefore, after: await snapshot(), resources_before: beforeResources, resources_after: resources(), additional_tables: added, tables, sequences,
        cache_warm: { before: cacheBefore, after: resources() }, minimal_actor: 903, initial_component_shapes: ['headerSerch','tabNav','menus','pictureCube'] } };
  } catch (reason) { await f.close(); throw reason; }
}
