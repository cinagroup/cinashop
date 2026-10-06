import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { storeCouponIssue, systemAdmin, systemRole, user } from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { couponIssueBody } from './helpers/couponIssueFixture';
import { seedCouponTemplates } from './helpers/couponTemplateFixture';

const wiring = vi.hoisted(() => ({ application: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({ ...await original<typeof import('../src/lib/di')>(), createContainer: () => {
  if (!wiring.application) throw Error('Owned issuer HTTP application LOGIN unavailable'); return wiring.application;
} }));
const prefixes = ['/adminapi', '/api/admin'], password = 'synthetic-issuer-http';
const actors = { all: 7601, manager: 7602, reader: 7603, records: 7604, both: 7605, unrelated: 7606 };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected complete HTTP object'); return value as Record<string, unknown>;
}
async function envelope(response: Response) {
  expect(response.headers.get('Cache-Control')).toContain('private'); expect(response.headers.get('Cache-Control')).toContain('no-store');
  const result = object(await response.json());
  if (typeof result.status !== 'number' || typeof result.msg !== 'string' || !Object.hasOwn(result, 'data')) throw Error('Malformed envelope');
  return result;
}
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Independent issuers assembled HTTP with exact App/Admin LOGIN and real JWT', () => {
  const app = createApp(), tokens = new Map<string, string>();
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture(); f.env.APP_KEY = 'local-independent-issuer-http-key'; await seedCouponTemplates(f.db);
    const rules = { all: 'coupon.manage,coupon_record.view', manager: 'coupon.manage', reader: 'coupon.view',
      records: 'coupon_record.view', both: 'coupon.view,coupon_record.view', unrelated: 'coupon_template.manage' };
    await f.db.insert(systemRole).values(Object.entries(actors).map(([name, id]) => ({ id, roleName: `Local issuer ${name}`, rules: rules[name as keyof typeof rules] })));
    await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name, id]) => ({ id, account: `local-issuer-${name}`, pwd: password,
      roles: String(id), level: 1, adminType: 1, status: 1, isDel: 0 })));
    for (const [name, id] of Object.entries(actors)) tokens.set(name, (await createToken(id, 'admin', md5(password), f.env.APP_KEY)).token);
  }, 60000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { wiring.application = undefined; tokens.clear(); vi.restoreAllMocks(); await f?.close(); }
  }, 30000);
  type Role = Parameters<NonNullable<typeof f.withRuntimeRole>>[0] extends (r: infer R) => unknown ? R : never;
  async function profiles(run: (env: Env, admin: Role) => Promise<void>) {
    await f.withRuntimeRole!(application => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS name');
      const names = { app: application.role, admin: admin.role, maintenance: 'finance_test', database: String(identity.name), pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      expect(await auditRuntimeBusinessPrivileges(application.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
      expect(await auditRuntimeBusinessPrivileges(admin.db, 'admin', names)).toMatchObject({ ready: true, failures: [] });
      expect((await admin.exec('SELECT current_user AS role,session_user AS session'))[0]).toEqual({ role: admin.role, session: admin.role });
      wiring.application = createContainerFromDb(application.db);
      const env: Env = { ...f.env, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
        HYPERDRIVE: { connectionString: application.connectionString } as Env['HYPERDRIVE'],
        HYPERDRIVE_ADMIN: { connectionString: admin.connectionString } as Env['HYPERDRIVE_ADMIN'] };
      Object.assign(env, { NODE_ENV: 'test' });
      try { await run(env, admin); } finally { wiring.application = undefined; }
    }));
  }
  const send = (env: Env, path: string, method = 'GET', body?: unknown, actor = 'all') => app.request(path, {
    method, headers: { 'Authori-zation': `Bearer ${tokens.get(actor) ?? ''}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  async function snapshot() {
    const state: Record<string, unknown> = {};
    for (const table of ['store_coupon_template', 'store_coupon_template_issue', 'store_coupon_issue', 'store_coupon_product',
      'store_coupon_user', 'store_coupon_issue_user', 'store_product_coupon', 'system_log']) {
      state[table] = (await f.query(`SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text`)).rows;
    }
    state.sequences = (await f.query("SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows;
    return state;
  }
  async function detail(env: Env, base: string, id: number) {
    const result = await envelope(await send(env, `${base}/marketing/coupon-issues/${id}`));
    expect(result.status, String(result.msg)).toBe(200); return object(result.data);
  }
  async function create(env: Env, base: string) {
    const result = await envelope(await send(env, `${base}/marketing/coupon-issues`, 'POST', couponIssueBody()));
    expect(result.status, String(result.msg)).toBe(200); const id = object(result.data).id;
    if (typeof id !== 'number' || id <= 0) throw Error('Unconfirmed issuer identity'); return { id, row: await detail(env, base, id) };
  }
  it.each(prefixes)('runs independent new/copy/status/delete and all six reads on %s', async base => {
    await profiles(async env => {
      const { id, row } = await create(env, base), beforeReads = await snapshot();
      for (const suffix of ['', '/options', '/products', `/${id}`, `/${id}/copy`, `/${id}/claims`]) {
        expect((await envelope(await send(env, `${base}/marketing/coupon-issues${suffix}`))).status).toBe(200);
      }
      expect(await snapshot()).toEqual(beforeReads);
      const copy = couponIssueBody({ ...object(row.copy_input), title: 'HTTP独立副本', source_id: id, source_revision: row.revision });
      const copied = await envelope(await send(env, `${base}/marketing/coupon-issues`, 'POST', copy));
      expect(copied.status, String(copied.msg)).toBe(200); expect(object(copied.data).id).not.toBe(id);
      const afterCopy = await snapshot(); expect((await envelope(await send(env, `${base}/marketing/coupon-issues`, 'POST', copy))).data).toEqual(copied.data);
      expect(await snapshot()).toEqual(afterCopy);
      expect((await detail(env, base, id)).revision).toBe(row.revision);
      expect((await envelope(await send(env, `${base}/marketing/coupon-issues/${id}/status`, 'POST', { request_id: crypto.randomUUID(), revision: row.revision, status: 0 }))).status).toBe(200);
      const stopped = await detail(env, base, id); expect(stopped.status).toBe(0);
      expect((await envelope(await send(env, `${base}/marketing/coupon-issues/${id}`, 'DELETE', { request_id: crypto.randomUUID(), revision: stopped.revision }))).status).toBe(200);
      expect(await detail(env, base, id)).toMatchObject({ deleted: true, status: -1, remain_count: 5 });
      const [audit] = await f.db.execute(sql`SELECT admin_id FROM system_log WHERE type='coupon_issue' ORDER BY id DESC LIMIT 1`);
      expect(audit.admin_id).toBe(actors.all);
    });
  }, 90000);
  it.each(prefixes)('keeps financial reads, writes and claimant identities independently authorized on %s', async base => {
    await profiles(async env => {
      const { id, row } = await create(env, base), before = await snapshot();
      for (const actor of ['records', 'unrelated']) for (const suffix of ['', '/options', '/products', `/${id}`, `/${id}/copy`]) {
        expect(await envelope(await send(env, `${base}/marketing/coupon-issues${suffix}`, 'GET', undefined, actor))).toMatchObject({ status: 400011, data: null });
      }
      for (const actor of ['reader', 'manager', 'unrelated']) expect(await envelope(await send(env, `${base}/marketing/coupon-issues/${id}/claims`, 'GET', undefined, actor)))
        .toMatchObject({ status: 400011, data: null });
      for (const actor of ['records', 'both']) expect((await envelope(await send(env, `${base}/marketing/coupon-issues/${id}/claims`, 'GET', undefined, actor))).status).toBe(200);
      const writes = [['', 'POST', couponIssueBody()], [`/${id}/status`, 'POST', { request_id: crypto.randomUUID(), revision: row.revision, status: 0 }],
        [`/${id}`, 'DELETE', { request_id: crypto.randomUUID(), revision: row.revision }]] as const;
      for (const actor of ['reader', 'records', 'both', 'unrelated']) for (const [suffix, method, body] of writes) {
        expect(await envelope(await send(env, `${base}/marketing/coupon-issues${suffix}`, method, body, actor))).toMatchObject({ status: 400011, data: null });
      }
      expect(await snapshot()).toEqual(before);
    });
  }, 90000);
  it('rejects unknown identities, malformed bodies, stale revisions and oversized queries without business or sequence changes', async () => {
    await profiles(async env => {
      const base = '/adminapi', { id, row } = await create(env, base), before = await snapshot();
      const cases = [['?page=1&page=2', 'GET', undefined], ['?limit=101', 'GET', undefined], ['/options?x=1', 'GET', undefined],
        [`/${id}?x=1`, 'GET', undefined], [`/${id}/claims?nickname=x`, 'GET', undefined], ['?x=1', 'POST', couponIssueBody()],
        ['', 'POST', couponIssueBody({ request_id: 'invalid' })], ['', 'POST', couponIssueBody({ uid: 22 })],
        ['', 'POST', couponIssueBody({ title: 'x'.repeat(17000) })], [`/${id}/status`, 'POST', { request_id: crypto.randomUUID(), revision: '0'.repeat(64), status: 0 }]] as const;
      for (const [suffix, method, body] of cases) expect(await envelope(await send(env, `${base}/marketing/coupon-issues${suffix}`, method, body))).toMatchObject({ status: 400, data: null });
      const apiToken = await createToken(11, 'api', md5(password), env.APP_KEY), unknownAdmin = await createToken(99999, 'admin', md5(password), env.APP_KEY);
      for (const token of ['', 'invalid', apiToken.token, unknownAdmin.token]) for (const prefix of prefixes) {
        const response = await app.request(`${prefix}/marketing/coupon-issues`, { method: 'POST', headers: {
          'Authori-zation': token ? `Bearer ${token}` : '', 'Content-Type': 'application/json' }, body: JSON.stringify(couponIssueBody()) }, env);
        expect((await envelope(response)).status).toBeGreaterThanOrEqual(410000);
      }
      expect(await snapshot()).toEqual(before);
      expect(typeof row.revision).toBe('string');
    });
  }, 90000);
  it('uses actual API identity for legacy ordinary once-only claim and rejects member/hidden acquisition with zero writes', async () => {
    await f.db.update(user).set({ pwd: password, status: 1 }).where(eq(user.uid, 11));
    await profiles(async env => {
      const { id } = await create(env, '/adminapi');
      await f.db.update(storeCouponIssue).set({ category: 1, receiveLimit: 0 }).where(eq(storeCouponIssue.id, id));
      const customer = await createToken(11, 'api', md5(password), env.APP_KEY);
      const claim = async () => object(await (await app.request('/api/coupon/receive', { method: 'POST', headers: {
        'Authori-zation': `Bearer ${customer.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, uid: 22 }) }, env)).json());
      const first = await claim(); expect(first.status, String(first.msg)).toBe(200);
      expect((await f.db.execute(sql`SELECT uid,issue_coupon_id,receive_source FROM store_coupon_user WHERE issue_coupon_id=${id}`))[0])
        .toEqual({ uid: 11, issue_coupon_id: id, receive_source: 'get' });
      const before = await snapshot(); expect(await claim()).toMatchObject({ status: 400, msg: expect.stringContaining('限领') }); expect(await snapshot()).toEqual(before);
      for (const fields of [{ receiveType: 0 }, { receiveType: 2 }, { receiveType: 3 }, { receiveType: 4 }, { category: 2 }, { appType: 1 }]) {
        await f.db.update(storeCouponIssue).set({ receiveType: 1, category: 1, appType: 0, ...fields }).where(eq(storeCouponIssue.id, id));
        const snapshotBefore = await snapshot(); expect(await claim()).toMatchObject({ status: 400, msg: expect.stringContaining('不允许手动领取') });
        expect(await snapshot()).toEqual(snapshotBefore);
      }
    });
  }, 90000);
});
