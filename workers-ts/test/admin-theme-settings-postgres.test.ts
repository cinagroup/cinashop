import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { createContainerFromDb, createDbFromConnectionString } from '../src/lib/di';
import type { AppVariables, Env } from '../src/env';
import { systemDise } from '../src/models/schema';
import { adminDiseDel, adminDiseSave } from '../src/controllers/api/v1/AdminCrudController';
import { themeCanonical, ThemeSettingsRejected, ThemeSettingsStaleVersion } from '../src/services/admin/AdminThemeSettingsInput';
import { THEME_SETTINGS_LOCK_NAMESPACE } from '../src/services/admin/AdminThemeSettingsService';
import { themeHash } from '../src/services/content/ThemeReadService';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { observeThemeDb, themeActor, themeSettingsFixture } from './helpers/themeSettingsFixture';

type Fixture = Awaited<ReturnType<typeof themeSettingsFixture>>;
type Peer = Parameters<Parameters<Fixture['withRuntimeRole']>[0]>[0];
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const input = (revision: string, status = 3) => ({ request_id: crypto.randomUUID(), revision, status });

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native theme management on the exact eight-table production privilege intersection', () => {
  let f: Fixture;
  beforeEach(async () => { f = await themeSettingsFixture(); }, 30_000);
  afterEach(async () => { await f?.close(); }, 30_000);
  const profiles = (run: (admin: Peer, app: Peer) => Promise<void>) => f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
    await f.installSlice(app, admin);
    for (const peer of [admin, app]) expect((await peer.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: peer.role, session_user: peer.role });
    expect(admin.pid).not.toBe(app.pid); await run(admin, app);
  }));
  it('reads the seed scalar despite table switches and refuses semantic app writes, DDL and role escalation', async () => {
    await profiles(async (admin, app) => {
      const before = await f.snapshot();
      expect(await f.serviceFor(app.db).read()).toMatchObject({ status: 1, configured: true, editable: true, issues: [] });
      for (const peer of [admin, app]) {
        await expect(peer.exec('CREATE TABLE public.forbidden_theme(id int)')).rejects.toMatchObject({ code: '42501' });
        await expect(peer.exec('SET ROLE finance_test')).rejects.toMatchObject({ code: '42501' });
      }
      for (const statement of ["UPDATE system_dise SET value='6' WHERE id=88", "INSERT INTO system_dise(name) VALUES('bad')", 'DELETE FROM system_dise WHERE id=88']) {
        await expect(app.exec(statement)).rejects.toMatchObject({ code: '42501' });
      }
      expect(await f.snapshot()).toEqual(before);
    });
  });
  it('saves all six real choices while preserving every unrelated row column and same-name SQL config', async () => {
    await profiles(async admin => {
      const service = f.serviceFor(admin.db), before = await f.snapshot(), initial = before.rows.find(row => row.id === 88)!;
      const stable = ({ value: _value, version: _version, updateTime: _time, ...rest }: typeof initial) => rest;
      for (const status of [1, 2, 3, 4, 5, 6]) {
        const body = input((await service.read()).revision, status), receipt = await service.save(body, themeActor);
        expect(receipt).toEqual({ operation: 'update', id: 88, request_id: body.request_id, payload_hash: await themeHash(themeCanonical(body).canonical) });
        const committed = await f.snapshot(), current = committed.rows.find(row => row.id === 88)!;
        expect(current.value).toBe(String(status)); expect(stable(current)).toEqual(stable(initial)); expect(current.updateTime).toBeGreaterThan(initial.updateTime);
        expect(current.version).not.toBe(initial.version); expect(committed.configs).toEqual(before.configs);
        expect((await service.read()).status).toBe(status);
      }
      expect((await f.snapshot()).logs).toHaveLength(6);
    });
  });
  it('does not seed on GET and explicitly initializes a missing template and journal in one transaction', async () => {
    await f.db.delete(systemDise).where(eq(systemDise.id, 88));
    await profiles(async admin => {
      const service = f.serviceFor(admin.db), before = await f.snapshot(), missing = await service.read();
      expect(missing).toMatchObject({ status: null, configured: false, editable: true, issues: ['theme_missing'] }); expect(await f.snapshot()).toEqual(before);
      const body = input(missing.revision, 6), receipt = await service.save(body, themeActor), after = await f.snapshot();
      expect(after.rows).toHaveLength(before.rows.length + 1); expect(after.logs).toHaveLength(1);
      expect(after.rows.find(row => row.id === receipt.id)).toMatchObject({ templateName: 'color_change', type: 3, value: '6', status: 0, isShow: 0, isDel: 0 });
      expect((await service.read()).status).toBe(6); expect(await service.receipt(body.request_id, themeActor)).toEqual(receipt);
    });
  });
  it('diagnoses bounded corrupt scalar values and permits explicit repair only on the unambiguous identity', async () => {
    await profiles(async admin => {
      const service = f.serviceFor(admin.db);
      for (const value of [null, '', '0', '7', ' 3 ', '"3"', 'x'.repeat(100_000)]) {
        await f.db.update(systemDise).set({ value }).where(eq(systemDise.id, 88));
        const before = await f.snapshot(), page = await service.read();
        expect(page).toMatchObject({ status: null, configured: false, editable: true, issues: ['theme_status_invalid'] });
        expect(JSON.stringify(page).length).toBeLessThan(256); expect(await f.snapshot()).toEqual(before);
        await service.save(input(page.revision, 3), themeActor); expect((await service.read()).status).toBe(3);
      }
    });
  });
  it('includes Unicode/tab aliases, wrong types, deleted identities and duplicates in non-writable diagnostics', async () => {
    await profiles(async admin => {
      const service = f.serviceFor(admin.db);
      for (const patch of [{ templateName: '\tCOLOR_CHANGE\n' }, { templateName: '\u00a0color_change\u00a0' }, { type: 1 }, { isDel: 1 }]) {
        await f.db.update(systemDise).set({ templateName: 'color_change', type: 3, isDel: 0, ...patch }).where(eq(systemDise.id, 88));
        const page = await service.read(), before = await f.snapshot();
        expect(page).toMatchObject({ status: null, editable: false, issues: ['theme_identity_invalid'] });
        await expect(service.save(input(page.revision), themeActor)).rejects.toBeInstanceOf(ThemeSettingsRejected); expect(await f.snapshot()).toEqual(before);
      }
      await f.db.update(systemDise).set({ templateName: 'color_change', type: 3, isDel: 0 }).where(eq(systemDise.id, 88));
      for (const templateName of ['\tCOLOR_CHANGE\t', '\u00a0color_change\u00a0']) {
        const [created] = await f.db.insert(systemDise).values({ templateName, type: 3, value: '6' }).returning({ id: systemDise.id });
        const page = await service.read(), before = await f.snapshot();
        expect(page).toMatchObject({ status: null, editable: false, issues: ['theme_duplicate'] });
        await expect(service.save(input(page.revision), themeActor)).rejects.toBeInstanceOf(ThemeSettingsRejected); expect(await f.snapshot()).toEqual(before);
        await f.db.delete(systemDise).where(eq(systemDise.id, created.id));
      }
    });
  });
  it('makes metadata xmin changes stale and replays a confirmed UUID before checking its now-old revision', async () => {
    await profiles(async admin => {
      const service = f.serviceFor(admin.db), body = input((await service.read()).revision);
      await f.db.update(systemDise).set({ content: 'metadata edited without touching version/time' }).where(eq(systemDise.id, 88));
      let before = await f.snapshot(); await expect(service.save(body, themeActor)).rejects.toBeInstanceOf(ThemeSettingsStaleVersion); expect(await f.snapshot()).toEqual(before);
      const fresh = input((await service.read()).revision), receipt = await service.save(fresh, themeActor); before = await f.snapshot();
      expect(await service.save(fresh, themeActor)).toEqual(receipt); expect(await f.snapshot()).toEqual(before);
      for (const [changed, actor] of [[{ ...fresh, status: 6 }, themeActor], [fresh, { id: 8 }]] as const) {
        const result = await outcome(service.save(changed, actor)); expect(result.ok).toBe(false);
        if (!result.ok) { expect(result.error).not.toBeInstanceOf(ThemeSettingsRejected); expect(result.error).not.toBeInstanceOf(ThemeSettingsStaleVersion); }
        expect(await f.snapshot()).toEqual(before);
      }
    });
  });
  it('rolls back missing initialization after a genuine late journal SQL failure without issuing a deterministic proof', async () => {
    await f.db.delete(systemDise).where(eq(systemDise.id, 88));
    await f.exec("CREATE FUNCTION public.fail_theme_journal() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'owned late journal failure'; END$$");
    await f.exec('CREATE TRIGGER fail_theme_journal BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION public.fail_theme_journal()');
    await profiles(async admin => {
      const service = f.serviceFor(admin.db), before = await f.snapshot(), result = await outcome(service.save(input((await service.read()).revision), themeActor));
      expect(result.ok).toBe(false); if (!result.ok) { expect(result.error).not.toBeInstanceOf(ThemeSettingsRejected); expect(result.error).not.toBeInstanceOf(ThemeSettingsStaleVersion); }
      expect(await f.snapshot()).toEqual(before);
    });
  });
  it('serializes the same UUID on distinct Admin LOGIN connections and commits exactly one audit receipt', async () => {
    await profiles(async (admin, app) => {
      const secondDb = createDbFromConnectionString(admin.connectionString, 1), body = input((await f.serviceFor(admin.db).read()).revision), entered = gate(), release = gate();
      try {
        await f.withPeer(async sentinel => {
          const holder = sentinel.db.transaction(async tx => { await tx.execute(sql`SELECT pg_advisory_xact_lock(${THEME_SETTINGS_LOCK_NAMESPACE},0)`); entered.resolve(); await release.promise; }); await entered.promise;
          const [identity] = await secondDb.execute(sql`SELECT pg_backend_pid() AS pid,current_user AS role,session_user AS session`);
          expect(identity.role).toBe(admin.role); expect(identity.session).toBe(admin.role);
          const one = outcome(f.serviceFor(admin.db).save(body, themeActor)), two = outcome(f.serviceFor(secondDb).save(body, themeActor));
          try { await waitForFinanceBlock(f.db, admin.pid, sentinel.pid); await waitForFinanceBlock(f.db, Number(identity.pid), sentinel.pid); }
          finally { release.resolve(); await holder; }
          const [a, b] = await Promise.all([one, two]); expect(a.ok).toBe(true); expect(b).toEqual(a); expect((await f.snapshot()).logs).toHaveLength(1);
          expect((await outcome(app.exec("INSERT INTO system_dise(name) VALUES('still denied')"))).ok).toBe(false);
        });
      } finally { release.resolve(); await secondDb.$client.end({ timeout: 5 }); }
    });
  });
  it('waits at the table fence before catalog reads and observes a committed importer phantom under READ COMMITTED', async () => {
    await profiles(async admin => {
      await admin.exec('SET default_transaction_isolation=\'repeatable read\'');
      const service = f.serviceFor(admin.db), body = input((await service.read()).revision), entered = gate(), release = gate();
      await f.withPeer(async writer => {
        const holder = writer.db.transaction(async tx => { await tx.insert(systemDise).values({ templateName: 'color_change', type: 3, value: '6' }); entered.resolve(); await release.promise; }); await entered.promise;
        const saving = outcome(service.save(body, themeActor));
        try { await waitForFinanceBlock(f.db, admin.pid, writer.pid); expect((await f.exec(`SELECT mode FROM pg_locks WHERE pid=${admin.pid} AND relation='system_dise'::regclass AND NOT granted`))[0].mode).toBe('ShareRowExclusiveLock'); }
        finally { release.resolve(); await holder; }
        const result = await saving; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(ThemeSettingsStaleVersion);
        expect((await f.snapshot()).logs).toHaveLength(0); expect((await service.read()).issues).toEqual(['theme_duplicate']);
      });
    });
  });
  it('holds the fence through journal commit and blocks a direct importer INSERT by its exact PID', async () => {
    await profiles(async admin => {
      const body = input((await f.serviceFor(admin.db).read()).revision), entered = gate(), release = gate(); let gated = false;
      const observed = observeThemeDb(admin.db, async (_tx, command) => { if (!gated && /LOCK TABLE.*system_dise.*SHARE ROW EXCLUSIVE/i.test(command)) { gated = true; entered.resolve(); await release.promise; } });
      const saving = outcome(f.serviceFor(observed).save(body, themeActor)); await entered.promise;
      await f.withPeer(async writer => {
        const inserting = outcome(writer.db.insert(systemDise).values({ templateName: 'color_change', type: 3, value: '6' }));
        try { await waitForFinanceBlock(f.db, writer.pid, admin.pid); expect((await f.exec(`SELECT mode FROM pg_locks WHERE pid=${admin.pid} AND relation='system_dise'::regclass AND granted`)).some(row => row.mode === 'ShareRowExclusiveLock')).toBe(true); }
        finally { release.resolve(); }
        expect((await saving).ok).toBe(true); expect((await inserting).ok).toBe(true);
      });
      expect((await f.snapshot()).logs).toHaveLength(1);
    });
  });
  it('makes actual generic save and delete wait at the same table-before-row boundary instead of holding a row first', async () => {
    await profiles(async (admin, app) => {
      await f.withRuntimeRole(async other => {
        await f.installSlice(app, other);
        const generic = new Hono<{ Bindings: Env; Variables: AppVariables }>();
        generic.use('*', async (c, next) => { c.set('container', createContainerFromDb(other.db)); await next(); });
        generic.onError((error, c) => c.json({ status: 400, msg: error.message }, 400));
        generic.post('/save', adminDiseSave); generic.delete('/delete/:id', adminDiseDel);
        for (const method of ['save', 'delete']) {
          const body = input((await f.serviceFor(admin.db).read()).revision), entered = gate(), release = gate(); let gated = false;
          const observed = observeThemeDb(admin.db, async (_tx, command) => { if (!gated && /LOCK TABLE.*system_dise.*SHARE ROW EXCLUSIVE/i.test(command)) { gated = true; entered.resolve(); await release.promise; } });
          const saving = outcome(f.serviceFor(observed).save(body, themeActor)); await entered.promise;
          const changing = generic.request(method === 'save' ? '/save' : '/delete/2', { method: method === 'save' ? 'POST' : 'DELETE',
            ...(method === 'save' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 2, value: '[]', name: 'ordinary updated' }) } : {}) });
          try { await waitForFinanceBlock(f.db, other.pid, admin.pid); expect((await f.exec(`SELECT mode FROM pg_locks WHERE pid=${other.pid} AND relation='system_dise'::regclass AND NOT granted`))[0].mode).toBe('ShareRowExclusiveLock'); }
          finally { release.resolve(); }
          expect((await saving).ok).toBe(true); expect((await changing).status).toBe(200);
        }
        expect((await f.db.select().from(systemDise).where(eq(systemDise.id, 2)))[0]).toMatchObject({ name: 'ordinary updated', isDel: 1 });
        expect((await f.snapshot()).logs).toHaveLength(2);
      });
    });
  });
  it('observes actual transaction-local read isolation and deadlines while preserving stricter session limits', async () => {
    await profiles(async admin => {
      await admin.exec("SET statement_timeout='2000ms'"); await admin.exec("SET lock_timeout='400ms'"); await admin.exec("SET idle_in_transaction_session_timeout='2000ms'");
      let observed = false;
      const db = observeThemeDb(admin.db, async (tx, command) => {
        if (!observed && command.includes("set_config('statement_timeout'")) {
          observed = true; const [limits] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,
            current_setting('idle_in_transaction_session_timeout') AS idle,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly`);
          expect(limits).toEqual({ statement: '2s', lock: '400ms', idle: '2s', isolation: 'repeatable read', readonly: 'on' });
        }
      });
      await f.serviceFor(db).read(); expect(observed).toBe(true);
    });
  });
});
