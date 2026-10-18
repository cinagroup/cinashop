import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb } from '@/lib/di';
import { storeProductRule } from '@/models/schema';
import { supplierProductUnitsFixture } from './supplierProductUnits';
import { supplierSystemFormCheckoutFixture } from './supplierProductSystemForms';
import type { SupplierProductScheduleRuntime } from './supplierProductSchedule';

export type SupplierRuleInlineState = Record<string, Array<{ row: Record<string, any> }>>;
export const supplierRuleInlineIds = { platform: 101, own: 201, second: 202, foreign: 301, missing: 999 } as const;
export const supplierRuleInlineBody = (name = '商品内新增规格模板') => ({ rule_name: name,
  spec: [{ value: '颜色', detail: ['红', '蓝'] }, { value: '尺码', detail: ['S', 'M'] }] });

/** Only a newly owned PG16 fixture. Rule-only authors use separate restricted
 * LOGINs; ordinary product authors and moderation retain their mature profiles. */
export async function supplierProductRuleInlineFixture() {
  const f = await supplierProductUnitsFixture();
  let checkout: Awaited<ReturnType<typeof supplierSystemFormCheckoutFixture>> | undefined;
  try {
    const definition = getTableConfig(storeProductRule), dialect = new PgDialect();
    const columns = definition.columns.map(column => {
      const initial = column.default;
      const defaultSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
      return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
    });
    await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
    await f.db.insert(storeProductRule).values([
      { id: 101, type: 0, relationId: 0, ruleName: '平台规格不可借用', ruleValue: JSON.stringify([{ value: '平台', detail: ['值'] }]) },
      { id: 201, type: 2, relationId: 7, ruleName: '本店服装模板', ruleValue: JSON.stringify(supplierRuleInlineBody().spec) },
      { id: 202, type: 2, relationId: 7, ruleName: '本店历史模板', ruleValue: JSON.stringify([{ value: '包装', detail: ['盒装'] }]) },
      { id: 301, type: 2, relationId: 8, ruleName: '外店私有规格', ruleValue: JSON.stringify([{ value: '外店维度', detail: ['外店值'] }]) },
    ]);
    await f.exec("SELECT setval('public.store_product_rule_id_seq',400,false)");
    const snapshot = async (): Promise<SupplierRuleInlineState> => {
      const tables = await f.exec("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
      const state: SupplierRuleInlineState = {};
      for (const row of tables) {
        const name = String(row.tablename); if (!/^[a-z][a-z0-9_]*$/.test(name)) throw Error('Unowned rule-inline table');
        state[name] = await f.exec(`SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`) as unknown as SupplierRuleInlineState[string];
      }
      return state;
    };
    const sequences = async () => {
      const rows = await f.exec("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename");
      return Promise.all(rows.map(async row => {
        const name = String(row.sequencename); if (!/^[a-z][a-z0-9_]*$/.test(name)) throw Error('Unowned rule-inline sequence');
        return { name, ...(await f.exec(`SELECT last_value,is_called FROM public."${name}"`))[0] };
      }));
    };
    function roleName(role: string) { if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(role)) throw Error('Unowned rule-inline LOGIN'); return '"' + role + '"'; }
    const grantRuleReader = async (role: string) => {
      await f.exec(`GRANT SELECT ON public.system_admin,public.system_supplier,public.system_role,public.system_menus,public.store_product_rule TO ${roleName(role)}`);
    };
    const grantRuleWriter = async (role: string) => {
      await grantRuleReader(role);
      await f.exec(`GRANT UPDATE(id) ON public.system_admin,public.system_supplier,public.system_role,public.system_menus TO ${roleName(role)};
        GRANT INSERT,DELETE,UPDATE(rule_name,rule_value) ON public.store_product_rule TO ${roleName(role)};
        GRANT SELECT,INSERT ON public.system_log TO ${roleName(role)};
        GRANT USAGE,SELECT ON SEQUENCE public.store_product_rule_id_seq,public.system_log_id_seq TO ${roleName(role)}`);
    };
    const withRuleReader = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withRuntimeRole!(async peer => {
      await grantRuleReader(peer.role); return work({ ...peer, container: createContainerFromDb(peer.db) });
    });
    const withRuleWriter = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withRuntimeRole!(async peer => {
      await grantRuleWriter(peer.role); return work({ ...peer, container: createContainerFromDb(peer.db) });
    });
    const prepareCheckout = async () => {
      // Existing commissioner adds missing true ORM tables/protocols and moves
      // synthetic source SKU IDs before baselines. Buyer SQL is maintenance;
      // this provides real JWT/quote/create, not a separate restricted Buyer.
      checkout ??= await supplierSystemFormCheckoutFixture(f);
      return checkout;
    };
    return { ...f, snapshot, sequences, withRuleReader, withRuleWriter, grantRuleReader, grantRuleWriter,
      prepareCheckout, ruleIds: supplierRuleInlineIds, ruleBody: supplierRuleInlineBody,
      buyerSqlBoundary: 'owned finance_test maintenance connection' as const,
      close: async () => { try { await checkout?.close(); } finally { await f.close(); } } };
  } catch (error) { try { await checkout?.close(); } finally { await f.close(); } throw error; }
}
