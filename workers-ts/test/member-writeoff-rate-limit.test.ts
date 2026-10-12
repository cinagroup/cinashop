import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { Hono } from 'hono';
import { memberWriteoffRateLimit } from '../src/middleware/member-writeoff-rate-limit';
import { errorHandler } from '../src/middleware/error';
import type { AppVariables, Env } from '../src/env';

function context(bucket?: { getByName: (name: string) => unknown }, key = 'test-member-writeoff-secret') {
  return {
    env: { APP_KEY: key, TOKEN_BUCKET: bucket },
    get: (name: string) => name === 'uid' ? 101 : undefined,
    header: vi.fn(),
  } as never;
}

describe('member writeoff rate limit', () => {
  it('atomically shares one authenticated operator read budget across both roles and read routes', async () => {
    const usage = new Map<string, number>();
    const names: string[] = [];
    const consumeRateLimit = vi.fn(async (policies: Array<{ key: string; limit: number }>) => {
      if (policies.some(({ key, limit }) => (usage.get(key) ?? 0) >= limit)) {
        return { allowed: false, resetAt: Date.now() + 60_000 };
      }
      policies.forEach(({ key }) => usage.set(key, (usage.get(key) ?? 0) + 1));
      return { allowed: true, resetAt: Date.now() + 60_000 };
    });
    const bucket = { getByName: vi.fn((name: string) => { names.push(name); return { consumeRateLimit }; }) };
    const next = vi.fn(async () => undefined);
    for (let index = 0; index < 30; index += 1) {
      const role = index % 2 ? 'delivery' : 'staff';
      const action = index % 2 ? 'info' : 'lookup';
      // A successful and an unsuccessful member code must both consume the same budget.
      await memberWriteoffRateLimit(role, action)(context(bucket), next);
    }
    await expect(memberWriteoffRateLimit('staff', 'info')(context(bucket), next))
      .rejects.toMatchObject({ name: 'RateLimitException' });
    expect(next).toHaveBeenCalledTimes(30);
    expect(usage.get('all-reads')).toBe(30);
    expect(new Set(names).size).toBe(1);
    expect(names[0]).toMatch(/^member-writeoff:[0-9a-f]{32}$/);
    expect(names[0]).not.toContain('101');
  });

  it('limits executions separately and fails closed before the controller on missing or broken binding', async () => {
    const next = vi.fn(async () => undefined);
    const middleware = memberWriteoffRateLimit('staff', 'execute');
    const missing = context() as { header: ReturnType<typeof vi.fn> };
    await expect(middleware(missing as never, next)).rejects.toMatchObject({ name: 'ServiceUnavailableException' });
    expect(missing.header).toHaveBeenCalledWith('Cache-Control', 'private, no-store, max-age=0');
    expect(missing.header).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
    const bad = { getByName: () => ({ consumeRateLimit: async () => { throw new Error('DO unavailable'); } }) };
    await expect(middleware(context(bad), next)).rejects.toMatchObject({ name: 'ServiceUnavailableException' });
    await expect(middleware(context({ getByName: () => ({ consumeRateLimit: async () => ({}) }) }), next))
      .rejects.toMatchObject({ name: 'ServiceUnavailableException' });
    await expect(middleware(context({ getByName: () => ({ consumeRateLimit: async () => ({ allowed: true, resetAt: Date.now() }) }) }, ''), next))
      .rejects.toMatchObject({ name: 'ServiceUnavailableException' });
    expect(next).not.toHaveBeenCalled();
  });

  it('places authentication and the atomic budget before every member-code database handler', () => {
    const routes = readFileSync(new NodeURL('../src/routes/v1/index.ts', import.meta.url), 'utf8');
    for (const [role, prefix] of [['staff', 'store'], ['delivery', 'delivery']] as const) {
      for (const [action, handler] of [['lookup', 'Lookup'], ['info', 'Info'], ['execute', 'Execute']] as const) {
        const tail = action === 'execute' ? 'member_writeoff' : `member_${action}`;
        const route = routes.match(new RegExp(`v1Routes\\.post\\(\\s*"/${prefix}/order/${tail}",[\\s\\S]*?\\);`))?.[0];
        expect(route, `${role}:${action} route`).toBeDefined();
        expect(route).toMatch(new RegExp(`authMiddleware\\(\\{ force: true \\}\\),\\s*memberWriteoffRateLimit\\("${role}", "${action}"\\),\\s*StoreOrderWriteoff\\.${role}Member${handler}`));
      }
    }
  });

  it('returns private errors and never enters the database handler after a denied budget', async () => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    const database = vi.fn(() => new Response('private order'));
    app.onError(errorHandler);
    app.post('/member', async (c, next) => { c.set('uid', 101); await next(); },
      memberWriteoffRateLimit('staff', 'lookup'), database);
    const tokenBucket = { getByName: () => ({ consumeRateLimit: async () =>
      ({ allowed: false, resetAt: Date.now() + 60_000 }) }) };
    const response = await app.request('http://localhost/member', { method: 'POST' },
      { APP_KEY: 'test-secret', TOKEN_BUCKET: tokenBucket } as never);
    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toMatch(/private, no-store/);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const unavailable = await app.request('http://localhost/member', { method: 'POST' },
      { APP_KEY: 'test-secret' } as never);
    expect(unavailable.headers.get('cache-control')).toMatch(/private, no-store/);
    expect(unavailable.headers.get('referrer-policy')).toBe('no-referrer');
    expect(database).not.toHaveBeenCalled();
  });
});
