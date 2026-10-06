/** Finite native fixture using the reviewed production grant-plan slice.
 * Runtime LOGIN creation and cleanup belong to the existing owned-database
 * helper. No production profile installation or startup repair is claimed. */
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';
import { integralBatchFixture, integralBatchTables } from './integralBatchFixture';

type Peer = SequenceRunnerPeer & { role: string };
const identifier = (value: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned integral runtime identifier');
  return `"${value}"`;
};
export async function integralBatchRuntimeFixture() {
  const whole = await sequenceRunnerDatabase();
  if (whole.format !== 'pg16' || !whole.withRuntimeRole) {
    await whole.close(); throw Error('Integral runtime requires native PG16 and independent LOGINs');
  }
  try {
    const dialect = new PgDialect();
    for (const table of integralBatchTables) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        const initial = column.default;
        const initialSql = initial === undefined ? '' : ` DEFAULT ${initial instanceof SQL
          ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `${identifier(column.name)} ${column.getSQLType()}${initialSql}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await whole.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);
    }
    const f = await integralBatchFixture(false, async () => ({ db: whole.db, exec: whole.exec, close: async () => {} }));
    const installSlice = async (peer: Peer, kind: 'app' | 'admin') => {
      const plan = runtimeBusinessPrivilegePlan(kind);
      for (const table of integralBatchTables) {
        const definition = getTableConfig(table), privileges = plan.tables[definition.name];
        if (!privileges?.includes('SELECT')) throw Error('Integral table missing from production runtime privilege plan');
        await whole.exec(`GRANT ${privileges.join(',')} ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
        const columns = plan.updateColumns[definition.name];
        if (columns?.length) await whole.exec(`GRANT UPDATE(${columns.map(identifier).join(',')}) ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
        if (privileges.includes('INSERT')) for (const column of definition.columns) {
          if (!['serial', 'bigserial'].includes(column.getSQLType())) continue;
          const [row] = await whole.exec(`SELECT pg_get_serial_sequence('public.${definition.name}','${column.name}') AS name`);
          const sequence = String(row.name).split('.');
          if (sequence.length !== 2 || sequence[0] !== 'public') throw Error('Unexpected owned integral serial');
          await whole.exec(`GRANT USAGE ON SEQUENCE public.${identifier(sequence[1])} TO ${identifier(peer.role)}`);
        }
      }
    };
    return { ...f, exec: whole.exec, withRuntimeRole: whole.withRuntimeRole,
      installSlice, close: whole.close };
  } catch (error) { await whole.close(); throw error; }
}
