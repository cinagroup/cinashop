import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import type { Env } from '../src/env';
import type { AppVariables } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { systemAttachment, systemGroup, systemGroupData } from '../src/models/schema';
import { AttachmentService } from '../src/services/system/AttachmentService';
import { asset } from '../src/controllers/system/AttachmentController';
import { getBanner } from '../src/controllers/api/v1/PcCompatibilityController';
import { runtimeBusinessPrivilegePlan } from '../src/migrations/runtimeBusinessPrivilegePlan';
import { decodePcBannerValue, PcBannerReadService } from '../src/services/pc/PcBannerReadService';
import { financePostgres } from './helpers/financePostgres';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';

const wrapped = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  title: { type: 'input', value: '  首页轮播  ' },
  image: { type: 'upload', value: '/uploads/banner.png' },
  url: { type: 'input', value: '/product/detail/7?from=banner' },
  ...overrides,
});

describe('PC banner decoding', () => {
  it('flattens legacy wrappers and preserves input, textarea, choices and dynamic values', () => {
    const value = decodePcBannerValue(wrapped({
      note: { type: 'textarea', value: '第一行\r\n第二行' },
      choice: { type: 'checkbox', value: ['b', 'a'] },
      future: { type: 'future', value: '010' },
      image: { type: 'upload', value: ['/uploads/banner.png', '/ignored-second.png'] },
    }));
    expect(value?.fields).toEqual({ title: '  首页轮播  ', image: '/uploads/banner.png',
      url: '/product/detail/7?from=banner', note: '第一行\r\n第二行', choice: ['b', 'a'], future: '010' });
    expect(value?.media).toEqual([{ key: 'image', index: null, value: '/uploads/banner.png' }]);
  });

  it('keeps an empty historical target static and retains safe HTTP and HTTPS links', () => {
    for (const url of ['', '/unknown-legacy/page?q=one#part', '/goods?q=white%20shirt', 'http://legacy.example/path', 'https://example.com/path?q=one']) {
      expect(decodePcBannerValue(wrapped({ url: { type: 'input', value: url } }))?.fields.url).toBe(url);
    }
  });

  it('filters corrupt JSON, invalid core values and oversized whole values without returning raw text', () => {
    for (const raw of ['not-json', 'null', '[]', '{"image":', '{"image":3}', 'x'.repeat(1024 * 1024 + 1),
      wrapped({ image: { type: 'upload', value: [] } }),
      wrapped({ title: { type: 'input', value: '\u0000secret' } })]) {
      expect(decodePcBannerValue(raw)).toBeNull();
    }
  });

  it('keeps the core display contract when opaque extensions exceed individual read bounds', () => {
    let deep: unknown = 'opaque';
    for (let index = 0; index < 18; index++) deep = { next: deep };
    const wide = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`extension_${index}`, { value: `value-${index}` }]));
    for (const extensions of [wide, { blob: { value: deep }, retained: { value: 'readable' } },
      { blob: { value: 'x'.repeat(100_001) }, retained: { value: 'readable' } },
      { blob: { value: Array(10_001).fill(1) }, retained: { value: 'readable' } }]) {
      // Put opaque keys before the core values to prove priority is semantic,
      // rather than depending on the original JSON member order.
      const decoded = decodePcBannerValue(JSON.stringify({ ...extensions, ...JSON.parse(wrapped()) }));
      expect(decoded?.fields).toMatchObject({ title: '  首页轮播  ', image: '/uploads/banner.png', url: '/product/detail/7?from=banner' });
      expect(decoded?.media).toEqual([{ key: 'image', index: null, value: '/uploads/banner.png' }]);
      expect(decoded?.fields).not.toHaveProperty('blob');
      if ('retained' in extensions) expect(decoded?.fields.retained).toBe('readable');
      else { expect(decoded?.fields.extension_99).toBe('value-99'); expect(decoded?.fields).not.toHaveProperty('extension_100'); }
    }
  });

  it('accepts the same one-MiB merged value capacity as dedicated Admin saves', () => {
    const extras = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`historical_${index}`, { value: 'x'.repeat(80_000) }]));
    const raw = wrapped(extras);
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(500_000);
    expect(decodePcBannerValue(raw)?.fields.historical_7).toBe('x'.repeat(80_000));
  });

  it('rejects executable, credential, protocol-relative and encoded unsafe navigation', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/path',
      'https://user:pass@example.com/', '/safe\\evil', '/%2fexample.com', '/%252fexample.com',
      '/safe%0aheader', '/safe%250aheader', '/safe%25250aheader', '/safe%2525250aheader',
      'https://user%40example.com@evil.example/', 'http://example.com/%5cpath']) {
      expect(decodePcBannerValue(wrapped({ url: { value: url } }))).toBeNull();
    }
  });

  it('drops prototype keys and indexes every dynamic upload for independent authority checks', () => {
    const raw = wrapped({ gallery: { type: 'uploads', value: ['/one.png', '/api/assets/41'] },
      legacy_gallery: { type: 'uploads', value: '/api/assets/41' },
      icon: { type: 'upload', value: '/api/assets/42' }, extra: { value: JSON.parse('{"safe":1,"__proto__":{"bad":true}}') } });
    const decoded = decodePcBannerValue(raw)!;
    expect(decoded.fields.extra).toEqual({ safe: 1 });
    expect(decoded.fields.legacy_gallery).toEqual(['/api/assets/41']);
    expect(decoded.media).toEqual([
      { key: 'image', index: null, value: '/uploads/banner.png' },
      { key: 'gallery', index: 0, value: '/one.png' },
      { key: 'gallery', index: 1, value: '/api/assets/41' },
      { key: 'legacy_gallery', index: 0, value: '/api/assets/41' },
      { key: 'icon', index: null, value: '/api/assets/42' },
    ]);
    expect(({} as Record<string, unknown>).bad).toBeUndefined();
  });
});

// These cases exercise real native SQL and the actual signed-asset resolver.
// There is no PGlite fallback, provider, HTTP listener or remote R2 operation.
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('PC banner native read', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>> | undefined;
  afterEach(async () => { await fixture?.close(); fixture = undefined; });
  async function setup() {
    fixture = await financePostgres([systemGroup, systemGroupData, systemAttachment], { namespace: 'public' });
    const container = createContainerFromDb(fixture.db);
    await fixture.db.insert(systemGroup).values([
      { id: 777, name: 'PC轮播', configName: 'pc_home_banner' },
      { id: 66, name: '另一个历史组', configName: 'unrelated_group' },
    ]);
    return { ...fixture, container, service: new PcBannerReadService(container, { APP_KEY: 'isolated-pc-banner-key' }) };
  }

  it('uses the named group, status, descending tie order and the first-ten window before filtering', async () => {
    const f = await setup();
    await f.db.insert(systemGroupData).values(Array.from({ length: 12 }, (_, index) => ({
      id: index + 1, gid: 777, sort: 9, status: 1,
      value: index === 11 ? 'corrupt-json' : wrapped(index === 10 ? { image: { type: 'upload', value: 'http://legacy.example/image.png' } } : { id: { value: 999 } }),
    })));
    await f.db.insert(systemGroupData).values([
      { id: 80, gid: 66, sort: 1000, status: 1, value: wrapped() },
      { id: 81, gid: 777, sort: 1000, status: 0, value: wrapped() },
    ]);
    const result = await f.service.banner();
    expect(result.list.map(row => row.id)).toEqual([10, 9, 8, 7, 6, 5, 4, 3]);
    expect(result.list[0]).toMatchObject({ title: '  首页轮播  ', image: '/uploads/banner.png', url: '/product/detail/7?from=banner' });
    expect(JSON.stringify(result)).not.toContain('corrupt-json');
  });

  it('signs only genuine platform raster metadata and reads that URL through AttachmentService', async () => {
    const f = await setup();
    await f.db.insert(systemAttachment).values([
      { attId: 41, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
        attDir: '/api/assets/41', name: 'attachments/admin/1/banner.png', attType: 'image/png' },
      { attId: 42, type: 4, relationId: 9, moduleType: 1, fileType: 1, imageType: 8,
        attDir: '/api/assets/42', name: 'attachments/supplier/9/private.png', attType: 'image/png' },
      { attId: 43, type: 1, relationId: 0, moduleType: 1, fileType: 2, imageType: 8,
        attDir: '/api/assets/43', name: 'attachments/admin/1/video.mp4', attType: 'video/mp4' },
      { attId: 44, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
        attDir: '/api/assets/44', name: 'attachments/admin/2/foreign.png', attType: 'image/png' },
      { attId: 45, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
        attDir: '/api/assets/45', name: 'attachments/admin/1/mismatch.png', attType: 'image/svg+xml' },
      { attId: 46, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 1,
        attDir: '/api/assets/46', name: 'attachments/admin/1/legacy.png', attType: 'image/png' },
      { attId: 48, type: 1, relationId: 0, moduleType: 2, fileType: 1, imageType: 8,
        attDir: '/api/assets/48', name: 'attachments/admin/1/kefu.png', attType: 'image/png' },
    ]);
    const ids = [41, 42, 43, 44, 45, 46, 47, 48];
    await f.db.insert(systemGroupData).values(ids.map((id, index) => ({ id: index + 1, gid: 777,
      value: wrapped({ image: { type: 'upload', value: id === 41 ? ['/api/assets/41?expires=1&signature=old', '/api/assets/42']
        : id === 42 ? ['/api/assets/42', '/api/assets/41'] : `/api/assets/${id}?expires=1&signature=old` } }) })));
    const result = await f.service.banner();
    expect(result.list).toHaveLength(1);
    const url = new URL(result.list[0].image, 'https://isolated.example');
    expect(url.pathname).toBe('/api/assets/41');
    const expires = url.searchParams.get('expires')!, signature = url.searchParams.get('signature')!;
    expect(Number(expires)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(signature).toBe(createHmac('sha256', 'isolated-pc-banner-key').update(`GET\n/api/assets/41\n${expires}`).digest('base64url'));
    const gets: string[] = [];
    const env = { APP_KEY: 'isolated-pc-banner-key', ASSETS_BUCKET: { get: async (key: string) => {
      gets.push(key);
      return { body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } }),
        httpEtag: '"isolated-banner"', size: 3, writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', 'image/png') };
    } } } as unknown as Env;
    expect(gets).toEqual([]);
    const asset = await new AttachmentService(f.container, env).getSignedAsset(41, expires, signature);
    expect(asset.response.status).toBe(200);
    expect(asset.response.headers.get('Content-Type')).toBe('image/png');
    expect([...new Uint8Array(await asset.response.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(gets).toEqual(['attachments/admin/1/banner.png']);
  });

  it('refreshes dynamic upload signatures and withholds foreign media without losing ordinary extension values', async () => {
    const f = await setup();
    await f.db.insert(systemAttachment).values([
      { attId: 41, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, attDir: '/api/assets/41',
        name: 'attachments/admin/1/banner.png', attType: 'image/png' },
      { attId: 42, type: 4, relationId: 9, moduleType: 1, fileType: 1, imageType: 8, attDir: '/api/assets/42',
        name: 'attachments/supplier/9/private.png', attType: 'image/png' },
    ]);
    await f.db.insert(systemGroupData).values({ id: 5, gid: 777, value: wrapped({
      note: { type: 'textarea', value: '原内容\r\n保留' }, choices: { type: 'checkbox', value: ['two', 'one'] },
      gallery: { type: 'uploads', value: ['/api/assets/41', '/api/assets/42', 'https://legacy.example/image.png'] },
      legacy_gallery: { type: 'uploads', value: '/api/assets/41' },
      legacy_private_gallery: { type: 'uploads', value: '/api/assets/42' },
      opaque_blob: { value: 'x'.repeat(100_001) },
      icon: { type: 'upload', value: '/api/assets/42' },
    }) });
    const { list } = await f.service.banner();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 5, note: '原内容\r\n保留', choices: ['two', 'one'], icon: '' });
    expect(list[0].gallery).toEqual([expect.stringMatching(/^\/api\/assets\/41\?expires=\d+&signature=/), '', 'https://legacy.example/image.png']);
    expect(list[0].legacy_gallery).toEqual([expect.stringMatching(/^\/api\/assets\/41\?expires=\d+&signature=/)]);
    expect(list[0].legacy_private_gallery).toEqual(['']);
    expect(list[0]).not.toHaveProperty('opaque_blob');
    expect(JSON.stringify(list)).not.toContain('/api/assets/42');
  });

  it('serves the actual banner and signed-image HTTP entries under an independent current app SELECT slice', async () => {
    const f = await sequenceRunnerDatabase();
    try {
      if (f.format !== 'pg16' || !f.withRuntimeRole) throw Error('PC banner LOGIN proof requires native PostgreSQL 16');
      const tables = [systemGroup, systemGroupData, systemAttachment], dialect = new PgDialect();
      // Three real ORM tables only. This is a reviewed SELECT slice of the
      // current application profile, not full 282-table commissioning.
      for (const table of tables) {
        const definition = getTableConfig(table);
        const columns = definition.columns.map(column => {
          const initial = column.default;
          const initialSql = initial === undefined ? '' : ` default ${initial instanceof SQL
            ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
          return `"${column.name}" ${column.getSQLType()}${initialSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
        });
        await f.exec(`CREATE TABLE public."${definition.name}" (${columns.join(', ')})`);
      }
      await f.db.insert(systemGroup).values({ id: 777, configName: 'pc_home_banner', name: 'PC轮播' });
      await f.db.insert(systemAttachment).values({ attId: 41, type: 1, relationId: 0, moduleType: 1, fileType: 1,
        imageType: 8, attDir: '/api/assets/41', name: 'attachments/admin/1/native-banner.png', attType: 'image/png' });
      await f.db.insert(systemGroupData).values({ id: 9, gid: 777, value: wrapped({ image: { type: 'upload', value: '/api/assets/41' } }) });
      const [owner] = (await f.query('SELECT pg_backend_pid() AS pid')).rows;
      await f.withRuntimeRole(async peer => {
        const profile = runtimeBusinessPrivilegePlan('app');
        for (const table of tables) {
          const name = getTableConfig(table).name;
          expect(profile.tables[name]).toContain('SELECT');
          await f.exec(`GRANT SELECT ON public."${name}" TO "${peer.role}"`);
        }
        const [identity] = await peer.exec('SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid');
        expect(identity.role).toBe(peer.role); expect(identity.session).toBe(peer.role);
        expect(identity.pid).toBe(peer.pid); expect(Number(identity.pid)).not.toBe(Number(owner.pid));
        await expect(peer.exec('DELETE FROM public.system_group_data WHERE id=9')).rejects.toMatchObject({ code: '42501' });
        await expect(peer.exec('CREATE TABLE public.pc_banner_unauthorized(id integer)')).rejects.toMatchObject({ code: '42501' });
        const gets: string[] = [];
        const env = { APP_KEY: 'isolated-pc-banner-login-key', ASSETS_BUCKET: { get: async (key: string) => {
          gets.push(key);
          return { body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([4, 5, 6])); controller.close(); } }),
            httpEtag: '"native-banner"', size: 3, writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', 'image/png') };
        } } } as unknown as Env;
        const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
        const container = createContainerFromDb(peer.db);
        app.use('*', async (c, next) => { c.set('container', container); c.set('uid', 0); await next(); });
        app.get('/api/pc/get_banner', getBanner);
        app.get('/api/assets/:id', asset);
        const response = await app.request('/api/pc/get_banner', undefined, env);
        expect(response.status).toBe(200);
        const body = await response.json() as { status: number; data: { list: Array<{ id: number; title: string; image: string; url: string }> } };
        expect(body.status).toBe(200); expect(body.data.list).toHaveLength(1);
        expect(body.data.list[0]).toMatchObject({ id: 9, title: '  首页轮播  ', url: '/product/detail/7?from=banner' });
        expect(gets).toEqual([]);
        const url = new URL(body.data.list[0].image, 'https://isolated.example');
        expect(url.pathname).toBe('/api/assets/41');
        const expires = url.searchParams.get('expires')!, signature = url.searchParams.get('signature')!;
        expect(signature).toBe(createHmac('sha256', env.APP_KEY).update(`GET\n/api/assets/41\n${expires}`).digest('base64url'));
        const image = await app.request(`${url.pathname}${url.search}`, undefined, env);
        expect(image.status).toBe(200); expect(image.headers.get('Content-Type')).toBe('image/png');
        expect(image.headers.get('Cache-Control')).toBe('private, no-store');
        expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([4, 5, 6]);
        const invalid = await app.request(`/api/assets/41?expires=${expires}&signature=invalid`, undefined, env);
        expect(invalid.status).toBe(404);
        expect(gets).toEqual(['attachments/admin/1/native-banner.png']);
      });
    } finally { await f.close(); }
  });
});
