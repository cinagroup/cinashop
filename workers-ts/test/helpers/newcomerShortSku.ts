/** Owned full-schema PG16 only. Admin/user JWTs and route authorization are
 * genuine; the App's SQL sessions are explicitly injected owned maintenance.
 * This does not commission HYPERDRIVE_ADMIN or prove production privileges. */
import { eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { storeCart, storeProduct, storeProductAttrValue, systemAdmin, systemRole, user } from '@/models/schema';
import { REGISTER_CONFIG_KEYS } from '@/services/activity/AdminNewcomerService';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
import { installNewcomerCartAddReplay, newcomerCartAddReplayReadiness } from '@/migrations/runNewcomerCartAddReplay';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './refundRuntimeFixture';
import { refundEvidenceR2, refundEvidenceSequences, refundEvidenceSnapshot } from './refundApplicationEvidence';

export const newcomerShortUnique = 'short7';
export function newcomerShortCatalogInput(unique = newcomerShortUnique, price = '8.00') {
  return {
    store_user_mobile: 0, routine_auth_type: [1, 2], store_user_agreement: 1,
    newcomer_status: 1, newcomer_limit_status: 0, newcomer_limit_time: 0,
    register_integral_status: 0, register_give_integral: 0,
    register_money_status: 0, register_give_money: '0.00',
    register_coupon_status: 0, register_give_coupon: [],
    first_order_status: 0, first_order_discount: '100', first_order_discount_limit: '0.00',
    register_price_status: 1, newcomer_agreement: 'Owned newcomer short-SKU scenario',
    product: [{ product_id: 70, attr: [{ unique, price }] }],
  };
}

export async function newcomerShortSkuFixture(options: { unique?: string } = {}) {
  const f = await refundRuntimeFixture();
  try {
    const unique = options.unique ?? newcomerShortUnique;
    if (!unique || unique.length > 8 || /[\s\x00-\x1f\x7f]/.test(unique))
      throw Error('Owned newcomer fixture requires a canonical base SKU');
    await f.db.update(storeProduct).set({ price: '17.00', isVip: 0, isVipProduct: 0,
      isPresaleProduct: 0, isLimit: 0 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ unique, price: '18.88' })
      .where(eq(storeProductAttrValue.id, 1));
    await f.db.update(storeCart).set({ productAttrUnique: unique }).where(eq(storeCart.id, 1));
    // Existing quote rows have explicit ids 1/2. The actual Admin clone and
    // buyer add must consume fresh ids, rather than collide with their seeds.
    for (const table of ['store_cart', 'store_product_attr_value'])
      await f.db.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${table}','id'),
        (SELECT max(id) FROM public.${table}),true)`));
    const adminId = 901, adminRoleId = 901;
    const adminPassword = 'owned-newcomer-config-password';
    const buyerPassword = 'owned-newcomer-buyer-password';
    const key = 'owned-newcomer-short-app-key';
    await f.db.insert(systemRole).values({ id: adminRoleId, type: 1,
      rules: 'config.view,config.manage', status: 1 });
    await f.db.insert(systemAdmin).values({ id: adminId, account: 'owned-newcomer-config',
      pwd: adminPassword, adminType: 1, level: 1, roles: String(adminRoleId), status: 1, isDel: 0 });
    await f.db.update(user).set({ pwd: buyerPassword, addTime: Math.floor(Date.now() / 1000),
      isNewcomer: 0 }).where(eq(user.uid, 11));
    const r2 = refundEvidenceR2(), configCache = new Map<string, string>();
    const configKeys = new Set<string>(REGISTER_CONFIG_KEYS.map(name => `cfg_${name}`));
    const kvWrites: Array<{ key: string; value: string }> = [], kvDeletes: string[] = [];
    // The donor pricing fixture has a fixed cfg_ view. For the exact Admin
    // register-config keys use a normal cold cache so actual SQL save/read and
    // invalidation determine eligibility. No service result is substituted.
    const configKv = new Proxy(f.env.CONFIG_KV, {
      get(target, property, receiver) {
        if (property === 'get') return async (name: string) => configKeys.has(name)
          ? configCache.get(name) ?? null : target.get(name);
        if (property === 'put') return async (name: string, value: string, opts?: KVNamespacePutOptions) => {
          kvWrites.push({ key: name, value });
          if (configKeys.has(name)) configCache.set(name, value);
          else await target.put(name, value, opts);
        };
        if (property === 'delete') return async (name: string) => {
          kvDeletes.push(name); configCache.delete(name); await target.delete(name);
        };
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const env: Env = { ...f.env, APP_KEY: key, NODE_ENV: 'test' as Env['NODE_ENV'],
      CONFIG_KV: configKv, ASSETS_BUCKET: r2.bucket };
    const adminToken = (await createToken(adminId, 'admin', md5(adminPassword), key)).token;
    const token = (await createToken(11, 'api', md5(buyerPassword), key)).token;
    type Writer = Parameters<Parameters<typeof f.withRuntime>[0]>[0];
    const withNewcomerRuntime = <T>(work: (writer: Writer) => Promise<T>) => f.withRuntime(async writer => {
      // Fixed before any business call, matching the already reviewed ordinary
      // app profile. This is not error-triggered permission repair or a new
      // production profile. The donor's independent LOGIN owns no SQL objects.
      const plan = runtimeBusinessPrivilegePlan('app');
      if (JSON.stringify(plan.tables.store_newcomer) !== '["SELECT"]'
        || JSON.stringify(plan.updateColumns.store_newcomer) !== '["id"]'
        || !/^cinashop_runtime_[a-f0-9]{32}$/.test(writer.role))
        throw Error('Owned newcomer grants differ from reviewed fixed app scope');
      await f.exec(`GRANT SELECT ON public.store_newcomer TO "${writer.role}"`);
      await f.exec(`GRANT UPDATE(id) ON public.store_newcomer TO "${writer.role}"`);
      const [owner] = await f.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      const [identity] = await writer.db.execute<{ role: string; session: string; pid: number;
        relation_owner: string; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean;
        rolbypassrls: boolean; can_select: boolean; can_insert: boolean; can_update: boolean;
        can_delete: boolean; can_truncate: boolean }>(sql`SELECT current_user AS role,
        session_user AS session,pg_backend_pid() AS pid,
        pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.store_newcomer'::regclass)) AS relation_owner,
        rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,
        has_table_privilege(current_user,'public.store_newcomer','SELECT') AS can_select,
        has_table_privilege(current_user,'public.store_newcomer','INSERT') AS can_insert,
        has_table_privilege(current_user,'public.store_newcomer','UPDATE') AS can_update,
        has_table_privilege(current_user,'public.store_newcomer','DELETE') AS can_delete,
        has_table_privilege(current_user,'public.store_newcomer','TRUNCATE') AS can_truncate
        FROM pg_roles WHERE rolname=current_user`);
      const columns = await writer.db.execute<{ column_name: string }>(sql`SELECT column_name
        FROM information_schema.columns WHERE table_schema='public' AND table_name='store_newcomer'
        AND has_column_privilege(current_user,'public.store_newcomer',column_name,'UPDATE')
        ORDER BY ordinal_position`);
      if (!identity || identity.role !== writer.role || identity.session !== writer.role
        || identity.pid !== writer.pid || identity.pid === owner.pid || identity.relation_owner === writer.role
        || identity.rolsuper || identity.rolcreatedb || identity.rolcreaterole || identity.rolbypassrls
        || !identity.can_select || identity.can_insert || identity.can_update || identity.can_delete || identity.can_truncate
        || JSON.stringify(columns.map(row => row.column_name)) !== '["id"]')
        throw Error('Independent owned newcomer LOGIN authority differs from declared scope');
      return work(writer);
    });
    type ReplayPeer = Parameters<Parameters<NonNullable<typeof f.withRuntimeRole>>[0]>[0];
    const withInstalledReplay = <T>(work: (peer: ReplayPeer & { tableCount: 284; sequenceCount: 229 }) => Promise<T>) => {
      if (!f.withRuntimeRole) throw Error('Owned replay installation requires an independent LOGIN');
      return f.withRuntimeRole(async peer => {
        // Deliberately outside runAll185. Only the Browser opts in. This peer
        // holds the fixed receipt SELECT/INSERT grant, not application-table
        // authority; the actual App remains explicitly owned maintenance SQL.
        await installNewcomerCartAddReplay(f.db, peer.role);
        if (!(await newcomerCartAddReplayReadiness(peer.db)).ready)
          throw Error('Owned independent replay receipt role is not ready');
        const [inventory] = await f.db.execute<{ tables: number; sequences: number }>(sql`SELECT
          (SELECT count(*)::integer FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r') AS tables,
          (SELECT count(*)::integer FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='S') AS sequences`);
        if (inventory.tables !== 284 || inventory.sequences !== 229)
          throw Error('Explicit replay protocol inventory differs from full-schema fixture');
        return work({ ...peer, tableCount: 284, sequenceCount: 229 });
      });
    };
    return { ...f, ...r2, env, token, adminToken, adminId, adminRoleId, unique, kvWrites, kvDeletes,
      container: createContainerFromDb(f.db), withNewcomerRuntime, withInstalledReplay,
      snapshot: () => refundEvidenceSnapshot(f.db), sequences: () => refundEvidenceSequences(f.db) };
  } catch (error) { await f.close(); throw error; }
}
