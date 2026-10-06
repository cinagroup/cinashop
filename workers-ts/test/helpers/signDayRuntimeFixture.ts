/** Native, disposable LOGINs using the exact production grant-plan slice for
 * this fixed group editor. This is not full runtime commissioning. */
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { installRuntimeSignDayGroupLockBoundaryInTransaction } from '../../src/migrations/runtimeSignDayGroupLockBoundary';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';
import { signDayConfigTables, seedSignDayConfig } from './signDayConfigFixture';
import { systemAdmin, systemRole, systemMenus } from '../../src/models/schema';

type Peer = SequenceRunnerPeer & { role: string };
const identifier = (value: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned sign-day identifier');
  return `"${value}"`;
};
export async function signDayRuntimeFixture() {
  const f = await sequenceRunnerDatabase();
  if (f.format !== 'pg16' || !f.withRuntimeRole) {
    await f.close(); throw Error('Sign-day runtime requires native PG16 and independent LOGINs');
  }
  try {
    const tables = [...new Set([...signDayConfigTables, systemAdmin, systemRole, systemMenus])];
    const dialect = new PgDialect();
    for (const table of tables) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        const initial = column.default;
        const initialSql = initial === undefined ? '' : ` DEFAULT ${initial instanceof SQL
          ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `${identifier(column.name)} ${column.getSQLType()}${initialSql}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);
      for (const index of definition.indexes) {
        const value = index.config;
        if (!value.unique) continue;
        const names = value.columns.map(column => {
          if (!('name' in column) || typeof column.name !== 'string') throw Error('Unexpected sign-day expression index');
          return identifier(column.name);
        });
        await f.exec(`CREATE UNIQUE INDEX ${identifier(value.name!)} ON public.${identifier(definition.name)} (${names.join(',')})`);
      }
    }
    await seedSignDayConfig(f.db);
    const installSlice = async (peer: Peer, kind: 'app' | 'admin') => {
      const plan = runtimeBusinessPrivilegePlan(kind);
      if (kind === 'admin') {
        await f.db.transaction(tx => installRuntimeSignDayGroupLockBoundaryInTransaction(tx,
          { maintenance: 'finance_test', admin: peer.role }),
        { isolationLevel: 'read committed', accessMode: 'read write' });
      }
      for (const table of tables) {
        const definition = getTableConfig(table), privileges = plan.tables[definition.name];
        if (!privileges?.includes('SELECT')) throw Error(`Sign-day table missing from ${kind} production runtime plan`);
        await f.exec(`GRANT ${privileges.join(',')} ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
        const columns = plan.updateColumns[definition.name];
        if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(identifier).join(',')}) ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
        if (privileges.includes('INSERT')) for (const column of definition.columns) {
          if (!['serial', 'bigserial'].includes(column.getSQLType())) continue;
          const [row] = await f.exec(`SELECT pg_get_serial_sequence('public.${definition.name}','${column.name}') AS name`);
          const sequence = String(row.name).split('.');
          if (sequence.length !== 2 || sequence[0] !== 'public') throw Error('Unexpected owned sign-day serial');
          await f.exec(`GRANT USAGE ON SEQUENCE public.${identifier(sequence[1])} TO ${identifier(peer.role)}`);
        }
      }
    };
    return { ...f, tables, withRuntimeRole: f.withRuntimeRole, installSlice };
  } catch (error) { await f.close(); throw error; }
}
