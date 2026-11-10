import { resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse, type V4FetchHandler } from 'miniflare';

const operations = [
  'share-json', 'share-image', 'menu-create', 'menu-read', 'geocode', 'robot',
  'enterprise-read', 'enterprise-create', 'enterprise-welcome',
  'waybill-catalog', 'waybill-template', 'waybill-issue',
  'app-json-reader', 'follow-image-reader', 'notification-post-reader',
] as const;
type Operation = typeof operations[number];
const twoHop = new Set<Operation>(['menu-create', 'menu-read', 'enterprise-read', 'enterprise-create', 'enterprise-welcome', 'waybill-catalog', 'waybill-template', 'waybill-issue']);
const statuses = [300, 301, 302, 303, 304, 305, 306, 307, 308, 399];
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
type Reply = { ok: boolean; modes: string[]; result?: unknown; failure?: { name: string; message: string; kind?: string; code?: number; retryable?: boolean } };
type Call = { origin: string; path: string; method: string; body: string };

describe('actual workerd provider transport, with every external request intercepted locally', () => {
  let mf: Miniflare;
  let operation: Operation | 'unsupported-error-probe' = 'share-json';
  let mode: 'ok' | 'redirect' = 'ok', redirectStatus = 302, stage: 'first' | 'last' = 'last';
  const calls: Call[] = [];
  const gateway: V4FetchHandler = async request => {
    const url = new URL(request.url);
    // Record even a forbidden destination before refusing it, so an attempted
    // follow cannot hide behind the gateway's local network prohibition.
    const call = { origin: url.origin, path: url.pathname, method: request.method, body: await request.text() };
    calls.push(call);
    if (!['https://api.weixin.qq.com', 'https://qyapi.weixin.qq.com', 'https://apis.map.qq.com', 'https://sms.crmeb.net', 'https://media.example.com'].includes(url.origin)) {
      throw Error('No external target or redirect destination is allowed');
    }
    const token = ['/cgi-bin/token', '/cgi-bin/gettoken', '/api/v2/user/login'].includes(url.pathname);
    if (mode === 'redirect' && (stage === 'first' ? calls.length === 1 : !token)) {
      // A tempting valid/invalid-token body cannot authorize a new POST, cache
      // entry or response. 304 has no body by the Fetch response contract.
      return new LocalResponse(redirectStatus === 304 ? null : JSON.stringify({ errcode: 40014, access_token: 'redirect-token-must-not-be-used', expires_in: 7200,
        status: 200, data: { access_token: 'redirect-token-must-not-be-used', kuaidinum: 'FORGED-SUCCESS' }, menu: { button: [] } }),
      { status: redirectStatus, headers: { location: 'https://redirect-destination.invalid/blocked', 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/v2/user/login') return LocalResponse.json({ status: 200, data: { access_token: 'inert-local-onepass-token' } });
    if (token) return LocalResponse.json({ errcode: 0, access_token: 'inert-local-token', expires_in: 7200 });
    if (operation === 'share-json') return LocalResponse.json({ local: true });
    if (operation === 'share-image' || operation === 'follow-image-reader') return new LocalResponse(png, { headers: { 'content-type': 'image/png' } });
    if (operation === 'menu-read') return LocalResponse.json({ menu: { button: [{ type: 'click', name: 'local menu', key: 'local-key' }] } });
    if (operation === 'geocode') return LocalResponse.json({ status: 0, result: { address: 'local address' } });
    if (operation === 'enterprise-read') return LocalResponse.json({ errcode: 0, userid: 'local-member' });
    if (operation === 'enterprise-create') return LocalResponse.json({ errcode: 0, tag_group: { group_id: 'local-group-id', group_name: 'local-group', order: 1, create_time: 1,
      tag: [{ id: 'local-tag-id', name: 'local-tag', order: 1, create_time: 1 }] } });
    if (operation === 'waybill-catalog') return LocalResponse.json({ status: 200, data: { data: [{ code: 'SF', name: 'local carrier', partner_id: 0, partner_key: 0, net: 0, check_man: 0, partner_name: 0, is_code: 0 }] } });
    if (operation === 'waybill-template') return LocalResponse.json({ status: 200, data: [{ id: 'local-template' }] });
    if (operation === 'waybill-issue') return LocalResponse.json({ status: 200, data: { kuaidinum: 'LOCAL-TRACKING', task_id: 'local-task' } });
    if (operation === 'app-json-reader') return LocalResponse.json({ openid: 'local-transport-reader' });
    return LocalResponse.json({ errcode: 0 });
  };
  beforeAll(async () => {
    const bundle = await build({ entryPoints: [resolve(import.meta.dirname, 'integration/ProviderRedirectWorker.ts')], bundle: true, write: false,
      platform: 'browser', format: 'esm', target: 'es2022', conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*'],
      tsconfig: resolve(import.meta.dirname, '../tsconfig.json') });
    mf = new Miniflare(convertV4MiniflareOptions({ script: bundle.outputFiles[0].text, modules: true, compatibilityDate: '2026-08-09',
      compatibilityFlags: ['nodejs_compat'], host: '127.0.0.1', port: 0, kvNamespaces: ['CONFIG_KV'], outboundService: gateway }));
    await mf.ready;
  }, 180000);
  beforeEach(() => { calls.length = 0; mode = 'ok'; stage = 'last'; redirectStatus = 302; });
  afterAll(async () => { await mf?.dispose(); }, 30000);
  const run = async (name: typeof operation): Promise<Reply> => {
    operation = name;
    const response = await mf.dispatchFetch('http://localhost/' + name);
    expect(response.status).toBe(200);
    return response.json() as Promise<Reply>;
  };
  const refused = (name: Operation, reply: Reply) => {
    if (name === 'menu-create' && stage === 'last') expect(reply).toMatchObject({ ok: true, result: { outcome: 'unknown' } });
    else {
      expect(reply.ok, JSON.stringify(reply)).toBe(false); expect(reply.failure?.message).toBeTruthy();
      for (const sensitive of ['redirect-token-must-not-be-used', 'FORGED-SUCCESS', 'redirect-destination.invalid', 'inert-local']) expect(reply.failure?.message).not.toContain(sensitive);
      if (stage === 'last' && ['enterprise-create', 'enterprise-welcome'].includes(name)) expect(reply.failure?.kind).toBe('unknown');
      if (name === 'notification-post-reader') expect(reply.failure?.code).toBeUndefined();
    }
    expect(reply.modes).toEqual(calls.map(() => 'manual'));
  };

  it('reproduces redirect:error rejection before any outbound request in the pinned workerd', async () => {
    const reply = await run('unsupported-error-probe');
    expect(reply).toMatchObject({ ok: false, failure: { name: 'TypeError' } }); expect(calls).toHaveLength(0);
  });
  it.each(operations)('allows a genuine direct success in the %s production transport', async name => {
    const reply = await run(name); expect(reply.ok, JSON.stringify(reply)).toBe(true);
    if (name === 'menu-create') expect(reply.result).toEqual({ outcome: 'accepted' });
    if (name === 'waybill-issue') expect(reply.result).toMatchObject({ trackingNumber: 'LOCAL-TRACKING' });
    expect(calls).toHaveLength(twoHop.has(name) ? 2 : 1);
    expect(reply.modes).toEqual(calls.map(() => 'manual'));
    if (name === 'enterprise-welcome' || name === 'enterprise-create' || name === 'waybill-issue') expect(calls.at(-1)?.method).toBe('POST');
  });
  it.each(operations.flatMap(name => statuses.map(status => ({ name, status }))))('rejects HTTP $status in $name without following or refreshing a token', async ({ name, status }) => {
    mode = 'redirect'; redirectStatus = status;
    refused(name, await run(name)); expect(calls).toHaveLength(twoHop.has(name) ? 2 : 1);
  });
  it.each([...twoHop].flatMap(name => statuses.map(status => ({ name, status }))))('rejects token/auth HTTP $status before the $name operation', async ({ name, status }) => {
    mode = 'redirect'; stage = 'first'; redirectStatus = status;
    refused(name, await run(name)); expect(calls).toHaveLength(1);
  });
});
