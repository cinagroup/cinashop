import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Container } from '../src/lib/di';
import type { AppVariables, Env } from '../src/env';
import { agreement, systemLog } from '../src/models/schema';
import { AdminAgentAgreementService } from '../src/services/admin/AdminAgentAgreementService';
import { getAgentAgreement, setAgentAgreement } from '../src/controllers/api/v1/AdminAgentAgreementController';
import { financePostgres } from './helpers/financePostgres';

const actor = { id: 7, name: '协议管理员', ip: '127.0.0.1' };
const input = (content: string, status: 0 | 1, revision: string) => ({ content, status, revision });

describe('Admin promoter agreement type=2', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let service: AdminAgentAgreementService;
  let container: Container;

  beforeAll(async () => {
    fixture = await financePostgres([agreement, systemLog]);
    await fixture.exec('CREATE UNIQUE INDEX agreement_type ON agreement(type)');
    container = { db: fixture.db } as Container;
    service = new AdminAgentAgreementService(container);
    await fixture.db.insert(agreement).values({ type: 1, title: '会员协议',
      content: '<p>会员原文</p>', status: 1, sort: 8, addTime: 1_700_000_000 });
  });
  afterAll(async () => { await fixture?.close(); });

  it('creates only type=2, sanitizes dangerous HTML and preserves member agreement', async () => {
    expect(await service.read()).toEqual([]);
    const created = await service.save(0,
      input('<p onclick="evil()">推广说明<img src="javascript:evil()" onerror="evil()"></p><script>alert(1)</script>',
        1, 'absent'), actor);
    expect(created).toMatchObject({ type: 2, title: '分销说明', status: 1 });
    expect(created.id).toBeGreaterThan(0);
    expect(created.revision).toMatch(/^[0-9]+$/);
    expect(created.content).toContain('推广说明');
    expect(created.content).not.toMatch(/<script|onclick|onerror|javascript:/i);
    const [member] = await fixture.db.select().from(agreement).where(eq(agreement.type, 1));
    expect(member).toMatchObject({ id: 1, content: '<p>会员原文</p>', status: 1, sort: 8 });
    const [saved] = await fixture.db.select().from(agreement).where(eq(agreement.type, 2));
    expect(saved.content).toBe(created.content);
    const logs = await fixture.db.select().from(systemLog);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ adminId: actor.id, type: 'agent_agreement', page: '/agent/agreement' });
    expect(logs[0].action).not.toContain('推广说明');
  });

  it('enforces compare-and-swap and cannot overwrite member content through a forged id', async () => {
    const first = await service.read();
    expect(Array.isArray(first)).toBe(false);
    if (Array.isArray(first)) throw new Error('missing agreement fixture');
    await expect(service.save(1, input('<p>伪造会员写入</p>', 0, first.revision), actor)).rejects.toMatchObject({ code: 409 });
    await expect(service.save(0, input('<p>重复创建</p>', 0, 'absent'), actor)).rejects.toMatchObject({ code: 409 });
    const updated = await service.save(first.id, input('<h2>修订后说明</h2>', 0, first.revision), actor);
    expect(updated).toMatchObject({ type: 2, status: 0, content: '<h2>修订后说明</h2>', sort: first.sort });
    expect(updated.revision).not.toBe(first.revision);
    await expect(service.save(first.id, input('<p>旧窗口覆盖</p>', 1, first.revision), actor)).rejects.toMatchObject({ code: 409 });
    const [member] = await fixture.db.select().from(agreement).where(eq(agreement.type, 1));
    expect(member.content).toBe('<p>会员原文</p>');
    expect((await service.read())).toMatchObject({ content: '<h2>修订后说明</h2>', status: 0 });
    expect(await fixture.db.select().from(systemLog)).toHaveLength(2);
  });

  it('rejects unknown fields, missing revision, invalid status and oversized HTML without writes', async () => {
    const current = await service.read();
    if (Array.isArray(current)) throw new Error('missing agreement fixture');
    const invalid = [
      { ...input('<p>错类型</p>', 1, current.revision), type: 1 },
      { content: '<p>无版本</p>', status: 1 },
      input('<p>状态错</p>', 2 as 1, current.revision),
      input('<p>' + '字'.repeat(200_001) + '</p>', 1, current.revision),
    ];
    for (const value of invalid) {
      await expect(service.save(current.id, value, actor)).rejects.toMatchObject({ code: 400 });
    }
    expect((await service.read())).toMatchObject({ content: current.content, status: current.status });
    expect(await fixture.db.select().from(systemLog)).toHaveLength(2);
  });

  it('projects imported unsafe HTML safely without rewriting the authoritative row', async () => {
    await fixture.db.update(agreement).set({ content: '<p onmouseover="evil()">旧正文</p><iframe src="https://evil.invalid"></iframe>' })
      .where(eq(agreement.type, 2));
    const projected = await service.read();
    if (Array.isArray(projected)) throw new Error('missing agreement fixture');
    expect(projected.content).toContain('旧正文');
    expect(projected.content).not.toMatch(/onmouseover|iframe|evil\.invalid/i);
    const [stored] = await fixture.db.select().from(agreement).where(eq(agreement.type, 2));
    expect(stored.content).toContain('onmouseover');
  });

  it('serves the legacy Admin path shape with no-store and returns a fresh revision after save', async () => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('container', container);
      c.set('adminInfo', { id: actor.id, account: actor.name, realName: actor.name,
        level: 1, roles: '', divisionId: 0 });
      await next();
    });
    app.get('/agent/get_agent_agreement', getAgentAgreement);
    app.post('/agent/set_agent_agreement/:id', setAgentAgreement);
    const read = await app.request('http://localhost/agent/get_agent_agreement');
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toContain('no-store');
    const body = await read.json() as { status: number; data: { id: number; revision: string } };
    expect(body.status).toBe(200);
    const save = await app.request(`http://localhost/agent/set_agent_agreement/${body.data.id}`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input('<p>HTTP 更新</p>', 1, body.data.revision)) });
    expect(save.status).toBe(200);
    expect(save.headers.get('cache-control')).toContain('no-store');
    const saved = await save.json() as { status: number; data: { content: string; revision: string } };
    expect(saved.status).toBe(200);
    expect(saved.data.content).toBe('<p>HTTP 更新</p>');
    expect(saved.data.revision).not.toBe(body.data.revision);
  });
});
