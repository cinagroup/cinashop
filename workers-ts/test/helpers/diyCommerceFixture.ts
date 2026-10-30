import { and, eq, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { DIY_STATE_NOW, diyStateBlocks, diyStateFixture, sortedDiyState, type DiyStateRow, type DiyStateSnapshot } from './diyStateFixture';
import { liveAnchor, liveGoods, liveRoom, liveRoomGoods, storeActivity, storeBargain, storeBargainUserHelp, storeBrand, storeCart, storeCombination,
  storeCouponIssue, storeCouponIssueUser, storeCouponUser, storeIntegral, storePink, storeProduct, storeProductCategory,
  storeProductLabel, storeProductRelation, storeSeckill, storeSeckillTime, systemConfig, systemDise } from '@/models/schema';

export { DIY_STATE_NOW as DIY_COMMERCE_NOW };
export const DIY_COMMERCE_FAMILIES = ['promotionList', 'seckill', 'combination', 'bargain', 'presale', 'pointsMall', 'coupon', 'liveBroadcast'] as const;
const colour = (a: string, b = a) => ({ color: [{ item: a }, { item: b }] });
/** Persisted Admin field names. The fixture exercises two independent instances
 * per family; runtime tests cover each family's remaining layout branches. */
export function diyCommerceBlocks(): DiyStateRow[] {
  const common = diyStateBlocks()[1];
  return [{ name: 'titles', timestamp: 1, titleConfig: { value: '真实商城八类组件' } }, ...DIY_COMMERCE_FAMILIES.flatMap((name, family) => [0, 1].map(style => ({
    ...structuredClone(common), name, timestamp: 301 + family * 2 + style, styleConfig: { tabVal: style },
    titleConfig: { tabVal: style }, titleTxtConfig: { value: `真实${name}样式${style}` }, rightBntConfig: { value: '查看真实列表' },
    numberConfig: { val: 3 }, checkboxInfo: { type: [0, 1, 2, 3, 4, 5] },
    goodStyleConfig: { tabVal: style }, goodsName: { tabVal: 1 }, goodsNameColor: colour('#243c54'),
    goodsPriceColor: colour('#a24c17'), goodsPriceColor2: colour('#7698ba'), goodsUnitPriceColor: colour('#6b7280'),
    goodsBntColor: colour('#375a7f', '#527da5'), titleColor: colour('#243c54'), headerBgColor: colour('#eaf0f7'),
    headerBntColor2: colour('#527da5'), tipsColor2: colour('#7698ba'), numberColor: colour('#375a7f'),
    numberColor2: colour('#527da5'), numberBgColor: colour('#eaf0f7'), numberBgColor2: colour('#edf7ff'),
    seckillPriceColor: colour('#a24c17'), pinkPriceColor: colour('#a24c17'), bargainPriceColor: colour('#a24c17'), presalePriceColor: colour('#a24c17'),
    imgBgConfig: { tabVal: 0 }, imgColorConfig: colour('#f3f6fa'), titleText: { tabVal: 0 },
    titleNumber: { val: 16 }, bntNumber: { val: 12 }, bntConfig: { tabVal: 0 }, bntStyleConfig: { tabVal: 1 },
    cartConfig: { tabVal: 0 }, slideConfig: { tabVal: 0 }, imgStyle: { tabVal: 0 },
    toneCartConfig: { tabVal: 1 }, textColor: colour('#375a7f'), textColor2: colour('#7698ba'),
    decorateColor: colour('#375a7f'), decorateColor2: colour('#eaf0f7'),
    dividerColor: colour('#dae5ef'), labelColor: colour('#375a7f'), joinBgColor: colour('#eaf0f7'),
    joinNumColor: colour('#375a7f'), joinNumColor2: colour('#527da5'), tipTxtConfig: { value: '真实砍价提示' },
    priceBgColor: colour('#eaf0f7'), liveConfig: { tabVal: 0 }, notBg: colour('#7698ba'), playBg: colour('#375a7f'), endBg: colour('#6b7280'),
    seckillConfig: { tabVal: 0 }, pinkConfig: { tabVal: 0 }, bargainConfig: { tabVal: 0 }, presaleConfig: { tabVal: 0 },
    tabConfig: { tabCur: 0, list: [
      { chiild: [{ val: '真实指定商品' }, { val: '零价与销量' }], image: '/static/logo.png', tabVal: 1, goodsSort: 0, numConfig: { val: 2 },
        goodsList: { ids: [601, 611], list: [{ id: 601 }, { id: 611 }] }, selectConfig: { activeValue: [701] }, brandConfig: { brandVal: [] }, goodsLabel: { activeValue: [] } },
      { chiild: [{ val: '真实分类筛选' }, { val: '单独分组' }], image: '/static/logo.png', tabVal: 3, goodsSort: 0, numConfig: { val: 1 },
        goodsList: { ids: [] }, selectConfig: { activeValue: [701] }, brandConfig: { brandVal: [] }, goodsLabel: { activeValue: [] } },
      { chiild: [{ val: '真实活动跳转' }, { val: '真实活动ID' }], image: '/static/logo.png', tabVal: 1, goodsSort: 0, numConfig: { val: 4 },
        goodsList: { ids: [602, 603, 604, 605], list: [{ id: 602 }, { id: 603 }, { id: 604 }, { id: 605 }] },
        selectConfig: { activeValue: [] }, brandConfig: { brandVal: [] }, goodsLabel: { activeValue: [] } },
      { chiild: [{ val: '真实品牌筛选' }, { val: '仅品牌703' }], image: '/static/logo.png', tabVal: 2, goodsSort: 0, numConfig: { val: 2 }, brandConfig: { brandVal: [703] } },
      { chiild: [{ val: '真实标签筛选' }, { val: '仅标签704' }], image: '/static/logo.png', tabVal: 4, goodsSort: 0, numConfig: { val: 2 }, goodsLabel: { activeValue: [704] } },
    ] },
  }))), { name: 'community', timestamp: 401, numberConfig: { val: 1 }, styleConfig: { tabVal: 0 }, titleConfig: { tabVal: 1 },
    titleTxtConfig: { value: '保留真实社区' }, rightBntConfig: { value: '更多社区' }, fillet: { type: 0, val: 8 }, filletImg: { type: 0, val: 8 },
    topConfig: { val: 6 }, bottomConfig: { val: 6 }, prConfig: { val: 10 }, mbConfig: { val: 6 }, moduleColor: colour('#ffffff'), bottomBgColor: colour('#f3f6fa') }];
}

/** Owned PG16 historical fixture, extending the already-owned DIY state data.
 * Additional CREATE TABLE statements derive only from the checked-in Drizzle
 * models inside this disposable database; no production DDL/ACL claim is made. */
export async function diyCommerceFixture(now = new Date(), options: { namespace?: 'public' } = {}) {
  const f = await diyStateFixture(now, options);
  try {
    const additions: PgTable[] = [storeCouponIssueUser, storeActivity, storeIntegral, storeCart, storeProductCategory, liveAnchor, liveGoods, liveRoom, liveRoomGoods, storePink, storeBargainUserHelp];
    const dialect = new PgDialect();
    for (const table of additions) {
      const definition = getTableConfig(table);
      if (f.tables.includes(definition.name)) throw Error(`Unexpected existing commerce table ${definition.name}`);
      const columns = definition.columns.map(column => {
        const initial = column.default;
        const initialSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${initialSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
      });
      await f.exec(`create table "${definition.name}" (${columns.join(', ')})`);
    }
    const seconds = Math.floor(now.getTime() / 1000), day = Math.floor((seconds + 28800) / 86400) * 86400 - 28800;
    const blocks = diyCommerceBlocks();
    await f.db.update(systemDise).set({ title: '真实商城组件首页', version: 'diy-commerce-1', value: JSON.stringify(blocks) }).where(eq(systemDise.id, 1));
    await f.db.update(systemDise).set({ title: '真实商城组件微页面', version: 'diy-commerce-1', value: JSON.stringify(blocks) }).where(eq(systemDise.id, 2));
    await f.db.insert(systemConfig).values([{ menuName: 'seckill_header_banner', value: '"/static/logo.png"', isStore: 0 },
      { menuName: 'site_url', value: '""', isStore: 0 }]);
    await f.db.insert(storeProductCategory).values({ id: 701, cateName: '真实商城分类', level: 0, pid: 0, isShow: 1, type: 0, relationId: 0 });
    await f.db.insert(storeBrand).values({ id: 703, brandName: '真实商城品牌', isShow: 1, isDel: 0 });
    await f.db.insert(storeProductLabel).values([
      { id: 704, labelName: '真实商城标签', color: '#375a7f', bgColor: '#eaf0f7', borderColor: '#7698ba', status: 1, isShow: 1 },
      { id: 705, labelName: '隐藏标签旁观', status: 1, isShow: 0 },
      { id: 706, labelName: '停用标签旁观', status: 0, isShow: 1 },
      { id: 707, labelName: '未关联标签旁观', status: 1, isShow: 1 },
    ]);
    await f.db.insert(storeProduct).values([
      { id: 601, storeName: '真实促销零价商品601', price: '0.00', sales: 7, ficti: 3, sort: 20, brandId: 703, storeLabelId: '704,705,706' },
      { id: 611, storeName: '真实促销商品611', price: '9.50', sales: 2, ficti: 4, sort: 10 },
      { id: 602, storeName: '秒杀关联商品602', price: '12.00', activity: '1,2,3' }, { id: 603, storeName: '拼团关联商品603', price: '15.00', activity: '3,2,1' },
      { id: 604, storeName: '砍价关联商品604', price: '20.00', activity: '2,1,3' },
      { id: 605, storeName: '真实预售商品605', price: '8.50', isPresaleProduct: 1, presaleStartTime: seconds - 3600, presaleEndTime: seconds + 3600, presaleDay: 2 },
      { id: 606, storeName: '积分关联商品606', price: '1.50' },
      { id: 612, storeName: '隐藏商城商品旁观', price: '999.00', isShow: 0, brandId: 703, storeLabelId: '704' },
    ].map(row => ({ ...row, image: '/static/logo.png', otPrice: '30.00', stock: 10, unitName: '件', isVerify: 1, isDel: 0, isShow: row.isShow ?? 1 })));
    await f.db.insert(storeProductRelation).values([{ productId: 601, relationId: 701, type: 1 }, { productId: 611, relationId: 701, type: 1 }, { productId: 612, relationId: 701, type: 1 }]);
    await f.db.insert(storeProductRelation).values([{ productId: 601, relationId: 703, type: 2 }, { productId: 612, relationId: 703, type: 2 },
      { productId: 601, relationId: 704, type: 3 }, { productId: 612, relationId: 704, type: 3 }]);
    await f.db.insert(storeCart).values([{ uid: 11, productId: 601, cartNum: 2, productAttrUnique: 'fixture-sku-601', type: 0, isPay: 0, isDel: 0, status: 1 },
      { uid: 22, productId: 601, cartNum: 4, productAttrUnique: 'fixture-sku-601', type: 0, isPay: 0, isDel: 0, status: 1 }]);
    await f.db.insert(storeSeckillTime).values([{ id: 501, title: '真实全天场', startTime: '00:00', endTime: '24:00', status: 1 },
      { id: 502, title: '真实午后场', startTime: '12:00', endTime: '14:00', status: 1 },
      { id: 503, title: '已禁用场次旁观', startTime: '16:00', endTime: '18:00', status: 0 }]);
    await f.db.insert(storeActivity).values({ id: 1501, type: 1, name: '真实秒杀父活动', startDay: day, endDay: day, timeId: '501,502', status: 1, isDel: 0 });
    await f.db.insert(storeSeckill).values([
      { id: 1701, productId: 602, activityId: 1501, storeName: '真实秒杀1701', timeId: '501', price: '0.00', otPrice: '12.00', quota: 3, quotaShow: 10, stock: 99, sort: 10 },
      { id: 1702, productId: 611, activityId: 1501, storeName: '真实午后秒杀1702', timeId: '502', price: '4.00', otPrice: '9.50', quota: 0, quotaShow: 10, stock: 50, sort: 9 },
      { id: 1703, productId: 612, activityId: 1501, storeName: '停发秒杀旁观', timeId: '501', status: 0, sort: 999 },
    ].map(row => ({ ...row, image: '/static/logo.png', startTime: new Date((day - 86400) * 1000), stopTime: new Date((day + 172800) * 1000) })));
    await f.db.insert(storeCombination).values([
      { id: 1801, productId: 603, storeName: '真实三人拼团1801', price: '0.00', otPrice: '15.00', people: 3, quota: 4, quotaShow: 10, stock: 4, sort: 10 },
      { id: 1802, productId: 611, storeName: '隐藏拼团旁观', isShow: 0, sort: 999 },
    ].map(row => ({ ...row, image: '/static/logo.png' })));
    await f.db.insert(storePink).values([
      { id: 2401, uid: 11, combinationId: 1801, productId: 603, status: 2, isRefund: 0, addTime: seconds - 60 },
      { id: 2402, uid: 22, combinationId: 1801, productId: 603, status: 2, isRefund: 0, addTime: seconds - 120 },
      { id: 2403, uid: 22, combinationId: 1801, productId: 603, status: 2, isRefund: 1, addTime: seconds - 30 },
      { id: 2404, uid: 0, combinationId: 1801, productId: 603, status: 2, isRefund: 0, addTime: seconds - 20 },
      { id: 2405, uid: 11, combinationId: 1801, productId: 603, status: 1, isRefund: 0, addTime: seconds - 10 },
    ]);
    await f.db.insert(storeBargain).values([
      { id: 1901, productId: 604, storeName: '真实砍价1901', title: '真实砍价标题1901', price: '20.00', minPrice: '0.00', people: 6, sales: 2, stock: 8, sort: 10 },
      { id: 1902, productId: 611, storeName: '过期砍价旁观', stopTime: new Date((seconds - 1) * 1000), sort: 999 },
    ].map(row => ({ startTime: new Date((seconds - 3600) * 1000), stopTime: new Date((seconds + 3600) * 1000), ...row, image: '/static/logo.png' })));
    await f.db.insert(storeBargainUserHelp).values([
      { id: 2501, uid: 11, bargainId: 1901, bargainUserId: 2601, type: 1, price: '1.00', addTime: seconds - 60 },
      { id: 2502, uid: 22, bargainId: 1901, bargainUserId: 2602, type: 1, price: '2.00', addTime: seconds - 120 },
      { id: 2503, uid: 22, bargainId: 1901, bargainUserId: 2601, type: 0, price: '3.00', addTime: seconds - 30 },
      { id: 2504, uid: 11, bargainId: 1902, bargainUserId: 2603, type: 1, price: '4.00', addTime: seconds - 20 },
    ]);
    await f.db.insert(storeIntegral).values([
      { id: 2001, productId: 606, storeName: '真实零积分商品2001', integral: 0, price: '1.50', sales: 4, stock: 7, sort: 10 },
      { id: 2002, productId: 611, storeName: '隐藏积分商品旁观', isShow: 0, sort: 999 },
    ].map(row => ({ ...row, image: '/static/logo.png' })));
    await f.db.insert(storeCouponIssue).values([
      { id: 901, couponTitle: '真实手动现金券901', couponType: 0, type: 1, couponPrice: '0.00', receiveLimit: 0, remainCount: 4 },
      { id: 902, couponTitle: '真实手动九折券902', couponType: 0, type: 2, couponPrice: '90.00', receiveLimit: 2, remainCount: 4 },
      ...[903, 904, 905, 907].map(id => ({ id, couponTitle: `真实别名领取券${id}`, couponType: 0, type: 1, couponPrice: '3.00', receiveLimit: 1, remainCount: 4 })),
      { id: 906, couponTitle: '真实最后库存券906', couponType: 0, type: 1, couponPrice: '1.00', receiveLimit: 1, remainCount: 1 },
      { id: 908, couponTitle: '零限领证据保护券908', couponType: 0, type: 1, couponPrice: '1.00', receiveLimit: 0, remainCount: 4 },
      { id: 911, couponTitle: '新人券旁观', receiveType: 2, remainCount: 4 },
      { id: 912, couponTitle: '赠送券旁观', receiveType: 3, remainCount: 4 },
      { id: 913, couponTitle: '会员券旁观', appType: 1, remainCount: 4 },
      { id: 914, couponTitle: '隐藏类别券旁观', category: 2, remainCount: 4 },
      { id: 915, couponTitle: '已停发券旁观', status: 0, remainCount: 4 },
      { id: 916, couponTitle: '零库存券旁观', remainCount: 0 },
    ].map(row => ({ ...row, receiveType: row.receiveType ?? 1, category: row.category ?? 0, appType: row.appType ?? 0,
      day: 7, useMinPrice: '0.00', sort: 1000 - row.id, status: row.status ?? 1, addTime: seconds })));
    // Explicit ids in inherited state data do not advance PG sequences. Advance
    // only this owned coupon sequence to the current real maximum before writes.
    await f.db.execute(sql`SELECT setval(pg_get_serial_sequence('store_coupon_user','id'),(SELECT MAX(id) FROM store_coupon_user),true)`);
    await f.db.insert(storeCouponUser).values({ uid: 22, issueCouponId: 902, couponTitle: '另一账号预领九折券', couponPrice: '90.00', type: 2,
      startTime: new Date((seconds - 3600) * 1000), endTime: new Date((seconds + 86400 * 7) * 1000), receiveTime: seconds - 3600, receiveSource: 'get' });
    await f.db.insert(storeCouponIssueUser).values([{ uid: 22, issueCouponId: 902, addTime: seconds - 3600 }, { uid: 11, issueCouponId: 908, addTime: seconds - 7200 }]);
    await f.db.insert(liveAnchor).values({ id: 2201, wechat: 'owned-live-anchor', name: '真实直播主播', coverImg: '/static/logo.png', isShow: 1, isDel: 0 });
    await f.db.insert(liveGoods).values({ id: 2301, goodsId: 3301, productId: 601, name: '真实直播商品', coverImg: '/static/logo.png', price: '0.00' });
    await f.db.insert(liveRoom).values([101, 102, 103].map((liveStatus, index) => ({ id: 2101 + index, roomId: 3101 + index,
      name: `真实直播间${2101 + index}`, coverImg: '/static/logo.png', anchorName: '真实直播主播', anchorWechat: 'owned-live-anchor', phone: `13900000${index}`,
      liveStatus, startTime: seconds - 3600, endTime: seconds + 3600, sort: 30 - index, isShow: 1, isDel: 0 })));
    await f.db.insert(liveRoom).values({ id: 2104, roomId: 3104, name: '隐藏直播间旁观', isShow: 0, sort: 999 });
    await f.db.insert(liveRoomGoods).values({ liveRoomId: 2101, liveGoodsId: 2301 });
    const tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row => row.name);
    const sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row => row.name);
    async function snapshot(): Promise<DiyStateSnapshot> {
      const state: DiyStateSnapshot = {};
      const rows = await f.db.execute<{ name: string; rows: DiyStateRow[] }>(sql.join(tables.map(name =>
        sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `));
      for (const row of rows) state[row.name] = row.rows;
      state.__sequences = await f.db.execute(sql.join(sequences.map(name =>
        sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `));
      return sortedDiyState(state);
    }
    async function setConfig(menuName: Parameters<typeof f.setConfig>[0], value: string) {
      const before = await snapshot();
      await f.db.update(systemConfig).set({ value }).where(and(eq(systemConfig.menuName, menuName), eq(systemConfig.isStore, 0)));
      f.cache.delete(`cfg_${menuName}`); return { before, after: await snapshot(), menuName, value };
    }
    async function saveSchema(id: 1 | 2, value: unknown[]) {
      const before = await snapshot(), saved = await f.saveSchema(id, value);
      return { ...saved, before, after: await snapshot() };
    }
    return { ...f, blocks, tables, sequences, snapshot, setConfig, saveSchema,
      ids: { ...f.ids, cash: 901, discount: 902, legacyAlias: 903, sameAliases: 904, unknownOutcome: 905,
        lastStock: 906, stringAlias: 907, retainedEvidence: 908, promotionProducts: [601, 611], category: 701, brand: 703, label: 704,
        seckillTime: 501, secondSeckillTime: 502, seckill: 1701, combination: 1801, bargain: 1901, integral: 2001,
        presaleProduct: 605, liveRoom: 2101, remoteLiveRoom: 3101 } };
  } catch (error) { await f.close(); throw error; }
}
