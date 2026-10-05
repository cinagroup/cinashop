import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainerFromDb } from '../src/lib/di';
import { AdminSignDayConfigService } from '../src/services/admin/AdminSignDayConfigService';
import { signDayRuntimeFixture } from './helpers/signDayRuntimeFixture';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('sign-day exact runtime grant slice', () => {
  let f: Awaited<ReturnType<typeof signDayRuntimeFixture>>;
  beforeEach(async () => { f = await signDayRuntimeFixture(); }, 30_000);
  afterEach(async () => { await f?.close(); }, 30_000);

  it('allows Admin fixed-group reads while the independent app LOGIN cannot mutate configuration', async () => {
    await f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
      await f.installSlice(app, 'app'); await f.installSlice(admin, 'admin');
      expect(app.pid).not.toBe(admin.pid);
      const svc = new AdminSignDayConfigService(createContainerFromDb(admin.db));
      expect((await svc.list()).group_present).toBe(true);
      for (const statement of ["INSERT INTO system_group(config_name) VALUES ('unauthorized_sign_group')",
        'UPDATE system_group_data SET status=0']) {
        await expect(app.exec(statement)).rejects.toMatchObject({ code: '42501' });
      }
    }));
  });

  it('keeps the Admin role unable to rewrite group metadata, delete groups or receipts, or reset sequences', async () => {
    await f.withRuntimeRole(async admin => {
      await f.installSlice(admin, 'admin');
      await expect(admin.exec("UPDATE system_group SET name='unauthorized_metadata' WHERE config_name='sign_day_num'")).rejects.toMatchObject({ code: '42501' });
      await expect(admin.exec("UPDATE system_group SET id=id+10000 WHERE config_name='sign_day_num'")).rejects.toMatchObject({ code: '42501' });
      expect(await admin.exec("UPDATE system_group SET id=id WHERE config_name='sign_day_num' RETURNING id")).toEqual([{ id: 55 }]);
      await expect(admin.exec('DELETE FROM system_group')).rejects.toMatchObject({ code: '42501' });
      await expect(admin.exec('DELETE FROM system_log')).rejects.toMatchObject({ code: '42501' });
      await expect(admin.exec("SELECT setval(pg_get_serial_sequence('system_group_data','id'),1,true)")).rejects.toMatchObject({ code: '42501' });
    });
  });
});
