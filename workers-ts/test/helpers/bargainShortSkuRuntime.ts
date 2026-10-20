/** Registered owned PG16; actual Admin/customer JWT routes use injected
 * maintenance SQL. Only strict create/replay use an independent LOGIN. This is
 * a declared test grant profile, not production runtime commissioning. */
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import type { Env } from '@/env';
import { storeCart, storeProduct, storeProductAttr, storeProductAttrValue,
  storeProductDescription, systemAdmin, systemRole, user } from '@/models/schema';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './refundRuntimeFixture';
import { refundEvidenceR2, refundEvidenceSequences, refundEvidenceSnapshot } from './refundApplicationEvidence';

export function seedBargainShortSkuAdminInput(unique = 'short7', price = '10.00', minPrice = '2.00') {
  return { type: 'bargain', productId: 70, storeName: 'Owned short base bargain',
    title: 'Owned short base bargain', unitName: '件', image: '/legacy/bargain-short-sku.png',
    images: ['/legacy/bargain-short-sku.png'], description: '<p>Owned bargain source</p>',
    stock: 6, quota: 5, num: 3, price, minPrice, people: 2, status: 1,
    startTime: new Date(Date.now() - 3_600_000).toISOString(),
    stopTime: new Date(Date.now() + 3_600_000).toISOString(),
    shipping: { deliveryType: '1', freight: 1, postage: '0.00', tempId: 0 },
    sku: { baseUnique: unique } };
}

export async function bargainShortSkuRuntimeFixture(options: { unique?: string } = {}) {
  const f = await refundRuntimeFixture();
  try {
    const unique = options.unique ?? 'short7';
    if (!unique || unique.length > 8 || /[\s\x00-\x1f\x7f]/u.test(unique))
      throw Error('Owned bargain fixture requires a canonical base key');
    await f.db.update(storeProduct).set({ type: 0, relationId: 0, productType: 0,
      price: '17.00', isVip: 0, isVipProduct: 0, isPresaleProduct: 0, isLimit: 0,
      stock: 12, sales: 0, freight: 1, tempId: 0, postage: '0.00', giveIntegral: '0.00',
      unitName: '件', deliveryType: '1', image: '/legacy/bargain-short-sku.png',
      sliderImage: '["/legacy/bargain-short-sku.png"]' }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ unique, suk: '短规格', price: '18.88',
      stock: 12, sales: 0, image: '/legacy/bargain-short-sku.png' }).where(eq(storeProductAttrValue.id, 1));
    await f.db.update(storeCart).set({ productAttrUnique: unique }).where(eq(storeCart.id, 1));
    await f.db.insert(storeProductAttr).values({ productId: 70, type: 0, attrName: '规格', attrValues: '短规格' });
    await f.db.insert(storeProductDescription).values({ productId: 70, type: 0, description: '<p>Owned bargain source</p>' });
    for (const table of ['store_cart', 'store_product_attr_value'])
      await f.db.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${table}','id'),(SELECT max(id) FROM public.${table}),true)`));
    // Distinct namespaces must not accidentally pass through activityId==recordId.
    await f.db.execute(sql`SELECT setval('public.store_bargain_user_id_seq',100,true)`);
    const adminId = 903, adminRoleId = 903, key = 'owned-bargain-short-app-key';
    const adminPassword = 'owned-bargain-short-admin', buyerPassword = 'owned-bargain-short-buyer';
    const helperPassword = 'owned-bargain-short-helper';
    await f.db.insert(systemRole).values({ id: adminRoleId, type: 1, rules: 'activity.manage', status: 1 });
    await f.db.insert(systemAdmin).values({ id: adminId, account: 'owned-bargain-short', pwd: adminPassword,
      adminType: 1, level: 1, roles: String(adminRoleId), status: 1, isDel: 0 });
    await f.db.update(user).set({ pwd: buyerPassword }).where(eq(user.uid, 11));
    await f.db.update(user).set({ pwd: helperPassword }).where(eq(user.uid, 22));
    const r2 = refundEvidenceR2(), kvWrites: Array<{ key: string; value: string }> = [], kvDeletes: string[] = [];
    const configKv = new Proxy(f.env.CONFIG_KV, { get(target, property, receiver) {
      if (property === 'put') return async (name: string, value: string, opts?: KVNamespacePutOptions) => {
        kvWrites.push({ key: name, value }); await target.put(name, value, opts);
      };
      if (property === 'delete') return async (name: string) => { kvDeletes.push(name); await target.delete(name); };
      const value = Reflect.get(target, property, receiver); return typeof value === 'function' ? value.bind(target) : value;
    } });
    // Activity Admin saves use SQL rows, not cfg_ keys. Preserve the donor's
    // real config closure; recording put/delete does not pretend to replace it.
    const env: Env = { ...f.env, APP_KEY: key, NODE_ENV: 'test' as Env['NODE_ENV'],
      CONFIG_KV: configKv, ASSETS_BUCKET: r2.bucket };
    const adminToken = (await createToken(adminId, 'admin', md5(adminPassword), key)).token;
    const token = (await createToken(11, 'api', md5(buyerPassword), key)).token;
    const helperToken = (await createToken(22, 'api', md5(helperPassword), key)).token;
    type Writer = Parameters<Parameters<typeof f.withRuntime>[0]>[0];
    const withBargainRuntime = <T>(work: (writer: Writer) => Promise<T>) => f.withRuntime(async writer => {
      const plan = runtimeBusinessPrivilegePlan('app');
      const profiles = { store_bargain: ['SELECT', 'UPDATE'], store_bargain_user: ['SELECT', 'INSERT', 'UPDATE'] };
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(writer.role)) throw Error('Unowned bargain runtime role');
      for (const [table, privileges] of Object.entries(profiles)) {
        if (JSON.stringify(plan.tables[table]) !== JSON.stringify(privileges))
          throw Error('Bargain fixture differs from the fixed app profile');
        // This author only reads/consumes the participation. Start/help are
        // actual JWT requests on the separately declared maintenance App SQL.
        await f.exec(`GRANT SELECT,UPDATE ON public."${table}" TO "${writer.role}"`);
      }
      const [owner] = await f.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      const [identity] = await writer.db.execute<{ role: string; session: string; pid: number;
        rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean }>(sql`SELECT
        current_user AS role,session_user AS session,pg_backend_pid() AS pid,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls
        FROM pg_roles WHERE rolname=current_user`);
      if (!identity || identity.role !== writer.role || identity.session !== writer.role || identity.pid !== writer.pid
        || identity.pid === owner.pid || identity.rolsuper || identity.rolcreatedb || identity.rolcreaterole || identity.rolbypassrls)
        throw Error('Independent bargain LOGIN identity differs');
      for (const table of Object.keys(profiles)) {
        const [rights] = await writer.db.execute<{ owner: string; selected: boolean; inserted: boolean; updated: boolean; deleted: boolean; truncated: boolean }>(sql`SELECT
          pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=${'public.' + table}::regclass)) AS owner,
          has_table_privilege(current_user,${'public.' + table},'SELECT') AS selected,
          has_table_privilege(current_user,${'public.' + table},'INSERT') AS inserted,
          has_table_privilege(current_user,${'public.' + table},'UPDATE') AS updated,
          has_table_privilege(current_user,${'public.' + table},'DELETE') AS deleted,
          has_table_privilege(current_user,${'public.' + table},'TRUNCATE') AS truncated`);
        if (!rights || rights.owner === writer.role || !rights.selected || !rights.updated
          || rights.inserted || rights.deleted || rights.truncated)
          throw Error('Independent bargain LOGIN rights differ from the declared two-table scope');
      }
      return work(writer);
    });
    return { ...f, ...r2, env, token, helperToken, adminToken, adminId, adminRoleId, unique,
      container: createContainerFromDb(f.db), withBargainRuntime, kvWrites, kvDeletes,
      adminInput: (price = '10.00', minPrice = '2.00') => seedBargainShortSkuAdminInput(unique, price, minPrice),
      snapshot: () => refundEvidenceSnapshot(f.db), sequences: () => refundEvidenceSequences(f.db) };
  } catch (error) { await f.close(); throw error; }
}
