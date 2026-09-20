import { timingSafeEqual } from 'node:crypto';
import type { TestImageMaintenanceEnv } from './test-product-image-maintenance.env';
import { ImageMaintenanceConflict, maintainTestImages } from '../../scripts/test-product-image-maintenance';

export default {
  async fetch(request: Request, env: TestImageMaintenanceEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    const respond = (body: object, status: number) => Response.json(body, { status,
      headers: { 'Cache-Control': 'no-store' } });
    if (request.method !== 'POST' || !['/inspect', '/apply'].includes(path)) return respond({ error: 'Not found' }, 404);
    const expires = Number(env.EXPIRES_AT);
    if (!Number.isFinite(expires) || Date.now() >= expires) return respond({ error: 'Expired' }, 410);
    const token = request.headers.get('X-Audit-Token') ?? '';
    if (!/^[a-f0-9]{64}$/.test(env.AUDIT_TOKEN_SHA256) || token.length > 128) return respond({ error: 'Forbidden' }, 403);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
    if (!timingSafeEqual(hash, Buffer.from(env.AUDIT_TOKEN_SHA256, 'hex'))) return respond({ error: 'Forbidden' }, 403);
    const expected = request.headers.get('X-Expected-Fingerprint') ?? '';
    if (path === '/apply' && !/^[a-f0-9]{64}$/.test(expected)) return respond({ error: 'Precondition required' }, 412);
    try {
      const result = await maintainTestImages(env.HYPERDRIVE.connectionString, path === '/apply' ? expected : undefined);
      console.log(JSON.stringify({ operation: 'fixed-test-product-images', mode: result.mode }));
      return respond(result, 200);
    } catch (error) {
      const conflict = error instanceof ImageMaintenanceConflict;
      console.error(JSON.stringify({ operation: 'fixed-test-product-images', conflict }));
      return respond({ error: conflict ? 'Precondition failed; rolled back' : 'Maintenance failed' }, conflict ? 409 : 500);
    }
  },
} satisfies ExportedHandler<TestImageMaintenanceEnv>;
