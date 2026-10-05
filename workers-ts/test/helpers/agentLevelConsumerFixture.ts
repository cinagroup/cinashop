/** Native PG16 only. Ten real ORM tables and the reviewed runtime profile
 * intersection, not full runtime commissioning or a production installer. */
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { agentLevel, agentLevelTask, agentLevelTaskRecord, luckLottery, storeOrder, systemAttachment, systemConfig, user, userFriends, userSpread } from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { installRuntimeAgentLevelCatalogBoundaryInTransaction } from '../../src/migrations/runtimeAgentLevelCatalogBoundary';
import { AgentLevelTaskService, upgradeAgentLevelsForUser } from '../../src/services/agent/AgentLevelTaskService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';

export const agentConsumerTables = [agentLevel, agentLevelTask, agentLevelTaskRecord, user, storeOrder, systemConfig, systemAttachment, userSpread, userFriends, luckLottery];
export type AgentConsumerPeer = SequenceRunnerPeer & { role: string; connectionString: string };
const ident = (value: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned distributor identifier');
  return `"${value}"`;
};
export async function agentLevelConsumerFixture() {
  const f = await sequenceRunnerDatabase();
  try {
    if (f.format !== 'pg16' || !f.withPeer || !f.withRuntimeRole) throw Error('Distributor consumer proof requires native PG16 and LOGIN peers');
    const dialect = new PgDialect();
    for (const table of agentConsumerTables) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        const value = column.default;
        const initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `${ident(column.name)} ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public.${ident(definition.name)} (${columns.join(',')})`);
      for (const index of definition.indexes) {
        const config = index.config;
        const columns = config.columns.map(column => {
          if (!('name' in column) || typeof column.name !== 'string') throw Error('Unexpected distributor expression index');
          return ident(column.name);
        });
        const where = config.where ? ` WHERE ${dialect.sqlToQuery(config.where).sql}` : '';
        await f.exec(`CREATE ${config.unique ? 'UNIQUE ' : ''}INDEX ${ident(config.name!)} ON public.${ident(definition.name)} (${columns.join(',')})${where}`);
      }
      for (const check of definition.checks) await f.exec(`ALTER TABLE public.${ident(definition.name)} ADD CONSTRAINT ${ident(check.name)} CHECK (${dialect.sqlToQuery(check.value).sql})`);
    }
    const now = Math.floor(Date.now() / 1000);
    await f.db.insert(user).values([
      { uid: 10, nickname: '祖级', spreadUid: 0, spreadTime: now, isPromoter: 1 },
      { uid: 20, nickname: '上级', spreadUid: 10, spreadTime: now, isPromoter: 1 },
      { uid: 30, nickname: '买家', spreadUid: 20, spreadTime: now, isPromoter: 1 },
    ]);
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'brokerage_func_status', value: '1', sort: 100 },
      { id: 2, menuName: 'is_self_brokerage', value: '0', sort: 100 },
      { id: 3, menuName: 'store_brokerage_binding_status', value: '1', sort: 100 },
      { id: 4, menuName: 'store_brokerage_binding_time', value: '30', sort: 100 },
      { id: 5, menuName: 'store_brokerage_ratio', value: '5', sort: 100 },
      { id: 6, menuName: 'store_brokerage_two', value: '3', sort: 100 },
      { id: 7, menuName: 'store_brokerage_statu', value: '1', sort: 100 },
      { id: 8, menuName: 'division_status', value: '0', sort: 100 },
      { id: 9, menuName: 'brokerage_level', value: '2', sort: 100 },
    ]);
    await f.db.insert(agentLevel).values([
      { id: 1, name: '初级', grade: 1, image: '/api/assets/41', color: '#3377ff', oneBrokerage: 20, twoBrokerage: 10 },
      { id: 2, name: '高级', grade: 2, image: '/legacy/level-2.png', color: '#aa3333', oneBrokerage: 100, twoBrokerage: 50 },
    ]);
    await f.db.insert(agentLevelTask).values({ id: 11, levelId: 1, type: 1, number: 1, name: '邀请一人', isMust: 0 });
    await f.db.insert(systemAttachment).values([
      { attId: 41, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, attDir: '/api/assets/41',
        name: 'attachments/admin/1/distributor.png', attType: 'image/png' },
      { attId: 42, type: 4, relationId: 77, moduleType: 1, fileType: 1, imageType: 8, attDir: '/api/assets/42',
        name: 'attachments/supplier/77/private.png', attType: 'image/png' },
    ]);
    const env = { APP_KEY: 'isolated-distributor-consumer-key' };
    const installSlice = async (app: AgentConsumerPeer, admin: AgentConsumerPeer) => {
      await f.db.transaction(tx => installRuntimeAgentLevelCatalogBoundaryInTransaction(tx,
        { maintenance: 'finance_test', app: app.role, admin: admin.role }), { isolationLevel: 'read committed', accessMode: 'read write' });
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
        const profile = runtimeBusinessPrivilegePlan(kind);
        for (const table of agentConsumerTables) {
          const definition = getTableConfig(table), grants = profile.tables[definition.name];
          if (!grants?.includes('SELECT')) throw Error(`${kind} cannot read production ${definition.name}`);
          await f.exec(`GRANT ${grants.join(',')} ON public.${ident(definition.name)} TO ${ident(peer.role)}`);
          const columns = profile.updateColumns[definition.name];
          if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(ident).join(',')}) ON public.${ident(definition.name)} TO ${ident(peer.role)}`);
          if (grants.includes('INSERT')) for (const column of definition.columns) {
            if (!['serial', 'bigserial'].includes(column.getSQLType())) continue;
            const [row] = await f.exec(`SELECT pg_get_serial_sequence('public.${definition.name}','${column.name}') AS name`);
            const sequence = String(row.name).split('.');
            if (sequence.length !== 2 || sequence[0] !== 'public') throw Error('Unexpected owned distributor sequence');
            await f.exec(`GRANT USAGE ON SEQUENCE public.${ident(sequence[1])} TO ${ident(peer.role)}`);
          }
        }
      }
    };
    return { ...f, env, now, installSlice,
      serviceFor: (db: DbClient = f.db) => new AgentLevelTaskService(createContainerFromDb(db), env),
      upgradeFor: (uid: number, db: DbClient = f.db) => upgradeAgentLevelsForUser(createContainerFromDb(db), uid),
      snapshot: async () => ({ users: await f.db.select().from(user).orderBy(user.uid),
        records: await f.db.select().from(agentLevelTaskRecord).orderBy(agentLevelTaskRecord.id) }),
    };
  } catch (error) { await f.close(); throw error; }
}
