import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { createContainerFromDb, type Container } from '../src/lib/di';
import {
  legacyCategory, storeProduct, storeProductRelation, storeProductRule, storeProductSpecs,
  systemAdmin, systemMenus, systemRole,
} from '../src/models/schema';
import { requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { createToken, md5 } from '../src/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Legacy product metadata fixture unavailable');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Legacy product metadata fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

const app = createApp();
const env = { APP_KEY: 'local-legacy-product-metadata-only', UPSTASH_REDIS_URL: '',
  UPSTASH_REDIS_TOKEN: '' } as Env;
const password = 'legacy-product-metadata-fixture';
const identities = { reader: 9811, manager: 9812, adjacent: 9813 } as const;
type Identity = keyof typeof identities;
const tokens = new Map<Identity, string>();
let fixture: Awaited<ReturnType<typeof financePostgres>>;

const spec = { name: '重量', value: '500克', sort: 8 };
const dimensions = [{ value: '颜色', detail: ['红', '蓝'] },
  { value: '尺寸', detail: ['M', 'L'] }];
const canonicalRoutes = [
  ['GET', '/product/all_specs'], ['GET', '/product/specs'],
  ['GET', '/product/specs/11'], ['POST', '/product/specs/11'],
  ['DELETE', '/product/specs/11'], ['GET', '/product/product/rule'],
  ['GET', '/product/product/rule/11'], ['POST', '/product/product/rule/11'],
  ['DELETE', '/product/product/rule/delete/11'],
] as const;

beforeEach(async () => {
  fixture = await financePostgres([legacyCategory, storeProductSpecs, storeProductRule,
    storeProduct, storeProductRelation, systemAdmin, systemRole, systemMenus]);
  wiring.container = createContainerFromDb(fixture.db);
  await fixture.db.insert(legacyCategory).values([
    { id: 11, type: 0, relationId: 0, group: 3, name: '平台参数', sort: 10, addTime: 1700000000 },
    { id: 12, type: 0, relationId: 0, group: 3, name: '零时间', sort: 0, addTime: 0 },
    { id: 201, type: 2, relationId: 91, group: 3, name: '供应商参数' },
    { id: 202, type: 0, relationId: 0, group: 2, name: '其他分类组' },
    { id: 203, type: 0, relationId: 88, group: 3, name: '其他所有者' },
  ]);
  await fixture.db.insert(storeProductSpecs).values([
    { tempId: 11, ...spec, status: 1 },
    { tempId: 11, name: '停用参数', value: '不供选择', sort: 0, status: 0 },
    { tempId: 201, type: 2, relationId: 91, name: '供应商私有', value: '隔离' },
  ]);
  await fixture.db.insert(storeProductRule).values([
    { id: 11, type: 0, relationId: 0, ruleName: '平台规则', ruleValue: JSON.stringify(dimensions) },
    { id: 201, type: 2, relationId: 91, ruleName: '供应商规则', ruleValue: JSON.stringify(dimensions) },
    { id: 203, type: 0, relationId: 88, ruleName: '其他所有者', ruleValue: JSON.stringify(dimensions) },
  ]);
  const rules: Record<Identity, string> = {
    reader: 'product.view', manager: 'product.manage', adjacent: 'order.manage',
  };
  await fixture.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: `Metadata ${name}`, rules: rules[name as Identity],
  })));
  await fixture.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `metadata-${name}`, pwd: password, roles: String(id), level: 1,
    adminType: 1, status: 1, isDel: 0,
  })));
  for (const [name, id] of Object.entries(identities)) tokens.set(name as Identity,
    (await createToken(id, 'admin', md5(password), env.APP_KEY)).token);
}, 30_000);

afterEach(async () => { wiring.container = undefined; tokens.clear(); await fixture?.close(); });

async function request(path: string, identity: Identity | 'anonymous' = 'manager',
  method = 'GET', data?: unknown) {
  const response = await app.request(`/adminapi${path}`, { method,
    headers: { ...(identity === 'anonymous' ? {} : { Authorization: `Bearer ${tokens.get(identity)}` }),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }, env);
  return response.json<{ status: number; msg: string; data: any }>();
}

it('enforces the real administrator read/manage boundary for all nine canonical routes', async () => {
  for (const [method, path] of canonicalRoutes) {
    expect(requiredAdminPermission(method, `/adminapi${path}`))
      .toBe(method === 'GET' ? 'product.view' : 'product.manage');
    for (const identity of ['anonymous', 'adjacent'] as const) {
      expect((await request(path, identity, method)).status)
        .toBe(identity === 'anonymous' ? 410000 : 400011);
    }
    if (method === 'GET') expect((await request(path, 'reader')).status).toBe(200);
    else expect((await request(path, 'reader', method, { name: '越权', specs: [spec] })).status).toBe(400011);
  }
  expect((await fixture.db.select().from(legacyCategory).where(eq(legacyCategory.id, 11)))[0].name)
    .toBe('平台参数');
  expect((await fixture.db.select().from(storeProductRule).where(eq(storeProductRule.id, 11)))[0].ruleName)
    .toBe('平台规则');
});

it('serves the original parameter list, editor and active selector contracts without changing the TS endpoint', async () => {
  const list = await request('/product/specs?page=1&limit=15&name=平台');
  expect(list).toMatchObject({ status: 200, data: { count: 1, page: 1, limit: 15,
    list: [{ id: 11, name: '平台参数', type: 0, relation_id: 0, group: 3,
      add_time: '2023-11-15 06:13:20' }] } });
  expect((await request('/product/specs?name=零时间')).data.list[0].add_time).toBe('');
  expect((await request('/specs?name=平台')).data.list[0].add_time).toBe(1700000000);
  const detail = await request('/product/specs/11');
  expect(detail).toMatchObject({ status: 200, data: { id: 11, name: '平台参数',
    sort: 10, specs: [{ ...spec, status: 1 }, { name: '停用参数', status: 0 }] } });
  const choices = await request('/product/all_specs');
  expect(choices.data.map((row: { id: number }) => row.id)).toEqual([11, 12]);
  expect(choices.data[0]).toMatchObject({ id: 11, name: '平台参数', specs: [{ ...spec, status: 1 }] });
  expect(choices.data[0].specs).toHaveLength(1);
});

it('accepts the old editor full body, creates at id zero, replaces parameters atomically and deletes an unused template', async () => {
  const created = await request('/product/specs/0', 'manager', 'POST',
    { id: '0', name: '新参数', sort: 7, specs: [spec], type: 2, relation_id: 91, group: 2 });
  expect(created.status).toBe(200);
  const id = created.data.id as number;
  const read = await request(`/product/specs/${id}`);
  expect(read.data).toMatchObject({ id, name: '新参数', sort: 7, type: 0, relation_id: 0, group: 3,
    specs: [{ ...spec, type: 0, relation_id: 0, temp_id: id }] });
  expect((await request(`/product/specs/${id}`, 'manager', 'POST', {
    ...read.data, name: '编辑参数', specs: [{ name: '容量', value: '1升', sort: 3 }],
  })).status).toBe(200);
  expect((await request(`/product/specs/${id}`)).data.specs)
    .toEqual([expect.objectContaining({ name: '容量', value: '1升', sort: 3, status: 1 })]);
  expect((await request(`/product/specs/${id}`, 'manager', 'DELETE')).status).toBe(200);
  expect(await fixture.db.select().from(legacyCategory).where(eq(legacyCategory.id, id))).toHaveLength(0);
  expect(await fixture.db.select().from(storeProductSpecs).where(eq(storeProductSpecs.tempId, id))).toHaveLength(0);
});

it('does not read, replace or delete supplier templates, other owners or other category groups', async () => {
  for (const id of [201, 202, 203]) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect((await request(`/product/specs/${id}`, 'manager', method,
        method === 'POST' ? { name: '跨范围', sort: 0, specs: [spec] } : undefined)).status).not.toBe(200);
    }
  }
  expect((await request('/product/specs')).data.list.map((row: { id: number }) => row.id)).toEqual([11, 12]);
  expect((await fixture.db.select().from(legacyCategory).where(eq(legacyCategory.id, 201)))[0].name)
    .toBe('供应商参数');
  expect((await fixture.db.select().from(storeProductSpecs).where(eq(storeProductSpecs.tempId, 201)))[0].value)
    .toBe('隔离');
});

it('retains both direct product and product-relation deletion protections on the canonical path', async () => {
  await fixture.db.insert(storeProduct).values({ id: 1, specsId: 11, isDel: 0 });
  expect((await request('/product/specs/11', 'manager', 'DELETE')).msg).toContain('仍被商品使用');
  await fixture.db.update(storeProduct).set({ specsId: 0 }).where(eq(storeProduct.id, 1));
  await fixture.db.insert(storeProductRelation).values({ productId: 1, relationId: 11, type: 6 });
  expect((await request('/product/specs/11', 'manager', 'DELETE')).msg).toContain('仍被商品使用');
  expect(await fixture.db.select().from(legacyCategory).where(eq(legacyCategory.id, 11))).toHaveLength(1);
  expect(await fixture.db.select().from(storeProductSpecs).where(eq(storeProductSpecs.tempId, 11))).toHaveLength(2);
});

it('serves list/count, attr values and info.spec, and completes the old SKU rule create/edit/delete flow', async () => {
  const initial = await request('/product/product/rule?page=1&limit=10&rule_name=平台');
  expect(initial).toMatchObject({ status: 200, data: { count: 1, page: 1, limit: 10,
    list: [{ id: 11, rule_name: '平台规则', attr_name: '颜色,尺寸', attr_value: ['红,蓝', 'M,L'] }] } });
  expect((await request('/product/product/rule/11')).data.info.spec).toEqual(dimensions);
  const created = await request('/product/product/rule/0', 'manager', 'POST',
    { rule_name: '新规则', spec: dimensions, type: 2, relation_id: 91 });
  expect(created.status).toBe(200);
  const id = created.data.id as number;
  const detail = await request(`/product/product/rule/${id}`);
  expect(detail.data.info).toMatchObject({ id, type: 0, relation_id: 0, rule_name: '新规则', spec: dimensions });
  expect((await request(`/product/product/rule/${id}`, 'manager', 'POST',
    { ...detail.data.info, rule_name: '已编辑规则', spec: [{ value: '口味', detail: ['原味'] }] })).status).toBe(200);
  expect((await request(`/product/product/rule/${id}`)).data.info.spec).toEqual([{ value: '口味', detail: ['原味'] }]);
  expect((await request(`/product/product/rule/delete/${id}`, 'manager', 'DELETE')).status).toBe(200);
  expect(await fixture.db.select().from(storeProductRule).where(eq(storeProductRule.id, id))).toHaveLength(0);
  for (const foreignId of [201, 203]) {
    expect((await request(`/product/product/rule/${foreignId}`)).status).not.toBe(200);
    expect((await request(`/product/product/rule/${foreignId}`, 'manager', 'POST',
      { rule_name: '跨范围', spec: dimensions })).status).not.toBe(200);
    expect((await request(`/product/product/rule/delete/${foreignId}`, 'manager', 'DELETE')).status).not.toBe(200);
  }
  expect((await fixture.db.select().from(storeProductRule).where(eq(storeProductRule.id, 201)))[0].ruleName)
    .toBe('供应商规则');
});

it('retains the complete validation gate and leaves existing rows unchanged after malformed edits', async () => {
  for (const body of [null, [], { name: ' ', specs: [spec] },
    { name: '错误', sort: -1, specs: [spec] },
    { name: '错误', specs: [{ ...spec, value: '' }] },
    { name: '错误', specs: [{ ...spec, status: 2 }] },
    { name: '错误', specs: Array.from({ length: 101 }, () => spec) }]) {
    expect((await request('/product/specs/11', 'manager', 'POST', body)).status).not.toBe(200);
  }
  for (const body of [null, [], { rule_name: '', spec: dimensions },
    { rule_name: '错误', spec: [] }, { rule_name: '错误', spec: [...dimensions, ...dimensions] },
    { rule_name: '错误', spec: [{ value: '颜色', detail: ['红', '红'] }] }]) {
    expect((await request('/product/product/rule/11', 'manager', 'POST', body)).status).not.toBe(200);
  }
  for (const id of ['-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
    expect((await request(`/product/specs/${id}`, 'manager', 'POST', { name: '错误', specs: [spec] })).status).not.toBe(200);
    expect((await request(`/product/product/rule/${id}`, 'manager', 'POST', { rule_name: '错误', spec: dimensions })).status).not.toBe(200);
  }
  expect((await request('/product/specs?page=bad')).status).not.toBe(200);
  expect((await request('/product/product/rule?limit=-1')).status).not.toBe(200);
  expect((await request('/product/specs/11')).data.name).toBe('平台参数');
  expect((await request('/product/specs/11')).data.specs).toHaveLength(2);
  expect((await request('/product/product/rule/11')).data.info.spec).toEqual(dimensions);
});
