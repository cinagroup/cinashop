import { and, eq, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { vi } from 'vitest';
import type { Env } from '@/env';
import { articleCategory, articleContent, memberRight, storeProduct, storeProductLabel, storePromotions,
  storePromotionsAuxiliary, systemArticle, systemConfig, systemDise, wechatNewsCategory } from '@/models/schema';
import { AttachmentService, adminAttachmentScope } from '@/services/system/AttachmentService';
import { advanceRateWindows, type RateLimitPolicy, type RateWindow } from '@/services/out/OutRateLimitPolicy';
import { diyCommerceFixture, DIY_COMMERCE_NOW } from './diyCommerceFixture';
import { diyStateBlocks, sortedDiyState, type DiyStateRow, type DiyStateSnapshot } from './diyStateFixture';

export { DIY_COMMERCE_NOW as DIY_EDITORIAL_NOW };
export const DIY_EDITORIAL_FAMILIES = ['goodList', 'articleList', 'news', 'hotspot', 'follow', 'activeParty'] as const;
const colour = (a: string, b = a) => ({ color: [{ item: a }, { item: b }] });

/** Persisted Admin fields from the six source components. activeParty follows
 * the existing Admin contract; the PHP UniApp has no activeParty renderer. */
export function diyEditorialBlocks(image = '/static/logo.png'): DiyStateRow[] {
  const common = { ...structuredClone(diyStateBlocks()[1]), topConfig: { val: 6 }, bottomConfig: { val: 8 },
    prConfig: { val: 10 }, mbConfig: { val: 7 }, filletImg: { type: 1, valList: [2, 4, 6, 8].map(val => ({ val })) } };
  const info = (title: string, description: string, link: string) => [{ title: '标题', value: title }, { title: '简介', value: description }, { title: '链接', value: link }];
  return [{ name: 'titles', timestamp: 1, titleConfig: { value: '真实商品与编辑内容' } },
    ...[0, 1, 2, 3, 4, 5].map(style => ({ ...structuredClone(common), name: 'goodList', timestamp: 501 + style,
      typeConfig: { activeValue: [1, 2, 3, 4, 1, 1][style] }, styleConfig: { tabVal: style }, goodsSort: { tabVal: style % 3 },
      goodsList: { ids: style === 5 ? [602, 603, 604, 605] : [601, 611], list: [{ id: 601 }, { id: 611 }] },
      brandList: { brandVal: [703] }, classList: { classVal: [701] }, goodsLabel: { activeValue: [704] }, numberConfig: { val: style === 5 ? 4 : 2 },
      checkboxInfo: { type: [0, 1, 2, 3, 4, 5] }, goodsName: { tabVal: 1 }, goodsNameColor: colour('#243c54'),
      goodsPriceColor: colour('#a24c17'), soldNumColor: colour('#6b7280'), scoreColor: colour('#375a7f'),
      cartConfig: { tabVal: 1 }, bntConfig: { tabVal: 0 }, bntStyleConfig: { tabVal: 1 }, toneCartConfig: { tabVal: 1 } })),
    ...[0, 1, 2].map(style => ({ ...structuredClone(common), name: 'articleList', timestamp: 511 + style,
      styleConfig: { tabVal: style }, selectConfig: { activeValue: style === 2 ? 812 : 811 }, numConfig: { val: 2 },
      checkboxList: { type: [0, 1, 2] }, nameConfig: { tabVal: style % 2 }, nameColor: colour('#243c54'),
      timeColor: colour('#64748b'), browseColor: colour('#375a7f'), likeColor: colour('#a24c17'), statisticColor: colour('#64748b'), bgColor: colour('#ffffff', '#eaf0f7') })),
    ...[0, 1].map(style => ({ ...structuredClone(common), name: 'news', timestamp: 521 + style,
      styleConfig: { tabVal: style }, titleConfig: { tabVal: 1 }, titleTxtConfig: { value: `真实公告${style}` },
      imgConfig: { url: image }, rollConfig: { tabVal: style }, buttonConfig: { tabVal: 0 }, linkConfig: { value: '/pages/article/list' },
      newsColor: colour('#375a7f'), titleBgColor: colour('#eaf0f7', '#dce6ef'), listConfig: { list: [
        { show: true, chiild: [{ val: '真实文章入口801' }, { val: '/pages/article/detail?id=801' }] },
        { show: false, chiild: [{ val: '隐藏公告旁观' }, { val: '/pages/article/detail?id=804' }] },
        { show: true, chiild: [{ val: '真实商品入口601' }, { val: '/pages/goods/detail?id=601' }] },
      ] } })),
    ...[0, 1].map(style => ({ ...structuredClone(common), name: 'hotspot', timestamp: 531 + style,
      picStyle: { url: image, list: [
        { number: 1, starX: 0, starY: 0, areaWidth: 300, areaHeight: 200, link: '/pages/article/list' },
        { number: 2, starX: 300, starY: 0, areaWidth: 400, areaHeight: 200, link: '/pages/goods/list?brand_id=703' },
      ] } })),
    ...[0, 1].map(style => ({ ...structuredClone(common), name: 'follow', timestamp: 541 + style,
      titleConfig: { value: `真实公众号${style}` }, imgConfig: { url: image }, codeConfig: { url: style ? '' : image },
      themeColor: colour('#375a7f'), bgColor: colour('#ffffff', '#eaf0f7') })),
    ...[0, 1].map(style => ({ ...structuredClone(common), name: 'activeParty', timestamp: 551 + style,
      titleConfig: { value: `真实活动魔方${style}` }, desConfig: { value: '真实Admin促销简介' },
      themeColor: colour('#375a7f'), bgColor: colour('#eaf0f7', '#dce6ef'), boxColor: colour('#fff5ef'), menuConfig: { list: [
        { img: image, info: info('文章专题', '来自真实持久配置', '/pages/article/list') },
        { img: image, info: info('品牌商品', '筛选真实品牌703', '/pages/goods/list?brand_id=703') },
      ] } })),
  ];
}

// A decodable 32x18 JPEG derived from the checked-in teal fixture. IMAGES below
// deliberately returns fixed pixels: SQL/R2 boundaries and explicit generation
// are real, but this is not a claim about Cloudflare's raster composition.
const POSTER_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAASACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDntPsrSXT7i7vrieKOOVIgsMQcksGOeWXH3P1p3laL/wA/mpf+Aif/ABypNN+zz6Ld2k15BaytcRSr5wfDBVkB+6p/vCo/7Ltv+g1pv5Tf/G69a+p+eqK5VZL7/wDgh5Wi/wDP5qX/AICJ/wDHKbqFlaRafb3djcTyxySvEVmiCEFQpzwzZ+/+lO/su2/6DWm/lN/8bqTUvs8Gi2lpDeQXUq3EsreSHwoZYwPvKP7povqDiuV3S+//AIJj0UUVZgFFFFAH/9k=';

/** Extends the owned 46-table/43-sequence fixture. No production schema or ACL
 * changes are made. Article details/likes are deliberately not used to hydrate. */
export async function diyEditorialFixture(now = new Date(), options: { namespace?: 'public' } = {}) {
  const f = await diyCommerceFixture(now, options);
  try {
    const dialect = new PgDialect();
    for (const table of [systemArticle, articleCategory, articleContent, wechatNewsCategory] as PgTable[]) {
      const definition = getTableConfig(table);
      if (f.tables.includes(definition.name)) throw Error(`Unexpected existing editorial table ${definition.name}`);
      const columns = definition.columns.map(column => {
        const initial = column.default;
        const initialSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${initialSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
      });
      await f.exec(`create table "${definition.name}" (${columns.join(', ')})`);
    }
    const platformImage = await new AttachmentService(f.container, f.env).uploadImage(adminAttachmentScope(), new File([f.png], 'diy-editorial.png', { type: 'image/png' }), 0);
    await f.db.insert(articleCategory).values([{ id: 811, title: '真实编辑分类811', sort: 10 }, { id: 812, title: '真实第二分类812', sort: 9 }]);
    await f.db.insert(systemArticle).values([
      { id: 801, cid: 811, title: '真实零访问文章801', visit: 0, likes: 0, addTime: f.seconds - 60, imageInput: `${platformImage.url},/static/logo.png`, url: '/pages/article/list' },
      { id: 802, cid: 811, title: '真实较旧文章802', visit: 12, likes: 3, addTime: f.seconds - 120, imageInput: '/static/logo.png', url: 'javascript:must-not-publish' },
      { id: 803, cid: 812, title: '真实第二分类文章803', visit: 7, likes: 2, addTime: f.seconds - 60, imageInput: platformImage.url },
      { id: 804, cid: 811, title: '隐藏文章旁观804', hide: 1 }, { id: 805, cid: 811, title: '停用文章旁观805', status: 0 },
      { id: 806, cid: 811, title: '删除文章旁观806', isDel: 1 },
      { id: 807, cid: 811, title: '公众号独占文章旁观807' }, { id: 808, cid: 811, title: '公众号零前缀文章旁观808' },
    ].map(row => ({ ...row, addTime: row.addTime ?? f.seconds, content: '', synopsis: `真实摘要${row.id}` })));
    await f.db.insert(articleContent).values({ nid: 801, content: `<p>真实编辑正文801</p><img src="${platformImage.url}">` });
    await f.db.insert(wechatNewsCategory).values({ id: 821, cateName: '公众号素材', newId: '807, 000808 ,invalid,,0,999999999999999999999' });
    await f.db.update(storeProduct).set({ star: '4.5', isVip: 1, vipPrice: '0.00' }).where(eq(storeProduct.id, 601));
    await f.db.update(storeProduct).set({ isVip: 1, vipPrice: '6.50' }).where(eq(storeProduct.id, 611));
    await f.db.update(storeProductLabel).set({ icon: platformImage.url, type: 0, relationId: 0 }).where(eq(storeProductLabel.id, 704));
    await f.db.update(systemConfig).set({ value: '1' }).where(eq(systemConfig.menuName, 'member_card_status'));
    await f.db.update(systemConfig).set({ value: '1' }).where(eq(systemConfig.menuName, 'svip_price_status'));
    await f.db.insert(memberRight).values({ rightType: 'vip_price', title: '真实SVIP价格权益', number: 1, status: 1 });
    await f.db.insert(systemConfig).values({ menuName: 'wechat_qrcode', value: JSON.stringify(platformImage.url), isStore: 0, status: 1 });
    await f.db.insert(storePromotions).values({ id: 831, promotionsType: 5, name: '真实商品活动边框831', image: '/static/logo.png',
      productPartakeType: 2, startTime: f.seconds - 3600, stopTime: f.seconds + 3600, updateTime: f.seconds, status: 1, isDel: 0 });
    await f.db.insert(storePromotionsAuxiliary).values({ promotionsId: 831, productPartakeType: 2, productId: 601 });
    const blocks = diyEditorialBlocks(platformImage.url);
    for (const id of [1, 2]) await f.db.update(systemDise).set({ title: `真实编辑组件${id === 1 ? '首页' : '微页面'}`, version: 'diy-editorial-1', value: JSON.stringify(blocks) }).where(eq(systemDise.id, id));
    const metadata = new Map<string, R2PutOptions>();
    f.env.ASSETS_BUCKET = { ...f.bucket,
      get: async (key: string, options?: R2GetOptions) => {
        const item = await f.bucket.get(key, options);
        return item ? { ...item, customMetadata: metadata.get(key)?.customMetadata, body: new Response(item.body).body } : null;
      },
      put: async (key: string, body: BodyInit, options?: R2PutOptions) => {
        const result = await f.bucket.put(key, body, options); if (options) metadata.set(key, options); return result;
      },
    } as unknown as R2Bucket;
    const posterBytes = Uint8Array.from(atob(POSTER_JPEG), value => value.charCodeAt(0));
    const rendering = { info: vi.fn(async () => ({ format: 'image/png', width: 500, height: 720 })),
      input: vi.fn(), transform: vi.fn(), draw: vi.fn(), output: vi.fn(async () => ({ response: () => new Response(posterBytes, { headers: { 'Content-Type': 'image/jpeg' } }) })) };
    const imageHandle = { transform: rendering.transform, draw: rendering.draw, output: rendering.output };
    rendering.input.mockImplementation(() => imageHandle); rendering.transform.mockImplementation(() => imageHandle); rendering.draw.mockImplementation(() => imageHandle);
    f.env.IMAGES = rendering as unknown as Env['IMAGES'];
    // The inherited upload-only binding assumes an 'upload' policy. Follow has
    // its own poster budget and must exercise the real generic policy logic.
    const budgets = new Map<string, Record<string, RateWindow>>();
    f.env.TOKEN_BUCKET = { getByName: vi.fn((name: string) => ({
      consumeRateLimit: async (policies: RateLimitPolicy[], seconds: number) => {
        const next = advanceRateWindows(budgets.get(name) ?? {}, policies, Date.now(), seconds);
        budgets.set(name, next.windows); return next.decision;
      },
    })) } as unknown as Env['TOKEN_BUCKET'];
    const tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row => row.name);
    const sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row => row.name);
    async function snapshot(): Promise<DiyStateSnapshot> {
      const state: DiyStateSnapshot = {};
      for (const row of await f.db.execute<{ name: string; rows: DiyStateRow[] }>(sql.join(tables.map(name =>
        sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `))) state[row.name] = row.rows;
      state.__sequences = await f.db.execute(sql.join(sequences.map(name =>
        sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `));
      return sortedDiyState(state);
    }
    async function setConfig(menuName: string, value: string) {
      const before = await snapshot();
      await f.db.update(systemConfig).set({ value }).where(and(eq(systemConfig.menuName, menuName), eq(systemConfig.isStore, 0)));
      f.cache.delete(`cfg_${menuName}`); return { before, after: await snapshot(), menuName, value };
    }
    async function saveSchema(id: 1 | 2, value: unknown[]) {
      const before = await snapshot(), saved = await f.saveSchema(id, value); return { ...saved, before, after: await snapshot() };
    }
    return { ...f, blocks, tables, sequences, snapshot, setConfig, saveSchema, platformImage, rendering, posterBytes,
      seedStorage: { puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length, keys: [...f.objects.keys()] },
      ids: { ...f.ids, article: 801, secondArticle: 802, otherArticle: 803, articleCategory: 811, otherArticleCategory: 812, frame: 831 } };
  } catch (error) { await f.close(); throw error; }
}
