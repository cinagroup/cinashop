import { describe, expect, it } from 'vitest';
import worker, { approvedNewcomerReplayApply,
  type NewcomerCartReplayMaintenanceEnv } from './integration/NewcomerCartReplayMaintenanceWorker';
import { NEWCOMER_CART_REPLAY_MAINTENANCE_OPERATION } from '../src/migrations/newcomerCartAddReplayMaintenance';

const url = 'https://temporary.example.workers.dev';
const token = 'a'.repeat(64);

async function env(): Promise<NewcomerCartReplayMaintenanceEnv> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return {
    HYPERDRIVE_MAINTENANCE: { connectionString: 'never-opened' },
    HYPERDRIVE: { connectionString: 'never-opened' },
    HYPERDRIVE_ADMIN: { connectionString: 'never-opened' },
    AUDIT_TOKEN_SHA256: Array.from(digest, b => b.toString(16).padStart(2, '0')).join(''),
    AUDIT_EXPIRES_AT: String(Date.now() + 600_000),
    SOURCE_SHA: 'b'.repeat(40),
    EXPECTED_INSTALL_SQL_SHA256: 'c'.repeat(64),
    RUN_MARKER: 'd'.repeat(64),
    APPLY_ARMED: 'false',
    APPROVED_PREFLIGHT_SHA256: '0'.repeat(64),
  };
}

describe('FE-003D temporary maintenance HTTP boundary', () => {
  it('requires armed mode and two matching independent approval fingerprints', () => {
    const digest = 'f'.repeat(64);
    expect(approvedNewcomerReplayApply('false', digest, digest, digest)).toBe(false);
    expect(approvedNewcomerReplayApply('true', '0'.repeat(64), '0'.repeat(64), '0'.repeat(64)))
      .toBe(false);
    expect(approvedNewcomerReplayApply('true', digest, null, digest)).toBe(false);
    expect(approvedNewcomerReplayApply('true', digest, 'e'.repeat(64), digest)).toBe(false);
    expect(approvedNewcomerReplayApply('true', digest, digest, 'e'.repeat(64))).toBe(false);
    expect(approvedNewcomerReplayApply('true', digest, digest, digest)).toBe(true);
  });

  it('rejects missing authority, wrong method, query, body and SQL digest before any DB connection', async () => {
    const bindings = await env();
    const request = (path: string, method = 'GET', headers: Record<string, string> = {}, body?: string) =>
      worker.fetch(new Request(`${url}${path}`, { method, headers,
        ...(body !== undefined ? { body } : {}) }), bindings);
    expect((await request('/preflight')).status).toBe(403);
    expect((await request('/apply', 'GET', { 'X-Audit-Token': token })).status).toBe(405);
    expect((await request('/preflight?sql=none', 'GET', { 'X-Audit-Token': token })).status).toBe(404);
    expect((await request('/apply', 'POST', { 'X-Audit-Token': token })).status).toBe(403);
    expect((await request('/apply', 'POST', { 'X-Audit-Token': token,
      'X-Migration-Operation': NEWCOMER_CART_REPLAY_MAINTENANCE_OPERATION }, '{}')).status).toBe(403);
    bindings.APPLY_ARMED = 'true';
    bindings.APPROVED_PREFLIGHT_SHA256 = 'e'.repeat(64);
    expect((await request('/apply', 'POST', { 'X-Audit-Token': token })).status).toBe(400);
    expect((await request('/apply', 'POST', { 'X-Audit-Token': token,
      'X-Migration-Operation': NEWCOMER_CART_REPLAY_MAINTENANCE_OPERATION }, '{}')).status).toBe(400);
    const operationHeaders = { 'X-Audit-Token': token,
      'X-Migration-Operation': NEWCOMER_CART_REPLAY_MAINTENANCE_OPERATION,
      'X-Preflight-SHA256': bindings.APPROVED_PREFLIGHT_SHA256 };
    expect((await request('/apply', 'POST', { ...operationHeaders,
      'X-Migration-Operation': 'other' })).status).toBe(400);
    expect((await request('/apply', 'POST', operationHeaders, '')).status).toBe(400);
    expect((await request('/apply', 'POST', { ...operationHeaders,
      'Content-Length': '1' }, '')).status).toBe(400);
    expect((await request('/apply', 'POST', { ...operationHeaders,
      'Content-Length': '0', 'Transfer-Encoding': 'chunked' }, '')).status).toBe(400);
    expect((await request('/apply', 'POST', { ...operationHeaders,
      'Content-Length': '0' }, '{}')).status).toBe(400);
    const zeroByteStream = new Request(`${url}/apply`, { method: 'POST',
      headers: { ...operationHeaders, 'Content-Length': '0' }, body: '' });
    expect(zeroByteStream.body).not.toBeNull();
    const emptyStreamReply = await worker.fetch(zeroByteStream, bindings);
    expect(emptyStreamReply.status).toBe(503);
    expect(await emptyStreamReply.json()).toMatchObject({
      error: 'reviewed installation SQL digest mismatch',
    });
    const mismatch = await request('/apply', 'POST', { 'X-Audit-Token': token,
      'X-Migration-Operation': NEWCOMER_CART_REPLAY_MAINTENANCE_OPERATION });
    expect(mismatch.status).toBe(503);
    expect(await mismatch.json()).toMatchObject({ error: 'reviewed installation SQL digest mismatch' });
    expect(mismatch.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects locked and stalled body streams before any DB connection', async () => {
    const bindings = await env();
    bindings.APPLY_ARMED = 'true';
    bindings.APPROVED_PREFLIGHT_SHA256 = 'e'.repeat(64);
    const headers = { 'X-Audit-Token': token,
      'X-Migration-Operation': NEWCOMER_CART_REPLAY_MAINTENANCE_OPERATION,
      'X-Preflight-SHA256': bindings.APPROVED_PREFLIGHT_SHA256,
      'Content-Length': '0' };
    const locked = new Request(`${url}/apply`, { method: 'POST', headers, body: '' });
    const reader = locked.body!.getReader();
    try { expect((await worker.fetch(locked, bindings)).status).toBe(400); }
    finally { reader.releaseLock(); }

    const stalled = new Request(`${url}/apply`, { method: 'POST', headers,
      body: new ReadableStream<Uint8Array>(), duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect((await worker.fetch(stalled, bindings)).status).toBe(400);
  }, 10_000);
});
