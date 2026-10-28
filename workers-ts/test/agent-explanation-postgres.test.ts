import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb, type Container } from '@/lib/di';
import { agreement, systemAttachment } from '@/models/schema';
import { AgentExplanationReadService } from '@/services/user/AgentExplanationReadService';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

// Substitute connection wiring only. The public router, controller, SQL,
// sanitizer, metadata policy and generic signed-asset GET are the real code.
const wiring = vi.hoisted(() => ({ context: undefined as AsyncLocalStorage<Container> | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { const container = wiring.context?.getStore();
    if (!container) throw Error('Owned explanation application LOGIN required'); return container; },
}));
type Row = Record<string, unknown>;
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<Fixture['withRuntimeRole']>>[0] extends (peer: infer T) => unknown ? T : never;
type ObjectValue = { bytes: Uint8Array; type: string };
const origin = 'https://owned-explanation.test', path = '/api/agent/explanation';
const memberId = 630010, explanationId = 630020, imageId = 630101, videoId = 630102;
const imageKey = 'attachments/admin/1/2026/10/63000000-0000-4000-8000-000000000001.png';
const videoKey = 'attachments/admin/1/2026/10/63000000-0000-4000-8000-000000000002.mp4';
const imageRef = '/api/assets/' + imageId, videoRef = '/api/assets/' + videoId;
const content = `<h2 style="color:#966a32;font-size:20px;line-height:1.7">PHP分销说明原文</h2>`
  + `<p onclick="window.__explanationUnsafe=1">推广说明完整正文</p><img src="${imageRef}" alt="平台说明图">`
  + `<video src="${videoRef}" controls></video><script>window.__explanationUnsafe=2</script>`;
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const slots = (html: string, tag: 'img' | 'video') => [...html.matchAll(new RegExp('<' + tag + '\\b[^>]*\\bsrc="([^"]*)"', 'gu'))].map(match => match[1]!);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('public PHP agent explanation real PG16 complete readonly projection', () => {
  let f: Fixture, env: Env, tables: string[], sequences: string[], png: Uint8Array, mp4: Uint8Array, expectedAssetReads = 0;
  const app = createApp(), objects = new Map<string, ObjectValue>();
  const io = { assetGet: vi.fn(), assetPut: vi.fn(), assetDelete: vi.fn(), assetHead: vi.fn(), assetList: vi.fn(),
    kvGet: vi.fn(), kvPut: vi.fn(), kvDelete: vi.fn(), kvList: vi.fn(), queue: vi.fn(), namespace: vi.fn(), images: vi.fn() };
  const resources = () => Object.fromEntries(Object.entries(io).map(([key, fn]) => [key, fn.mock.calls.length]));

  beforeAll(async () => {
    f = await refundRuntimeFixture(); wiring.context = new AsyncLocalStorage<Container>();
    png = new Uint8Array(await readFile(resolve(import.meta.dirname, 'fixtures/community-teal.png')));
    mp4 = new Uint8Array(await readFile(resolve(import.meta.dirname, 'fixtures/community-video.mp4')));
    tables = (await f.exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(row => String(row.name));
    sequences = (await f.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(row => String(row.name));
    expect(tables).toHaveLength(283); expect(sequences).toHaveLength(229);
    for (const name of [...tables, ...sequences]) expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
    // Keep the actual registered unique index. Legacy duplicate ordering is
    // covered by the query unit test, never by altering the native schema.
    expect(await f.exec("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='agreement' AND indexname='agreement_type'"))
      .toEqual([{ indexname: 'agreement_type' }]);
    const namespace = { idFromName: io.namespace, idFromString: io.namespace, newUniqueId: io.namespace, get: io.namespace };
    env = { ...f.env, APP_KEY: crypto.randomUUID() + crypto.randomUUID(),
      CONFIG_KV: { get: io.kvGet, put: io.kvPut, delete: io.kvDelete, list: io.kvList },
      ASSETS_BUCKET: { get: io.assetGet, put: io.assetPut, delete: io.assetDelete, head: io.assetHead, list: io.assetList },
      ORDER_QUEUE: { send: io.queue, sendBatch: io.queue }, TOKEN_BUCKET: namespace, SEQUENCE: namespace,
      ORDER_LOCK: namespace, CHAT_ROOM: namespace, STAFF_NOTICE: namespace, IMAGES: { input: io.images },
    } as unknown as Env;
  }, 60000);
  beforeEach(async () => {
    await f.db.delete(agreement);
    await f.db.insert(agreement).values([
      { id: memberId, type: 1, title: 'MEMBER_PRIVATE_TITLE', content: '<p onclick="legacy()">MEMBER_RAW</p>', status: 1, sort: 2147483647 },
      { id: explanationId, type: 2, title: 'TITLE_NOT_IN_PUBLIC_DTO', content, status: 0, sort: -20, addTime: 123 },
    ]);
    await f.db.delete(systemAttachment).where(sql`${systemAttachment.attId} BETWEEN 630101 AND 630199`);
    await f.db.insert(systemAttachment).values([
      { attId: imageId, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: imageKey,
        attDir: imageRef, sattDir: imageRef, attType: 'image/png', attSize: String(png.byteLength) },
      { attId: videoId, type: 1, relationId: 0, moduleType: 1, fileType: 2, imageType: 8, name: videoKey,
        attDir: videoRef, sattDir: videoRef, attType: 'video/mp4', attSize: String(mp4.byteLength) },
      { attId: 630103, type: 3, relationId: 11, moduleType: 3, fileType: 1, imageType: 8,
        name: 'attachments/user/11/explanation.png', attDir: '/api/assets/630103', attType: 'image/png' },
      { attId: 630104, type: 2, relationId: 7, moduleType: 1, fileType: 1, imageType: 8,
        name: 'attachments/supplier/7/explanation.png', attDir: '/api/assets/630104', attType: 'image/png' },
    ]);
    objects.clear(); objects.set(imageKey, { bytes: new Uint8Array(png), type: 'image/png' });
    objects.set(videoKey, { bytes: new Uint8Array(mp4), type: 'video/mp4' });
    for (const fn of Object.values(io)) fn.mockReset().mockImplementation(() => { throw Error('Explanation resource access forbidden'); });
    io.assetGet.mockImplementation(async (key: string, options: unknown) => {
      expect(options).toBeUndefined(); const object = objects.get(key); if (!object) return null;
      const etag = createHash('sha256').update(object.bytes).digest('hex');
      return { size: object.bytes.byteLength, etag, httpEtag: '"' + etag + '"',
        body: new Response(new Uint8Array(object.bytes)).body, httpMetadata: { contentType: object.type },
        writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', object.type) };
    });
    expectedAssetReads = 0;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Explanation native forbids external network'));
  });
  afterEach(() => {
    try { for (const [name, fn] of Object.entries(io)) expect(fn).toHaveBeenCalledTimes(name === 'assetGet' ? expectedAssetReads : 0);
      expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); }
  });
  afterAll(async () => { wiring.context = undefined; await f?.close(); }, 30000);

  async function snapshot() {
    const state: Record<string, unknown> = {};
    for (const row of await f.db.execute<{ name: string; rows: Row[] }>(sql.join(tables.map(name => sql`SELECT ${name}::text AS name,
      coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `)))
      state[row.name] = row.rows.map(stable).sort();
    state.__sequences = Array.from(await f.db.execute(sql.join(sequences.map(name => sql`SELECT ${name}::text AS name,
      last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `))).map(stable).sort();
    return state;
  }
  async function readonly<T>(work: () => Promise<T>, assetReads = 0) {
    const before = await snapshot(), external = resources(); expectedAssetReads += assetReads;
    try { return await work(); }
    finally { expect(await snapshot()).toEqual(before);
      expect(resources()).toEqual({ ...external, assetGet: external.assetGet + assetReads }); }
  }
  async function reader<T>(work: (peer: Peer) => Promise<T>) {
    return f.withRuntimeRole!(async peer => {
      expect(peer.role).toMatch(/^cinashop_runtime_[a-f0-9]{32}$/);
      await f.exec(`GRANT SELECT ON public.agreement,public.system_attachment TO "${peer.role}"`);
      const [identity] = await peer.exec('SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid');
      expect(identity).toEqual({ role: peer.role, session: peer.role, pid: peer.pid });
      const [authority] = await peer.exec("SELECT count(*)::integer AS count FROM information_schema.role_table_grants WHERE grantee=current_user AND privilege_type<>'SELECT'");
      expect(authority.count).toBe(0);
      const sequenceGrants = await peer.db.execute<{ name: string; allowed: boolean }>(sql`SELECT sequencename AS name,
        has_sequence_privilege(current_user,format('%I.%I',schemaname,sequencename),'USAGE,SELECT,UPDATE') AS allowed
        FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`);
      expect(sequenceGrants).toHaveLength(229); expect(sequenceGrants.every(row => row.allowed === false)).toBe(true);
      return work(peer);
    });
  }
  async function request(peer: Peer, suffix = path, init?: RequestInit) {
    const started = Date.now(), response = await wiring.context!.run(createContainerFromDb(peer.db), () => app.fetch(
      new Request(origin + suffix, init), env, { waitUntil: () => {}, passThroughOnException: () => {} } as never));
    return { response, dto: await response.json() as { status: number; msg: string; data: any }, started, completed: Date.now() };
  }
  function document(result: Awaited<ReturnType<typeof request>>, id = explanationId) {
    expect(result.response.status).toBe(200); expect(result.dto.status, result.dto.msg).toBe(200);
    expect(result.response.headers.get('cache-control')).toBe('private, no-store');
    expect(Object.keys(result.dto.data).sort()).toEqual(['member_explain', 'version']); expect(result.dto.data.version).toBe(1);
    const row = result.dto.data.member_explain;
    expect(Object.keys(row).sort()).toEqual(['content_preview', 'id', 'type']); expect(row.id).toBe(id); expect(row.type).toBe(2);
    expect(typeof row.content_preview).toBe('string'); return row as { id: number; type: 2; content_preview: string };
  }
  function ticket(value: string, result: Awaited<ReturnType<typeof request>>, reference: string) {
    const url = new URL(value.replaceAll('&amp;', '&'), origin);
    expect(url.origin).toBe(origin); expect(url.pathname).toBe(reference); expect(url.hash).toBe('');
    expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'signature']);
    const expires = url.searchParams.get('expires')!;
    expect(Number(expires)).toBeGreaterThanOrEqual(Math.floor(result.started / 1000) + 900);
    expect(Number(expires)).toBeLessThanOrEqual(Math.floor(result.completed / 1000) + 900);
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256', env.APP_KEY).update('GET\n' + reference + '\n' + expires).digest('base64url'));
    return url.pathname + url.search;
  }
  async function asset(peer: Peer, url: string) {
    return wiring.context!.run(createContainerFromDb(peer.db), () => app.fetch(new Request(origin + url), env,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never));
  }
  const setContent = (html: string | null) => f.db.update(agreement).set({ content: html }).where(eq(agreement.type, 2));

  it('publicly reads status0 with exact closed DTO, safe PHP typography and no login/config/R2/provider access', async () => reader(peer => readonly(async () => {
    const result = await request(peer), row = document(result);
    expect(row.content_preview).toContain('PHP分销说明原文'); expect(row.content_preview).toContain('推广说明完整正文');
    for (const style of ['color:#966a32', 'font-size:20px', 'line-height:1.7']) expect(row.content_preview).toContain(style);
    expect(row.content_preview).not.toMatch(/script|onclick|__explanationUnsafe|MEMBER_RAW|TITLE_NOT_IN_PUBLIC_DTO/u);
    expect(slots(row.content_preview, 'img')).toHaveLength(1); expect(slots(row.content_preview, 'video')).toHaveLength(1);
    ticket(slots(row.content_preview, 'img')[0]!, result, imageRef); ticket(slots(row.content_preview, 'video')[0]!, result, videoRef);
  })), 30000);

  it('does not require or consume an optional invalid customer token on this public route', async () => reader(peer => readonly(async () => {
    expect(document(await request(peer, path, { headers: { 'Authori-zation': 'Bearer invalid-public-token' } })).content_preview).toContain('PHP分销说明原文');
  })), 30000);

  it.each([0, -2147483648, 2147483647])('preserves persisted signed document id %s', async id => {
    await f.db.update(agreement).set({ id, status: -32768, content: '历史说明' }).where(eq(agreement.type, 2));
    await reader(peer => readonly(async () => { expect(document(await request(peer), id).content_preview).toBe('历史说明'); }));
  }, 30000);

  it('returns null only for missing type2, never falls back to type1 even with a higher sort', async () => {
    await f.db.delete(agreement).where(eq(agreement.type, 2));
    await reader(peer => readonly(async () => { const result = await request(peer);
      expect(result.dto).toEqual({ status: 200, msg: 'ok', data: { version: 1, member_explain: null } }); }));
  }, 30000);

  it.each([null, ''] as const)('keeps a configured empty document %s distinct from missing', async value => {
    await setContent(value); await reader(peer => readonly(async () => {
      expect(document(await request(peer))).toEqual({ id: explanationId, type: 2, content_preview: '' });
    }));
  }, 30000);

  it('preserves the old agreement1 raw record and agreement2 disabled envelope without adding new fields', async () => {
    await setContent('<p>LEGACY_TYPE2_STATUS0</p>');
    await reader(peer => readonly(async () => {
      const member = await request(peer, '/api/agreement/1'), agent = await request(peer, '/api/agreement/2');
      expect(member.dto).toEqual({ status: 200, msg: 'ok', data: { member_explain: { id: memberId, type: 1,
        title: 'MEMBER_PRIVATE_TITLE', content: '<p onclick="legacy()">MEMBER_RAW</p>', status: 1, sort: 2147483647, add_time: 0 } } });
      expect(agent.dto).toEqual({ status: 200, msg: 'ok', data: { member_explain: { id: explanationId, type: 2,
        title: 'TITLE_NOT_IN_PUBLIC_DTO', content: '<p>LEGACY_TYPE2_STATUS0</p>', status: 0, sort: -20, add_time: 123 } } });
    }));
  }, 30000);

  it('retains safe static/HTTPS image, video and link references without external fetching', async () => {
    await setContent('<img src="/static/logo.png"><img src="https://example.invalid/legal.png">'
      + '<video src="https://example.invalid/legal.mp4"></video><a href="https://example.invalid/rules">规则</a>'
      + '<img src="javascript:bad()" onerror="bad()"><iframe src="https://example.invalid/private"></iframe>');
    await reader(peer => readonly(async () => { const html = document(await request(peer)).content_preview;
      expect(html).toContain('src="/static/logo.png"'); expect(html).toContain('https://example.invalid/legal.png');
      expect(html).toContain('https://example.invalid/legal.mp4'); expect(html).toContain('https://example.invalid/rules');
      expect(html).not.toMatch(/javascript:|onerror|iframe|signature=/u);
    }));
  }, 30000);

  it('issues fresh canonical platform capabilities only, then serves actual PNG/MP4 bytes through the unchanged generic GET', async () => reader(async peer => {
    const result = await readonly(() => request(peer)), row = document(result);
    const image = ticket(slots(row.content_preview, 'img')[0]!, result, imageRef), video = ticket(slots(row.content_preview, 'video')[0]!, result, videoRef);
    for (const [url, bytes, mime, key] of [[image, png, 'image/png', imageKey], [video, mp4, 'video/mp4', videoKey]] as const) {
      await readonly(async () => { const response = await asset(peer, url); expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(mime); expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes); expect(io.assetGet.mock.lastCall?.[0]).toBe(key);
      }, 1);
    }
  }), 30000);

  it('recanonicalizes copied absolute/relative signed asset queries before platform authorization and never signs user/supplier/private/missing IDs', async () => {
    await setContent(`<img src="https://old.invalid${imageRef}?expires=1&amp;signature=forged"><img src="${imageRef}?expires=1#old">`
      + '<img src="/api/assets/630103"><img src="/api/assets/630104"><img src="/api/assets/630199"><video src="/api/assets/630103"></video>');
    await reader(peer => readonly(async () => { const result = await request(peer), html = document(result).content_preview;
      expect(slots(html, 'img')).toHaveLength(2); for (const value of slots(html, 'img')) ticket(value, result, imageRef);
      expect(html).not.toMatch(/old\.invalid|signature=forged|630103|630104|630199/u); expect(slots(html, 'video')).toEqual([]);
    }));
  }, 30000);

  it.each([{ type: 2 }, { type: 3 }, { relationId: 7 }, { moduleType: 3 }, { fileType: 2 }, { imageType: 1 },
    { attType: 'image/jpeg' }, { name: 'attachments/admin/0/private.png' }, { name: 'attachments/admin/1/../private.png' },
    { attDir: '/api/assets/630199' }])('refuses image signing for actual persisted metadata mismatch %j', async patch => {
    await setContent(`<img src="${imageRef}">`); await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId, imageId));
    await reader(peer => readonly(async () => { const html = document(await request(peer)).content_preview;
      expect(html).not.toMatch(/signature=|\/api\/assets/u); }));
  }, 30000);

  it.each([{ type: 3 }, { relationId: 11 }, { moduleType: 3 }, { fileType: 1 }, { imageType: 1 }, { attType: 'video/webm' },
    { name: 'attachments/admin/1/not-a-generated.mp4' }, { attDir: '/api/assets/630199' }])('refuses video signing for actual persisted metadata mismatch %j', async patch => {
    await setContent(`<video src="${videoRef}"></video>`); await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId, videoId));
    await reader(peer => readonly(async () => { expect(document(await request(peer)).content_preview).not.toMatch(/signature=|\/api\/assets/u); }));
  }, 30000);

  it('treats issuance as metadata authority only and preserves real empty404 when R2 object is absent', async () => {
    objects.delete(imageKey); await setContent(`<img src="${imageRef}">`);
    await reader(async peer => { const result = await readonly(() => request(peer));
      const url = ticket(slots(document(result).content_preview, 'img')[0]!, result, imageRef);
      await readonly(async () => { const response = await asset(peer, url); expect(response.status).toBe(404);
        expect(await response.text()).toBe(''); expect(response.headers.get('cache-control')).toBe('no-store'); }, 1);
    });
  }, 30000);

  it('fails closed when local platform media needs a missing signing key, while safe text/static content remains readable', async () => {
    const key = env.APP_KEY; env.APP_KEY = '';
    try { await reader(peer => readonly(async () => { const result = await request(peer);
      expect(result.dto.status).toBe(400); expect(result.dto.data).toBeNull(); expect(JSON.stringify(result.dto)).not.toContain(imageRef);
    }));
      await setContent('<p>仅文字说明</p><img src="/static/logo.png">');
      await reader(peer => readonly(async () => { const html = document(await request(peer)).content_preview;
        expect(html).toContain('仅文字说明'); expect(html).toContain('src="/static/logo.png"'); expect(html).not.toContain('signature=');
      }));
    } finally { env.APP_KEY = key; }
  }, 30000);

  it('keeps the complete4MB UTF8 boundary and rejects one-byte input overflow without truncation', async () => {
    const full = '规'.repeat(1_333_333) + 'a'; expect(Buffer.byteLength(full)).toBe(4_000_000);
    await setContent(full); await reader(peer => readonly(async () => { expect(document(await request(peer)).content_preview).toBe(full); }));
    await setContent(full + 'b'); await reader(peer => readonly(async () => { const result = await request(peer);
      expect(result.dto.status).toBe(400); expect(result.dto.data).toBeNull(); expect(result.dto.msg).toContain('4MB'); }));
  }, 30000);

  it('rejects signed-ticket output expansion beyond4MB instead of returning a truncated safe document', async () => {
    const tag = `<img src="${imageRef}">`, html = 'x'.repeat(4_000_000 - Buffer.byteLength(tag)) + tag;
    await setContent(html); await reader(peer => readonly(async () => { const result = await request(peer);
      expect(result.dto.status).toBe(400); expect(result.dto.data).toBeNull(); expect(result.dto.msg).toContain('4MB'); }));
  }, 30000);

  it('retains all9999 mixed image/video slots and rejects10000 even when none needs a signature', async () => {
    const image = '<img src="/static/logo.png">', video = '<video src="/static/legal.mp4"></video>';
    await setContent(image.repeat(5000) + video.repeat(4999));
    await reader(peer => readonly(async () => { const html = document(await request(peer)).content_preview;
      expect(slots(html, 'img')).toHaveLength(5000); expect(slots(html, 'video')).toHaveLength(4999); }));
    await setContent(image.repeat(5000) + video.repeat(5000));
    await reader(peer => readonly(async () => { const result = await request(peer);
      expect(result.dto.status).toBe(400); expect(result.dto.data).toBeNull(); expect(result.dto.msg).toContain('9999'); }));
  }, 30000);

  it('actually uses RR READ ONLY and local5s, restores the session, and has no DML/sequence privilege', async () => reader(async peer => {
    const settings = async () => Array.from(await peer.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
      current_setting('transaction_isolation') AS isolation,(SELECT setting FROM pg_settings WHERE name='statement_timeout') AS timeout`));
    const before = await settings(), observed: Row[] = [], transaction = peer.db.transaction.bind(peer.db);
    const wrapped: typeof peer.db.transaction = (callback, config) => transaction(async tx => {
      const result = await callback(tx); observed.push(...Array.from(await tx.execute(sql`SELECT
        current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation,
        (SELECT setting FROM pg_settings WHERE name='statement_timeout') AS timeout`))); return result;
    }, config);
    const spy = vi.spyOn(peer.db, 'transaction').mockImplementation(wrapped);
    try { await readonly(async () => { const value = await new AgentExplanationReadService(createContainerFromDb(peer.db), env).read();
      expect(value.version).toBe(1); expect(value.member_explain?.type).toBe(2); }); }
    finally { spy.mockRestore(); }
    expect(observed).toEqual([{ readonly: 'on', isolation: 'repeatable read', timeout: '5000' }]); expect(await settings()).toEqual(before);
    await readonly(async () => {
      await expect(peer.exec('UPDATE public.agreement SET status=status')).rejects.toMatchObject({ code: '42501' });
      await expect(peer.exec("SELECT nextval('public.agreement_id_seq')")).rejects.toMatchObject({ code: '42501' });
    });
  }), 30000);

  it.each(['?', '?type=2', '?uid=11', '?content=x', '?preview=1', '?type=1&type=2'])('rejects query %s with no rows/resources changed', async suffix => reader(peer => readonly(async () => {
    const result = await request(peer, path + suffix); expect(result.dto.status).toBe(400); expect(result.dto.data).toBeNull();
    expect(result.response.headers.get('cache-control')).toBe('private, no-store');
  })), 30000);

  it('rejects nonempty framing and POST, while the implicit HEAD returns no body', async () => reader(peer => readonly(async () => {
    const framed = await request(peer, path, { headers: { 'Content-Length': '1' } }); expect(framed.dto.status).toBe(400); expect(framed.dto.data).toBeNull();
    const post = await request(peer, path, { method: 'POST', body: '{}' }); expect(post.dto).toEqual({ status: 404, msg: 'not found', data: null });
    const head = await wiring.context!.run(createContainerFromDb(peer.db), () => app.fetch(new Request(origin + path, { method: 'HEAD' }), env,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never));
    expect(head.status).toBe(200); expect(await head.text()).toBe(''); expect(head.headers.get('cache-control')).toBe('private, no-store');
  })), 30000);
});
