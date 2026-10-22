import { vi } from 'vitest';
import { and, eq, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { diyFooterFixture } from './diyFooterFixture';
import { sortedDiyState, type DiyStateSnapshot, type DiyStateRow } from './diyStateFixture';
import { AttachmentService, adminAttachmentScope } from '@/services/system/AttachmentService';
import { createToken, md5 } from '@/utils/jwt';
import { systemAdmin, systemRole, systemMenus, systemGroup, systemGroupData, systemStoreStaff, deliveryService,
  storeOrderRefund, storeOrderCartInfo, systemMessage, userMessage, userBrokerage, userExtract, storeService,
  storeProductAttrValue, storeProductAttr, storeProductDescription, storeProductEnsure, storeProductReply,
  storeDiscounts, storeDiscountsProducts, storeOrderPromotionGiftCouponReward, userBill, storeCart, systemConfig,
  systemDise, storeProductCategory } from '@/models/schema';

/** Owned Browser-only schema maintenance. The native50/46 fixture is unchanged.
 * Additional ORM tables serve actual Admin auth, cart and user-tab reads; no
 * production migration/ACL, alternate endpoint or seeded business response. */
export async function diyFooterBrowserFixture() {
  const f = await diyFooterFixture();
  try {
    const dialect = new PgDialect(), additional: string[] = [];
    const tables = [systemAdmin, systemRole, systemMenus, systemGroup, systemGroupData, systemStoreStaff, deliveryService,
      storeOrderRefund, storeOrderCartInfo, systemMessage, userMessage, userBrokerage, userExtract, storeService,
      storeProductAttrValue, storeProductAttr, storeProductDescription, storeProductEnsure, storeProductReply,
      storeDiscounts, storeDiscountsProducts, storeOrderPromotionGiftCouponReward, userBill];
    for (const table of tables) {
      const definition = getTableConfig(table); if (f.tables.includes(definition.name)) continue;
      const columns = definition.columns.map(column => {
        const initial = column.default, initialSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${initialSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
      });
      await f.exec(`create table "${definition.name}" (${columns.join(', ')})`); additional.push(definition.name);
    }
    const tableNames = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row => row.name);
    const sequenceNames = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row => row.name);
    async function snapshot(): Promise<DiyStateSnapshot> {
      const state: DiyStateSnapshot = {};
      const rows = await f.db.execute<{ name: string; rows: DiyStateRow[] }>(sql.join(tableNames.map(name => sql`SELECT ${name}::text AS name, COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `));
      for (const row of rows) state[row.name] = row.rows;
      state.__sequences = await f.db.execute(sql.join(sequenceNames.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `));
      return sortedDiyState(state);
    }
    const setupResources = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length, objects: [...f.objects.keys()].sort(), queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length });
    const beforeSetupResources = setupResources();
    const beforeSetup = await snapshot(), password = 'owned-footer-browser-password';
    const permissions = ['dise.view', 'dise.manage', 'attachment.view', 'attachment.manage'];
    await f.db.insert(systemRole).values({ id: 901, roleName: 'Owned footer editor', rules: permissions.join(','), status: 1 });
    await f.db.insert(systemAdmin).values({ id: 901, account: 'owned-footer-editor', realName: '页脚验收编辑', pwd: password, roles: '901', level: 1, adminType: 1, relationId: 0, status: 1 });
    const adminToken = (await createToken(901, 'admin', md5(password), f.env.APP_KEY)).token;
    const secondIcon = await new AttachmentService(f.container, f.env).uploadImage(adminAttachmentScope(), new File([f.png], 'footer-unselected.png', { type: 'image/png' }), 0);
    await f.db.insert(storeProductAttrValue).values({ id: 9801, productId: 601, unique: 'foot601', suk: '默认', type: 0, stock: 100, price: '6.50', otPrice: '10.00', image: '/static/logo.png' });
    await f.db.update(storeCart).set({ productAttrUnique: 'foot601' }).where(eq(storeCart.id, 9101));
    await f.db.update(storeCart).set({ productAttrUnique: 'foot601' }).where(eq(storeCart.id, 9107));
    // The actual public product_detail reader takes category style from this
    // exact Dise identity, not system_config. 2/2 exposes the primary 更多
    // drawer and mini-cart while initial scope stays {cid:701}; inherited
    // product relations and every cart quantity/flag remain untouched.
    const beforeCategorySetup = await snapshot(), beforeCategoryResources = setupResources();
    await f.db.insert(systemDise).values({ id: 88, name: '商品分类', title: '真实页脚分类布局', templateName: 'category', type: 3,
      isDiy: 0, isDel: 0, status: 1, isShow: 1, value: JSON.stringify({ level: 2, index: 2 }), version: 'owned-footer-category-1' });
    await f.db.insert(storeProductCategory).values([
      { id: 751, pid: 701, level: 1, type: 0, relationId: 0, path: '701', cateName: '真实页脚子分类A', isShow: 1, sort: 2 },
      { id: 752, pid: 701, level: 1, type: 0, relationId: 0, path: '701', cateName: '真实页脚子分类B', isShow: 1, sort: 1 },
    ]);
    const categorySetup = { authority: 'system_dise: exact category/type3/is_del0', style_id: 88, layout: { level: 2, index: 2 }, root_id: 701, child_ids: [751, 752],
      before: beforeCategorySetup, after: await snapshot(), resources_before: beforeCategoryResources, resources_after: setupResources() };
    async function station(value: string) { const before = await snapshot(); await f.db.update(systemConfig).set({ value }).where(and(eq(systemConfig.menuName, 'station_open'), eq(systemConfig.isStore, 0))); f.cache.delete('cfg_station_open'); return { before, after: await snapshot() }; }
    const adminSession = { userInfo: { id: 901, account: 'owned-footer-editor', real_name: '页脚验收编辑', level: 1, roles: '901' }, menus: [{ id: 1, pid: 0, path: '/content/dise', name: 'DIY 装修' }, { id: 2, pid: 0, path: '/assets', name: '素材中心' }], uniqueAuth: permissions };
    return { ...f, tables: tableNames, sequences: sequenceNames, additionalTables: additional, beforeBrowserSetup: beforeSetup, afterBrowserSetup: await snapshot(), beforeBrowserSetupResources: beforeSetupResources, afterBrowserSetupResources: setupResources(), categorySetup, snapshot, station, adminToken, adminSession, secondIcon };
  } catch (error) { await f.close(); throw error; }
}
