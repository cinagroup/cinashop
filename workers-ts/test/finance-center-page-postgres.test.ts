/** Actual registered finance APIs on a separately authenticated PG16 App LOGIN.
 * Every read compares the complete 283-table/229-sequence snapshot. Binding has
 * one independently computed allowed row/serial delta; it is never called a read. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import type { DiyStateSnapshot, DiyStateRow as Row } from './helpers/diyStateFixture';
import { financeCenterFixture, FINANCE_CENTER as ids, assertFinanceBinding } from './helpers/financeCenterFixture';

const wiring = vi.hoisted(() => ({ context: undefined as AsyncLocalStorage<Container> | undefined }));
vi.mock('@/lib/di', async original => ({
  ...await original<typeof import('@/lib/di')>(),
  createContainer: () => {
    const container = wiring.context?.getStore();
    if (!container) throw Error('Owned finance center App LOGIN required');
    return container;
  },
}));

interface Envelope { status: number; msg: string; data: unknown }
const native = describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL));
native('finance center registered JWT API with full283tables229sequences and independent App LOGIN', () => {
  let f: Awaited<ReturnType<typeof financeCenterFixture>>;
  beforeAll(async () => {
    f = await financeCenterFixture();
    wiring.context = new AsyncLocalStorage<Container>();
  }, 60_000);
  afterAll(async () => {
    wiring.context?.disable(); wiring.context = undefined;
    await f?.close(); vi.restoreAllMocks();
  }, 30_000);

  it('proves read pagination, auth denial, exact permanent binding and account isolation without external providers', async () => {
    const app = createApp();
    const forbiddenFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Finance center forbids external providers'));
    const installedFrom = await f.snapshot();
    let finalSnapshot: DiyStateSnapshot | undefined;
    await f.withApplication(async runtime => {
      // Commissioning installs only the reviewed authority. Its business rows
      // and serials must equal the post-fixture state before any HTTP request.
      const installed = await f.snapshot();
      expect(installed).toEqual(installedFrom);
      expect(Object.keys(installed).filter(name => name !== '__sequences')).toHaveLength(283);
      expect(installed.__sequences).toHaveLength(229);
      expect(runtime.identity.role).toBe(runtime.identity.session);
      expect(runtime.identity.role).toBe(runtime.roles.app);
      expect(runtime.identity.role).not.toBe(runtime.roles.maintenance);
      expect(runtime.identity.role).not.toBe(runtime.roles.admin);
      expect(runtime.identity.rolcanlogin).toBe(true);
      for (const flag of ['rolsuper', 'rolinherit', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls']) {
        expect(runtime.identity[flag]).toBe(false);
      }
      const request = async (path: string, options: { uid?: number; token?: string; data?: Row } = {}) => {
        const uid = options.uid ?? ids.a;
        const headers = new Headers({ 'Form-type': 'h5' });
        if (uid) {
          const token = options.token ?? f.tokens.get(uid);
          if (!token) throw Error('Synthetic signed JWT required for this actor');
          headers.set('Authori-zation', 'Bearer ' + token);
        }
        const method = options.data === undefined ? 'GET' : 'POST';
        if (method === 'POST') headers.set('Content-Type', 'application/json');
        const jobs: Promise<unknown>[] = [];
        const response = await wiring.context!.run(runtime.container, () => app.fetch(new Request('https://finance-center-proof.test' + path, {
          method, headers, ...(options.data === undefined ? {} : { body: JSON.stringify(options.data) }),
        }), runtime.env, {
          waitUntil: (job: Promise<unknown>) => jobs.push(job), passThroughOnException: () => {},
        } as never));
        const body = await response.json() as Envelope;
        // PHP-compatible known business/auth errors also use HTTP200. The
        // business envelope, rather than an assumed HTTP4xx, is authoritative.
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(Object.keys(body).sort()).toEqual(['data', 'msg', 'status']);
        expect(body.status).toEqual(expect.any(Number)); expect(body.msg).toEqual(expect.any(String));
        expect((await Promise.allSettled(jobs)).every(result => result.status === 'fulfilled')).toBe(true);
        expect(jobs).toHaveLength(0);
        return { response, body };
      };
      const read = async (path: string, uid: number = ids.a, status = 200, token?: string) => {
        const before = await f.snapshot(), forbiddenCalls = f.forbidden.mock.calls.length;
        const result = await request(path, { uid, token });
        expect(result.body.status).toBe(status);
        expect(await f.snapshot()).toEqual(before);
        expect(f.forbidden).toHaveBeenCalledTimes(forbiddenCalls);
        if (status === 200) expect(result.response.headers.get('cache-control')).toBe('private, no-store');
        return result;
      };
      const commissionA = await read('/api/commission');
      expect(commissionA.body.data).toMatchObject({ uid: ids.a, ...f.setup.expected[ids.a],
        commissionSum: '41.22', commissionRefund: '2.02', commissionCount: '39.20', extractCount: '0.00' });
      const first = await read('/api/user/commission/list/1?page=1&limit=20');
      const second = await read('/api/user/commission/list/1?page=2&limit=20');
      const pageOne = first.body.data as Row[], pageTwo = second.body.data as Row[];
      expect(pageOne).toHaveLength(20); expect(pageTwo).toHaveLength(2);
      expect(pageOne.map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, index) => 667122 - index));
      expect(pageTwo.map(row => row.id)).toEqual([667102, 667101]);
      const allRows = [...pageOne, ...pageTwo];
      expect(new Set(allRows.map(row => row.id)).size).toBe(22);
      expect(allRows.every(row => row.uid === ids.a && row.type === 'one_brokerage' && row.pm === 1 && row.number === (row.id === 667122 ? '20.01' : '1.01'))).toBe(true);
      expect(allRows.some(row => row.id === 667123 || row.id === 667124)).toBe(false);
      const third = await read('/api/user/commission/list/1?page=3&limit=20');
      expect(third.body.data).toEqual([]);

      for (const path of ['/api/commission', '/api/user/commission/list/1?page=1&limit=20']) {
        const guest = await read(path, 0, 410000);
        expect(guest.body.data).toBeNull();
        const invalid = await read(path, ids.a, 410001, 'invalid-synthetic-finance-jwt');
        expect(invalid.body.data).toBeNull();
      }
      {
        const before = await f.snapshot();
        const denied = await request('/api/user/spread', { data: { spread_uid: ids.a } });
        expect(denied.body).toEqual({ status: 400, msg: '不能绑定自己为推广人', data: null });
        expect(await f.snapshot()).toEqual(before);
      }
      {
        const before = await f.snapshot(), start = Date.now();
        const accepted = await request('/api/user/spread', { data: { spread_uid: ids.parent } });
        const end = Date.now(), after = await f.snapshot();
        expect(accepted.body).toEqual({ status: 200, msg: '绑定成功', data: null });
        const delta = assertFinanceBinding(before, after, start, end);
        expect(delta).toMatchObject({ kind: 'explicit-permanent-binding', owner: ids.a, parent: ids.parent,
          sequence_allocations: ['user_spread_id_seq', 'user_friends_id_seq'] });
      }
      // An accepted permanent relationship is idempotent, including an attempt
      // to replace it with another valid actor. No serial gap is permitted here.
      for (const spreadUid of [ids.parent, ids.b]) {
        const before = await f.snapshot();
        const repeated = await request('/api/user/spread', { data: { spread_uid: spreadUid } });
        expect(repeated.body).toEqual({ status: 200, msg: '绑定成功', data: null });
        expect(await f.snapshot()).toEqual(before);
      }
      const commissionB = await read('/api/commission', ids.b);
      expect(commissionB.body.data).toMatchObject({ uid: ids.b, ...f.setup.expected[ids.b],
        commissionSum: '9.99', commissionRefund: '0.00', commissionCount: '9.99' });
      const isolated = await read('/api/user/commission/list/1?page=1&limit=20', ids.b);
      expect(isolated.body.data).toMatchObject([{ id: 667124, uid: ids.b, title: '另一账号佣金', number: '9.99', type: 'one_brokerage' }]);
      expect(isolated.body.data).toHaveLength(1);
      const sameA = await read('/api/commission');
      expect(sameA.body.data).toMatchObject({ uid: ids.a, ...f.setup.expected[ids.a],
        commissionSum: '41.22', commissionRefund: '2.02', commissionCount: '39.20', extractCount: '0.00' });
      expect(f.forbidden).not.toHaveBeenCalled();
      expect(forbiddenFetch).not.toHaveBeenCalled();
      finalSnapshot = await f.snapshot();
    });
    expect(finalSnapshot).toBeDefined();
    expect(await f.snapshot()).toEqual(finalSnapshot);
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(forbiddenFetch).not.toHaveBeenCalled();
  }, 120_000);
});
