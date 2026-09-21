import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainer } from '../src/lib/di';
import { adminRuntimeAuthMiddleware } from '../src/middleware/admin-runtime-auth';
import { systemAdmin, systemRole, systemMenus, systemConfig } from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { installRuntimeAdminBoundaryInTransaction } from '../src/migrations/runtimeAdminBoundary';

describe('real Admin request factory using two independently authenticated PG16 connections', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string;
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}),kit.generateDrizzleJson({systemAdmin,systemRole,systemMenus,systemConfig}))).join('\n');
  });
  beforeEach(async () => {
    f = await sequenceRunnerDatabase(); if (!f.withRuntimeRole) throw Error('Owned native PG16 required');
    await f.exec(ddl);
    await f.exec("INSERT INTO system_admin(id,account,pwd,admin_type,level) VALUES(1,'test-admin','local-hash',1,0); INSERT INTO system_config(id,menu_name,value) VALUES(1,'test-flag','before')");
  });
  afterEach(async () => { await f?.close(); });
  it('selects the admin LOGIN only after auth, keeps assisted operations on app, and closes request sessions', async () => {
    await f.withRuntimeRole!(async appRole => f.withRuntimeRole!(async adminRole => {
      await f.db.transaction(tx => installRuntimeAdminBoundaryInTransaction(tx, appRole.role, 'finance_test'));
      await f.exec(`GRANT SELECT ON system_admin,system_role,system_menus,system_config TO "${appRole.role}";
        GRANT SELECT,UPDATE ON system_config,system_admin TO "${adminRole.role}"`);
      const env = { APP_KEY:'owned-native-login-test-only', UPSTASH_REDIS_URL:'', UPSTASH_REDIS_TOKEN:'',
        HYPERDRIVE:{connectionString:appRole.connectionString}, HYPERDRIVE_ADMIN:{connectionString:adminRole.connectionString} } as Env;
      const app = new Hono<{Bindings:Env;Variables:AppVariables}>();
      app.use('*',async(c,next)=>{const container=createContainer(c.env);c.set('container',container);
        try{await next();}finally{await container.db.$client.end({timeout:5});}});
      app.post('/adminapi/setting/config/test',adminRuntimeAuthMiddleware(),async c=>{
        const original=c.get('applicationContainer'); if(!original)throw Error('Missing application connection');
        const [adminIdentity]=await c.get('container').db.execute(sql`SELECT current_user AS role,session_user AS session`);
        const [appIdentity]=await original.db.execute(sql`SELECT current_user AS role,session_user AS session`);
        await c.get('container').db.execute(sql`UPDATE public.system_config SET value='after' WHERE id=1`);
        return c.json({adminIdentity,appIdentity});
      });
      const {token}=await createToken(1,'admin',md5('local-hash'),env.APP_KEY);
      const result=await app.request('/adminapi/setting/config/test',{method:'POST',headers:{Authorization:`Bearer ${token}`}},env);
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({adminIdentity:{role:adminRole.role,session:adminRole.role},appIdentity:{role:appRole.role,session:appRole.role}});
      expect((await appRole.exec('SELECT value FROM system_config WHERE id=1'))[0].value).toBe('after');
      await expect(appRole.exec("UPDATE system_config SET value='forbidden' WHERE id=1")).rejects.toMatchObject({code:'42501'});
      await expect(appRole.exec("UPDATE system_admin SET pwd='forbidden' WHERE id=1")).rejects.toMatchObject({code:'42501'});
      const [{remaining}]=await f.db.execute(sql`SELECT count(*)::int AS remaining FROM pg_stat_activity
        WHERE datname=current_database() AND application_name IN ('cinashop_admin','cinashop_api')`);
      expect(remaining).toBe(0);
    }));
  });
});
