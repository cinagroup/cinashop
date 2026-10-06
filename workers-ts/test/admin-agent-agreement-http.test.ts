import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { agreement, systemAdmin, systemLog, systemMenus, systemRole } from '../src/models/schema';
import { AdminPermissionService, requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { createToken, md5 } from '../src/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Isolated promoter agreement fixture unavailable');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Isolated promoter agreement fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

const app = createApp();
const env = { APP_KEY: 'local-promoter-agreement-only', UPSTASH_REDIS_URL: '',
  UPSTASH_REDIS_TOKEN: '' } as Env;
const password = 'promoter-agreement-role';
const identities = { reader: 9961, manager: 9962, legacyPage: 9963,
  wrongLegacy: 9964, other: 9965 } as const;
type Identity = keyof typeof identities;
const tokens = new Map<Identity, string>();
let fixture: Awaited<ReturnType<typeof financePostgres>>;
let agentId: number;

beforeEach(async () => {
  fixture = await financePostgres([agreement, systemAdmin, systemRole, systemMenus, systemLog]);
  wiring.container = createContainerFromDb(fixture.db);
  await fixture.db.insert(agreement).values([
    { type: 1, title: '会员协议', content: '<p>会员原文</p>', status: 1, sort: 8 },
    { type: 2, title: '分销说明', content: '<p>初始推广说明</p>', status: 1, sort: 3 },
  ]);
  const [agent] = await fixture.db.select({ id: agreement.id }).from(agreement)
    .where(eq(agreement.type, 2));
  agentId = agent.id;
  await fixture.db.insert(systemMenus).values([
    { id: 1385, menuName: '推广员协议', authType: 1, type: 1,
      menuPath: '/admin/agent/agreement', uniqueAuth: 'agent-agreement' },
    { id: 1386, menuName: '伪推广员协议', authType: 1, type: 1,
      menuPath: '/admin/agent/agreement', uniqueAuth: 'wrong-rule' },
  ]);
  const rules: Record<Identity, string> = {
    reader: 'agent_agreement.view', manager: 'agent_agreement.manage',
    legacyPage: '1385', wrongLegacy: '1386', other: 'division.manage',
  };
  await fixture.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: `Promoter agreement ${name}`, rules: rules[name as Identity],
  })));
  await fixture.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `agent-agreement-${name}`, pwd: password, roles: String(id), level: 1,
    adminType: 1, status: 1, isDel: 0,
  })));
  for (const [name, id] of Object.entries(identities)) {
    tokens.set(name as Identity,
      (await createToken(id, 'admin', md5(password), env.APP_KEY)).token);
  }
}, 30_000);

afterEach(async () => {
  wiring.container = undefined;
  tokens.clear();
  await fixture?.close();
});

async function request(base: string, name: Identity | 'anonymous', path: string,
  method = 'GET', data?: Record<string, unknown>) {
  const response = await app.request(`${base}/${path}`, { method,
    headers: name === 'anonymous' ? {} : { Authorization: `Bearer ${tokens.get(name)}`,
      ...(data ? { 'Content-Type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  }, env);
  return { status: response.status, cache: response.headers.get('Cache-Control'),
    body: await response.json<{ status: number; msg: string; data: any }>() };
}

it.each(['/adminapi', '/api/admin'])('enforces read, manage and legacy-menu grants on %s', async base => {
  const readPath = 'agent/get_agent_agreement';
  const writePath = `agent/set_agent_agreement/${agentId}`;
  for (const name of ['anonymous', 'wrongLegacy', 'other'] as const) {
    expect((await request(base, name, readPath)).body.status).not.toBe(200);
  }
  for (const name of ['reader', 'manager', 'legacyPage'] as const) {
    const read = await request(base, name, readPath);
    expect(read).toMatchObject({ status: 200,
      body: { status: 200, data: { id: agentId, type: 2, content: '<p>初始推广说明</p>' } } });
    expect(read.body.data.revision).toMatch(/^[0-9]+$/);
    expect(read.cache).toContain('no-store');
  }
  const revision = (await request(base, 'manager', readPath)).body.data.revision as string;
  for (const name of ['anonymous', 'reader', 'legacyPage', 'wrongLegacy', 'other'] as const) {
    expect((await request(base, name, writePath, 'POST',
      { content: '<p>越权修改</p>', status: 1, revision })).body.status).not.toBe(200);
  }
  const saved = await request(base, 'manager', writePath, 'POST',
    { content: '<p>已授权更新</p>', status: 1, revision });
  expect(saved).toMatchObject({ status: 200,
    body: { status: 200, data: { id: agentId, type: 2, content: '<p>已授权更新</p>' } } });
  expect(saved.cache).toContain('no-store');
  expect(saved.body.data.revision).not.toBe(revision);
  const [member] = await fixture.db.select().from(agreement).where(eq(agreement.type, 1));
  expect(member.content).toBe('<p>会员原文</p>');
  expect(await fixture.db.select().from(systemLog)).toHaveLength(1);
});

it('maps exact old menu 1385 to view only and keeps both prefixes on the same ACL contract', async () => {
  const permissions = new AdminPermissionService(createContainerFromDb(fixture.db));
  expect(await permissions.resolveManyRulePermissionKeys(['1385', '1386']))
    .toEqual([['agent_agreement.view'], []]);
  for (const base of ['/adminapi', '/api/admin']) {
    expect(requiredAdminPermission('GET', `${base}/agent/get_agent_agreement`))
      .toBe('agent_agreement.view');
    expect(requiredAdminPermission('POST', `${base}/agent/set_agent_agreement/${agentId}`))
      .toBe('agent_agreement.manage');
  }
});

it('rejects old bodies, forged types and ids, and stale revisions on both prefixes', async () => {
  const initial = await request('/adminapi', 'manager', 'agent/get_agent_agreement');
  const revision = initial.body.data.revision as string;
  const [member] = await fixture.db.select({ id: agreement.id }).from(agreement)
    .where(eq(agreement.type, 1));
  const path = `agent/set_agent_agreement/${agentId}`;
  for (const base of ['/adminapi', '/api/admin']) {
    const oldBody = await request(base, 'manager', path, 'POST',
      { content: '<p>旧客户端无版本</p>', status: 1 });
    expect(oldBody.body.status).toBe(400);
    const forgedType = await request(base, 'manager', path, 'POST',
      { content: '<p>伪造类型</p>', status: 1, revision, type: 1 });
    expect(forgedType.body.status).toBe(400);
    const forgedId = await request(base, 'manager', `agent/set_agent_agreement/${member.id}`,
      'POST', { content: '<p>伪造会员 ID</p>', status: 1, revision });
    expect(forgedId.status).toBe(409);
  }
  const saved = await request('/adminapi', 'manager', path, 'POST',
    { content: '<p>新版本</p>', status: 0, revision });
  expect(saved.body.status).toBe(200);
  const stale = await request('/api/admin', 'manager', path, 'POST',
    { content: '<p>覆盖新版本</p>', status: 1, revision });
  expect(stale.status).toBe(409);
  const [storedMember] = await fixture.db.select().from(agreement).where(eq(agreement.type, 1));
  const [storedAgent] = await fixture.db.select().from(agreement).where(eq(agreement.type, 2));
  expect(storedMember.content).toBe('<p>会员原文</p>');
  expect(storedAgent).toMatchObject({ content: '<p>新版本</p>', status: 0 });
  expect(await fixture.db.select().from(systemLog)).toHaveLength(1);
  const publicResponse = await app.request('/api/agreement/2', {}, env);
  expect(publicResponse.status).toBe(200);
  expect(await publicResponse.json()).toMatchObject({ status: 200,
    data: { member_explain: { type: 2, content: '<p>新版本</p>', status: 0 } } });
});
