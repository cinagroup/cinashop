import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createToken, md5 } from '@/utils/jwt';
import { storeProductUnit, systemLog } from '@/models/schema';
import { productUnitFixture } from './helpers/adminProductUnits';
import axios from '../../view/admin-ts/node_modules/axios/index.js';
const wiring = vi.hoisted(() => ({ application: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.application, createAdminDatabaseSession: wiring.open }));
const env = { APP_KEY: 'unit-http-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
describe('actual App PHP unit routes and current aliases with JWT and SQL', () => {
  const app = createApp(); let f: Awaited<ReturnType<typeof productUnitFixture>>, tokens: Record<number, string>;
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden')); f = await productUnitFixture();
    wiring.application.mockImplementation(() => f.container); wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    tokens = {}; for (const id of [101, 102, 103, 104, 105]) tokens[id] = (await createToken(id, 'admin', md5('unit-fixture-password'), env.APP_KEY)).token;
  }, 30000);
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  async function request(method: string, path: string, body?: unknown, id = 101) {
    const response = await app.request(path, { method, headers: id ? { 'Authori-zation': `Bearer ${tokens[id]}`, 'Content-Type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  it('serves every old read, create/edit form and six modern aliases through the full application', async () => {
    for (const path of ['/adminapi/product/get_all_unit', '/adminapi/product/unit', '/adminapi/product/unit/create', '/adminapi/product/unit/1', '/adminapi/product/unit/1/edit', '/adminapi/get_all_unit', '/adminapi/unit', '/adminapi/unit/1', '/api/admin/get_all_unit', '/api/admin/unit', '/api/admin/unit/1']) {
      const result = await request('GET', path); expect(result.body.status, result.body.msg).toBe(200);
    }
    expect((await request('GET', '/adminapi/product/unit/create')).body.data).toMatchObject({ method: 'POST', action: 'product/unit' });
    expect((await request('GET', '/adminapi/product/unit/1/edit')).body.data).toMatchObject({ method: 'PUT', action: 'product/unit/1' });
  });
  it('executes the old POST/PUT/DELETE and accepts complete displayed DTO bodies without changing ownership', async () => {
    const created = await request('POST', '/adminapi/product/unit', { name: 'HTTP单位', sort: 10 }); expect(created.body.status).toBe(200);
    const id = created.body.data.id, row = (await request('GET', `/adminapi/product/unit/${id}`)).body.data;
    const updated = await request('PUT', `/adminapi/product/unit/${id}`, { ...row, name: 'HTTP改名', sort: 12 }); expect(updated.body.status, updated.body.msg).toBe(200);
    const deleted = await request('DELETE', `/adminapi/product/unit/${id}`); expect(deleted.body.status).toBe(200);
    expect((await f.db.select().from(systemLog)).map(row => row.method)).toEqual(['POST', 'PUT', 'DELETE']);
  });
  it('uses identical 15-character write behavior and committed rows for both contemporary prefixes', async () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      expect((await request('POST', `${prefix}/unit`, { name: 'x'.repeat(16) })).body.status).not.toBe(200);
      const created = await request('POST', `${prefix}/unit`, { name: prefix.endsWith('admin') ? '现代API' : '现代Admin', sort: 2 }); expect(created.body.status).toBe(200);
      const id = created.body.data.id;
      expect((await request('PUT', `${prefix}/unit/${id}`, { name: prefix.endsWith('admin') ? '现代API改' : '现代Admin改', sort: 3 })).body.status).toBe(200);
      expect((await request('DELETE', `${prefix}/unit/${id}`)).body).toMatchObject({ status: 200, data: null });
    }
  });
  it('rejects missing/foreign/view-only auth and numeric-menu forgery without state changes', async () => {
    const before = await f.db.select().from(storeProductUnit);
    expect((await request('GET', '/adminapi/product/unit', undefined, 0)).body.status).not.toBe(200);
    expect((await request('GET', '/adminapi/product/unit', undefined, 103)).body.status).not.toBe(200);
    expect((await request('GET', '/adminapi/product/unit', undefined, 102)).body.status).toBe(200);
    expect((await request('POST', '/adminapi/product/unit', { name: '越权' }, 102)).body.status).not.toBe(200);
    expect((await request('POST', '/adminapi/product/unit', { name: 'numeric单位' }, 104)).body.status).toBe(200);
    expect((await f.db.select().from(storeProductUnit)).length).toBe(before.length + 1);
  });
  it('rejects malformed IDs, unsupported verbs, repeated query and ownership/body injection', async () => {
    const before = await f.db.select().from(storeProductUnit);
    for (const [method, path, body] of [
      ['GET', '/adminapi/product/unit/01', undefined], ['PATCH', '/adminapi/product/unit/1', { name: '错误' }],
      ['GET', '/adminapi/product/unit?page=1&page=2', undefined], ['POST', '/adminapi/product/unit', { name: '跨户', type: 2 }],
      ['PUT', '/adminapi/product/unit/1', { name: '错ID', id: 2 }], ['POST', '/adminapi/product/unit', { name: '字段', status: 1, secret: 'forbidden' }],
    ] as const) expect((await request(method, path, body)).body.status).not.toBe(200);
    expect(await f.db.select().from(storeProductUnit)).toEqual(before);
  });
  it('admits the exact original unit page role for reads and forms but refuses all its writer aliases', async () => {
    for (const path of ['/adminapi/product/unit', '/adminapi/product/unit/create', '/adminapi/product/unit/1/edit', '/adminapi/unit', '/api/admin/unit']) {
      expect((await request('GET', path, undefined, 105)).body.status).toBe(200);
    }
    for (const path of ['/adminapi/product/unit', '/adminapi/unit', '/api/admin/unit']) {
      expect((await request('POST', path, { name: '原页面只读' }, 105)).body.status).toBe(400011);
    }
  });
  it('submits the actual create and edit form responses through the legacy Axios base URL to the real App', async () => {
    // The PHP modal submits request[form.method.toLowerCase()](form.action,
    // values), and its shared Axios instance already owns the /adminapi base.
    const client = axios.create({ baseURL: 'http://localhost/adminapi' });
    expect(client.getUri({ url: '/adminapi/product/unit' })).toBe('http://localhost/adminapi/adminapi/product/unit');
    const beforeLogs = await f.db.select().from(systemLog);
    const createForm = (await request('GET', '/adminapi/product/unit/create')).body.data;
    const createUrl = new URL(client.getUri({ url: createForm.action }));
    expect(createUrl.pathname).toBe('/adminapi/product/unit');
    const created = await request(createForm.method, createUrl.pathname, { name: '实际表单单位', sort: 6 });
    expect(created.body.status, created.body.msg).toBe(200);
    const id = created.body.data.id;
    const editForm = (await request('GET', `/adminapi/product/unit/${id}/edit`)).body.data;
    expect(editForm.rules).toMatchObject([{ field: 'name', value: '实际表单单位' }, { field: 'sort', value: 6 }]);
    const editUrl = new URL(client.getUri({ url: editForm.action }));
    expect(editUrl.pathname).toBe(`/adminapi/product/unit/${id}`);
    const updated = await request(editForm.method, editUrl.pathname, { name: '实际表单改名', sort: 8 });
    expect(updated.body.status, updated.body.msg).toBe(200);
    expect((await request('GET', editUrl.pathname)).body.data).toMatchObject({ id, name: '实际表单改名', sort: 8 });
    expect((await request('DELETE', editUrl.pathname)).body.status).toBe(200);
    const logs = await f.db.select().from(systemLog);
    expect(logs.slice(beforeLogs.length).map(row => row.method)).toEqual(['POST', 'PUT', 'DELETE']);
  });
});
