/** Eight real ORM tables, independent non-owner PG16 LOGINs and only the
 * intersection with current production privileges. Not full commissioning. */
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { systemAdmin, systemConfig, systemDise, systemGroup, systemGroupData, systemLog, systemMenus, systemRole } from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { AdminThemeSettingsService } from '../../src/services/admin/AdminThemeSettingsService';
import { AdminSignDayConfigService } from '../../src/services/admin/AdminSignDayConfigService';
import { ThemeReadService } from '../../src/services/content/ThemeReadService';
import { V2PublicCompatibilityService } from '../../src/services/content/V2PublicCompatibilityService';
import type { SystemConfigEnv } from '../../src/services/system/SystemConfigService';
import { observeFabDb } from './fabSettingsFixture';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';

export const themeActor = { id: 7 };
export const themeTables = [systemDise, systemLog, systemAdmin, systemRole, systemMenus, systemConfig, systemGroup, systemGroupData];
export const observeThemeDb = observeFabDb;
export const themeConfigEnv = { CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} } } satisfies SystemConfigEnv;
const identifier = (value: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned theme identifier'); return `"${value}"`; };
type Peer = SequenceRunnerPeer & { role: string; connectionString: string };

export async function themeSettingsFixture(options: { row?: boolean } = {}) {
  const f = await sequenceRunnerDatabase();
  if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) { await f.close(); throw Error('Theme fixture requires native PG16 with independent LOGINs'); }
  try {
    const dialect = new PgDialect();
    for (const table of themeTables) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        const value = column.default;
        const initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `${identifier(column.name)} ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);
      for (const index of definition.indexes) {
        const value = index.config, names = value.columns.map(column => {
          if (!('name' in column) || typeof column.name !== 'string') throw Error('Unexpected theme expression index'); return identifier(column.name);
        });
        await f.exec(`CREATE ${value.unique ? 'UNIQUE ' : ''}INDEX ${identifier(value.name!)} ON public.${identifier(definition.name)} (${names.join(',')})`);
      }
    }
    await f.db.insert(systemDise).values([
      { id: 1, name: '默认页面', templateName: 'default', type: 1, value: '[]' },
      { id: 2, name: '普通页面', templateName: 'ordinary', type: 1, value: '[]', isDiy: 1, status: 0 },
      { id: 87, name: '分类布局', templateName: 'product_category_diy', type: 3, value: '4' },
    ]);
    if (options.row !== false) await f.db.insert(systemDise).values({ id: 88, name: '一键换色', title: '一键换色', templateName: 'color_change', type: 3,
      value: '1', status: 0, isShow: 0, isDel: 0, isDiy: 1, content: 'preserve imported metadata', defaultValue: 'legacy-default',
      coverImage: '/legacy/theme-cover.png', colorPicker: '#123456', bgPic: '/legacy/background.png', version: 'legacy-v1',
      addTime: 1626055689, updateTime: 1726022341 });
    await f.exec("SELECT setval(pg_get_serial_sequence('public.system_dise','id'),100,true)");
    await f.db.insert(systemConfig).values([
      { menuName: 'navigation_open', value: '1', isStore: 0 },
      { menuName: 'product_category_level', value: '2', isStore: 0 },
      // Deliberately conflicting same-name system_config must never be theme authority.
      { menuName: 'color_change', value: '6', isStore: 0 },
    ]);
    await f.db.insert(systemGroup).values({ id: 12, name: '签到天数', configName: 'sign_day_num', info: '签到天数', fields: JSON.stringify([
      { name: '第几天', title: 'day', type: 'input', param: '' }, { name: '获取积分', title: 'sign_num', type: 'input', param: '' },
    ]) });
    const installSlice = async (app: Peer, admin: Peer) => {
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
        const plan = runtimeBusinessPrivilegePlan(kind);
        for (const table of themeTables) {
          const definition = getTableConfig(table), privileges = plan.tables[definition.name];
          if (!privileges?.includes('SELECT')) throw Error(`${kind} profile cannot read ${definition.name}`);
          await f.exec(`GRANT ${privileges.join(',')} ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
          const columns = plan.updateColumns[definition.name];
          if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(identifier).join(',')}) ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
          if (privileges.includes('INSERT')) for (const column of definition.columns) {
            if (!['serial', 'bigserial'].includes(column.getSQLType())) continue;
            const [row] = await f.exec(`SELECT pg_get_serial_sequence('public.${definition.name}','${column.name}') AS name`);
            const sequence = String(row.name).split('.');
            if (sequence.length !== 2 || sequence[0] !== 'public') throw Error('Unexpected theme sequence');
            await f.exec(`GRANT USAGE ON SEQUENCE public.${identifier(sequence[1])} TO ${identifier(peer.role)}`);
          }
        }
      }
    };
    return { ...f, tables: themeTables, installSlice,
      serviceFor: (db: DbClient = f.db) => new AdminThemeSettingsService(createContainerFromDb(db)),
      readFor: (db: DbClient = f.db) => new ThemeReadService(createContainerFromDb(db)),
      publicFor: (db: DbClient = f.db) => new V2PublicCompatibilityService(createContainerFromDb(db), themeConfigEnv),
      signFor: (db: DbClient = f.db) => new AdminSignDayConfigService(createContainerFromDb(db)),
      snapshot: async () => ({ rows: await f.db.select().from(systemDise).orderBy(systemDise.id), logs: await f.db.select().from(systemLog).orderBy(systemLog.id),
        configs: await f.db.select().from(systemConfig).orderBy(systemConfig.id) }),
      withRuntimeRole: f.withRuntimeRole, withPeer: f.withPeer,
    };
  } catch (error) { await f.close(); throw error; }
}
