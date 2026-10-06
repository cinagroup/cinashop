import type { PgTable } from 'drizzle-orm/pg-core';
import type { DbClient } from '../../src/lib/di';
import { createContainerFromDb } from '../../src/lib/di';
import { systemDise, systemGroup, systemGroupData, systemLog } from '../../src/models/schema';
import { AdminSignDayConfigService } from '../../src/services/admin/AdminSignDayConfigService';
import { financePostgres } from './financePostgres';

export const signDayConfigTables = [systemGroup, systemGroupData, systemDise, systemLog];
export const signDayConfigActor = { id: 7 };
type FixtureDatabase = Pick<Awaited<ReturnType<typeof financePostgres>>, 'db' | 'exec' | 'close'>;
export type SignDaySeedOptions = { group?: boolean; rows?: number; theme?: string | null };

/** A real legacy group/row shape, reusable by root-owned HTTP and role fixtures. */
export async function seedSignDayConfig(db: DbClient, options: SignDaySeedOptions = {}) {
  const { group = true, rows = 2, theme = '2' } = options;
  if (theme !== null) await db.insert(systemDise).values({ id: 9, templateName: 'color_change', type: 3, value: theme });
  if (!group) return;
  await db.insert(systemGroup).values({ id: 55, cateId: 1, name: '签到天数配置', info: '签到天数配置',
    configName: 'sign_day_num', fields: JSON.stringify([
      { name: '第几天', title: 'day', type: 'input', param: '' },
      { name: '获取积分', title: 'sign_num', type: 'input', param: '' },
    ]) });
  const examples = [
    { id: 147, day: '第一天', points: '10', sort: 100, value: {} },
    { id: 148, day: '第二天', points: '20', sort: 99, value: { pp: { type: 'upload', value: '/legacy/sign.png' }, ll: { value: '保留' } } },
  ];
  if (rows > 2 || rows < 0) throw Error('Seed supports zero to two legacy rows');
  for (const example of examples.slice(0, rows)) {
    await db.insert(systemGroupData).values({ id: example.id, gid: 55, addTime: 1_700_000_000,
      sort: example.sort, status: 1, value: JSON.stringify({ ...example.value,
        day: { type: 'input', value: example.day }, sign_num: { type: 'input', value: example.points } }) });
  }
}

export async function signDayConfigFixture(
  options: SignDaySeedOptions = {},
  createDatabase: (tables: PgTable[]) => Promise<FixtureDatabase> = tables => financePostgres(tables, { namespace: 'public' }),
) {
  const fixture = await createDatabase(signDayConfigTables);
  try {
    // financePostgres creates table columns but not declared indexes. The
    // production fixed-name uniqueness is essential to missing-group CAS.
    await fixture.exec('CREATE UNIQUE INDEX IF NOT EXISTS system_group_config_name_uq ON system_group(config_name)');
    await seedSignDayConfig(fixture.db, options);
    return { ...fixture, serviceFor: () => new AdminSignDayConfigService(createContainerFromDb(fixture.db)) };
  } catch (error) { await fixture.close(); throw error; }
}
