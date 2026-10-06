/** Disposable native PG16 database and genuine LOGINs. This is the unchanged
 * production ACL intersection on eight tables, not full runtime commissioning. */
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { systemAdmin, systemAttachment, systemAttachmentCategory, systemGroup, systemGroupData, systemLog, systemMenus, systemRole } from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { installRuntimeSignDayGroupLockBoundaryInTransaction } from '../../src/migrations/runtimeSignDayGroupLockBoundary';
import { AdminPcBannerService } from '../../src/services/admin/AdminPcBannerService';
import { PC_BANNER_DEFAULT_METADATA } from '../../src/services/admin/AdminPcBannerInput';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';

export const pcBannerActor = { id: 7 };
export const pcBannerTestBindings = { APP_KEY: 'owned-pc-banner-http-key' };
export const pcBannerTables = [systemGroup, systemGroupData, systemAttachment, systemAttachmentCategory, systemLog, systemAdmin, systemRole, systemMenus];
type Peer = SequenceRunnerPeer & { role: string; connectionString: string };
const identifier = (value: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned PC-banner identifier'); return `"${value}"`;
};
export const pcBannerValues = (title = '轮播标题') => ({ title, image: '/legacy/banner.png', url: '/goods?q=white%20shirt' });
export function pcBannerStored(values: Record<string, unknown> = pcBannerValues()) {
  return JSON.stringify(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { type: key === 'image' ? 'upload' : 'input', value }])));
}
export async function pcBannerFixture(options: { group?: boolean; rows?: boolean } = {}) {
  const f = await sequenceRunnerDatabase();
  if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) { await f.close(); throw Error('PC banner fixture requires native PG16 and real independent LOGINs'); }
  try {
    const dialect = new PgDialect();
    for (const table of pcBannerTables) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        const value = column.default;
        const initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `${identifier(column.name)} ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);
      for (const index of definition.indexes) {
        const value = index.config;
        if (!value.unique) continue;
        const names = value.columns.map(column => {
          if (!('name' in column) || typeof column.name !== 'string') throw Error('Unexpected PC-banner expression index'); return identifier(column.name);
        });
        await f.exec(`CREATE UNIQUE INDEX ${identifier(value.name!)} ON public.${identifier(definition.name)} (${names.join(',')})`);
      }
    }
    if (options.group !== false) {
      await f.db.insert(systemGroup).values({ id: 66, cateId: 0, name: 'PC端首页banner', info: 'PC端首页banner', configName: 'pc_home_banner', fields: PC_BANNER_DEFAULT_METADATA });
      if (options.rows !== false) await f.db.insert(systemGroupData).values([
        { id: 301, gid: 66, value: JSON.stringify({ ...JSON.parse(pcBannerStored()), title: { type: 'input', value: '轮播一', legacy_tip: '保留' }, extra_root: { future: true } }), sort: 100, status: 1, addTime: 1700000000 },
        { id: 302, gid: 66, value: pcBannerStored({ title: '隐藏轮播', image: ['/legacy/banner-2.png', '/legacy/ignored.png'], url: 'http://example.com/catalog' }), sort: 100, status: 0, addTime: 1700000001 },
      ]);
    }
    await f.db.insert(systemGroup).values({ id: 90, cateId: 0, name: '其他组', configName: 'other_banner', fields: PC_BANNER_DEFAULT_METADATA });
    await f.db.insert(systemGroupData).values({ id: 900, gid: 90, value: pcBannerStored(), sort: 1000, status: 1 });
    await f.db.insert(systemAttachment).values([
      { attId: 41, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/2026/10/00000000-0000-4000-8000-000000000041.png',
        attDir: '/api/assets/41', sattDir: '/api/assets/41', attType: 'image/png', realName: 'platform.png' },
      { attId: 42, type: 4, relationId: 77, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/supplier/77/2026/10/00000000-0000-4000-8000-000000000042.png',
        attDir: '/api/assets/42', sattDir: '/api/assets/42', attType: 'image/png' },
      { attId: 43, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/2026/10/00000000-0000-4000-8000-000000000043.png',
        attDir: '/api/assets/43', sattDir: '/api/assets/43', attType: 'text/html' },
    ]);
    const installSlice = async (app: Peer, admin: Peer) => {
      await f.db.transaction(tx => installRuntimeSignDayGroupLockBoundaryInTransaction(tx, { maintenance: 'finance_test', admin: admin.role }),
        { isolationLevel: 'read committed', accessMode: 'read write' });
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
        const plan = runtimeBusinessPrivilegePlan(kind);
        for (const table of pcBannerTables) {
          const definition = getTableConfig(table), privileges = plan.tables[definition.name];
          if (!privileges?.includes('SELECT')) throw Error(`${kind} production profile cannot read ${definition.name}`);
          await f.exec(`GRANT ${privileges.join(',')} ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
          const columns = plan.updateColumns[definition.name];
          if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(identifier).join(',')}) ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
          if (privileges.includes('INSERT')) for (const column of definition.columns) {
            if (!['serial', 'bigserial'].includes(column.getSQLType())) continue;
            const [row] = await f.exec(`SELECT pg_get_serial_sequence('public.${definition.name}','${column.name}') AS name`);
            const sequence = String(row.name).split('.');
            if (sequence.length !== 2 || sequence[0] !== 'public') throw Error('Unexpected owned PC-banner sequence');
            await f.exec(`GRANT USAGE ON SEQUENCE public.${identifier(sequence[1])} TO ${identifier(peer.role)}`);
          }
        }
      }
    };
    const serviceFor = (db: DbClient = f.db) => new AdminPcBannerService(createContainerFromDb(db), pcBannerTestBindings);
    const snapshot = async () => ({ groups: await f.db.select().from(systemGroup).orderBy(systemGroup.id),
      rows: await f.db.select().from(systemGroupData).orderBy(systemGroupData.id), logs: await f.db.select().from(systemLog).orderBy(systemLog.id),
      assets: await f.db.select().from(systemAttachment).orderBy(systemAttachment.attId) });
    return { ...f, tables: pcBannerTables, env: pcBannerTestBindings, serviceFor, snapshot, installSlice, withRuntimeRole: f.withRuntimeRole, withPeer: f.withPeer };
  } catch (error) { await f.close(); throw error; }
}
