import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppVariables, Env } from '@/env';
import { adminDiseSave } from '@/controllers/api/v1/AdminCrudController';
import { errorHandler } from '@/middleware/error';
import { systemDise } from '@/models/schema';
import { diyEditorialFixture, DIY_EDITORIAL_NOW } from './diyEditorialFixture';
import type { DiyStateRow } from './diyStateFixture';

export { DIY_EDITORIAL_NOW as DIY_CAROUSEL_NOW };
export const DIY_CAROUSEL_FAMILIES = ['swipers', 'swiperBg', 'homeComb'] as const;
const colour = (item: string) => ({ color: [{ item }] });

/** PHP's persisted fields. homeComb's background follows its selected slide;
 * its category/menu entries are text and typed destinations, not image slots. */
export function diyCarouselBlocks(image = '/static/logo.png'): DiyStateRow[] {
  const slides = () => [
    { img: image, imgTitle: '真实首张轮播', info: [{ title: '链接', value: '/pages/article/list' }, { title: '/pages/goods/list?brand_id=703', value: '/pages/goods/list?brand_id=703' }] },
    { img: '/static/logo.png', imgTitle: '真实静态轮播', info: [{ title: '链接', value: '/pages/goods/list?cate_id=701' }, { title: '/pages/article/list', value: '/pages/article/list' }] },
    { img: 'https://images.example.test/carousel.png', imgTitle: '真实外部图片', info: [{ title: '链接', value: '/pages/article/list' }, { title: '/pages/article/list', value: '/pages/article/list' }] },
  ];
  return [
    { name: 'titles', timestamp: 1, titleConfig: { value: '真实轮播调用族' } },
    ...[0, 1].map(style => ({ name: 'swipers', timestamp: 701 + style, isHide: false,
      swiperConfig: { list: slides() }, tabConfig: { tabVal: style }, docConfig: { type: style },
      imgConfig: { type: style }, itemEdge: { val: 28 }, lrConfig: { val: 12 }, mbConfig: { val: 9 } })),
    ...[0, 1, 2].map(style => ({ name: 'swiperBg', timestamp: 711 + style, isHide: false,
      swiperConfig: { maxList: 10, list: slides() }, styleConfig: { tabVal: style }, docConfig: { tabVal: style }, docPosition: { tabVal: style },
      toneConfig: { tabVal: 1 }, bgColor: colour('#eaf0f7'), dotColor: colour('#375a7f'), dotBgColor: colour('#dce6ef'),
      topConfig: { val: 6 }, bottomConfig: { val: 8 }, prConfig: { val: 10 }, mbConfig: { val: 7 }, imgConfig: { val: 4 }, filletImg: { val: 12 } })),
    ...[0, 1].map(style => ({ name: 'homeComb', timestamp: 721 + style, isHide: false,
      swiperConfig: { maxList: 10, list: slides() }, logoConfig: { url: image, type: 'code', name: 'logo图' },
      styleConfig: { tabVal: style }, classConfig: { tabVal: style }, searchConfig: { tabVal: style },
      inputConfig: { value: '请输入真实搜索词', max: 10 }, numConfig: { val: 3 }, hotWords: { list: [{ val: '真实品牌' }, { val: '真实分类' }] },
      tabListConfig: { max: 100, list: [
        { text: { val: '真实微页', max: 4 }, dataType: { tabVal: 0 }, microPage: { id: 2, name: '真实微页面' }, classPage: { id: 0, name: '' } },
        { text: { val: '真实分类', max: 4 }, dataType: { tabVal: 1 }, microPage: { id: 0, name: '' }, classPage: { id: 701, name: '真实分类701' } },
      ] }, contentConfig: { val: 20 }, classColor: colour('#375a7f'), docConfig: { tabVal: style ? 3 : 2 }, docPosition: { tabVal: style },
      toneConfig: { tabVal: 1 }, dotColor: colour('#375a7f'), dotBgColor: colour('#dce6ef'),
      filletImg: { type: 1, val: 10, valList: [2, 4, 6, 8].map(val => ({ val })) } })),
  ];
}

/** Reuses real createApp/JWT/Admin parser/AttachmentService and the complete
 * owned 50-table/46-sequence snapshot. No new schema or production ACL exists. */
export async function diyCarouselFixture(now = new Date(), options: { namespace?: 'public' } = {}) {
  const f = await diyEditorialFixture(now, options);
  try {
    const blocks = diyCarouselBlocks(f.platformImage.url);
    for (const id of [1, 2]) await f.db.update(systemDise).set({ title: `真实轮播${id === 1 ? '首页' : '微页面'}`,
      version: 'diy-carousel-1', value: JSON.stringify(blocks) }).where(eq(systemDise.id, id));
    // This fixture-only host keeps the actual controller/parser/transaction and
    // production error envelope, including atomic over-budget rejections. It
    // does not replace or claim the production Admin authentication policy.
    const admin = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    admin.onError(errorHandler);
    admin.use('*', async (c, next) => { c.set('container', f.container); await next(); });
    admin.post('/owned-dise-save', adminDiseSave);
    async function saveSchema(id: 1 | 2, value: unknown[]) {
      const before = await f.snapshot();
      const response = await admin.request('/owned-dise-save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, value: JSON.stringify(value) }) }, f.env);
      const body = await response.json() as DiyStateRow;
      return { before, after: await f.snapshot(), response, body };
    }
    return { ...f, blocks, saveSchema };
  } catch (error) { await f.close(); throw error; }
}
