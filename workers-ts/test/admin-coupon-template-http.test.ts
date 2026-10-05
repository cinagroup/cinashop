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

// The assembled app uses real JWT/account/role checks and opens its own Admin
// LOGIN. Only its application binding is redirected to an owned local LOGIN.
const wiring = vi.hoisted(() => ({ application: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({ ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.application) throw Error('Owned coupon HTTP application LOGIN unavailable');
    return wiring.application;
  },
}));
const prefixes = ['/adminapi', '/api/admin'];
const actors = { all: 7101, manager: 7102, reader: 7103, publisher: 7104, mixed: 7105, existing: 7106 };
const password = 'synthetic-coupon-template-http';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected complete HTTP object');
  return value as Record<string, unknown>;
}
async function envelope(response: Response) {
  expect(response.headers.get('Cache-Control')).toContain('private');
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  const body = object(await response.json());
  if (typeof body.status !== 'number' || typeof body.msg !== 'string' || !Object.hasOwn(body, 'data')) throw Error('Malformed HTTP envelope');
  return body;
}
const input = () => ({ request_id: crypto.randomUUID(), title: 'HTTP 优惠模板', scope_type: 0, category_id: 0, product_ids: [],
  coupon_price: '5.00', use_min_price: '20.00', valid_days: 7, sort: 1, status: 1 });
function publish(id: number, revision: string) {
  return { request_id: crypto.randomUUID(), template_id: id, revision, receive_type: 1, status: 1,
    is_permanent: 0, count: 3, start_time: null, end_time: null, full_reduction: '0.00' };
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Coupon template assembled HTTP on formal schema and exact LOGIN profiles', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  const app = createApp(), tokens = new Map<string, string>();
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture(); f.env.APP_KEY = 'local-coupon-template-http-key';
    const rules = { all: 'coupon_template.manage,coupon_template_issue.manage', manager: 'coupon_template.manage',
      reader: 'coupon_template.view', publisher: 'coupon_template_issue.manage',
      mixed: 'coupon_template.view,coupon_template_issue.manage', existing: 'coupon.manage' };
    await f.db.insert(systemRole).values(Object.entries(actors).map(([name, id]) => ({ id, roleName: `Local coupon ${name}`, rules: rules[name as keyof typeof rules] })));
    await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name, id]) => ({ id, account: `local-coupon-${name}`, pwd: password,
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
    for (const table of ['store_coupon_template', 'store_coupon_template_issue', 'store_coupon_issue', 'store_coupon_product', 'store_coupon_user', 'store_coupon_issue_user', 'system_log'])
      state[table] = (await f.query(`SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text`)).rows;
    state.sequences = (await f.query("SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows;
    return state;
  }
  async function detail(env: Env, base: string, id: number) {
    const result = await envelope(await send(env, `${base}/marketing/coupon-templates/${id}`));
    expect(result.status, String(result.msg)).toBe(200);
    const row = object(result.data);
    expect(row).toMatchObject({ id, revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    return row;
  }
  async function create(env: Env, base: string) {
    const result = await envelope(await send(env, `${base}/marketing/coupon-templates`, 'POST', input()));
    expect(result.status, String(result.msg)).toBe(200);
    const id = object(result.data).id;
    if (typeof id !== 'number' || id <= 0) throw Error('Unconfirmed template identity');
    return { id, row: await detail(env, base, id) };
  }

  it.each(prefixes)('executes template lifecycle and snapshot publication on %s', async base => {
    await profiles(async env => {
      const { id, row } = await create(env, base), body = publish(id, String(row.revision));
      const issued = await envelope(await send(env, `${base}/marketing/coupon-template-issues`, 'POST', body));
      expect(issued.status, String(issued.msg)).toBe(200);
      expect(issued.data).toMatchObject({ template_id: id, issue_id: expect.any(Number) });
      const replay = await envelope(await send(env, `${base}/marketing/coupon-template-issues`, 'POST', body));
      expect(replay.status, String(replay.msg)).toBe(200); expect(replay.data).toEqual(issued.data);
      const before = await snapshot();
      for (const suffix of ['', '/options', '/products', `/${id}`, `/${id}/issues`]) {
        const result = await envelope(await send(env, `${base}/marketing/coupon-templates${suffix}`));
        expect(result.status, String(result.msg)).toBe(200);
      }
      expect(await snapshot()).toEqual(before);
      const invalidated = await envelope(await send(env, `${base}/marketing/coupon-templates/${id}/invalidate`, 'POST',
        { request_id: crypto.randomUUID(), revision: row.revision }));
      expect(invalidated.status, String(invalidated.msg)).toBe(200);
      const updated = await detail(env, base, id); expect(updated.status).toBe(0);
      const stopped = await f.db.execute(sql`SELECT status FROM store_coupon_issue WHERE id=${object(issued.data).issue_id}`);
      expect(stopped[0].status).toBe(-1);
      const removed = await envelope(await send(env, `${base}/marketing/coupon-templates/${id}`, 'DELETE',
        { request_id: crypto.randomUUID(), revision: updated.revision }));
      expect(removed.status, String(removed.msg)).toBe(200);
      const state = await f.db.execute(sql`SELECT is_del FROM store_coupon_template WHERE id=${id}`);
      expect(state[0].is_del).toBe(1);
      expect((await f.db.execute(sql`SELECT count(*)::int AS count FROM store_coupon_template_issue WHERE template_id=${id}`))[0].count).toBe(1);
    });
  }, 90000);

  it.each(prefixes)('enforces template management and composite publication rights on %s without denied DML', async base => {
    await profiles(async env => {
      const { id, row } = await create(env, base), before = await snapshot();
      for (const actor of ['publisher', 'existing']) for (const suffix of ['', '/options', '/products', `/${id}`, `/${id}/issues`])
        expect(await envelope(await send(env, `${base}/marketing/coupon-templates${suffix}`, 'GET', undefined, actor))).toMatchObject({ status: 400011, data: null });
      const writes = [[`${base}/marketing/coupon-templates`, 'POST', input()],
        [`${base}/marketing/coupon-templates/${id}/invalidate`, 'POST', { request_id: crypto.randomUUID(), revision: row.revision }],
        [`${base}/marketing/coupon-templates/${id}`, 'DELETE', { request_id: crypto.randomUUID(), revision: row.revision }]] as const;
      for (const actor of ['reader', 'publisher', 'mixed', 'existing']) for (const [path, method, body] of writes)
        expect(await envelope(await send(env, path, method, body, actor))).toMatchObject({ status: 400011, data: null });
      for (const actor of ['manager', 'reader', 'publisher', 'existing'])
        expect(await envelope(await send(env, `${base}/marketing/coupon-template-issues`, 'POST', publish(id, String(row.revision)), actor))).toMatchObject({ status: 400011, data: null });
      expect(await snapshot()).toEqual(before);
      // The restricted publisher with template visibility can issue, but has
      // no template-management capability and cannot create/invalidate/delete.
      expect((await envelope(await send(env, `${base}/marketing/coupon-template-issues`, 'POST', publish(id, String(row.revision)), 'mixed'))).status).toBe(200);
    });
  }, 90000);

  it.each(prefixes)('rejects malformed, stale, replay-conflicting and oversized requests on %s', async base => {
    await profiles(async env => {
      const { id, row } = await create(env, base), before = await snapshot();
      const cases = [
        [`${base}/marketing/coupon-templates?page=1&page=2`, 'GET', undefined],
        [`${base}/marketing/coupon-templates?limit=101`, 'GET', undefined],
        [`${base}/marketing/coupon-templates/options?unknown=1`, 'GET', undefined],
        [`${base}/marketing/coupon-templates/${id}?unknown=1`, 'GET', undefined],
        [`${base}/marketing/coupon-templates?unknown=1`, 'POST', input()],
        [`${base}/marketing/coupon-templates`, 'POST', { ...input(), request_id: 'invalid' }],
        [`${base}/marketing/coupon-templates`, 'POST', { ...input(), product_ids: [70] }],
        [`${base}/marketing/coupon-templates/${id}/invalidate`, 'POST', { request_id: crypto.randomUUID(), revision: '0'.repeat(64) }],
        [`${base}/marketing/coupon-templates/${id}`, 'DELETE', { request_id: crypto.randomUUID() }],
        [`${base}/marketing/coupon-template-issues`, 'POST', { ...publish(id, String(row.revision)), receive_type: 0 }],
        [`${base}/marketing/coupon-template-issues`, 'POST', { ...publish(id, String(row.revision)), is_permanent: 0, count: 0 }],
        [`${base}/marketing/coupon-template-issues?extra=1`, 'POST', publish(id, String(row.revision))],
        [`${base}/marketing/coupon-templates`, 'POST', { ...input(), title: 'x'.repeat(17000) }],
      ] as const;
      for (const [path, method, body] of cases)
        expect(await envelope(await send(env, path, method, body))).toMatchObject({ status: 400, data: null });
      for (const body of ['[]', '{']) {
        const response = await app.request(`${base}/marketing/coupon-templates`, { method: 'POST',
          headers: { 'Authori-zation': `Bearer ${tokens.get('all')}`, 'Content-Type': 'application/json' }, body }, env);
        expect(await envelope(response)).toMatchObject({ status: 400, data: null });
      }
      expect(await snapshot()).toEqual(before);
      const body = publish(id, String(row.revision));
      expect((await envelope(await send(env, `${base}/marketing/coupon-template-issues`, 'POST', body))).status).toBe(200);
      const after = await snapshot();
      expect(await envelope(await send(env, `${base}/marketing/coupon-template-issues`, 'POST', { ...body, count: 4 }))).toMatchObject({ status: 400, data: null });
      expect(await snapshot()).toEqual(after);
    });
  }, 90000);

  it('uses the real API JWT identity and exact App LOGIN for manual claim, rejecting hidden modes without writes', async () => {
    await f.db.update(user).set({ pwd: password, status: 1 }).where(eq(user.uid, 11));
    await profiles(async env => {
      const { id, row } = await create(env, '/adminapi');
      const published = await envelope(await send(env, '/adminapi/marketing/coupon-template-issues', 'POST', publish(id, String(row.revision))));
      expect(published.status, String(published.msg)).toBe(200);
      const issueId = Number(object(published.data).issue_id);
      const customer = await createToken(11, 'api', md5(password), env.APP_KEY);
      const claim = async (token: string, extra: Record<string, unknown> = {}) => object(await (await app.request('/api/coupon/receive', {
        method: 'POST', headers: { 'Authori-zation': token ? `Bearer ${token}` : '', 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: issueId, ...extra }),
      }, env)).json());
      const unauthenticated = await snapshot();
      for (const token of ['', 'invalid-jwt', tokens.get('all')!])
        expect((await claim(token)).status).toBeGreaterThanOrEqual(410000);
      expect(await snapshot()).toEqual(unauthenticated);
      for (const fields of [{ receiveType: 0 }, { receiveType: 2 }, { receiveType: 3 }, { receiveType: 4 }, { category: 2 }, { appType: 1 }]) {
        await f.db.update(storeCouponIssue).set({ receiveType: 1, category: 0, appType: 0, ...fields }).where(eq(storeCouponIssue.id, issueId));
        const before = await snapshot(), result = await claim(customer.token, { uid: 22 });
        expect(result).toMatchObject({ status: 400, msg: expect.stringContaining('不允许手动领取') });
        expect(await snapshot()).toEqual(before);
      }
      await f.db.update(storeCouponIssue).set({ receiveType: 1, category: 0, appType: 0 }).where(eq(storeCouponIssue.id, issueId));
      const claimed = await claim(customer.token, { uid: 22 });
      expect(claimed.status, String(claimed.msg)).toBe(200);
      expect((await f.db.execute(sql`SELECT uid,issue_coupon_id,receive_source FROM store_coupon_user WHERE issue_coupon_id=${issueId}`))[0])
        .toEqual({ uid: 11, issue_coupon_id: issueId, receive_source: 'get' });
      expect((await f.db.execute(sql`SELECT uid,issue_coupon_id FROM store_coupon_issue_user WHERE issue_coupon_id=${issueId}`))[0])
        .toEqual({ uid: 11, issue_coupon_id: issueId });
      expect((await f.db.execute(sql`SELECT remain_count FROM store_coupon_issue WHERE id=${issueId}`))[0].remain_count).toBe(2);
      const after = await snapshot();
      expect(await claim(customer.token)).toMatchObject({ status: 400, msg: expect.stringContaining('限领') });
      expect(await snapshot()).toEqual(after);
    });
  }, 90000);

  it('rejects invalid and non-Admin JWTs on both surfaces without exposing the graph', async () => {
    await profiles(async env => {
      const customer = await createToken(actors.all, 'api', md5(password), env.APP_KEY), before = await snapshot();
      for (const base of prefixes) for (const token of ['', 'invalid-jwt', customer.token]) {
        const response = await app.request(`${base}/marketing/coupon-templates`, { method: 'POST',
          headers: { 'Authori-zation': token ? `Bearer ${token}` : '', 'Content-Type': 'application/json' }, body: JSON.stringify(input()) }, env);
        expect((await envelope(response)).status).toBeGreaterThanOrEqual(410000);
      }
      expect(await snapshot()).toEqual(before);
    });
  }, 90000);
});
