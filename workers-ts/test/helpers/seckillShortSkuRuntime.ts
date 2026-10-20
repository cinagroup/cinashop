/** Actual registered owned PG16. Admin/customer App sessions are explicitly
 * injected maintenance SQL; a separately authenticated LOGIN authors orders.
 * No production Admin binding, runtime commissioning, login or provider claim. */
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import type { Env } from '@/env';
import { storeCart, storeProduct, storeProductAttr, storeProductAttrValue,
  storeProductDescription, storeSeckillTime, systemAdmin, systemAttachment, systemRole, user } from '@/models/schema';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './refundRuntimeFixture';
import { refundEvidenceR2, refundEvidenceSequences, refundEvidenceSnapshot } from './refundApplicationEvidence';

export const seckillShortRuntimeSlotId = 4001;
export function seedSeckillShortSkuAdminInput(unique = 'short7', price = '6.25') {
  const day = new Date(Date.now() + 28_800_000).toISOString().slice(0, 10);
  return { request_id: crypto.randomUUID(), name: 'Owned short base seckill', start_day: day, end_day: day,
    time_ids: [seckillShortRuntimeSlotId], num: 10, once_num: 3, image: '/api/assets/42', status: 1,
    products: [{ child_id: null, product_id: 70, status: 1,
      skus: [{ id: null, base_unique: unique, price, quota_total: 6, enabled: true }] }] };
}

export async function seckillShortSkuRuntimeFixture(options: { unique?: string } = {}) {
  const f = await refundRuntimeFixture();
  try {
    const unique = options.unique ?? 'short7';
    if (!unique || unique.length > 8 || /[\s\x00-\x1f\x7f]/.test(unique))
      throw Error('Owned seckill fixture requires a canonical base key');
    await f.db.update(storeProduct).set({ type: 0, relationId: 0, price: '17.00', isVip: 0,
      isVipProduct: 0, isPresaleProduct: 0, isLimit: 0, stock: 12, sales: 0,
      freight: 1, tempId: 0, postage: '0.00', giveIntegral: '0.00', unitName: '件',
      deliveryType: '1', image: '/legacy/seckill-short-sku.png', sliderImage: '["/legacy/seckill-short-sku.png"]' })
      .where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ unique, suk: '短规格', price: '18.88', stock: 12,
      sales: 0, image: '/legacy/seckill-short-sku.png' }).where(eq(storeProductAttrValue.id, 1));
    await f.db.update(storeCart).set({ productAttrUnique: unique }).where(eq(storeCart.id, 1));
    await f.db.insert(storeProductAttr).values({ productId: 70, type: 0, attrName: '规格', attrValues: '短规格' });
    await f.db.insert(storeProductDescription).values({ productId: 70, type: 0, description: '<p>Owned seckill source</p>' });
    await f.db.insert(storeSeckillTime).values({ id: seckillShortRuntimeSlotId, title: 'Owned全天', startTime: '0000', endTime: '2400', status: 1 });
    await f.db.insert(systemAttachment).values({ attId: 42, type: 1, relationId: 0, moduleType: 1,
      fileType: 1, attDir: '/api/assets/42' });
    for (const table of ['store_cart', 'store_product_attr_value'])
      await f.db.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${table}','id'),(SELECT max(id) FROM public.${table}),true)`));
    const adminId = 902, adminRoleId = 902, key = 'owned-seckill-short-app-key';
    const adminPassword = 'owned-seckill-short-admin', buyerPassword = 'owned-seckill-short-buyer';
    await f.db.insert(systemRole).values({ id: adminRoleId, type: 1,
      rules: 'seckill_activity.view,seckill_activity.manage', status: 1 });
    await f.db.insert(systemAdmin).values({ id: adminId, account: 'owned-seckill-short', pwd: adminPassword,
      adminType: 1, level: 1, roles: String(adminRoleId), status: 1, isDel: 0 });
    await f.db.update(user).set({ pwd: buyerPassword }).where(eq(user.uid, 11));
    const r2 = refundEvidenceR2(), kvWrites: Array<{ key: string; value: string }> = [], kvDeletes: string[] = [];
    const configKv = new Proxy(f.env.CONFIG_KV, { get(target, property, receiver) {
      if (property === 'put') return async (name: string, value: string, opts?: KVNamespacePutOptions) => {
        kvWrites.push({ key: name, value }); await target.put(name, value, opts);
      };
      if (property === 'delete') return async (name: string) => { kvDeletes.push(name); await target.delete(name); };
      const value = Reflect.get(target, property, receiver); return typeof value === 'function' ? value.bind(target) : value;
    } });
    // Admin activity mutations use their actual SQL rows, not cfg_ register keys.
    // Preserve the donor's pricing config view; do not invent a mutable f.config.
    const env: Env = { ...f.env, APP_KEY: key, NODE_ENV: 'test' as Env['NODE_ENV'], CONFIG_KV: configKv, ASSETS_BUCKET: r2.bucket };
    const adminToken = (await createToken(adminId, 'admin', md5(adminPassword), key)).token;
    const token = (await createToken(11, 'api', md5(buyerPassword), key)).token;
    type Writer = Parameters<Parameters<typeof f.withRuntime>[0]>[0];
    const withSeckillRuntime = <T>(work: (writer: Writer) => Promise<T>) => f.withRuntime(async writer => {
      const plan = runtimeBusinessPrivilegePlan('app');
      const extra = { store_seckill: ['SELECT', 'UPDATE'], store_activity: ['SELECT'], store_seckill_time: ['SELECT'] };
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(writer.role)) throw Error('Unowned seckill runtime role');
      for (const [table, privileges] of Object.entries(extra)) {
        if (JSON.stringify(plan.tables[table]) !== JSON.stringify(privileges)) throw Error('Seckill fixture differs from fixed app table profile');
        if (table !== 'store_seckill' && JSON.stringify(plan.updateColumns[table]) !== '["id"]')
          throw Error('Seckill fixture differs from fixed app lock profile');
        await f.exec(`GRANT ${privileges.join(',')} ON public."${table}" TO "${writer.role}"`);
        if (table !== 'store_seckill') await f.exec(`GRANT UPDATE(id) ON public."${table}" TO "${writer.role}"`);
      }
      const [owner] = await f.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      const [identity] = await writer.db.execute<{ role: string; session: string; pid: number;
        rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean }>(sql`SELECT
        current_user AS role,session_user AS session,pg_backend_pid() AS pid,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls
        FROM pg_roles WHERE rolname=current_user`);
      if (!identity || identity.role !== writer.role || identity.session !== writer.role || identity.pid !== writer.pid
        || identity.pid === owner.pid || identity.rolsuper || identity.rolcreatedb || identity.rolcreaterole || identity.rolbypassrls)
        throw Error('Independent seckill LOGIN identity differs');
      for (const table of Object.keys(extra)) {
        const [rights] = await writer.db.execute<{ owner: string; selected: boolean; inserted: boolean; updated: boolean; deleted: boolean; truncated: boolean }>(sql`SELECT
          pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=${'public.' + table}::regclass)) AS owner,
          has_table_privilege(current_user,${'public.' + table},'SELECT') AS selected,
          has_table_privilege(current_user,${'public.' + table},'INSERT') AS inserted,
          has_table_privilege(current_user,${'public.' + table},'UPDATE') AS updated,
          has_table_privilege(current_user,${'public.' + table},'DELETE') AS deleted,
          has_table_privilege(current_user,${'public.' + table},'TRUNCATE') AS truncated`);
        const columns = await writer.db.execute<{ column_name: string }>(sql`SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=${table} AND has_column_privilege(current_user,${'public.' + table},column_name,'UPDATE') ORDER BY ordinal_position`);
        if (!rights || rights.owner === writer.role || !rights.selected || rights.inserted || rights.deleted || rights.truncated
          || rights.updated !== (table === 'store_seckill') || (table !== 'store_seckill' && JSON.stringify(columns.map(row => row.column_name)) !== '["id"]'))
          throw Error('Independent seckill LOGIN grants differ from fixed declared scope');
      }
      return work(writer);
    });
    return { ...f, ...r2, env, token, adminToken, adminId, adminRoleId, unique,
      slotId: seckillShortRuntimeSlotId, container: createContainerFromDb(f.db), withSeckillRuntime,
      kvWrites, kvDeletes, adminInput: (price = '6.25') => seedSeckillShortSkuAdminInput(unique, price),
      snapshot: () => refundEvidenceSnapshot(f.db), sequences: () => refundEvidenceSequences(f.db) };
  } catch (error) { await f.close(); throw error; }
}
