import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { corsMiddleware } from '../src/middleware/cors';

const origin = 'https://admin.cinashop.test';
const env = { NODE_ENV: 'production', ALLOWED_ORIGINS: origin,
  WORK_WECHAT_ALLOWED_ORIGINS: 'https://work.cinashop.test' } as Env;
const confirmations = ['x-admin-operation-id', 'x-admin-revision', 'x-admin-expires-at', 'x-admin-confirmed'];
function app() {
  const application = new Hono<{ Bindings: Env }>();
  application.use('*', corsMiddleware);
  application.all('*', c => c.json({ ok: true }));
  return application;
}
describe('actual middleware preflight for legacy staff confirmation headers', () => {
  it.each(['/adminapi', '/api/admin'])('admits the fixed confirmation protocol on %s', async prefix => {
    for (const [method, path] of [['POST', '/setting/admin'], ['PUT', '/setting/admin/20'],
      ['PUT', '/setting/set_status/20/0'], ['DELETE', '/setting/admin/20']] as const) {
      const response = await app().request(`${prefix}${path}`, { method: 'OPTIONS', headers: {
        Origin: origin, 'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': ['content-type', 'authori-zation', ...confirmations].join(','),
      } }, env);
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
      expect(response.headers.get('access-control-allow-methods')?.split(',')).toContain(method);
      const admitted = response.headers.get('access-control-allow-headers')?.toLowerCase().split(',');
      for (const name of confirmations) expect(admitted).toContain(name);
      expect(admitted).not.toContain('*');
    }
  });
  it.each(['https://untrusted.test', 'https://work.cinashop.test', 'null', 'http://localhost:5173'])('does not admit %s to staff writes in production', async untrusted => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      const response = await app().request(`${prefix}/setting/admin/20`, { method: 'OPTIONS', headers: {
        Origin: untrusted, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': confirmations.join(','),
      } }, env);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
  });
});
