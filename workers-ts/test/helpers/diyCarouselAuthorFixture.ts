import { eq, sql } from 'drizzle-orm';
import { storeProductCategory, systemDise } from '@/models/schema';
import { diyNavigationAuthorFixture, DIY_NAVIGATION_AUTHOR_IDS } from './diyNavigationAuthorFixture';
import { diyFooterBlock } from './diyFooterFixture';
import { sortedDiyState, type DiyStateRow as Row } from './diyStateFixture';
import defaults from '../fixtures/diy-carousel-author-defaults.json';

export const DIY_CAROUSEL_AUTHOR_NAMES = ['swiperBg', 'homeComb', 'swipers'] as const;
export const DIY_CAROUSEL_MODERN_NAMES = ['swiperBg', 'homeComb'] as const;
export const DIY_CAROUSEL_AUTHOR_IDS = DIY_NAVIGATION_AUTHOR_IDS;
type Images = { platformImage: { url: string }; secondIcon: { url: string } };
/** Complete fixed-PHP literal; only timestamp binds the actual new instance. */
export function carouselAuthorBlock(kind: keyof typeof defaults, timestamp: number): Row {
  const block: Row = structuredClone(defaults[kind]); block.timestamp = timestamp; return block;
}
/** An explicit imported legacy record, never an ordinary-new PHP default. */
export function importedLegacyCarousel(image: string, timestamp = 40): Row {
  return { name: 'swipers', cname: '导入旧版轮播', timestamp, isHide: false,
    tabConfig: { tabVal: 1, imported: 'retain-tab' }, docConfig: { type: 0, imported: 'retain-dot' }, imgConfig: { type: 0, imported: 'retain-radius' },
    itemEdge: { val: 17, imported: 'retain-edge' }, lrConfig: { val: 9 }, mbConfig: { val: 7 },
    swiperConfig: { importedUnknown: { zero: 0 }, list: [
      { img: image, imported: 'legacy-primary-title', info: [{ title: '标题', value: '旧图一', dormant: true }, { title: '/pages/article/list', value: '/pages/user/sign', dormant: 'keep-value' }] },
      { img: image, imported: 'legacy-caption-fallback', info: [{ title: '标题', value: '旧图二' }, { title: '链接', value: '/pages/index/index', dormant: 'keep-caption' }] },
    ] }, legacyUnknown: { empty: [], zero: 0, keep: 'whole-object' } };
}
export function carouselAuthorBlocks(f: Images, micro = false): Row[] {
  const home = carouselAuthorBlock('homeComb', 0), background = carouselAuthorBlock('swiperBg', 30), legacy = importedLegacyCarousel(f.platformImage.url);
  home.authorExtra = { preserve: 'home-unknown', empty: [] }; background.authorExtra = { preserve: 'background-unknown', zero: 0 };
  home.logoConfig.url = f.platformImage.url; home.hotWords.list = [{ val: '原始轮播词', imported: true }];
  home.swiperConfig.list = Array.from({ length: 2 }, (_, i) => ({ ...structuredClone(home.swiperConfig.list[0]), img: f.platformImage.url,
    info: [{ ...structuredClone(home.swiperConfig.list[0].info[0]), value: `组合图${i + 1}`, imported: true }, { ...structuredClone(home.swiperConfig.list[0].info[1]), value: '/pages/index/index', dormant: 'home-link' }], slotExtra: i }));
  background.swiperConfig.list = Array.from({ length: 2 }, (_, i) => ({ ...structuredClone(background.swiperConfig.list[0]), img: f.platformImage.url, imgTitle: `背景图${i + 1}`, slotExtra: i }));
  for (const [i, tab] of home.tabListConfig.list.entries()) {
    tab.text.val = ['微页一', '分类一', '待选一', '待选二'][i]; tab.authorExtra = { retained: i };
    tab.microPage.dormant = 'micro-slot-kept'; tab.classPage.dormant = 'category-slot-kept';
  }
  home.tabListConfig.list[1].dataType.tabVal = 1;
  if (micro) {
    home.numConfig.val = 0; home.inputConfig.value = '导入原提示文字'; home.contentConfig.val = ' 12.5 ';
    home.filletImg.type = true; home.filletImg.val = ' 1e-3 ';
    home.filletImg.valList = [{ val: '0.0005' }, { val: ' 2.25 ' }, { val: '3e0' }, { val: 4.75 }];
    home.hotWords.list = Array.from({ length: 23 }, (_, i) => ({ val: `导入热词${i + 1}`, originalIndex: i }));
    home.tabListConfig.list[0].dataType.tabVal = '0'; home.tabListConfig.list[0].microPage.id = '2';
    home.tabListConfig.list[1].dataType.tabVal = '1'; home.tabListConfig.list[1].classPage.id = String(DIY_CAROUSEL_AUTHOR_IDS.categoryChild);
    background.topConfig.val = '1e30'; background.prConfig.val = ' 12.5 '; background.imgConfig.val = '0.0005';
    background.filletImg.type = true; background.filletImg.valList = [{ val: ' 1.25 ' }, { val: '2e0' }, { val: 3.5 }, { val: ' 4.75 ' }];
    legacy.itemEdge.val = ' 17.25 '; legacy.lrConfig.val = '2e0'; legacy.mbConfig.val = ' 0.0005 ';
    legacy.swiperConfig.list = Array.from({ length: 27 }, (_, i) => ({ ...structuredClone(legacy.swiperConfig.list[i % 2]), img: i === 26 ? f.secondIcon.url : f.platformImage.url, originalIndex: i }));
  }
  const hidden = carouselAuthorBlock('homeComb', 25); hidden.isHide = true; hidden.numConfig.val = 101;
  const title = { name: 'titles', timestamp: 10, titleConfig: { value: micro ? '轮播作者导入微页正文' : '轮播作者首页正文' }, fontSize: { val: 18 }, independent: 'retain-title' };
  const neighbor = { name: 'unsupported-carousel-neighbor', timestamp: 35, opaque: { zero: 0, list: [] }, preserve: 'whole-object' };
  return [home, title, background, legacy, ...(micro ? [hidden] : []), neighbor, diyFooterBlock(f.platformImage.url)];
}
export function expectedCarouselRootEdit(f: Images, baseline = carouselAuthorBlocks(f)): Row[] {
  const value = structuredClone(baseline), home = value.find(r => r.name === 'homeComb')!, bg = value.find(r => r.name === 'swiperBg')!, legacy = value.find(r => r.name === 'swipers')!;
  home.styleConfig.tabVal = 1; home.searchConfig.tabVal = 1; home.inputConfig.value = '轮播作者搜索'; home.logoConfig.url = f.secondIcon.url;
  home.hotWords.list[0].val = '作者热词25'; home.numConfig.val = 4; home.contentConfig.val = 22;
  home.tabListConfig.list[0].text.val = '作者微页'; home.tabListConfig.list[1].text.val = '作者分类';
  Object.assign(home.tabListConfig.list[0].microPage, { id: 2, name: '轮播作者微页' });
  Object.assign(home.tabListConfig.list[1].classPage, { id: DIY_CAROUSEL_AUTHOR_IDS.categoryChild, name: '作者子分类' });
  home.swiperConfig.list[0].img = f.secondIcon.url; home.swiperConfig.list[0].info[0].value = '作者图'; home.swiperConfig.list[0].info[1].value = '/pages/user/index';
  bg.styleConfig.tabVal = 2; bg.swiperConfig.list[0].img = f.secondIcon.url; bg.swiperConfig.list[0].info[0].value = `/pages/goods_details/index?id=${DIY_CAROUSEL_AUTHOR_IDS.product}`;
  bg.docConfig.tabVal = 3; bg.docPosition.tabVal = 2; bg.toneConfig.tabVal = 1; bg.dotColor.color[0].item = '#123456'; bg.dotBgColor.color[0].item = '#abcdef';
  bg.imgConfig.val = 6; bg.filletImg.type = 1; bg.filletImg.valList = [{ val: 1 }, { val: 2 }, { val: 3 }, { val: 4 }];
  legacy.swiperConfig.list[0].img = f.secondIcon.url; legacy.swiperConfig.list[0].info[1].title = '/pages/index/index'; legacy.mbConfig.val = 8;
  return value;
}
export function expectedCarouselAlternateEdit(f: Images, baseline = expectedCarouselRootEdit(f)): Row[] {
  const value = structuredClone(baseline), home = value.find(r => r.name === 'homeComb')!, bg = value.find(r => r.name === 'swiperBg')!, legacy = value.find(r => r.name === 'swipers')!;
  home.styleConfig.tabVal = 0; home.classConfig.tabVal = 1; bg.styleConfig.tabVal = 1; bg.toneConfig.tabVal = 0; legacy.tabConfig.tabVal = 0; legacy.docConfig.type = 1;
  return value;
}
export function expectedCarouselMicroEdit(f: Images, baseline = carouselAuthorBlocks(f, true)): Row[] {
  const value = structuredClone(baseline); value.find(r => r.name === 'swiperBg')!.swiperConfig.list[0].imgTitle = '微页保留'; return value;
}

/** Reuses the prior full owned catalog/role/media fixture; no old default,
 * production DDL, permission policy or service is modified by this extension. */
export async function diyCarouselAuthorFixture(now = new Date(), options: { namespace?: 'public' } = {}) {
  const f = await diyNavigationAuthorFixture(now, options);
  try {
    const before = await f.snapshot(), resourcesBefore = f.resources(), rootBlocks = carouselAuthorBlocks(f), microBlocks = carouselAuthorBlocks(f, true);
    // The reused Admin catalog seed predates public category navigation. Keep
    // that historical fixture unchanged and give this child its real depth.
    await f.db.update(storeProductCategory).set({ level: 1, path: String(DIY_CAROUSEL_AUTHOR_IDS.categoryRoot) })
      .where(eq(storeProductCategory.id, DIY_CAROUSEL_AUTHOR_IDS.categoryChild));
    for (const id of [1, 2]) await f.db.update(systemDise).set({ name: id === 1 ? '轮播作者首页' : '轮播作者微页', title: id === 1 ? '轮播作者首页' : '轮播作者导入微页',
      value: JSON.stringify(id === 1 ? rootBlocks : microBlocks), content: `independent-carousel-author-content-${id}`, version: 'carousel-author-initial' }).where(eq(systemDise.id, id));
    const tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(r => r.name);
    const sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(r => r.name);
    async function snapshot() {
      const result = await f.snapshot();
      if (Object.keys(result).length !== tables.length + 1 || result.__sequences.length !== sequences.length) throw Error('Carousel full inventory changed');
      return sortedDiyState(result);
    }
    const carouselAuthorSetup = { phase: 'owned modern2 literaldefaults, explicit legacyimport page and valid public-category identity setup; separate from GUI writes and measured GET',
      before, after: await snapshot(), resources_before: resourcesBefore, resources_after: f.resources(), tables, sequences,
      public_category_setup: { id: DIY_CAROUSEL_AUTHOR_IDS.categoryChild, pid: DIY_CAROUSEL_AUTHOR_IDS.categoryRoot, level: 1, path: String(DIY_CAROUSEL_AUTHOR_IDS.categoryRoot),
        authority: 'Owned carousel fixture only; actual publicCategoryIdentitySql still validates the complete visible platform ancestry.' },
      previous_navigation_catalog_setup: f.navigationAuthorSetup, initial_component_shapes: [...DIY_CAROUSEL_AUTHOR_NAMES], legacy_ordinary_new_default: false };
    return { ...f, tables, sequences, snapshot, rootBlocks, microBlocks, carouselAuthorSetup };
  } catch (reason) { await f.close(); throw reason; }
}
