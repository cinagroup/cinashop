import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { articleCategory, storeBrand, storeProductLabel } from '@/models/schema';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
import { AdminDiyListAuthorOptionsService } from '@/services/admin/AdminDiyListAuthorOptionsService';
import { diyAuthorOptionsFixture } from './diyAuthorOptionsFixture';

/** New owned selection slice only. The preceding FAB/DIY fixture defaults and
 * production schema/grant plans remain unchanged. */
export async function diyListAuthorOptionsFixture() {
  const f = await diyAuthorOptionsFixture();
  try {
    const dialect = new PgDialect(), additions = [storeBrand, storeProductLabel];
    const identifier = (name: string) => { if (!/^[a-z_][a-z_0-9]*$/u.test(name)) throw Error('Invalid owned list table'); return `"${name}"`; };
    for (const table of additions) {
      const definition = getTableConfig(table), columns = definition.columns.map(column => {
        const value = column.default, initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `${identifier(column.name)} ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);
    }
    await f.db.insert(storeBrand).values([
      { id: 3101, brandName: '可见品牌', sort: 20 }, { id: 3102, pid: 3101, fid: '3101', brandName: '可见子品牌' },
      { id: 3103, pid: 3102, fid: '3101,3102', brandName: '可见三级品牌' }, { id: 3104, pid: 3103, brandName: '超过三级品牌' },
      { id: 3105, brandName: '隐藏品牌', isShow: 0 }, { id: 3106, pid: 3105, brandName: '隐藏祖先子品牌' },
      { id: 3107, brandName: '门店品牌', storeId: 17 }, { id: 3108, pid: 3107, brandName: '跨门店祖先子品牌' },
      { id: 3109, brandName: '删除品牌', isDel: 1 }, { id: 3110, pid: 999999, brandName: '孤儿品牌' },
      { id: 3111, pid: 3112, brandName: '循环品牌一' }, { id: 3112, pid: 3111, brandName: '循环品牌二' },
      { id: 3113, brandName: '%_品牌', sort: 15 }, { id: 3114, brandName: '第二品牌', sort: 10 }, { id: 3120, brandName: '' },
    ]);
    await f.db.insert(storeProductLabel).values([
      { id: 3201, labelName: '可见标签', sort: 20, icon: 'javascript:private-label-icon', color: 'never-label-style' },
      { id: 3202, labelName: '禁用标签', status: 0 }, { id: 3203, labelName: '隐藏标签', isShow: 0 },
      { id: 3204, labelName: '供应商标签', type: 2, relationId: 77 }, { id: 3205, labelName: '错误平台归属标签', relationId: 77 },
      { id: 3206, labelName: '%_标签', sort: 10 }, { id: 3220, labelName: '' },
    ]);
    await f.db.insert(articleCategory).values([
      { id: 3301, title: '列表作者文章分类', sort: 20 }, { id: 3302, title: '停用文章分类', status: 0 },
      { id: 3303, title: '删除文章分类', isDel: 1 }, { id: 3304, title: '隐藏文章分类', hidden: 1 },
      { id: 3305, title: '公开平面文章分类', pid: 999999 }, { id: 3306, title: '%_文章分类', sort: 10 },
      { id: 3307, title: '' }, { id: 0, title: '伪造持久化热门分类' }, { id: -1, title: '负数文章分类' },
    ]);
    const tables = (await f.exec('SELECT tablename AS name FROM pg_tables WHERE schemaname=\'public\' ORDER BY tablename')).map(row => String(row.name));
    const sequences = (await f.exec('SELECT sequencename AS name FROM pg_sequences WHERE schemaname=\'public\' ORDER BY sequencename')).map(row => String(row.name));
    const snapshot = async () => ({
      tables: await f.db.execute(sql.join(tables.map(name => sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `)),
      sequences: await f.db.execute(sql.join(sequences.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `)),
    });
    const installSlice: typeof f.installSlice = async (app, admin) => {
      await f.installSlice(app, admin);
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const) for (const table of additions) {
        const name = getTableConfig(table).name, plan = runtimeBusinessPrivilegePlan(kind), privileges = plan.tables[name];
        if (!privileges?.includes('SELECT')) throw Error('No current production selection grant for ' + name);
        await f.exec(`GRANT ${privileges.join(',')} ON public.${identifier(name)} TO ${identifier(peer.role)}`);
        if (plan.updateColumns[name]?.length) await f.exec(`GRANT UPDATE(${plan.updateColumns[name].map(identifier).join(',')}) ON public.${identifier(name)} TO ${identifier(peer.role)}`);
        if (privileges.includes('INSERT')) {
          const [row] = await f.exec(`SELECT pg_get_serial_sequence('public.${name}','id') AS name`), parts = String(row.name).split('.');
          if (parts.length !== 2 || parts[0] !== 'public') throw Error('Unexpected owned list sequence');
          await f.exec(`GRANT USAGE ON SEQUENCE public.${identifier(parts[1])} TO ${identifier(peer.role)}`);
        }
      }
    };
    return { ...f, tables, sequences, snapshot, installSlice,
      listFor: (db: DbClient = f.db) => new AdminDiyListAuthorOptionsService(createContainerFromDb(db), f.env) };
  } catch (reason) { await f.close(); throw reason; }
}
