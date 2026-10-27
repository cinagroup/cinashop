import { expect, vi } from 'vitest';
import { eq, inArray, sql, SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createHash } from 'node:crypto';
import { agreement, legacyCache, memberRight, storeBrand, storeProduct, storeProductAttrValue, storeProductLabel,
  storeProductLog, storePromotions, storeSeckill, storeVisit, systemConfig, systemDise, systemForm, systemFormData,
  systemUserLevel, user, userLevel, wechatUser } from '@/models/schema';
import { AttachmentService, adminAttachmentScope } from '@/services/system/AttachmentService';
import type { Env } from '@/env';
import { diyFooterBrowserFixture } from './diyFooterBrowserFixture';
import { sortedDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from './diyStateFixture';

/** Additive local Browser setup. The inherited exact fixtures are unchanged. */
export async function memberLevelRecommendationsBrowserFixture() {
  const f = await diyFooterBrowserFixture({ namespace: 'public' });
  try {
    const dialect = new PgDialect();
    for (const table of [userLevel, storeVisit, storeProductLog, legacyCache, agreement, wechatUser, systemForm, systemFormData]) {
      const def = getTableConfig(table);
      if ((await f.db.execute(sql`SELECT to_regclass(${def.name}) AS name`))[0]?.name) continue;
      const columns = def.columns.map(c => { const value = c.default, initial = value === undefined ? '' : ` default ${value instanceof SQL ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `"${c.name}" ${c.getSQLType()}${initial}${c.notNull ? ' not null' : ''}${c.primary ? ' primary key' : ''}`; });
      await f.exec(`CREATE TABLE "${def.name}" (${columns.join(',')})`);
    }
    const tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row => row.name);
    const sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row => row.name);
    async function snapshot(): Promise<DiyStateSnapshot> {
      const value: DiyStateSnapshot = {};
      for (const row of await f.db.execute<{ name: string; rows: Row[] }>(sql.join(tables.map(name => sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `))) value[row.name] = row.rows;
      value.__sequences = await f.db.execute(sql.join(sequences.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `));
      return sortedDiyState(value);
    }
    const sequenceCalls: Row[] = [];
    f.env.SEQUENCE = { idFromName: (name: unknown) => { sequenceCalls.push({ name }); throw Error('Recommendation Browser prohibits DO allocation'); }, get: () => { throw Error('Unexpected sequence stub'); } } as unknown as Env['SEQUENCE'];
    const resources = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length,
      queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length, sequence: structuredClone(sequenceCalls),
      objects: [...f.objects].map(([key, item]) => ({ key, type: item.type, bytes: item.bytes.length, sha256: createHash('sha256').update(item.bytes).digest('hex') })).sort((a, b) => a.key.localeCompare(b.key)) });
    const before = await snapshot(), resourcesBefore = resources(), seconds = Math.floor(Date.now() / 1000);
    const transparent = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR4nO3BAQEAAACCIP+vbkhAAQAAAO8GECAAARlDNO4AAAAASUVORK5CYII=', 'base64'));
    const frame = await new AttachmentService(f.container, f.env).uploadImage(adminAttachmentScope(), new File([transparent], 'recommendation-transparent-frame.png', { type: 'image/png' }), 0);
    await f.db.delete(userLevel); await f.db.delete(systemUserLevel);
    await f.db.insert(systemUserLevel).values({ id: 8101, name: '原版九折会员', grade: 1, expNum: 0, discount: '90.00',
      color: '#725027', image: frame.url, icon: frame.url, isShow: 1, isDel: 0, isForever: 1 });
    for (const uid of [11, 22]) {
      await f.db.update(user).set({ level: 8101, levelStatus: 1, exp: '150.00', nickname: '原版等级推荐' + uid, isMoneyLevel: 0, isEverLevel: 0, overdueTime: 0 }).where(eq(user.uid, uid));
      await f.db.insert(userLevel).values({ uid, levelId: 8101, grade: 1, status: 1, isDel: 0, isForever: 1, validTime: 0, merId: 0, discount: 90, addTime: seconds });
    }
    const settings = { member_func_status: '1', member_card_status: '1', svip_price_status: '1', level_activate_status: '0', site_name: '"会员等级推荐本机验收"' };
    for (const [menuName, value] of Object.entries(settings)) {
      const changed = await f.db.update(systemConfig).set({ value }).where(eq(systemConfig.menuName, menuName)).returning({ id: systemConfig.id });
      if (!changed.length) await f.db.insert(systemConfig).values({ menuName, value, isStore: 0 });
    }
    const right = await f.db.update(memberRight).set({ status: 1, number: 1 }).where(eq(memberRight.rightType, 'vip_price')).returning({ id: memberRight.id });
    if (!right.length) await f.db.insert(memberRight).values({ rightType: 'vip_price', status: 1, number: 1 });
    await f.db.update(storeBrand).set({ brandName: '原版品牌' }).where(eq(storeBrand.id, 703));
    await f.db.update(storeProductLabel).set({ labelName: '本机标签', icon: f.platformImage.url }).where(eq(storeProductLabel.id, 704));
    await f.db.update(storeProduct).set({ isHot: 0 });
    const productIds = [602, ...Array.from({ length: 22 }, (_, i) => 191001 + i)];
    await f.db.insert(storeProduct).values(productIds.slice(1).map((id, index) => ({ id, type: 0, relationId: 0, storeName: '原版推荐商品' + String(index + 1).padStart(2, '0'),
      image: f.platformImage.url, sliderImage: JSON.stringify([f.platformImage.url]), price: '12.30', otPrice: '20.00', vipPrice: '9.90', isVip: 1,
      stock: 100, isShow: 1, isDel: 0, isVerify: 1, sort: 1000, isHot: 1, brandId: 703, storeLabelId: '704', activity: '0,1,2,3', cateId: '701' })));
    await f.db.update(storeProduct).set({ isHot: 1, sort: 1001, brandId: 703, storeLabelId: '704', image: f.platformImage.url, sliderImage: JSON.stringify([f.platformImage.url]),
      isVip: 1, vipPrice: '9.90' }).where(eq(storeProduct.id, 602));
    await f.db.update(storeProduct).set({ sort: 1001 }).where(eq(storeProduct.id, 191022));
    await f.db.update(storeSeckill).set({ onceNum: 1, num: 3 }).where(eq(storeSeckill.id, 1701));
    await f.db.insert(storeProductAttrValue).values([{ id: 191022, productId: 191022, unique: 'rc191022', suk: '默认', type: 0, price: '12.30', vipPrice: '9.90', otPrice: '20.00', stock: 100, image: f.platformImage.url },
      { id: 191023, productId: 1701, unique: 'reco1701', suk: '默认', type: 1, price: '0.00', vipPrice: '0.00', otPrice: '12.00', stock: 99, quota: 3, image: f.platformImage.url },
      { id: 191024, productId: 602, unique: 'rc000602', suk: '默认', type: 0, price: '12.00', vipPrice: '9.90', otPrice: '20.00', stock: 100, image: f.platformImage.url }]);
    await f.db.insert(storePromotions).values({ id: 191001, promotionsType: 5, name: '本机透明边框', productPartakeType: 1, image: frame.url, startTime: seconds - 86400, stopTime: seconds + 86400, updateTime: seconds });
    const blocks = structuredClone(f.blocks), footer = blocks.find(value => value.name === 'pageFoot')!;
    footer.menuList = [{ name: '会员等级', link: '/pages/users/user_vip/index', imgList: [f.platformImage.url, f.platformImage.url] }, { name: '首页', link: '/pages/index/index', imgList: [f.platformImage.url, f.platformImage.url] }];
    for (const id of [1, 2]) await f.db.update(systemDise).set({ value: JSON.stringify(blocks), version: 'member-recommendation-entry-' + seconds }).where(eq(systemDise.id, id));
    f.cache.clear();
    const setEmpty = async (empty: boolean) => { const before = await snapshot(); await f.db.update(storeProduct).set({ isHot: empty ? 0 : 1 }).where(inArray(storeProduct.id, productIds));
      return { before, after: await snapshot(), product_ids: productIds, empty }; };
    expect(productIds).toHaveLength(23);
    return { ...f, tables, sequences, snapshot, resources, frame, productIds, setEmpty, tokens: new Map([[11, f.token], [22, f.otherToken]]),
      setup: { before, after: await snapshot(), resources_before: resourcesBefore, resources_after: resources(), product_ids: productIds, expected_page_sizes: [10, 10, 3], ordinary_id: 191022, seckill_id: 1701, seckill_product_id: 602 } };
  } catch (error) { await f.close(); throw error; }
}
