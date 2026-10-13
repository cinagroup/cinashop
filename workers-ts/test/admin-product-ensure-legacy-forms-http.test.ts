import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { storeProductEnsure, systemAdmin, systemMenus, systemRole } from '../src/models/schema';
import { requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { ProductExperienceService, supplierEnsureOwner } from '../src/services/product/ProductExperienceService';
import { createToken, md5 } from '../src/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Ensure form fixture unavailable');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Ensure form fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

const app = createApp();
const env = { APP_KEY: 'local-ensure-form-only', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const identities = { reader: 9821, manager: 9822, adjacent: 9823 } as const;
type Identity = keyof typeof identities;
const tokens = new Map<Identity, string>();
let fixture: Awaited<ReturnType<typeof financePostgres>>;
const original = { name: '七天退换', image: '/ensure.png', desc: '到货后七天内可申请退换', sort: 6 };

beforeEach(async () => {
  fixture = await financePostgres([storeProductEnsure, systemAdmin, systemRole, systemMenus]);
  wiring.container = createContainerFromDb(fixture.db);
  await fixture.db.insert(storeProductEnsure).values([
    { id: 11, type: 0, relationId: 0, ...original, status: 0 },
    { id: 201, type: 2, relationId: 91, ...original, status: 0 },
    { id: 202, type: 0, relationId: 88, ...original, status: 0 },
  ]);
  const grants: Record<Identity, string> = { reader: 'product.view', manager: 'product.manage', adjacent: 'order.manage' };
  const password = 'ensure-form-fixture';
  await fixture.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: `Ensure ${name}`, rules: grants[name as Identity],
  })));
  await fixture.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `ensure-${name}`, pwd: password, roles: String(id), level: 1,
    adminType: 1, status: 1, isDel: 0,
  })));
  for (const [name, id] of Object.entries(identities)) tokens.set(name as Identity,
    (await createToken(id, 'admin', md5(password), env.APP_KEY)).token);
}, 30_000);

afterEach(async () => { wiring.container = undefined; tokens.clear(); await fixture?.close(); });

async function request(path: string, identity: Identity | 'anonymous' = 'manager', method = 'GET', data?: unknown) {
  const response = await app.request(`/adminapi/${path.replace(/^\//, '')}`, {
    method, headers: {
      ...(identity === 'anonymous' ? {} : { Authorization: `Bearer ${tokens.get(identity)}` }),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }, env);
  return response.json<{ status: number; msg: string; data: any }>();
}

function formData(form: { rules: Array<{ field: string; value: unknown }> }) {
  return Object.fromEntries(form.rules.map(rule => [rule.field, rule.value]));
}

it('returns the original four-field create form before the numeric detail route', async () => {
  const result = await request('product/ensure/create', 'reader');
  expect(result).toMatchObject({ status: 200, data: { title: '添加保障服务', action: 'product/ensure', method: 'POST' } });
  expect(formData(result.data)).toEqual({ name: '', desc: '', image: '', sort: 0 });
  expect(result.data.rules).toHaveLength(4);
  expect(result.data.rules[0]).toMatchObject({ type: 'input', props: { maxlength: 100 }, validate: [{ required: true }] });
  expect(result.data.rules[1]).toMatchObject({ type: 'input', props: { type: 'textarea' }, validate: [{ required: true }] });
  expect(result.data.rules[2]).toMatchObject({ type: 'frame', props: { type: 'image', maxLength: 1,
    src: '/admin/widget.images/index?fodder=image', icon: 'ios-add', width: '960px', height: '505px',
    modal: { 'footer-hide': true } }, validate: [{ type: 'string', required: true }] });
  expect(result.data.rules[3]).toMatchObject({ type: 'inputNumber', props: { min: 0, max: 99999 } });
});

it('loads an inactive platform row into the edit form and keeps the detail contract', async () => {
  const result = await request('product/ensure/11/edit', 'reader');
  expect(result).toMatchObject({ status: 200, data: { title: '编辑保障服务', action: 'product/ensure/11', method: 'PUT' } });
  expect(formData(result.data)).toEqual(original);
  expect((await request('product/ensure/11', 'reader')).data).toMatchObject({ ...original, id: 11, status: 0 });
});

it('submits the returned actions with four fields and preserves inactive status on editing', async () => {
  const create = (await request('product/ensure/create')).data;
  const created = await request(create.action, 'manager', create.method, { ...formData(create), ...original, name: '新保障条款' });
  expect(created.status).toBe(200);
  const id = created.data.id as number;
  expect((await request(`product/ensure/${id}`)).data).toMatchObject({ type: 0, relation_id: 0, status: 1 });
  const edit = (await request('product/ensure/11/edit')).data;
  expect(await request(edit.action, 'manager', edit.method, { ...formData(edit), name: '停用条款编辑后', sort: 9 }))
    .toMatchObject({ status: 200, data: { id: 11 } });
  expect((await request('product/ensure/11')).data).toMatchObject({ name: '停用条款编辑后', sort: 9, status: 0 });
  expect((await request('product/ensure/11', 'manager', 'PUT', { ...original, status: 1 })).status).toBe(200);
  expect((await request('product/ensure/11')).data.status).toBe(1);
});

it('enforces live administrator read/manage grants for forms and their submissions', async () => {
  for (const path of ['product/ensure/create', 'product/ensure/11/edit']) {
    expect(requiredAdminPermission('GET', `/adminapi/${path}`)).toBe('product.view');
    expect((await request(path, 'anonymous')).status).toBe(410000);
    expect((await request(path, 'adjacent')).status).toBe(400011);
    expect((await request(path, 'reader')).status).toBe(200);
  }
  expect((await request('product/ensure', 'reader', 'POST', original)).status).toBe(400011);
  expect((await request('product/ensure/11', 'reader', 'PUT', original)).status).toBe(400011);
  await fixture.db.update(systemAdmin).set({ status: 0 }).where(eq(systemAdmin.id, identities.reader));
  expect((await request('product/ensure/create', 'reader')).status).not.toBe(200);
});

it('does not expose or update another owner through a platform edit form', async () => {
  for (const id of [201, 202, 999]) {
    expect((await request(`product/ensure/${id}/edit`)).status).not.toBe(200);
    expect((await request(`product/ensure/${id}`, 'manager', 'PUT', { ...original, name: '越界修改' })).status).not.toBe(200);
  }
  for (const id of [201, 202]) expect((await fixture.db.select().from(storeProductEnsure)
    .where(eq(storeProductEnsure.id, id)))[0]).toMatchObject({ ...original, status: 0 });
});

it('rejects malformed edit identities and invalid submitted status without mutating the row', async () => {
  for (const id of ['0', '-1', 'abc', '1.5']) expect((await request(`product/ensure/${id}/edit`)).status).not.toBe(200);
  expect((await request('product/ensure/11', 'manager', 'PUT', { ...original, status: 2 })).status).not.toBe(200);
  expect((await request('product/ensure/11')).data).toMatchObject({ ...original, status: 0 });
});

it('also preserves omitted status for a supplier owner while accepting an explicit status change', async () => {
  const service = new ProductExperienceService(wiring.container!);
  await service.saveEnsure(supplierEnsureOwner(91), 201, { ...original, name: '供应商停用项编辑' });
  expect((await fixture.db.select().from(storeProductEnsure).where(eq(storeProductEnsure.id, 201)))[0])
    .toMatchObject({ name: '供应商停用项编辑', status: 0, type: 2, relationId: 91 });
  await service.saveEnsure(supplierEnsureOwner(91), 201, { ...original, status: 1 });
  expect((await fixture.db.select().from(storeProductEnsure).where(eq(storeProductEnsure.id, 201)))[0].status).toBe(1);
});
