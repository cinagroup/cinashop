import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDbFromConnectionString } from '../src/lib/di';

vi.mock('@/lib/di', () => ({ createDbFromConnectionString: vi.fn(() => {
  throw new Error('database connection must remain unopened in boundary tests');
}) }));
afterEach(() => {
  expect(createDbFromConnectionString).not.toHaveBeenCalled();
  vi.clearAllMocks();
});
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
      worker.fetch(new Request(`${url}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }), bindings);
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
    const mismatch = await request('/apply', 'POST', { 'X-Audit-Token': token,
      'X-Migration-Operation': NEWCOMER_CART_REPLAY_MAINTENANCE_OPERATION });
    expect(mismatch.status).toBe(503);
    expect(await mismatch.json()).toMatchObject({ error: 'reviewed installation SQL digest mismatch' });
    expect(mismatch.headers.get('Cache-Control')).toBe('no-store');
  });
});


describe('FE-003D actual empty POST stream boundary', () => {
  const headers = {
    'X-Audit-Token': token,
    'X-Migration-Operation': NEWCOMER_CART_REPLAY_MAINTENANCE_OPERATION,
    'X-Preflight-SHA256': 'e'.repeat(64),
  };
  async function applyBody(body?: string | ReadableStream<Uint8Array>, signal?: AbortSignal) {
    const bindings = await env();
    bindings.APPLY_ARMED = 'true';
    bindings.APPROVED_PREFLIGHT_SHA256 = 'e'.repeat(64);
    const init = { method: 'POST', headers, signal,
      ...(body !== undefined ? { body, duplex: 'half' } : {}) } as RequestInit & { duplex?: 'half' };
    return worker.fetch(new Request(`${url}/apply`, init), bindings);
  }
  async function acceptedBeforeDb(body?: string | ReadableStream<Uint8Array>) {
    const response = await applyBody(body);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'reviewed installation SQL digest mismatch' });
  }
  async function rejectedBeforeDb(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
    const response = await applyBody(body, signal);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'explicit operation and empty body required' });
  }
  it('accepts omitted body, explicit empty string, EOF stream and zero-byte chunks followed by EOF', async () => {
    await acceptedBeforeDb();
    await acceptedBeforeDb('');
    await acceptedBeforeDb(new ReadableStream({ start(controller) { controller.close(); } }));
    await acceptedBeforeDb(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array()); controller.enqueue(new Uint8Array()); controller.close();
    } }));
  });
  it('rejects the first non-empty chunk and cancels remaining content', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel: cancelled,
    });
    await rejectedBeforeDb(body);
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it('continues past empty chunks and rejects later non-empty content', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array()); controller.enqueue(new Uint8Array());
      controller.enqueue(new Uint8Array([1, 2]));
    }, cancel: cancelled });
    await rejectedBeforeDb(body);
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it('bounds a stream that keeps emitting empty chunks without EOF', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array()); }, cancel: cancelled,
    }, { highWaterMark: 0 });
    await rejectedBeforeDb(body);
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it('times out and cancels a stream that stays open without bytes', async () => {
    const cancelled = vi.fn();
    await rejectedBeforeDb(new ReadableStream<Uint8Array>({ cancel: cancelled }));
    expect(cancelled).toHaveBeenCalledOnce();
  }, 2_000);
  it('rejects an aborted body before any database connection', async () => {
    const abort = new AbortController(); abort.abort();
    await rejectedBeforeDb(new ReadableStream<Uint8Array>(), abort.signal);
  });
  it('rejects an abort during a pending read and cancels it', async () => {
    const abort = new AbortController(), cancelled = vi.fn();
    const pending = rejectedBeforeDb(new ReadableStream<Uint8Array>({ cancel: cancelled }), abort.signal);
    const timer = setTimeout(() => abort.abort(), 20);
    try { await pending; } finally { clearTimeout(timer); }
    expect(cancelled).toHaveBeenCalledOnce();
  }, 2_000);
  it('rejects an errored stream without exposing its error or opening the DB', async () => {
    await rejectedBeforeDb(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('private stream sentinel')); },
    }));
  });
  it('does not await or expose a failed cancellation', async () => {
    const cancelled = vi.fn(() => Promise.reject(new Error('private cancellation sentinel')));
    await rejectedBeforeDb(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel: cancelled,
    }));
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it('preserves unarmed, authority and explicit-operation guards before a body read', async () => {
    const bindings = await env(), read = vi.fn();
    const body = () => new ReadableStream<Uint8Array>({ pull: read }, { highWaterMark: 0 });
    const request = (custom: Record<string, string>) => new Request(`${url}/apply`, {
      method: 'POST', headers: custom, body: body(), duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect((await worker.fetch(request(headers), bindings)).status).toBe(403);
    bindings.APPLY_ARMED = 'true'; bindings.APPROVED_PREFLIGHT_SHA256 = 'e'.repeat(64);
    expect((await worker.fetch(request({}), bindings)).status).toBe(403);
    expect((await worker.fetch(request({ 'X-Audit-Token': token }), bindings)).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
});
