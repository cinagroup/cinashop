import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { auditRuntimeBusinessPrivileges, inspectRuntimeBusinessProfileInTransaction } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { runCouponTemplateCatalog } from '../src/migrations/runCouponTemplateCatalog';
import { COUPON_TEMPLATE_CATALOG_SQL, inspectCouponTemplateCatalog } from '../src/migrations/couponTemplateCatalog';
import { installCouponTemplateRuntimeUpgradeInTransaction, runCouponTemplateRuntimeUpgrade } from '../src/migrations/runCouponTemplateRuntimeUpgrade';
import { removePromotionGiftFixtureGrants } from './helpers/runtimeHistoricalProfile';

type Peer = SequenceRunnerPeer & { role: string };
type Target = { database: string; maintenance: string; app: string; admin: string };
const native = process.env.TEST_FINANCE_POSTGRES_URL ? describe : describe.skip;
const templateInsert = "INSERT INTO public.store_coupon_template(title,scope_type,coupon_price,valid_days,add_time) VALUES('native template',0,5.25,7,0) RETURNING id";
async function sqlState(work: Promise<unknown>, code: string) {
  let error: unknown = await work.then(() => null, e => e); expect(error).not.toBeNull();
  for (let n = 0; n < 8 && error && typeof error === 'object'; n++) {
    if ('code' in error) { expect(error.code).toBe(code); return; }
    error = 'cause' in error ? error.cause : undefined;
  }
  throw Error('Expected PostgreSQL refusal ' + code);
}

native('coupon template isolated PG16 catalog and exact real LOGIN authority', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => { f = await refundRuntimeFixture(); }, 60_000);
  afterEach(async () => { await f?.close(); }, 30_000);
  async function roles(run: (app: Peer, admin: Peer, target: Target) => Promise<void>, commissioned = true) {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [row] = await f.exec('SELECT current_database() AS database');
      const target = { database: String(row.database), maintenance: 'finance_test', app: app.role, admin: admin.role };
      if (commissioned) {
        await runRuntimeBusinessCommissioning(f.db, { ...target, pricingOwner: f.pricingOwner });
        await removePromotionGiftFixtureGrants(f.exec,target);
      }
      await run(app, admin, target);
    }));
  }
  const catalog = () => f.exec(`SELECT 'relation' AS kind,oid::text AS key,relname AS name,relowner::text AS owner,relacl::text AS acl
    FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'column',c.oid::text||'.'||a.attnum::text,c.relname||'.'||a.attname,NULL,a.attacl::text
    FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT 'function',oid::text,proname,proowner::text,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace
    ORDER BY kind,key`);
  async function rows(excludeTemplates = false) {
    const tables = await f.exec(`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'
      ${excludeTemplates ? "AND relname NOT IN ('store_coupon_template','store_coupon_template_issue')" : ''} ORDER BY relname`);
    expect(tables).toHaveLength(excludeTemplates ? 280 : 282);
    return f.exec(tables.map(({ name }) => {
      expect(name).toMatch(/^[a-z_][a-z_0-9]*$/);
      return `SELECT '${name}' AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${name}" t`;
    }).join(' UNION ALL ') + ' ORDER BY name');
  }
  const couponProfile=(peer:Peer,kind:'app'|'admin',target:Target)=>peer.db.transaction(
    tx=>inspectRuntimeBusinessProfileInTransaction(tx,kind,target,'pre-full-gifts'));
  async function previous(target: Target) {
    await f.exec(`REVOKE SELECT,INSERT ON public.store_coupon_template,public.store_coupon_template_issue FROM "${target.admin}";
      REVOKE UPDATE(status,is_del) ON public.store_coupon_template FROM "${target.admin}";
      REVOKE USAGE ON SEQUENCE public.store_coupon_template_id_seq FROM "${target.admin}"`);
    for (const kind of ['app', 'admin'] as const)
      expect(await f.db.transaction(tx => inspectRuntimeBusinessProfileInTransaction(tx, kind, target, 'pre-coupon-templates')))
        .toMatchObject({ ready: true, failures: [] });
  }

  it('adds only the two empty tables to the exact previous schema without adopting orphan cid or granting existing roles', async () => {
    await roles(async (app, admin, target) => {
      await f.exec('DROP TABLE public.store_coupon_template_issue;DROP TABLE public.store_coupon_template');
      await f.exec('INSERT INTO public.store_coupon_issue(id,cid,coupon_price,day) VALUES(501,1,9.25,7)');
      const before = await catalog(), data = await rows(true);
      await runCouponTemplateCatalog(f.db);
      expect(await inspectCouponTemplateCatalog(f.db, target.maintenance)).toMatchObject({ ready: true });
      const after = await catalog();
      expect(after.filter(row => before.some(old => old.kind === row.kind && old.key === row.key))).toEqual(before);
      expect(await rows(true)).toEqual(data);
      expect(await f.exec('SELECT * FROM store_coupon_template')).toEqual([]);
      expect(await f.exec('SELECT * FROM store_coupon_template_issue')).toEqual([]);
      await sqlState(admin.exec('SELECT * FROM store_coupon_template'), '42501');
      await sqlState(app.exec('SELECT * FROM store_coupon_template_issue'), '42501');
      for (const kind of ['app', 'admin'] as const)
        expect(await f.db.transaction(tx => inspectRuntimeBusinessProfileInTransaction(tx, kind, target, 'pre-coupon-templates'))).toMatchObject({ ready: true });
      await runCouponTemplateCatalog(f.db); expect(await catalog()).toEqual(after);
      expect(await rows(true)).toEqual(data);
    });
  }, 60_000);

  it('forwards only exact Admin table, two-column and sequence ACLs, preserves every row and leaves APP unchanged', async () => {
    await roles(async (app, admin, target) => {
      await previous(target);
      const before = await catalog(), data = await rows();
      const appBefore = await couponProfile(app,'app',target);
      expect(appBefore).toMatchObject({ ready: true });
      expect(await runCouponTemplateRuntimeUpgrade(f.db, target)).toMatchObject({ applied: true, profileStage: 'pre-full-gifts' });
      const after = await catalog(); expect(after).toHaveLength(before.length);
      const changed = before.filter(old => after.some(row => row.kind === old.kind && row.key === old.key && JSON.stringify(row) !== JSON.stringify(old)));
      expect(changed.map(row => row.name).sort()).toEqual(['store_coupon_template', 'store_coupon_template.is_del', 'store_coupon_template.status', 'store_coupon_template_id_seq', 'store_coupon_template_issue'].sort());
      expect(await couponProfile(app,'app',target)).toEqual(appBefore);
      expect(await couponProfile(admin,'admin',target)).toMatchObject({ ready: true, failures: [] });
      expect(await auditRuntimeBusinessPrivileges(admin.db,'admin',target)).toMatchObject({ready:false});
      expect(await rows()).toEqual(data);
      expect(await runCouponTemplateRuntimeUpgrade(f.db, target)).toMatchObject({ applied: false });
      expect(await catalog()).toEqual(after); expect(await rows()).toEqual(data);
    });
  }, 60_000);

  it('lets the real Admin create, lock and disable/soft-delete templates, and insert immutable issue provenance only', async () => {
    await roles(async (app, admin, target) => {
      expect(await couponProfile(admin,'admin',target)).toMatchObject({ ready: true });
      const [created] = await admin.exec(templateInsert); const id = Number(created.id);
      await admin.exec(`SELECT id FROM store_coupon_template WHERE id=${id} FOR UPDATE`);
      expect(await admin.exec(`UPDATE store_coupon_template SET status=0,is_del=1 WHERE id=${id} RETURNING status,is_del`)).toEqual([{ status: 0, is_del: 1 }]);
      for (const statement of [`UPDATE store_coupon_template SET title='rewrite' WHERE id=${id}`,
        `UPDATE store_coupon_template SET coupon_price=1 WHERE id=${id}`, `UPDATE store_coupon_template SET id=id WHERE id=${id}`,
        `DELETE FROM store_coupon_template WHERE id=${id}`, 'TRUNCATE store_coupon_template', "SELECT setval('store_coupon_template_id_seq',100)"])
        await sqlState(admin.exec(statement), '42501');
      await admin.exec(`INSERT INTO store_coupon_issue(id,cid,coupon_price,day) VALUES(502,${id},5.25,7)`);
      await admin.exec(`INSERT INTO store_coupon_template_issue VALUES(502,${id},0,'${'a'.repeat(64)}')`);
      expect(await admin.exec('SELECT issue_id,template_id FROM store_coupon_template_issue')).toEqual([{ issue_id: 502, template_id: id }]);
      for (const statement of ['UPDATE store_coupon_template_issue SET issued_at=1', 'DELETE FROM store_coupon_template_issue', 'TRUNCATE store_coupon_template_issue'])
        await sqlState(admin.exec(statement), '42501');
      for (const statement of ['SELECT * FROM store_coupon_template', 'SELECT * FROM store_coupon_template_issue', templateInsert,
        'UPDATE store_coupon_template SET status=0', 'DELETE FROM store_coupon_template_issue', "SELECT nextval('store_coupon_template_id_seq')"])
        await sqlState(app.exec(statement), '42501');
      await sqlState(f.exec(`DELETE FROM store_coupon_template WHERE id=${id}`), '23503');
      await sqlState(f.exec('DELETE FROM store_coupon_issue WHERE id=502'), '23503');
      await sqlState(f.exec(`INSERT INTO store_coupon_template_issue VALUES(999,${id},0,'${'a'.repeat(64)}')`), '23503');
      expect(await couponProfile(admin,'admin',target)).toMatchObject({ ready: true });
    });
  }, 60_000);

  it('refuses partial, extra or delegated template grants and sequence drift instead of repairing permissions', async () => {
    await roles(async (_app, admin, target) => {
      await previous(target);
      for (const mutation of [
        `GRANT SELECT ON store_coupon_template TO "${admin.role}"`,
        `GRANT UPDATE ON store_coupon_template TO "${admin.role}"`,
        `GRANT INSERT ON store_coupon_template_issue TO "${admin.role}" WITH GRANT OPTION`,
        `GRANT USAGE ON SEQUENCE store_coupon_template_id_seq TO "${admin.role}"`,
        'ALTER SEQUENCE store_coupon_template_id_seq OWNED BY NONE',
        'ALTER TABLE store_coupon_template_issue DROP CONSTRAINT scti_template_fk',
      ]) {
        const before = await catalog();
        await expect(f.db.transaction(async tx => {
          await tx.execute(sql.raw(mutation));
          await expect(installCouponTemplateRuntimeUpgradeInTransaction(tx, target)).rejects.toThrow();
          throw Error('rollback invalid profile fixture');
        })).rejects.toThrow('rollback invalid profile fixture');
        expect(await catalog()).toEqual(before);
      }
    });
  }, 60_000);

  it('rolls back all forward grants on late failure and rejects wrong role, database, transaction and busy gate', async () => {
    await roles(async (app, _admin, target) => {
      await previous(target); const before = await catalog(), data = await rows();
      await expect(f.db.transaction(async tx => {
        expect(await installCouponTemplateRuntimeUpgradeInTransaction(tx, target)).toMatchObject({ applied: true });
        throw Error('late template forward failure');
      })).rejects.toThrow('late template forward failure');
      await expect(runCouponTemplateRuntimeUpgrade(f.db, { ...target, database: 'wrong_database' })).rejects.toThrow('database requires review');
      await expect(runCouponTemplateRuntimeUpgrade(app.db, target)).rejects.toThrow('requires review');
      await expect(installCouponTemplateRuntimeUpgradeInTransaction(f.db, target)).rejects.toThrow('existing transaction');
      await expect(f.db.transaction(tx => installCouponTemplateRuntimeUpgradeInTransaction(tx, target), { isolationLevel: 'repeatable read' })).rejects.toThrow('requires review');
      await f.withPeer!(async peer => {
        await peer.exec('BEGIN;SELECT pg_advisory_xact_lock(731626,5)');
        try { await expect(runCouponTemplateRuntimeUpgrade(f.db, target)).rejects.toThrow('busy'); }
        finally { await peer.exec('ROLLBACK'); }
      });
      expect(await catalog()).toEqual(before); expect(await rows()).toEqual(data);
    });
  }, 60_000);

  it('rejects schema drift before initial commissioning and leaves both fresh LOGIN roles without table grants', async () => {
    await roles(async (app, admin, target) => {
      await f.exec('ALTER TABLE store_coupon_template ALTER COLUMN title TYPE varchar(65)');
      const before = await catalog();
      await expect(runRuntimeBusinessCommissioning(f.db, { ...target, pricingOwner: f.pricingOwner })).rejects.toThrow();
      expect(await catalog()).toEqual(before);
      for (const peer of [app, admin]) {
        await sqlState(peer.exec('SELECT * FROM store_coupon_template'), '42501');
        await sqlState(peer.exec('SELECT * FROM system_log'), '42501');
      }
    }, false);
  }, 60_000);

  it('rechecks a maintenance DDL winner after waiting for the fixed table locks and refuses all grants', async () => {
    await roles(async (app, admin, target) => {
      const [identity] = await f.exec('SELECT pg_backend_pid() AS pid');
      await f.withPeer!(holder => f.withPeer!(async observer => {
        await holder.exec('BEGIN;ALTER TABLE store_coupon_template ALTER COLUMN title TYPE varchar(65)');
        const pending = runRuntimeBusinessCommissioning(f.db, { ...target, pricingOwner: f.pricingOwner }).then(
          () => ({ ok: true, error: undefined }), error => ({ ok: false, error }));
        try {
          let blocked = false;
          const deadline = Date.now() + 800;
          while (Date.now() < deadline) {
            const [row] = await observer.exec(`SELECT ${holder.pid}=ANY(pg_blocking_pids(${Number(identity.pid)})) AS blocked`);
            if (row.blocked === true) { blocked = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
          await holder.exec('COMMIT');
          const result = await pending; expect(result.ok).toBe(false);
          expect(String(result.error)).toContain('exact catalog required');
        } finally { await holder.exec('ROLLBACK'); await pending; }
      }));
      expect(await inspectCouponTemplateCatalog(f.db)).toMatchObject({ ready: false });
      for (const peer of [app, admin]) {
        await sqlState(peer.exec('SELECT * FROM store_coupon_template'), '42501');
        await sqlState(peer.exec('SELECT * FROM system_log'), '42501');
      }
    }, false);
  }, 60_000);

  it('keeps native scope/money/proof constraints authoritative and documents transactional rollback with serial gaps', async () => {
    const [created] = await f.exec(templateInsert); const id = Number(created.id);
    for (const mutation of ["coupon_price='NaN'", 'coupon_price=0', 'use_min_price=-1', 'valid_days=3651', 'scope_type=1', "scope_type=2,product_ids='2147483648'", 'sort=-1'])
      await expect(f.exec(`UPDATE store_coupon_template SET ${mutation} WHERE id=${id}`)).rejects.toBeTruthy();
    await f.exec(`INSERT INTO store_coupon_issue(id,cid) VALUES(503,${id})`);
    await sqlState(f.exec(`INSERT INTO store_coupon_template_issue VALUES(503,${id},0,'${'A'.repeat(64)}')`), '23514');
    const before = await rows(); let consumed = 0;
    await expect(f.db.transaction(async tx => {
      const [row] = await tx.execute(sql.raw(templateInsert)); consumed = Number(row.id);
      await tx.execute(sql.raw(`INSERT INTO store_coupon_template_issue VALUES(503,${consumed},0,'${'a'.repeat(64)}')`));
      throw Error('late insert failure');
    })).rejects.toThrow('late insert failure');
    expect(await rows()).toEqual(before);
    const [next] = await f.exec(templateInsert); expect(Number(next.id)).toBeGreaterThan(consumed);
  }, 60_000);

  it('requires a root DDL transaction, rolls back installation and retains tighter caller deadlines', async () => {
    await f.exec('DROP TABLE store_coupon_template_issue;DROP TABLE store_coupon_template');
    const before = await catalog(), data = await rows(true);
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout='1500ms'`); await tx.execute(sql`SET LOCAL lock_timeout='500ms'`);
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='1500ms'`);
      await tx.execute(sql.raw(COUPON_TEMPLATE_CATALOG_SQL));
      const [settings] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,
        current_setting('idle_in_transaction_session_timeout') AS idle,current_setting('transaction_isolation') AS isolation`);
      expect(settings).toEqual({ statement: '1500ms', lock: '500ms', idle: '1500ms', isolation: 'read committed' });
      throw Error('late catalog fixture failure');
    })).rejects.toThrow('late catalog fixture failure');
    expect(await catalog()).toEqual(before); expect(await rows(true)).toEqual(data);
    await expect(f.db.transaction(tx => tx.execute(sql.raw(COUPON_TEMPLATE_CATALOG_SQL)), { isolationLevel: 'repeatable read' })).rejects.toThrow();
    await f.withPeer!(async peer => {
      await peer.exec('BEGIN;SELECT pg_advisory_xact_lock(731626,5)');
      try { await expect(runCouponTemplateCatalog(f.db)).rejects.toThrow('busy'); }
      finally { await peer.exec('ROLLBACK'); }
    });
    expect(await catalog()).toEqual(before);
    await runCouponTemplateCatalog(f.db);
    expect(await inspectCouponTemplateCatalog(f.db, 'finance_test')).toMatchObject({ ready: true });
  }, 60_000);
});
