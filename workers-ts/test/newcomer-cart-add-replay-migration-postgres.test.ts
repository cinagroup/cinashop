import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { financePostgres } from './helpers/financePostgres';
import { storeCart } from '../src/models/schema';
import { newcomerCartAddReplay } from '../src/models/schema/newcomer_cart_replay';
import {
  inspectNewcomerCartAddReplayCatalog, installNewcomerCartAddReplay,
  newcomerCartAddReplayReadiness,
} from '../src/migrations/runNewcomerCartAddReplay';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('independent newcomer cart replay installation on PG16', () => {
  it('installs an empty receipt and app SELECT/INSERT atomically without touching old carts', async () => {
    const f = await financePostgres([storeCart], { namespace: 'public' });
    const role = `ncar_reader_${crypto.randomUUID().replaceAll('-', '')}`;
    let created = false;
    try {
      await f.db.insert(storeCart).values({ uid: 11, productId: 70,
        productAttrUnique: 'base0001', cartNum: 1, type: 7, isNew: 1 });
      const before = await f.db.select().from(storeCart);
      expect(await inspectNewcomerCartAddReplayCatalog(f.db)).toMatchObject({ present: false, complete: false });
      await f.db.execute(sql.raw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`));
      created = true;
      await installNewcomerCartAddReplay(f.db, role);
      expect(await inspectNewcomerCartAddReplayCatalog(f.db)).toMatchObject({ present: true, complete: true });
      expect(await newcomerCartAddReplayReadiness(f.db)).toMatchObject({ ready: true });
      expect(await f.db.select().from(storeCart)).toEqual(before);
      expect(await f.db.select().from(newcomerCartAddReplay)).toEqual([]);
      const [grants] = await f.db.execute(sql`SELECT
        pg_catalog.has_table_privilege(${role},'public.newcomer_cart_add_replay','SELECT') AS read,
        pg_catalog.has_table_privilege(${role},'public.newcomer_cart_add_replay','INSERT') AS append,
        pg_catalog.has_table_privilege(${role},'public.newcomer_cart_add_replay','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS mutable,
        NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
          WHERE c.oid='public.newcomer_cart_add_replay'::regclass AND a.grantee=0) AS public_safe`);
      expect(grants).toMatchObject({ read: true, append: true, mutable: false, public_safe: true });
      const row = { uid: 11, requestKey: '00000000-0000-4000-8000-000000000001',
        intentHash: 'a'.repeat(64), cartId: before[0].id, baseUnique: 'base0001', createdAt: 1 };
      await f.db.insert(newcomerCartAddReplay).values(row);
      await expect(f.db.insert(newcomerCartAddReplay).values({ ...row, cartId: row.cartId + 1 }))
        .rejects.toThrow();
      await expect(f.db.insert(newcomerCartAddReplay).values({ ...row,
        requestKey: '00000000-0000-4000-8000-000000000002' })).rejects.toThrow();
      await expect(installNewcomerCartAddReplay(f.db, role)).rejects.toThrow();
      await f.db.execute(sql`ALTER TABLE public.newcomer_cart_add_replay ADD COLUMN unreviewed text`);
      expect(await inspectNewcomerCartAddReplayCatalog(f.db)).toMatchObject({ present: true, complete: false });
    } finally {
      if (created) await f.db.execute(sql.raw(`DROP OWNED BY ${role}; DROP ROLE ${role}`));
      await f.close();
    }
  }, 30_000);

  it('rolls back default third-party grants and rejects later rogue app ACL drift', async () => {
    const f = await financePostgres([storeCart], { namespace: 'public' });
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const app = `ncar_app_${suffix}`;
    const rogue = `ncar_rogue_${suffix}`;
    let appCreated = false;
    let rogueCreated = false;
    let defaultGrant = false;
    try {
      await f.db.execute(sql.raw(`CREATE ROLE ${app} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`));
      appCreated = true;
      await f.db.execute(sql.raw(`CREATE ROLE ${rogue} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`));
      rogueCreated = true;
      await f.db.execute(sql.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO ${rogue}`));
      defaultGrant = true;
      await expect(installNewcomerCartAddReplay(f.db, app))
        .rejects.toThrow('Newcomer replay installed ACL contains an unreviewed grant');
      expect(await inspectNewcomerCartAddReplayCatalog(f.db)).toMatchObject({ present: false });
      await f.db.execute(sql.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT ON TABLES FROM ${rogue}`));
      defaultGrant = false;

      await installNewcomerCartAddReplay(f.db, app);
      const asApp = () => f.db.transaction(async tx => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${app}`));
        return newcomerCartAddReplayReadiness(tx);
      });
      expect(await asApp()).toMatchObject({ ready: true });
      await f.db.execute(sql.raw(`GRANT SELECT, INSERT ON public.newcomer_cart_add_replay TO ${rogue}`));
      expect(await newcomerCartAddReplayReadiness(f.db)).toMatchObject({ ready: false });
      expect(await asApp()).toMatchObject({ ready: false,
        reason: 'newcomer_cart_replay_runtime_privileges_unreviewed' });
      await f.db.execute(sql.raw(`REVOKE SELECT, INSERT ON public.newcomer_cart_add_replay FROM ${rogue}`));
      expect(await asApp()).toMatchObject({ ready: true });
    } finally {
      if (defaultGrant) await f.db.execute(sql.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT ON TABLES FROM ${rogue}`));
      if (rogueCreated) await f.db.execute(sql.raw(`DROP OWNED BY ${rogue}; DROP ROLE ${rogue}`));
      if (appCreated) await f.db.execute(sql.raw(`DROP OWNED BY ${app}; DROP ROLE ${app}`));
      await f.close();
    }
  }, 30_000);
});
