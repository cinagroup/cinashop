import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { systemDise } from '../src/models/schema';
import { colorChangeV2 } from '../src/controllers/api/v1/PublicController';
import { readThemeSnapshot } from '../src/services/content/ThemeReadService';
import { observeThemeDb, themeConfigEnv, themeSettingsFixture } from './helpers/themeSettingsFixture';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('common native theme authority in public and existing sign-day consumers', () => {
  let f: Awaited<ReturnType<typeof themeSettingsFixture>>, fetchGuard: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    f = await themeSettingsFixture(); fetchGuard = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Theme reads do not call providers'); });
  }, 30_000);
  afterEach(async () => { if (fetchGuard) expect(fetchGuard).not.toHaveBeenCalled(); fetchGuard?.mockRestore(); await f?.close(); }, 30_000);
  type Peer = Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0];
  const profiles = (run: (app: Peer) => Promise<void>) => f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
    await f.installSlice(app, admin); expect((await app.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: app.role, session_user: app.role });
    expect(app.pid).not.toBe(admin.pid); await run(app);
  }));

  it('shares all six stored choices with public and sign previews while ignoring system_config and row switches', async () => {
    await profiles(async app => {
      for (const status of [1, 2, 3, 4, 5, 6]) {
        await f.db.update(systemDise).set({ value: String(status), status: 0, isShow: 0 }).where(eq(systemDise.id, 88)); const before = await f.snapshot();
        expect(await f.readFor(app.db).read()).toMatchObject({ status, configured: true, issues: [] });
        expect(await f.publicFor(app.db).colorChange('color_change')).toEqual({ status, navigation: 1, product_category_level: 2, theme_issues: [] });
        expect(await f.signFor(app.db).list()).toMatchObject({ group_present: true, theme: status, theme_issue: null }); expect(await f.snapshot()).toEqual(before);
      }
      expect(await f.publicFor(app.db).colorChange('product_category_diy')).toEqual({ status: 4, navigation: 1, product_category_level: 2 });
    });
  });
  it('reports absence, duplicate, damaged scalar and every alias consistently without leaking raw data or choosing a winner', async () => {
    await profiles(async app => {
      for (const [patch, issue, message] of [
        [{ value: '"3"' }, 'theme_status_invalid', '签到主题值无效'],
        [{ value: 'private-import-'.repeat(20_000) }, 'theme_status_invalid', '签到主题值无效'],
        [{ templateName: '\tCOLOR_CHANGE\n' }, 'theme_identity_invalid', '签到主题模板身份异常'],
        [{ templateName: '\u00a0color_change\u00a0' }, 'theme_identity_invalid', '签到主题模板身份异常'],
        [{ type: 1 }, 'theme_identity_invalid', '签到主题模板身份异常'],
        [{ isDel: 1 }, 'theme_identity_invalid', '签到主题模板身份异常'],
      ] as const) {
        const defaults = { value: '1', templateName: 'color_change', type: 3, isDel: 0 };
        await f.db.update(systemDise).set({ ...defaults, ...patch }).where(eq(systemDise.id, 88)); const before = await f.snapshot();
        const value = await f.publicFor(app.db).colorChange('color_change'); expect(value).toEqual({ status: 0, navigation: 1, product_category_level: 2, theme_issues: [issue] });
        expect(JSON.stringify(value)).not.toContain('private-import'); expect(await f.signFor(app.db).list()).toMatchObject({ theme: null, theme_issue: message }); expect(await f.snapshot()).toEqual(before);
      }
      await f.db.update(systemDise).set({ value: '1', templateName: 'color_change', type: 3, isDel: 0 }).where(eq(systemDise.id, 88));
      const [extra] = await f.db.insert(systemDise).values({ templateName: '\tCOLOR_CHANGE\t', type: 3, value: '6' }).returning({ id: systemDise.id });
      let before = await f.snapshot(); expect(await f.publicFor(app.db).colorChange('color_change')).toMatchObject({ status: 0, theme_issues: ['theme_duplicate'] });
      expect(await f.signFor(app.db).list()).toMatchObject({ theme: null, theme_issue: '签到主题存在重复模板' }); expect(await f.snapshot()).toEqual(before);
      await f.db.delete(systemDise).where(eq(systemDise.id, extra.id)); await f.db.delete(systemDise).where(eq(systemDise.id, 88)); before = await f.snapshot();
      expect(await f.publicFor(app.db).colorChange('color_change')).toMatchObject({ status: 0, theme_issues: ['theme_missing'] });
      expect(await f.signFor(app.db).list()).toMatchObject({ theme: null, theme_issue: '签到主题未配置' }); expect(await f.snapshot()).toEqual(before);
    });
  });
  it('keeps one RR snapshot while an independent writer changes the selected value and adds a conflicting alias', async () => {
    await profiles(async app => {
      let resolveEntered!: () => void, resolveRelease!: () => void;
      const entered = new Promise<void>(done => { resolveEntered = done; }), release = new Promise<void>(done => { resolveRelease = done; }); let observed = false;
      const db = observeThemeDb(app.db, async (_tx, command) => {
        if (!observed && /^select.*from.*system_dise/i.test(command)) { observed = true; resolveEntered(); await release; }
      });
      const reading = f.readFor(db).read(); await entered;
      try { await f.withPeer(async writer => {
        await writer.db.transaction(async tx => {
          await tx.update(systemDise).set({ value: '6' }).where(eq(systemDise.id, 88));
          await tx.insert(systemDise).values({ templateName: '\u00a0COLOR_CHANGE\u00a0', type: 3, value: '3' });
        });
      }); } finally { resolveRelease(); }
      expect(await reading).toMatchObject({ status: 1, configured: true, issues: [] });
      expect(await f.readFor(app.db).read()).toMatchObject({ status: null, configured: false, issues: ['theme_duplicate'] });
    });
  });
  it('executes the real public controller on a readonly app LOGIN and propagates SQL authority failures', async () => {
    await profiles(async appPeer => {
      const bindings = { APP_KEY: 'owned-theme-public-key', ...themeConfigEnv } satisfies Pick<Env, 'APP_KEY'> & typeof themeConfigEnv;
      const env = bindings as unknown as Env, http = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      http.use('*', async (c, next) => { c.set('container', createContainerFromDb(appPeer.db)); await next(); });
      http.get('/api/v2/diy/color_change/:name', colorChangeV2);
      const before = await f.snapshot(), response = await http.request('/api/v2/diy/color_change/color_change', undefined, env);
      expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ status: 200, msg: 'ok', data: { status: 1, navigation: 1, product_category_level: 2, theme_issues: [] } }); expect(await f.snapshot()).toEqual(before);
      await f.exec(`REVOKE SELECT ON system_dise FROM "${appPeer.role}"`);
      await expect(f.readFor(appPeer.db).read()).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(f.publicFor(appPeer.db).colorChange('color_change')).rejects.toMatchObject({ cause: { code: '42501' } }); expect(await f.snapshot()).toEqual(before);
      await f.exec(`GRANT SELECT ON system_dise TO "${appPeer.role}"`);
      await withTx(createContainerFromDb(appPeer.db), async tx => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        expect((await readThemeSnapshot(tx)).status).toBe(1);
      });
    });
  });
});
