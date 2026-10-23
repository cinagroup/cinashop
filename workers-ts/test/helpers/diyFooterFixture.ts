import { eq } from 'drizzle-orm';
import { storeCart, systemConfig, systemDise } from '@/models/schema';
import { diyCarouselFixture, DIY_CAROUSEL_NOW } from './diyCarouselFixture';
import type { DiyStateRow } from './diyStateFixture';

export { DIY_CAROUSEL_NOW as DIY_FOOTER_NOW };
const colour = (item: string) => ({ color: [{ item }] });
/** Actual PHP pageFooter/c_foot fields. Five is the visual editor's add limit;
 * imported lists are not silently clipped by this fixture or public policy. */
export function diyFooterBlock(image = '/static/logo.png'): DiyStateRow {
  return { name: 'pageFoot', timestamp: 900, effectConfig: { tabVal: 1 }, navConfig: { tabVal: 0 }, navStyleConfig: { tabVal: 0 },
    toneConfig: { tabVal: 1 }, activeTxtColor: colour('#375a7f'), txtColor: colour('#64748b'), bgColor: colour('#ffffff'), bgColor2: colour('#eaf0f7'),
    topConfig: { val: 6 }, bottomConfig: { val: 8 }, prConfig: { val: 10 }, mbConfig: { val: 7 },
    fillet: { type: 1, val: 8, valList: [2, 4, 6, 8].map(val => ({ val })) },
    menuList: ['/pages/index/index', '/pages/goods_cate/goods_cate', '/pages/discoverIndex/index', '/pages/order_addcart/order_addcart', '/pages/user/index']
      .map((link, index) => ({ name: ['首页', '分类', '发现', '购物车', '我的'][index], link, imgList: [image, image] })) };
}

/** Additional owned setup only: actual createApp/JWT/AttachmentService/Admin
 * transaction and the inherited full50-table/46-sequence snapshot. No new DDL,
 * endpoint or ACL. Second included cart intentionally has nonstandard product,
 * staff/store/type/activity fields: PHP's badge is strictly actor/flags only. */
export async function diyFooterFixture(now = new Date(), options: { namespace?: 'public' } = {}) {
  const f = await diyCarouselFixture(now, options);
  try {
    const blocks = [{ name: 'titles', timestamp: 1, titleConfig: { value: '真实页脚合同' } }, diyFooterBlock(f.platformImage.url)];
    for (const id of [1, 2]) await f.db.update(systemDise).set({ value: JSON.stringify(blocks), version: 'diy-footer-1' }).where(eq(systemDise.id, id));
    await f.db.delete(storeCart);
    const carts = [
      { id: 9101, uid: 11, cartNum: 3 },
      { id: 9102, uid: 11, cartNum: 4, productId: 999999, type: 2, activityId: 777, staffId: 91, storeId: 7, touristUid: 'owned-footer' },
      { id: 9103, uid: 11, cartNum: 9, status: 0 }, { id: 9104, uid: 11, cartNum: 8, isPay: 1 },
      { id: 9105, uid: 11, cartNum: 7, isDel: 1 }, { id: 9106, uid: 11, cartNum: 6, isNew: 1 }, { id: 9107, uid: 22, cartNum: 4 },
    ].map(row => ({ productId: 601, productAttrUnique: 'fixture-footer', type: 0, isPay: 0, isNew: 0, isDel: 0, status: 1, ...row }));
    await f.db.insert(storeCart).values(carts);
    const statisticsScript = 'window.__ownedFooterStatistics = 1;';
    await f.db.insert(systemConfig).values({ menuName: 'system_statistics', value: JSON.stringify(statisticsScript), isStore: 0, status: 1 });
    return { ...f, blocks, carts, statisticsScript };
  } catch (error) { await f.close(); throw error; }
}
