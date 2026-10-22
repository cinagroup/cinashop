import { eq } from 'drizzle-orm';
import { systemConfig, systemDise } from '@/models/schema';
import { diyCarouselFixture, DIY_CAROUSEL_NOW } from './diyCarouselFixture';
import type { DiyStateRow } from './diyStateFixture';

export { DIY_CAROUSEL_NOW as DIY_NAVIGATION_NOW };
export const DIY_NAVIGATION_FAMILIES = ['headerSerch', 'tabNav', 'menus', 'pictureCube'] as const;
const colour = (a: string, b = a) => ({ color: [{ item: a }, { item: b }] });
const destinations = [
  { text: { val: '真实微页', max: 4 }, dataType: { tabVal: 0 }, microPage: { id: 2, name: '真实微页面' }, classPage: { id: 0, name: '' } },
  { text: { val: '真实分类', max: 4 }, dataType: { tabVal: 1 }, microPage: { id: 0, name: '' }, classPage: { id: 701, name: '真实分类701' } },
];

/** Actual PHP Admin search_box/nav_bar/home_menu/picture_cube save fields.
 * All twelve cube layouts are represented; its menuConfig picker is only an
 * editor bridge, and only custom style11 consumes docPicList images. Multiple
 * headers/tabs deliberately exercise imported schema, not the PHP editor's
 * one-header/one-tab placement rules. */
export function diyNavigationBlocks(image = '/static/logo.png'): DiyStateRow[] {
  const images = [image, '/static/logo.png', 'https://images.example.test/navigation.png'];
  const common = { isHide: false, toneConfig: { tabVal: 1 }, topConfig: { val: 6 }, bottomConfig: { val: 8 },
    prConfig: { val: 10 }, mbConfig: { val: 7 }, imgConfig: { val: 4 },
    bottomBgColor: colour('#eaf0f7'), moduleColor: colour('#ffffff', '#eaf0f7'), bgColor: colour('#ffffff', '#eaf0f7'),
    fillet: { type: 1, val: 8, valList: [2, 4, 6, 8].map(val => ({ val })) },
    filletImg: { type: 1, val: 10, valList: [2, 4, 6, 8].map(val => ({ val })) } };
  return [
    { name: 'titles', timestamp: 1, titleConfig: { value: '真实导航调用族' } },
    ...[0, 1, 2].map(style => ({ ...structuredClone(common), name: 'headerSerch', timestamp: 801 + style,
      styleConfig: { tabVal: style }, styleSearchConfig: { tabVal: style }, logoConfig: { url: image, type: 'code', name: 'logo图' },
      titleConfig: { value: '真实商城', max: 6 }, linkConfig: { value: '/pages/article/list' }, tipConfig: { value: '真实搜索词', max: 20 }, numConfig: { val: 3 },
      hotWords: { list: [{ val: '真实品牌' }, { val: '真实分类' }] }, searchBoxColor: colour('#ffffff'), tipColor: colour('#64748b'),
      hotWordsColor: colour('#375a7f'), searchBgColor: colour('#375a7f'), searchTxtColor: colour('#ffffff'), searchColor: colour('#375a7f') })),
    ...[0, 1, 2].map(style => ({ ...structuredClone(common), name: 'tabNav', timestamp: 811 + style,
      styleConfig: { tabVal: style }, stickyConfig: { tabVal: style % 2 }, tabListConfig: { max: 100, list: structuredClone(destinations) },
      textColor: colour('#375a7f'), textColor2: colour('#243c54'), textColor3: colour('#ffffff'),
      decorateColor: colour('#375a7f', '#527da5'), decorateColor2: colour('#375a7f') })),
    ...[0, 1, 2].flatMap(style => [0, 1].map(mode => ({ ...structuredClone(common), name: 'menus', timestamp: 821 + style * 2 + mode,
      menuStyleConfig: { tabVal: style }, number: { tabVal: style }, showConfig: { tabVal: mode }, rowsNum: { tabVal: mode + 1 },
      menuConfig: { maxList: 100, list: images.map((img, index) => ({ img, show: index !== 2,
        info: [{ title: '标题', value: `导航${index}`, max: 4 }, { title: '链接', value: index ? '/pages/goods/list?cate_id=701' : '/pages/article/list', max: 100 }] })) },
      pointerColor: colour('#375a7f'), pointerBgColor: colour('#dce6ef') }))),
    ...[2, 3, 4, 3, 3, 3, 3, 4, 5, 4, 1, 2].map((count, style) => ({ ...structuredClone(common), name: 'pictureCube', timestamp: 841 + style,
      styleConfig: { tabVal: style, count, type: 'pictureCube' }, picStyle: { tabVal: style,
        picList: Array.from({ length: count }, (_, index) => ({ image: images[index % images.length], link: '/pages/article/list' })),
        docPicList: style === 11 ? Array.from({ length: count }, (_, index) => ({ img: images[index % images.length], link: '/pages/article/list',
          doc: { startX: index * 150, startY: 0, w: 150, h: 120 } })) : [] },
      menuConfig: { maxList: 1, isCube: 1, list: [{ img: image, info: [{ title: '链接', value: '/pages/article/list' }] }] } })),
  ];
}

/** Reuses actual createApp/JWT/Admin transaction/AttachmentService setup and
 * its complete 50-table/46-sequence snapshot. No production table/ACL changes. */
export async function diyNavigationFixture(now = new Date()) {
  const f = await diyCarouselFixture(now);
  try {
    const blocks = diyNavigationBlocks(f.platformImage.url);
    const statisticsScript = 'window.__ownedNavigationStatistics = 1;';
    await f.db.insert(systemConfig).values({ menuName: 'system_statistics', value: JSON.stringify(statisticsScript), isStore: 0, status: 1 });
    for (const id of [1, 2]) await f.db.update(systemDise).set({ title: `真实导航${id === 1 ? '首页' : '微页面'}`,
      version: 'diy-navigation-1', value: JSON.stringify(blocks) }).where(eq(systemDise.id, id));
    return { ...f, blocks, statisticsScript };
  } catch (error) { await f.close(); throw error; }
}
