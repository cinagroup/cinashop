/** Real production Hono/JWT/Drizzle author against separately authenticated
 * restricted PG16 roles and the formal maintenance addon. No provider call,
 * browser claim or historical account ownership is inferred from this suite. */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContainerFromDb } from '@/lib/di';
import { AdminWechatRoutineService } from '@/services/admin/AdminWechatRoutineService';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { systemAdmin, systemConfig, systemMenus, systemRole } from '@/models/schema';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runAdminAuthorityOperationUpgrade } from '@/migrations/runAdminAuthorityOperationUpgrade';
import { runAdminWechatMenuUpgrade } from '@/migrations/runAdminWechatMenuUpgrade';
import { runAdminWechatBaseUpgrade } from '@/migrations/runAdminWechatBaseUpgrade';
import { runAdminWechatRoutineUpgrade } from '@/migrations/runAdminWechatRoutineUpgrade';
import { ADMIN_WECHAT_ROUTINE_SOURCE_SQL, ADMIN_WECHAT_ROUTINE_REQUEST_GATE } from '@/migrations/adminWechatRoutineWriteCapability';
import { WECHAT_ROUTINE_VIEW_SEED, WECHAT_ROUTINE_SAVE_SEED } from '@/services/admin/AdminWechatRoutinePermissionBinding';
import { wechatRoutineActorBinding, wechatRoutineSourceRevision } from '@/services/admin/AdminWechatRoutineWriteProtocol';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { WECHAT_ROUTINE_KEYS, type WechatRoutineSave } from '../../view/common/wechatRoutine';

const PASSWORD = 'owned-routine-http-password', KEY = 'owned-routine-http-signing', ADMIN = 913500;
const rules = ['1346,315', '1346', '315', 'wechat_routine.manage', 'wechat_routine.view', 'config.manage', '', '1345,315', '1348,315'];
const prefixes = ['/adminapi', '/api/admin'];
const request = (revision: string): WechatRoutineSave => ({ request_id: randomUUID(), revision, confirmed: true,
  fields: { routine_appId: { action: 'keep' }, routine_appsecret: { action: 'keep' }, routine_name: { action: 'keep' },
    routine_contact_type: { action: 'keep' }, store_user_avatar: { action: 'keep' } } });
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type ResponseDto = { status: number; msg: string; data: any; headers: Headers };
const tokenFacts = (token: string): { iat: number; exp: number } => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
type Context = { f: Fixture; install: () => Promise<unknown>; tokens: string[];
  revisionFor: (index: number) => Promise<string>;
  installRoutineOnly: () => Promise<unknown>;
  readAsMaintenance: () => Promise<import('../../view/common/wechatRoutine').WechatRoutineSnapshot>;
  call: (path: string, method?: string, body?: unknown, index?: number, raw?: string) => Promise<ResponseDto>;
  facts: () => Promise<unknown>; failCache: { value: boolean }; invalidated: string[];
  withLock: (namespace: number, id: string | null, work: () => Promise<void>) => Promise<void>;
};

async function fixture(run: (ctx: Context) => Promise<void>, install = true) {
  const f = await refundRuntimeFixture();
  try {
    if (f.format !== 'pg16' || !f.withRuntimeRole) throw Error('Actual independent PG16 LOGINs required');
    await f.withRuntimeRole(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS database,current_user AS maintenance');
      const target = { database: String(identity.database), maintenance: String(identity.maintenance), app: app.role,
        admin: admin.role, writer: 'routine_http_' + randomUUID().replaceAll('-', '') };
      const names = { ...target, pricingOwner: f.pricingOwner }, writer = pricingIdentifier(target.writer);
      await runRuntimeBusinessCommissioning(f.db, names);
      await runAdminWechatMenuUpgrade(f.db, names); await runAdminWechatBaseUpgrade(f.db, names);
      await f.db.insert(systemRole).values(rules.map((rules, i) => ({ id: ADMIN + i, roleName: 'Owned Routine HTTP ' + i, rules })));
      await f.db.insert(systemAdmin).values(rules.map((_rules, i) => ({ id: ADMIN + i, account: 'owned_routine_http_' + i,
        pwd: PASSWORD, roles: String(ADMIN + i), level: 1, adminType: 1 })));
      await f.db.delete(systemMenus).where(inArray(systemMenus.id, [1346, 315]));
      await f.db.insert(systemMenus).values([{ ...WECHAT_ROUTINE_VIEW_SEED, menuName: '小程序配置' },
        { ...WECHAT_ROUTINE_SAVE_SEED, menuName: '保存配置' }]);
      await f.db.delete(systemConfig).where(inArray(systemConfig.menuName, [...WECHAT_ROUTINE_KEYS]));
      await f.db.insert(systemConfig).values([
        ...WECHAT_ROUTINE_KEYS.map((menuName, i) => ({ id: ADMIN + 100 + i, menuName,
          value: JSON.stringify(['owned-routine-app', 'owned-routine-http-original-secret', 'Original Routine', 1, 0][i]),
          sort: 7, configTabId: 74, parameter: 'preserve-metadata' })),
        { id: ADMIN + 105, menuName: 'routine_appsecret', value: '"owned-routine-http-shadow-secret"', sort: -1 },
        { id: ADMIN + 106, menuName: 'routine_appsecret', value: '"owned-routine-http-store-secret"', isStore: 9 },
      ]);
      const [created] = await f.db.execute<{ oid: string }>(sql`
        CREATE ROLE ${sql.raw(writer)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`)
        .then(() => f.db.execute<{ oid: string }>(sql`SELECT oid::text FROM pg_roles WHERE rolname=${target.writer}`));
      if (!created?.oid) throw Error('Owned writer identity must be recorded');
      try {
        const upgrade = async () => {
          await runAdminAuthorityOperationUpgrade(f.db, names);
          return runAdminWechatRoutineUpgrade(f.db, target);
        };
        if (install) await upgrade();
        const cached: string[] = [], invalidated: string[] = [], failCache = { value: false };
        const env = { HYPERDRIVE: { connectionString: app.connectionString }, HYPERDRIVE_ADMIN: { connectionString: admin.connectionString },
          APP_KEY: KEY, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', CONFIG_KV: {
            get: async (key: string) => { cached.push(key); return 'poisoned-routine-cache'; }, put: async () => {},
            delete: async (key: string) => { invalidated.push(key); if (failCache.value) throw Error('Owned cache unavailable'); },
          } } as unknown as Env;
        const http = createApp(), tokens = await Promise.all(rules.map(async (_rules, i) =>
          (await createToken(ADMIN + i, 'admin', md5(PASSWORD), KEY)).token));
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Routine author fixture forbids provider I/O'));
        const cleanupApi = () => f.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE
          datname=current_database() AND usename=${app.role} AND application_name='cinashop_api' AND pid<>pg_backend_pid()`);
        const call: Context['call'] = async (path, method = 'GET', body, index = 0, raw) => {
          const response = await http.request(path, { method, headers: { Authorization: 'Bearer ' + tokens[index], 'Content-Type': 'application/json' },
            ...(body === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(body) }) }, env);
          const text = await response.text();
          expect(text).not.toMatch(/owned-routine-http-(?:original|shadow|store|replacement|forbidden)-secret/u);
          expect(text).not.toMatch(/actor_binding|before_source|after_source|payload_hash|PostgresError|Failed query|cinashop_admin_wechat_routine_write_v1/u);
          const data = JSON.parse(text) as { status: number; msg: string; data: any };
          await cleanupApi(); return { ...data, headers: response.headers };
        };
        const facts = async () => ({
          config: Array.from(await f.db.execute(sql`SELECT to_jsonb(c) AS row,xmin::text AS version FROM system_config c ORDER BY id`)),
          receipts: Array.from(await f.db.execute(sql`SELECT * FROM admin_wechat_routine_operation ORDER BY operation_id`)),
          sequence: Array.from(await f.db.execute(sql`SELECT last_value,is_called FROM system_config_id_seq`)),
        });
        try {
          const withLock: Context['withLock'] = (namespace, id, work) => app.db.transaction(async tx => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(${namespace},${id === null ? sql`0` : sql`hashtext(${id})`})`);
            await work();
          });
          const revisionFor = async (index: number) => {
            const [source] = await f.db.execute<{ hash: string }>(sql`SELECT
              encode(sha256(convert_to((${sql.raw(ADMIN_WECHAT_ROUTINE_SOURCE_SQL)})::text,'UTF8')),'hex') AS hash`);
            const binding = wechatRoutineActorBinding({ APP_KEY: KEY }, { id: ADMIN + index,
              authVersion: md5(PASSWORD), expiresAt: tokenFacts(tokens[index]).exp });
            return wechatRoutineSourceRevision({ APP_KEY: KEY }, binding, source.hash);
          };
          const readAsMaintenance = () => new AdminWechatRoutineService(createContainerFromDb(f.db), env).loadSnapshot({
            id: ADMIN, authVersion: md5(PASSWORD), expiresAt: tokenFacts(tokens[0]).exp });
          await run({ f, install: upgrade, installRoutineOnly: () => runAdminWechatRoutineUpgrade(f.db, target), readAsMaintenance,
            tokens, call, facts, failCache, invalidated, withLock, revisionFor });
          expect(fetch).not.toHaveBeenCalled();
          expect(cached.some(key => WECHAT_ROUTINE_KEYS.some(name => key === 'cfg_' + name))).toBe(false);
          expect(app.pid).not.toBe(admin.pid);
        } finally { await cleanupApi(); }
      } finally {
        const [current] = await f.db.execute<{ oid: string }>(sql`SELECT oid::text FROM pg_roles WHERE rolname=${target.writer}`);
        if (current?.oid !== created.oid) throw Error('Owned Routine writer changed before cleanup');
        await f.exec(`DROP OWNED BY ${writer}; DROP ROLE ${writer}`);
        expect(await f.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${target.writer}`)).toHaveLength(0);
      }
    }));
  } finally { await f.close(); }
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Routine production HTTP/JWT/Drizzle and commissioned PG16 author', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads without the optional addon, then binds real JSON intents exactly once and returns only redacted seven-field receipts', async () => fixture(async c => {
    const old = await c.call('/adminapi/wechat/routine');
    expect(old.status, old.msg).toBe(200); expect(old.data.runtime_ready).toBe(false);
    expect((await c.call('/adminapi/wechat/routine', 'POST', request(old.data.revision))).status).toBe(503);
    await c.installRoutineOnly();
    const sqlOnly = await c.call('/adminapi/wechat/routine');
    expect(sqlOnly.data).toMatchObject({ storage_ready: false, runtime_ready: false });
    const incomplete = await c.facts();
    expect((await c.call('/adminapi/wechat/routine', 'POST', request(sqlOnly.data.revision))).status).toBe(503);
    expect(await c.facts()).toEqual(incomplete);
    await c.install();
    expect(await c.readAsMaintenance()).toMatchObject({ storage_ready: false, runtime_ready: false });
    const read = await c.call('/api/admin/wechat/routine');
    expect(read.data).toMatchObject({ storage_ready: true, runtime_ready: false, credentials_complete: true,
      settings: { routine_appId: 'owned-routine-app', routine_name: 'Original Routine', routine_contact_type: 1, store_user_avatar: 0 },
      secrets: { routine_appsecret: { present: true } } });
    expect(read.headers.get('Cache-Control')).toBe('private, no-store');
    const input = request(read.data.revision), text = '  中文😀\\quote"\u0000\n  ';
    input.fields.routine_name = { action: 'replace', value: text };
    input.fields.routine_appsecret = { action: 'replace', value: 'owned-routine-http-replacement-secret\u0000\\😀' };
    input.fields.routine_contact_type = { action: 'replace', value: 0 };
    c.failCache.value = true;
    const saved = await c.call('/adminapi/wechat/routine', 'POST', input);
    expect(saved.status, saved.msg).toBe(200); expect(saved.data).toMatchObject({ state: 'committed', replayed: false, cache_status: 'pending' });
    expect(Object.keys(saved.data).sort()).toEqual(['actor_id','cache_status','created_at','replayed','request_id','revision','state']);
    c.failCache.value = false;
    const facts = await c.facts();
    expect((await c.call('/api/admin/wechat/routine', 'POST', input)).data).toMatchObject({ replayed: true, cache_status: 'cleared', revision: saved.data.revision });
    expect(await c.facts()).toEqual(facts);
    const receipt = await c.call('/api/admin/wechat/routine/operations/' + input.request_id);
    expect(receipt.data).toMatchObject({ state: 'committed', actor_id: ADMIN, revision: saved.data.revision });
    expect(receipt.headers.get('Cache-Control')).toBe('private, no-store');
    const rows = await c.f.db.select().from(systemConfig).where(inArray(systemConfig.id, [ADMIN+101,ADMIN+102,ADMIN+105,ADMIN+106]));
    expect(rows.find(row => row.id === ADMIN+101)).toMatchObject({ value: JSON.stringify('owned-routine-http-replacement-secret\u0000\\😀'), parameter: 'preserve-metadata' });
    expect(rows.find(row => row.id === ADMIN+102)?.value).toBe(JSON.stringify(text));
    expect(rows.find(row => row.id === ADMIN+105)?.value).toBe('"owned-routine-http-shadow-secret"');
    expect(rows.find(row => row.id === ADMIN+106)?.value).toBe('"owned-routine-http-store-secret"');
    const fresh = await c.call('/adminapi/setting/config/edit_new_build/routine');
    expect(fresh.data.settings.routine_name).toBe(text);
    expect(fresh.data.secrets.routine_appsecret).toEqual({ present: true });
    const whitespace = request(fresh.data.revision);
    whitespace.fields.routine_appsecret = { action: 'replace', value: ' \t ' };
    expect((await c.call('/adminapi/wechat/routine', 'POST', whitespace)).status).toBe(200);
    const unconfigured = await c.call('/adminapi/wechat/routine');
    expect(unconfigured.data).toMatchObject({ credentials_complete: false, secrets: { routine_appsecret: { present: false } },
      fields: { routine_appsecret: { present: true, parseable: true } } });
    expect((await c.f.db.select().from(systemConfig).where(eq(systemConfig.id, ADMIN+101)))[0].value).toBe(JSON.stringify(' \t '));
    const clear = request(unconfigured.data.revision); clear.fields.routine_appsecret = { action: 'clear' };
    expect((await c.call('/api/admin/wechat/routine', 'POST', clear)).status).toBe(200);
    expect((await c.call('/adminapi/wechat/routine')).data.secrets.routine_appsecret).toEqual({ present: false });
    expect(c.invalidated).toContain('cfg_routine_appsecret');
    expect(c.invalidated).not.toContain('cfg_wechat_app_appsecret');
  }, false), 180000);

  it('requires the complete fixed leaf1346+315 on both prefixes and dispatches only the fifth whole basics envelope', async () => fixture(async c => {
    for (const prefix of prefixes) {
      const read = await c.call(prefix + '/wechat/routine'); expect(read.status, read.msg).toBe(200);
      expect(await c.revisionFor(0)).toBe(read.data.revision);
      const viewOnly = await c.call(prefix + '/wechat/routine', 'GET', undefined, 1);
      expect(viewOnly.status).toBe(200); expect(await c.revisionFor(1)).toBe(viewOnly.data.revision);
      for (const i of [2,3,4,5,6,7,8]) expect((await c.call(prefix + '/wechat/routine', 'GET', undefined, i)).status).not.toBe(200);
      for (const i of [1,2,3,4,5,6,7,8]) {
        // Valid versions for the actual UID/session prevent CAS failure from
        // hiding a missing manage check. Require the authority error itself.
        const revision = await c.revisionFor(i);
        expect((await c.call(prefix + '/wechat/routine', 'POST', request(revision), i)).status).toBe(400011);
        expect((await c.call(prefix + '/setting/config/save_basics', 'POST', request(revision), i)).status).toBe(400011);
      }
      const input = request(read.data.revision);
      expect((await c.call(prefix + '/setting/config/save_basics', 'POST', input)).data).toMatchObject({ request_id: input.request_id, state: 'committed' });
    }
  }), 180000);

  it('rejects duplicate, partial, mixed, oversized, spoofed and query inputs with unchanged config/xmin/receipt/sequence', async () => fixture(async c => {
    const read = await c.call('/adminapi/wechat/routine'), before = await c.facts(), input = request(read.data.revision);
    const invalid = [{ ...input, actor_id: ADMIN+1 }, { ...input, confirmed: false },
      { ...input, fields: { ...input.fields, wechat_app_appsecret: { action: 'clear' } } },
      { ...input, fields: { routine_appId: { action: 'keep' } } },
      { ...input, fields: { ...input.fields, routine_contact_type: { action: 'replace', value: '1' } } },
      { ...input, fields: { ...input.fields, routine_appsecret: { action: 'replace', value: '' } } },
      { ...input, fields: { ...input.fields, routine_name: { action: 'replace', value: 'a'.repeat(4999) } } }];
    const raw = JSON.stringify(input), duplicate = raw.replace('"confirmed":true', '"confirmed":false,"confirmed":true');
    for (const prefix of prefixes) for (const path of ['/wechat/routine','/setting/config/save_basics']) {
      for (const body of invalid) expect((await c.call(prefix + path, 'POST', body)).status).not.toBe(200);
      for (const text of ['{bad','[]',duplicate]) expect((await c.call(prefix + path, 'POST', undefined, 0, text)).status).toBe(400);
      expect((await c.call(prefix + path, 'POST', undefined, 0, raw.padEnd(65537))).status).toBe(400);
      expect((await c.call(prefix + path + '?actor_id=' + ADMIN, 'POST', input)).status).toBe(400);
    }
    expect((await c.call('/adminapi/wechat/routine?x=1')).status).toBe(400);
    expect(await c.facts()).toEqual(before);
  }), 180000);

  it('recovers the immutable original binding after same-UID relogin, current-source changes and permission revocation', async () => fixture(async c => {
    const read = await c.call('/adminapi/wechat/routine'), original = request(read.data.revision);
    original.fields.routine_name = { action: 'replace', value: 'First Routine' };
    const saved = await c.call('/adminapi/wechat/routine', 'POST', original); expect(saved.status, saved.msg).toBe(200);
    const fresh = await c.call('/adminapi/wechat/routine'), second = request(fresh.data.revision);
    second.fields.routine_name = { action: 'replace', value: 'Second Routine' };
    expect((await c.call('/adminapi/wechat/routine', 'POST', second)).status).toBe(200);
    const oldToken = tokenFacts(c.tokens[0]);
    const relogin = await createToken(ADMIN, 'admin', md5(PASSWORD), KEY, 'cinashop', oldToken.iat-60, randomUUID());
    expect(relogin.exp).not.toBe(oldToken.exp); c.tokens[0] = relogin.token;
    const before = await c.facts();
    const replay = await c.call('/api/admin/wechat/routine', 'POST', original);
    expect(replay.status, replay.msg).toBe(200); expect(replay.data).toMatchObject({ replayed: true, revision: saved.data.revision });
    expect(await c.facts()).toEqual(before);
    const altered = structuredClone(original); altered.fields.routine_name = { action: 'replace', value: 'different' };
    expect((await c.call('/adminapi/wechat/routine', 'POST', altered)).status).toBe(409);
    await c.f.db.update(systemRole).set({ rules: '' }).where(eq(systemRole.id, ADMIN));
    expect((await c.call('/adminapi/wechat/routine')).status).not.toBe(200);
    expect((await c.call('/api/admin/wechat/routine/operations/' + original.request_id)).data).toMatchObject({ state: 'committed', revision: saved.data.revision });
    expect((await c.call('/adminapi/wechat/routine/operations/' + original.request_id, 'GET', undefined, 1)).status).toBe(409);
    const missing = request(fresh.data.revision), sealed = await c.call('/adminapi/wechat/routine/operations/' + missing.request_id + '/resolve', 'POST', { confirmed: true });
    expect(sealed.status, sealed.msg).toBe(200); expect(sealed.data).toMatchObject({ state: 'not_applied', replayed: false });
    await c.f.db.update(systemRole).set({ rules: '1346,315' }).where(eq(systemRole.id, ADMIN));
    expect((await c.call('/api/admin/wechat/routine', 'POST', missing)).data).toMatchObject({ state: 'not_applied', replayed: true });
    await c.f.db.update(systemAdmin).set({ pwd: 'owned-routine-rotated-password' }).where(eq(systemAdmin.id, ADMIN));
    expect((await c.call('/adminapi/wechat/routine/operations/' + original.request_id)).status).not.toBe(200);
  }), 180000);

  it('rejects stale complete metadata and uncommissioned AppID switch/adoption before every other field write', async () => fixture(async c => {
    const read = await c.call('/adminapi/wechat/routine'), input = request(read.data.revision), before = await c.facts();
    input.fields.routine_appId = { action: 'replace', value: 'different-uncommissioned-app' };
    input.fields.routine_name = { action: 'replace', value: 'must-not-write' };
    expect((await c.call('/adminapi/wechat/routine', 'POST', input)).status).toBe(503);
    expect(await c.facts()).toEqual(before);
    const fake = request('a'.repeat(64)); fake.fields.routine_name = { action: 'replace', value: 'must-not-write' };
    expect((await c.call('/adminapi/wechat/routine', 'POST', fake)).status).toBe(409);
    // Explicit owned maintenance changes only metadata then restores the guard.
    await c.f.exec('ALTER TABLE system_config DISABLE TRIGGER routine_config_rows');
    try { await c.f.db.update(systemConfig).set({ parameter: 'owned-maintenance-changed-metadata' }).where(eq(systemConfig.id, ADMIN+102)); }
    finally { await c.f.exec('ALTER TABLE system_config ENABLE TRIGGER routine_config_rows'); }
    const maintained = await c.facts();
    expect((await c.call('/api/admin/wechat/routine', 'POST', request(read.data.revision))).status).toBe(409);
    expect(await c.facts()).toEqual(maintained);
    await c.f.exec('ALTER TABLE system_config DISABLE TRIGGER routine_config_rows');
    try { await c.f.db.delete(systemConfig).where(eq(systemConfig.id, ADMIN+100)); }
    finally { await c.f.exec('ALTER TABLE system_config ENABLE TRIGGER routine_config_rows'); }
    const absent = await c.call('/adminapi/wechat/routine'), unadopted = await c.facts();
    expect(absent.data.settings.routine_appId).toBeNull();
    const adopt = request(absent.data.revision);
    adopt.fields.routine_appId = { action: 'replace', value: 'first-uncommissioned-app' };
    adopt.fields.routine_name = { action: 'replace', value: 'must-not-write' };
    expect((await c.call('/api/admin/wechat/routine', 'POST', adopt)).status).toBe(503);
    expect(await c.facts()).toEqual(unadopted);
  }), 180000);

  it('rejects maintenance/request-lock contention and catalog drift without changing or repairing business facts', async () => fixture(async c => {
    const read = await c.call('/adminapi/wechat/routine'), input = request(read.data.revision), before = await c.facts();
    // Independent actual LOGIN holds the lock; fixture-owner facts/cleanup use
    // a separate connection and cannot deadlock on its own max-one pool.
    await c.withLock(ADMIN_WECHAT_ROUTINE_REQUEST_GATE, input.request_id, async () => {
      expect((await c.call('/adminapi/wechat/routine', 'POST', input)).status).toBe(409);
    });
    expect(await c.facts()).toEqual(before);
    await c.withLock(731667, null, async () => {
      expect((await c.call('/adminapi/wechat/routine', 'POST', input)).status).toBe(503);
    });
    expect(await c.facts()).toEqual(before);
    await c.f.exec('ALTER TABLE admin_wechat_routine_operation ADD COLUMN owned_http_drift integer');
    const drifted = await c.facts();
    expect((await c.call('/adminapi/wechat/routine', 'POST', input)).status).toBe(503);
    expect(await c.facts()).toEqual(drifted);
  }), 180000);

  it('rejects disabled, deleted, foreign-realm, password-changed and expired live owners without creating recovery evidence', async () => fixture(async c => {
    const read = await c.call('/adminapi/wechat/routine'), input = request(read.data.revision);
    expect((await c.call('/adminapi/wechat/routine', 'POST', input)).status).toBe(200);
    const before = await c.facts();
    for (const change of [{ status: 0 }, { isDel: 1 }, { adminType: 2 }, { relationId: 4 }, { pwd: 'changed-owned-password' }]) {
      await c.f.db.update(systemAdmin).set(change).where(eq(systemAdmin.id, ADMIN));
      for (const path of ['/adminapi/wechat/routine', '/adminapi/wechat/routine/operations/' + input.request_id])
        expect((await c.call(path)).status).not.toBe(200);
      expect((await c.call('/api/admin/wechat/routine/operations/' + randomUUID() + '/resolve', 'POST', { confirmed: true })).status).not.toBe(200);
      expect(await c.facts()).toEqual(before);
      await c.f.db.update(systemAdmin).set({ status: 1, isDel: 0, adminType: 1, relationId: 0, pwd: PASSWORD }).where(eq(systemAdmin.id, ADMIN));
    }
    const old = tokenFacts(c.tokens[0]), duration = old.exp-old.iat;
    c.tokens[0] = (await createToken(ADMIN, 'admin', md5(PASSWORD), KEY, 'cinashop', Math.floor(Date.now()/1000)-duration-10)).token;
    expect((await c.call('/adminapi/wechat/routine/operations/' + input.request_id)).status).not.toBe(200);
    expect(await c.facts()).toEqual(before);
  }), 180000);

  it('rejects over-budget complete history through the production reader and writer without prefix snapshots', async () => fixture(async c => {
    const read = await c.call('/adminapi/wechat/routine');
    await c.f.exec('ALTER TABLE system_config DISABLE TRIGGER routine_config_rows');
    try {
      await c.f.db.insert(systemConfig).values(Array.from({ length: 59 }, (_, i) => ({
        id: ADMIN+200+i, menuName: 'routine_name', value: JSON.stringify('owned-import-'+i), sort: -100,
      })));
    } finally { await c.f.exec('ALTER TABLE system_config ENABLE TRIGGER routine_config_rows'); }
    const before = await c.facts();
    expect((await c.call('/adminapi/wechat/routine')).status).toBe(503);
    expect((await c.call('/api/admin/wechat/routine', 'POST', request(read.data.revision))).status).toBe(503);
    expect(await c.facts()).toEqual(before);
  }), 180000);
});
