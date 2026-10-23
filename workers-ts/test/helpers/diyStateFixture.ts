import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppVariables, Env } from '@/env';
import { communityVideoFixture } from './communityVideoFixture';
import { AttachmentService, userAttachmentScope } from '@/services/system/AttachmentService';
import { adminDiseSave } from '@/controllers/api/v1/AdminCrudController';
import { community, communityUser, systemConfig, systemDise, systemUserLevel, user, userFriends, video,
  storeCouponIssue, storeCouponUser, storeCouponProduct, storeNewcomer, storeOrder, memberRight,
  userSign, systemSignReward, systemStore, systemSupplier, storeBrand, storeProductLabel,
  storePromotions, storePromotionsAuxiliary, storeProductRelation, storeSeckill, storeSeckillTime,
  storeCombination, storeBargain, storeProduct, userRelation, storeProductLog } from '@/models/schema';

export const DIY_STATE_NOW = new Date('2026-10-21T02:00:00.000Z');
export type DiyStateViewer = 0 | 11 | 22;
export type DiyStateRow = Record<string, any>;
export type DiyStateSnapshot = Record<string, DiyStateRow[]>;
export const stableDiyState = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const sortedDiyState = (value: DiyStateSnapshot): DiyStateSnapshot => Object.fromEntries(Object.entries(value)
  .map(([name, rows]) => [name, rows.slice().sort((a, b) => stableDiyState(a).localeCompare(stableDiyState(b)))]));
const colour = (a: string, b = a) => ({ color: [{ item: a }, { item: b }] });
/** Actual Admin-authored field names, not a browser business-operation bridge. */
export function diyStateBlocks() {
  const block = (name: string, timestamp: number, style: number) => ({ name, timestamp, isHide: 0,
    styleConfig: { tabVal: style }, checkboxInfo: { type: name === 'userInfor' ? [0, 1, 2, 3, 4, 5] : [0, 1, 2] },
    logoConfig: { url: '/static/logo.png' }, titleConfig: { tabVal: style }, titleTxtConfig: { value: `实际${style ? '拼贴' : '分组'}排行榜` },
    imgConfig: { url: '/static/logo.png' }, rightBntConfig: { value: '更多真实榜单' }, titleText: { tabVal: 0 }, titleNumber: { val: 16 }, bntNumber: { val: 12 },
    toneConfig: { tabVal: 1 }, toneCouponConfig: { tabVal: 1 }, toneGoodsConfig: { tabVal: 1 },
    fillet: { type: 1, val: 8, valList: [4, 6, 8, 10].map(val => ({ val })) },
    filletBg: { type: 1, val: 8, valList: [3, 5, 7, 9].map(val => ({ val })) }, filletImg: { type: 0, val: 8 },
    topConfig: { val: 8 }, bottomConfig: { val: 8 }, prConfig: { val: 10 }, mbConfig: { val: 6 },
    spacingConfig: { val: 5 }, spacingConfig2: { val: 9 }, bottomBgColor: colour('#f3f6fa'),
    moduleColor: colour('#ffffff', '#eef4fa'), moduleColor2: colour('#fff5ef', '#f0f7fe'), listBgColor: colour('#ffffff', '#eff3f8'),
    progressBgColor: colour('#dce6ef'), progressColor: colour('#375a7f', '#7698ba'), titleColor: colour('#243c54'), headerBntColor: colour('#375a7f'),
    bntBgColor: colour('#375a7f', '#527da5'), bntColor: colour('#375a7f', '#527da5'), bntTxtColor: colour('#ffffff'),
    integralBgColor: colour('#eaf0f7'), integralTxtColor: colour('#375a7f'), tipsColor: colour('#375a7f'),
    couponBgColor: colour('#fff5e9', '#ffead1'), couponBgColor2: colour('#fff8ef'), couponMoneyColor: colour('#a24c17'),
    couponTypeColor: colour('#6b4b35'), vipBgColor: colour('#fff8ef', '#ffebd2'), priceColor: colour('#a24c17'),
    goodsPriceColor: colour('#a24c17'), classColor: colour('#375a7f'), labelTxtColor: colour('#375a7f'), labelBgColor: colour('#eaf0f7') });
  return [{ name: 'titles', timestamp: 1, titleConfig: { value: '保留商城内容' } },
    ...['userInfor', 'newVip', 'signIn', 'ranking'].flatMap((name, i) => [block(name, 101 + i * 2, 0), block(name, 102 + i * 2, 1)]),
    { name: 'community', timestamp: 201, numberConfig: { val: 1 }, styleConfig: { tabVal: 0 }, titleConfig: { tabVal: 1 },
      titleTxtConfig: { value: '保留社区预览' }, rightBntConfig: { value: '更多社区' }, fillet: { type: 0, val: 8 }, filletImg: { type: 0, val: 8 },
      topConfig: { val: 6 }, bottomConfig: { val: 6 }, prConfig: { val: 10 }, mbConfig: { val: 6 }, moduleColor: colour('#ffffff'), bottomBgColor: colour('#f3f6fa') }];
}

/** Owned historical fixture; it does not install or claim production runtime ACLs. */
export async function diyStateFixture(now = new Date(), options: { namespace?: 'public' } = {}) {
  const extraTables = [userFriends, systemUserLevel, video, systemDise, storeCouponIssue, storeCouponUser, storeCouponProduct,
    storeNewcomer, storeOrder, memberRight, userSign, systemSignReward, systemStore, systemSupplier, storeBrand, storeProductLabel,
    storePromotions, storePromotionsAuxiliary, storeProductRelation, storeSeckill, storeSeckillTime, storeCombination, storeBargain];
  const f = await communityVideoFixture(extraTables, options);
  try {
    const png = new Uint8Array(await readFile(resolve(import.meta.dirname, '../fixtures/community-teal.png')));
    const image = await new AttachmentService(f.container, f.env).uploadImage(userAttachmentScope(11), new File([png], 'diy-state.png', { type: 'image/png' }), 0);
    const seconds = Math.floor(now.getTime() / 1000), shanghaiDay = Math.floor((seconds + 28800) / 86400) * 86400 - 28800;
    const local = new Date(now.getTime() + 28800_000), weekIndex = (local.getUTCDay() + 6) % 7, monday = shanghaiDay - weekIndex * 86400;
    await f.db.update(user).set({ nickname: '零值会员11', phone: '13900000011', avatar: '/static/logo.png', nowMoney: '0.00', integral: 0,
      exp: '0.00', level: 1, levelStatus: 1, isNewcomer: 0, addTime: seconds - 86400 }).where(eq(user.uid, 11));
    await f.db.update(user).set({ nickname: '另一会员22', phone: '13900000022', avatar: '/static/logo.png', nowMoney: '88.00', integral: 50,
      exp: '50.00', level: 2, levelStatus: 1, isNewcomer: 1, addTime: seconds - 86400 }).where(eq(user.uid, 22));
    await f.db.insert(systemUserLevel).values([
      { id: 1, name: '蓝色会员', grade: 1, color: '#375a7f', isShow: 1, isDel: 0, expNum: 100, discount: '100.00' },
      { id: 2, name: '绿色会员', grade: 2, color: '#246e49', isShow: 1, isDel: 0, expNum: 200, discount: '100.00' },
    ]);
    const settings = { station_open: '1', community_status: '1', community_comment_status: '1', community_comment_add: '1',
      community_comment_verify: '0', video_func_status: '1', member_func_status: '1', member_card_status: '0', svip_price_status: '0',
      newcomer_status: '1', register_integral_status: '1', register_give_integral: '0', register_coupon_status: '1',
      register_give_coupon: '[81,82]', register_price_status: '1', newcomer_limit_status: '1', newcomer_limit_time: '30',
      sign_mode: '1', sign_status: '1', sign_give_point: '0', sign_give_exp: '2', routine_contact_type: '0',
      site_name: '"DIY数据组件验收"', wap_login_logo: '""', image_thumb_status: '0' };
    await f.db.insert(systemConfig).values(Object.entries(settings).map(([menuName, value]) => ({ menuName, value, isStore: 0, status: 1 })));
    await f.db.insert(storeCouponIssue).values([
      { id: 81, couponTitle: '真实零元金额券', couponType: 0, type: 1, couponPrice: '0.00', useMinPrice: '0.00', remainCount: 20, receiveType: 2, status: 1 },
      { id: 82, couponTitle: '真实九折商品券', couponType: 2, type: 2, couponPrice: '90.00', useMinPrice: '10.00', productId: '301', remainCount: 20, receiveType: 2, status: 1 },
    ]);
    await f.db.insert(storeCouponUser).values([
      { id: 91, uid: 11, issueCouponId: 81, couponTitle: '真实零元金额券', couponPrice: '0.00', useMinPrice: '0.00', status: 0,
        startTime: new Date((seconds - 172800) * 1000), endTime: new Date((seconds + 864000) * 1000), receiveTime: seconds - 172800, receiveSource: 'user_first' },
      { id: 92, uid: 11, issueCouponId: 82, couponTitle: '真实九折商品券', couponPrice: '90.00', useMinPrice: '10.00', status: 0,
        startTime: new Date((seconds - 172800) * 1000), endTime: new Date((seconds + 864000) * 1000), receiveTime: seconds - 172800, receiveSource: 'user_first' },
      { id: 93, uid: 22, issueCouponId: 82, couponTitle: '其他账号券旁观', couponPrice: '90.00', useMinPrice: '10.00', status: 1 },
    ]);
    await f.db.insert(storeProduct).values([
      ...[301, 302, 303].map((id, i) => ({ id, storeName: `榜单真实商品${id}`, image: '/static/logo.png', price: `${i}.00`, otPrice: '10.00',
        isShow: 1, isDel: 0, isVerify: 1, stock: 10, sales: 90 - i * 10, star: ['3.0', '5.0', '4.0'][i], collect: [20, 10, 90][i], activity: '0' })),
      { id: 304, storeName: '下架商品旁观', isShow: 0, isVerify: 1, sales: 999, star: '5.0', collect: 999 },
      { id: 305, storeName: '待审商品旁观', isShow: 1, isVerify: 0, sales: 998, star: '5.0', collect: 998 },
      { id: 306, storeName: '删除商品旁观', isShow: 1, isVerify: 1, isDel: 1, sales: 997, star: '5.0', collect: 997 },
      { id: 307, type: 1, relationId: 11, storeName: '同号无门店旁观', isShow: 1, isVerify: 1, sales: 996, star: '5.0', collect: 996 },
    ]);
    await f.db.insert(storeNewcomer).values({ id: 71, productId: 301, price: '0.00', otPrice: '10.00', sales: 0, isDel: 0 });
    await f.db.insert(storeOrder).values({ id: 1, orderId: 'diy-state-other-paid', unique: 'diy-state-other-paid', uid: 22, type: 7, paid: 1, status: 1 });
    await f.db.insert(userRelation).values([{ uid: 11, relationId: 301, type: 'collect', category: 'product' },
      { uid: 22, relationId: 302, type: 'collect', category: 'product' }]);
    await f.db.insert(storeProductLog).values([{ uid: 22, productId: 302, type: 'visit' }, { uid: 22, productId: 302, type: 'visit' }]);
    await f.db.insert(userSign).values([{ uid: 11, title: '本周一已签', addTime: monday + 3600 },
      { uid: 22, title: '其他账号今天已签', addTime: shanghaiDay + 3600 }]);
    await f.db.insert(systemSignReward).values([{ id: 1, type: 0, days: 7, point: 0, exp: 3 },
      { id: 2, type: 0, days: 14, point: 20, exp: 5 }, { id: 3, type: 1, days: 1, point: 999, exp: 999 }]);
    await f.db.insert(communityUser).values({ type: 2, relationId: 11, nickname: '社区资料旁观', communityNum: 1 });
    await f.db.insert(community).values({ id: 1, type: 2, relationId: 11, title: '实际社区预览', content: '独立社区域内容', contentType: 1,
      image: image.url, sliderImage: JSON.stringify([image.url]), status: 1, isVerify: 1, likeNum: 3, playNum: 4 });
    await f.db.insert(video).values([{ id: 1, desc: '独立旧视频一', playNum: 77, isShow: 1, isVerify: 1, sort: 10 },
      { id: 2, desc: '独立旧视频二', playNum: 88, isShow: 1, isVerify: 1, sort: 9 }]);
    const blocks = diyStateBlocks();
    await f.db.insert(systemDise).values([{ id: 1, title: '实际数据组件首页', name: '首页', templateName: 'default', type: 1, status: 1, isDiy: 1, isShow: 1, version: 'diy-state-1', value: JSON.stringify(blocks) },
      { id: 2, title: '实际数据组件微页面', name: '微页面', templateName: 'micro', type: 2, status: 1, isDiy: 1, isShow: 1, version: 'diy-state-1', value: JSON.stringify(blocks) }]);
    const tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row => row.name);
    const sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row => row.name);
    async function snapshot(): Promise<DiyStateSnapshot> {
      const state: DiyStateSnapshot = {};
      const tableRows = await f.db.execute<{ name: string; rows: DiyStateRow[] }>(sql.join(tables.map(name =>
        sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `));
      for (const row of tableRows) state[row.name] = row.rows;
      state.__sequences = await f.db.execute(sql.join(sequences.map(name =>
        sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `));
      return sortedDiyState(state);
    }
    async function setConfig(menuName: keyof typeof settings, value: string) {
      const before = await snapshot();
      await f.db.update(systemConfig).set({ value }).where(and(eq(systemConfig.menuName, menuName), eq(systemConfig.isStore, 0)));
      f.cache.delete(`cfg_${menuName}`);
      return { before, after: await snapshot(), menuName, value };
    }
    // Fixture-only controller host: production parser, transaction, catalog lock,
    // new version and row lock run unchanged. No Admin-auth/role assertion is made.
    const admin = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    admin.use('*', async (c, next) => { c.set('container', f.container); await next(); });
    admin.post('/owned-dise-save', adminDiseSave);
    async function saveSchema(id: 1 | 2, value: unknown[]) {
      const before = await snapshot();
      const response = await admin.request('/owned-dise-save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, value: JSON.stringify(value) }) }, f.env);
      const body = await response.json() as DiyStateRow;
      return { before, after: await snapshot(), response, body };
    }
    return { ...f, png, image, blocks, tables, sequences, snapshot, setConfig, saveSchema, now, seconds, monday, shanghaiDay,
      seedStorage: { puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length, keys: [...f.objects.keys()] },
      ids: { home: 1, micro: 2, newcomer: 71, product: 301, community: 1, cashIssue: 81, discountIssue: 82 } };
  } catch (error) { await f.close(); throw error; }
}
