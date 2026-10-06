/** Native PG16 + real separate LOGINs using the production privilege-plan
 * intersection on these eleven tables and the real three-table catalog guard.
 * This fixture does not claim full 282-table runtime commissioning. */
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { agentLevel, agentLevelTask, agentLevelTaskRecord, systemAdmin, systemAttachment, systemAttachmentCategory,
  systemConfig, systemLog, systemMenus, systemRole, user } from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { installRuntimeAgentLevelCatalogBoundaryInTransaction, inspectRuntimeAgentLevelCatalogBoundary } from '../../src/migrations/runtimeAgentLevelCatalogBoundary';
import { AdminDistributorLevelService } from '../../src/services/admin/AdminDistributorLevelService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';

export const distributorActor = { id: 7 };
export const distributorTestBindings = { APP_KEY: 'owned-distributor-catalog-http-key' };
export const distributorLevelTables = [agentLevel, agentLevelTask, agentLevelTaskRecord, systemConfig, systemAttachment, systemAttachmentCategory, systemLog, systemAdmin, systemRole, systemMenus, user];
type Peer = SequenceRunnerPeer & { role: string; connectionString: string };
export const distributorIdentifier = (value: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned distributor identifier'); return `"${value}"`;
};
export const distributorLevelValues = (grade = 4) => ({ name: `等级${grade}`, grade, image: '/uploads/system/agent_level_1.png', color: '#D97E1D', one_brokerage: 19, two_brokerage: 12, status: 1 });
export const distributorTaskValues = (level_id = 2, type = 3) => ({ level_id, name: '新任务', type, number: 30, desc: '任务说明\n第二行', sort: 10, status: 1 });
export async function installDistributorTables(f: Pick<Awaited<ReturnType<typeof sequenceRunnerDatabase>>, 'exec'>, tables: typeof distributorLevelTables = distributorLevelTables) {
  const dialect = new PgDialect();
  for (const table of tables) {
    const definition = getTableConfig(table), q = distributorIdentifier;
    const columns = definition.columns.map(column => {
      const value = column.default, initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
      return `${q(column.name)} ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
    });
    const checks = definition.checks.map(check => `CONSTRAINT ${q(check.name)} CHECK (${dialect.sqlToQuery(check.value).sql})`);
    await f.exec(`CREATE TABLE public.${q(definition.name)} (${[...columns, ...checks].join(',')})`);
    for (const index of definition.indexes) {
      const value = index.config, names = value.columns.map(column => {
        if (!('name' in column) || typeof column.name !== 'string') throw Error('Unexpected distributor expression index'); return q(column.name);
      });
      const predicate = value.where ? ` WHERE ${dialect.sqlToQuery(value.where).sql}` : '';
      await f.exec(`CREATE ${value.unique ? 'UNIQUE ' : ''}INDEX ${q(value.name!)} ON public.${q(definition.name)} (${names.join(',')})${predicate}`);
    }
  }
}
export async function distributorLevelFixture(options: { empty?: boolean } = {}) {
  const f = await sequenceRunnerDatabase();
  if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) { await f.close(); throw Error('Distributor fixture requires native PG16 and real independent LOGINs'); }
  try {
    await installDistributorTables(f);
    if (!options.empty) {
      await f.db.insert(agentLevel).values([
        { id: 1, ...{ name: '等级一', grade: 1, image: '/uploads/system/agent_level_1.png', color: '#D97E1D', oneBrokerage: 2, twoBrokerage: 1, status: 1, addTime: 1700000001 } },
        { id: 2, name: '等级二', grade: 2, image: '/uploads/system/agent_level_2.png', color: '#5D7DAC', oneBrokerage: 5, twoBrokerage: 3, status: 1, addTime: 1700000002 },
        { id: 3, name: '隐藏等级 %_', grade: 3, image: '/uploads/system/agent_level_3.png', color: '#5856D6', oneBrokerage: 10, twoBrokerage: 5, status: 0, addTime: 1700000003 },
      ]);
      await f.db.insert(agentLevelTask).values([
        { id: 11, levelId: 1, name: '邀请10人', type: 1, number: 10, sort: 10, status: 1, addTime: 1700000011 },
        { id: 12, levelId: 2, name: '邀请20人', type: 1, number: 20, sort: 20, status: 1, addTime: 1700000012 },
        { id: 13, levelId: 3, name: '隐藏父级任务', type: 1, number: 5, sort: 30, status: 1, addTime: 1700000013 },
        { id: 21, levelId: 1, name: '消费金额', type: 2, number: 10, desc: '历史说明', isMust: 1, sort: 30, status: 1, addTime: 1700000021 },
      ]);
      await f.db.insert(agentLevelTaskRecord).values({ id: 1, uid: 91, levelId: 1, taskId: 21, status: 1 });
    }
    await f.db.insert(user).values([{ uid: 91, nickname: '已升级用户', agentLevel: 2 }, { uid: 92, nickname: '新用户', agentLevel: 0 }]);
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'store_brokerage_ratio', value: '10.01' }, { id: 2, menuName: 'store_brokerage_two', value: '5' },
      { id: 3, menuName: 'brokerage_func_status', value: '1' },
    ]);
    await f.db.insert(systemAttachment).values([
      { attId: 41, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/2026/10/00000000-0000-4000-8000-000000000041.png', attDir: '/api/assets/41', sattDir: '/api/assets/41', attType: 'image/png' },
      { attId: 42, type: 4, relationId: 77, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/supplier/77/2026/10/00000000-0000-4000-8000-000000000042.png', attDir: '/api/assets/42', sattDir: '/api/assets/42', attType: 'image/png' },
      { attId: 43, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/2026/10/00000000-0000-4000-8000-000000000043.png', attDir: '/api/assets/43', sattDir: '/api/assets/43', attType: 'text/html' },
    ]);
    for (const table of distributorLevelTables) {
      const definition = getTableConfig(table);
      for (const column of definition.columns.filter(column => column.getSQLType() === 'serial')) {
        await f.exec(`SELECT setval(pg_get_serial_sequence('public.${definition.name}','${column.name}'),GREATEST(COALESCE((SELECT MAX(${distributorIdentifier(column.name)}) FROM public.${distributorIdentifier(definition.name)}),1),1),(SELECT COUNT(*)>0 FROM public.${distributorIdentifier(definition.name)}))`);
      }
    }
    const installSlice = async (app: Peer, admin: Peer) => {
      await f.db.transaction(tx => installRuntimeAgentLevelCatalogBoundaryInTransaction(tx, { maintenance: 'finance_test', app: app.role, admin: admin.role }), { isolationLevel: 'read committed', accessMode: 'read write' });
      const q = distributorIdentifier;
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
        const plan = runtimeBusinessPrivilegePlan(kind);
        for (const table of distributorLevelTables) {
          const definition = getTableConfig(table), privileges = plan.tables[definition.name];
          if (!privileges?.includes('SELECT')) throw Error(`${kind} production profile cannot read ${definition.name}`);
          await f.exec(`GRANT ${privileges.join(',')} ON public.${q(definition.name)} TO ${q(peer.role)}`);
          const columns = plan.updateColumns[definition.name];
          if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(q).join(',')}) ON public.${q(definition.name)} TO ${q(peer.role)}`);
          if (privileges.includes('INSERT')) for (const column of definition.columns.filter(column => column.getSQLType() === 'serial')) {
            const [row] = await f.exec(`SELECT pg_get_serial_sequence('public.${definition.name}','${column.name}') AS name`), name = String(row.name).split('.');
            if (name.length !== 2 || name[0] !== 'public') throw Error('Unexpected owned distributor sequence');
            await f.exec(`GRANT USAGE ON SEQUENCE public.${q(name[1])} TO ${q(peer.role)}`);
          }
        }
      }
      return f.db.transaction(tx => inspectRuntimeAgentLevelCatalogBoundary(tx, { maintenance: 'finance_test', app: app.role, admin: admin.role }));
    };
    const serviceFor = (db: DbClient = f.db) => new AdminDistributorLevelService(createContainerFromDb(db), distributorTestBindings);
    const snapshot = async () => ({ levels: await f.db.select().from(agentLevel).orderBy(agentLevel.id), tasks: await f.db.select().from(agentLevelTask).orderBy(agentLevelTask.id),
      records: await f.db.select().from(agentLevelTaskRecord).orderBy(agentLevelTaskRecord.id), users: await f.db.select().from(user).orderBy(user.uid),
      settings: await f.db.select().from(systemConfig).orderBy(systemConfig.id), assets: await f.db.select().from(systemAttachment).orderBy(systemAttachment.attId), logs: await f.db.select().from(systemLog).orderBy(systemLog.id) });
    return { ...f, tables: distributorLevelTables, env: distributorTestBindings, serviceFor, snapshot, installSlice, withRuntimeRole: f.withRuntimeRole, withPeer: f.withPeer };
  } catch (error) { await f.close(); throw error; }
}
