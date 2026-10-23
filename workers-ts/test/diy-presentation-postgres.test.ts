import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemAttachment, systemDise, systemRole } from '@/models/schema';
import { DIY_PRESENTATION_MEDIA_SLOT_LIMIT, renderDiyEditorialMedia } from '@/services/content/DiyEditorialMediaPolicy';
import * as productMedia from '@/services/activity/ProductAssetPolicy';
import { diyPresentationHtmlMediaReferences, canonicalizeDiyPresentationHtml, sanitizeDiyPresentationHtml } from '../../view/common/diyPresentationHtml';
import { diyPresentationBlocks, diyPresentationFixture } from './helpers/diyPresentationFixture';
import { communityVideoFixture } from './helpers/communityVideoFixture';
import { OwnedFixedLengthStream } from './helpers/adminProductVideoUpload';
import { sortedDiyState, type DiyStateRow as Row, type DiyStateSnapshot } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing actual presentation SQL fixture'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing actual presentation Admin SQL fixture'); return { container: wiring.container, close: async () => {} }; } }));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const stale = (value: string) => value + '?expires=1&signature=historical';
const videoBlock = (video: string, image: string): Row => ({ name: 'videos', videoConfig: { url: video }, imgConfig: { url: image } });
const richBlock = (html: string): Row => ({ name: 'richText', richText: { val: html } });
const kinds = (value: Row[]) => value.filter(row => ['titles', 'blankPage', 'guide', 'richText', 'videos'].includes(row.name));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual PG16 five presentation components, live Admin authority and real platform MP4 uploads', () => {
  let f: Awaited<ReturnType<typeof diyPresentationFixture>>, schemas: Array<typeof systemDise.$inferSelect>, now: Date;
  const app = createApp(), reads: Array<{ path: string; actor: number; status: number; before: string; after: string; r2_reads: number; unchanged: boolean }> = [];
  let proofDirectory = '';
  beforeAll(async () => {
    now = new Date(); vi.stubGlobal('FixedLengthStream', OwnedFixedLengthStream); vi.setSystemTime(now);
    f = await diyPresentationFixture(now); wiring.container = f.container;
    expect(f.tables).toHaveLength(74); expect(f.sequences).toHaveLength(68);
    expect((await f.db.execute(sql`SELECT current_schema() AS schema`))[0].schema).toBe('public');
    schemas = await f.db.select().from(systemDise);
    proofDirectory = await mkdtemp(join(tmpdir(), 'cinashop-diy-presentation-native-'));
    const setup = { namespace: 'explicit public in unique owned database; old fixture defaults unchanged', tables: f.tables, sequences: f.sequences,
      inherited_before: f.beforeBrowserSetup, inherited_after: f.afterBrowserSetup, addon: f.addonSetup,
      actual_mp4_upload: f.uploadSetup, actual_image_batch: f.imageSetup, schema_setup: f.schemaSetup };
    const text = JSON.stringify(setup, null, 2) + '\n', path = join(proofDirectory, 'setup.json');
    await writeFile(path, text); process.stdout.write('DIY_PRESENTATION_SETUP ' + JSON.stringify({ path, sha256: sha(text), tables: f.tables.length, sequences: f.sequences.length, real_mp4_bytes: f.mp4.length, image_uploads: f.batchImages.length }) + '\n');
  }, 90_000);
  afterAll(async () => {
    try {
      if (f) { const text = JSON.stringify({ reads, tables: f.tables, sequences: f.sequences, final: await f.snapshot(), resources: f.resources(),
        note: 'Every read compares all table rows/sequences and write resources. R2 GETs are separate actual byte reads. Owned database close is enforced by financePostgres and external runner.' }, null, 2) + '\n';
        const path = join(proofDirectory, 'reads.json'); await writeFile(path, text); process.stdout.write('DIY_PRESENTATION_READS ' + JSON.stringify({ path, sha256: sha(text), count: reads.length, all_unchanged: reads.every(x => x.unchanged) }) + '\n'); }
    } finally { wiring.container = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); await f?.close(); }
  }, 30_000);
  beforeEach(() => { vi.setSystemTime(now); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider network in owned presentation suite')); });
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f.db.delete(systemDise); await f.db.insert(systemDise).values(schemas); }
  });
  async function request(path: string, options: { method?: string; body?: unknown; token?: string; range?: string } = {}) {
    const waits: Promise<unknown>[] = [], headers: Record<string, string> = {};
    if (options.token) headers['Authori-zation'] = 'Bearer ' + options.token;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.range) headers.Range = options.range;
    const response = await app.fetch(new Request('https://owned-presentation.local' + path, { method: options.method ?? 'GET', headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }), f.env,
      { waitUntil: (work: Promise<unknown>) => { waits.push(work); }, passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(waits); return response;
  }
  async function get(path: string, actor: 0 | 11 | 22 = 0, range?: string) {
    const before = await f.snapshot(), resources = f.resources(), count = f.bucket.get.mock.calls.length;
    const response = await request(path, { token: actor === 11 ? f.token : actor === 22 ? f.otherToken : undefined, range });
    // Consume the complete actual HTTP body before checking storage/state.
    const bytes = new Uint8Array(await response.arrayBuffer()), after = await f.snapshot();
    expect(after).toEqual(before); expect(f.resources()).toEqual(resources);
    reads.push({ path, actor, status: response.status, before: sha(JSON.stringify(before)), after: sha(JSON.stringify(after)), r2_reads: f.bucket.get.mock.calls.length - count, unchanged: true });
    return { response, bytes, body: () => JSON.parse(new TextDecoder().decode(bytes)) as Row };
  }
  async function page(id = 2, actor: 0 | 11 | 22 = 0, status = 200): Promise<Row[]> {
    const read = await get('/api/diy/get_diy/' + id, actor), body = read.body();
    expect(read.response.status).toBe(200); expect(body.status).toBe(status); expect(read.response.headers.get('Cache-Control')).toContain('no-store');
    return body.data?.value ?? [];
  }
  async function imported(value: unknown, id = 2) { await f.db.update(systemDise).set({ value: typeof value === 'string' ? value : JSON.stringify(value) }).where(eq(systemDise.id, id)); }
  async function save(value: Row[], id = 2, token: string | null = f.adminToken, extra: Row = {}) {
    const before = await f.snapshot(), resources = f.resources(), response = await request('/adminapi/dise/save', { method: 'POST', token: token ?? undefined, body: { id, value: JSON.stringify(value), ...extra } });
    const body = await response.json() as Row, after = await f.snapshot(); expect(f.resources()).toEqual(resources);
    return { before, after, response, body };
  }
  function expectedSave(result: { before: DiyStateSnapshot; after: DiyStateSnapshot; body: Row }, value: Row[], id = 2) {
    expect(result.body.status).toBe(200); const saved = result.after.system_dise.find(row => row.id === id)!, old = result.before.system_dise.find(row => row.id === id)!;
    expect(saved.value).toBe(JSON.stringify(value)); expect(saved.version).not.toBe(old.version); expect(saved.update_time).toBeGreaterThan(old.update_time);
    const expected = structuredClone(result.before); expected.system_dise = expected.system_dise.map(row => row.id === id ? { ...row, value: saved.value, version: saved.version, update_time: saved.update_time } : row);
    expect(result.after).toEqual(sortedDiyState(expected)); return saved;
  }

  it('keeps the default historical fixture in its random namespace while the new actual Admin pipeline uses public', async () => {
    const old = await communityVideoFixture(); try { const [row] = await old.db.execute(sql`SELECT current_schema() AS schema`); expect(row.schema).toMatch(/^finance_test_[a-f0-9]{32}$/u); } finally { await old.close(); }
    expect((await f.db.execute(sql`SELECT current_schema() AS schema`))[0].schema).toBe('public');
  });
  it('installs the existing addon only in owned setup and commits all real decodable MP4 bytes through initialize/parts/complete', async () => {
    expect(f.uploadSetup.parts).toHaveLength(4); expect(f.uploadSetup.completed.state).toBe('committed');
    const rows = f.uploadSetup.after.admin_product_video_upload_v1; expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ actor_id: 901, state: 'committed', attachment_id: f.platformVideo.id, confirmed: [1, 2, 3, 4] });
    const asset = f.uploadSetup.after.system_attachment.find(row => row.att_id === f.platformVideo.id)!;
    expect(asset).toMatchObject({ type: 1, relation_id: 0, module_type: 1, file_type: 2, image_type: 8, att_dir: f.platformVideo.url, pid: 920 });
    expect(asset.name).toMatch(/^attachments\/admin\/1\/\d{4}\/\d{2}\/[a-f0-9-]{36}\.mp4$/u); expect(asset.att_type.trim()).toBe('video/mp4');
    expect(f.objects.get(asset.name)?.bytes).toEqual(f.mp4); expect(Buffer.from(f.mp4).includes(Buffer.from('moov'))).toBe(true); expect(Buffer.from(f.mp4).includes(Buffer.from('avc1'))).toBe(true);
    expect(f.uploadSetup.resources_after.puts - f.uploadSetup.resources_before.puts).toBe(5); expect(f.uploadSetup.resources_after.queue).toBeGreaterThan(f.uploadSetup.resources_before.queue);
    const expected = structuredClone(f.addonSetup.before); expected.admin_product_video_upload_v1 = []; expect(f.addonSetup.after).toEqual(sortedDiyState(expected));
    expect(f.addonSetup.resources_after).toEqual(f.addonSetup.resources_before);
  });
  it('records 257 real platform image uploads as setup with exactly one attachment/sequence delta and no business tables or queue', async () => {
    const setup = f.imageSetup, expected = structuredClone(setup.before); expected.system_attachment = setup.after.system_attachment;
    expected.__sequences = expected.__sequences.map(row => row.name === 'system_attachment_att_id_seq' ? setup.after.__sequences.find(next => next.name === row.name)! : row);
    expect(setup.after).toEqual(sortedDiyState(expected)); expect(setup.after.system_attachment.length - setup.before.system_attachment.length).toBe(257);
    expect(setup.resources_after.puts - setup.resources_before.puts).toBe(257); expect(setup.resources_after.queue).toBe(setup.resources_before.queue); expect(setup.resources_after.deletes).toBe(setup.resources_before.deletes);
  });
  it('publishes all five actual authored structures for home0/micro2 and guest/two actors without schema, sequence or resource writes', async () => {
    for (const id of [0, 2]) for (const actor of [0, 11, 22] as const) {
      const blocks = await page(id, actor), actual = kinds(blocks); expect(actual.map(row => row.name)).toEqual(['titles', 'blankPage', 'guide', 'richText', 'videos']);
      for (const index of [0, 1, 2]) expect(actual[index]).toEqual(f.blocks[index]);
      expect(actual[3].richText.val).toContain('真实 WangEditor 段落'); expect(actual[3].udConfig).toEqual({ val: 9 }); expect(actual[4].scaleConfig).toEqual({ tabVal: 0 });
      expect(actual[4].videoConfig.url).toMatch(new RegExp('^' + f.platformVideo.url + '\\?expires='));
      expect(blocks.some(row => row.name === 'pageFoot')).toBe(id === 2);
    }
  });
  it('serves exact real MP4/image bytes and byte-range206 from published current tickets without SQL or R2/Queue writes', async () => {
    const blocks = await page(), video = blocks.find(row => row.name === 'videos')!;
    const full = await get(video.videoConfig.url); expect(full.response.status).toBe(200); expect(full.response.headers.get('Content-Type')).toBe('video/mp4'); expect(full.bytes).toEqual(f.mp4);
    const partial = await get(video.videoConfig.url, 0, 'bytes=12-99'); expect(partial.response.status).toBe(206); expect(partial.response.headers.get('Content-Range')).toBe(`bytes 12-99/${f.mp4.length}`); expect(partial.bytes).toEqual(f.mp4.slice(12, 100));
    const suffix = await get(video.videoConfig.url, 0, 'bytes=-13'); expect(suffix.response.status).toBe(206); expect(suffix.bytes).toEqual(f.mp4.slice(-13));
    const image = await get(video.imgConfig.url); expect(image.response.headers.get('Content-Type')).toBe('image/png'); expect(image.bytes).toEqual(f.png);
  });
  it('actual authenticated Admin save preserves every typed field, unknown block, independent content and immutable metadata', async () => {
    const value = diyPresentationBlocks(f.platformImage.url, f.platformVideo.url); value.splice(2, 0, { name: 'unknown-neighbor', timestamp: 1002.5, preserve: { schema: 'original', link: stale(f.platformVideo.url) } });
    value[0].fontSize.val = 26; value[1].heightConfig.val = 900; const result = await save(value), saved = expectedSave(result, value);
    expect(saved.content).toBe('independent-owned-content'); expect(saved.status).toBe(1); expect(saved.type).toBe(2); expect(kinds(await page())).toHaveLength(5);
  });
  it('actual signed-read/edit/save canonicalizes only precise video/poster and real HTML src; author HTML nonmedia bytes remain byte-identical', async () => {
    const oldVideo = stale(f.platformVideo.url), oldImage = stale(f.platformImage.url);
    const html = `<!-- <img src="${oldImage}"> --><P data-note='keep > & untouched' onclick="evil()"><a href='${oldVideo}'>保留</a><IMG alt='q > z' SRC='${oldImage}'><video src="${oldVideo}" autoplay></video><script>"<img src='${oldImage}'>"</script></P>`;
    const value = [richBlock(html), { ...videoBlock(oldVideo, oldImage), link: oldVideo, preview: oldImage }, { name: 'titles', titleConfig: { value: oldImage } }];
    const expected = structuredClone(value); expected[0].richText.val = html.replace(`SRC='${oldImage}'`, `SRC='${f.platformImage.url}'`).replace(`src="${oldVideo}"`, `src="${f.platformVideo.url}"`); expected[1].videoConfig.url = f.platformVideo.url; expected[1].imgConfig.url = f.platformImage.url;
    const result = await save(value); expectedSave(result, expected); const published = await page();
    expect(published[0].richText.val).not.toMatch(/onclick|script|data-note|autoplay|<!--/iu); expect(published[0].richText.val).toContain('controls="controls"');
    expect(published[1].preview).toBe(oldImage); expect(published[1].link).toBe(oldVideo); expect(published[2]).toEqual(value[2]);
    const signed = published[1].videoConfig.url; published[1].scaleConfig = { tabVal: 2 };
    const roundtrip = await save(published); expect(roundtrip.body.status).toBe(200); expect(roundtrip.after.system_dise.find(row => row.id === 2)!.value).not.toContain(`"url":"${signed}"`);
  });
  it.each(['missing', 'read-only', 'api-user', 'invalid'] as const)('rejects %s Admin save authority with full database/resource identity', async kind => {
    const token = kind === 'missing' ? null : kind === 'read-only' ? f.readerToken : kind === 'api-user' ? f.token : 'invalid.jwt';
    const result = await save([videoBlock(f.platformVideo.url, f.platformImage.url)], 2, token); expect(result.body.status).not.toBe(200); expect(result.after).toEqual(result.before);
  });
  it('rechecks the existing live role rather than trusting a valid previously issued Admin JWT', async () => {
    const [role] = await f.db.select().from(systemRole).where(eq(systemRole.id, 901));
    try { await f.db.update(systemRole).set({ rules: 'dise.view,attachment.view' }).where(eq(systemRole.id, 901)); const result = await save([]); expect(result.body.status).not.toBe(200); expect(result.after).toEqual(result.before); }
    finally { await f.db.update(systemRole).set(role).where(eq(systemRole.id, 901)); }
  });
  it('rejects immutable metadata/status shapes at the real Admin DTO entrance without adopting partial component edits', async () => {
    for (const extra of [{ type: 1 }, { is_diy: 0 }, { template_name: 'default' }, { version: 'forged' }, { status: true }]) {
      const result = await save([videoBlock(f.platformVideo.url, f.platformImage.url)], 2, f.adminToken, extra); expect(result.body.status).toBe(400); expect(result.after).toEqual(result.before);
    }
  });
  it('freshens imported historical tickets and rejects old901-second capabilities while new actual byte reads remain available', async () => {
    await imported([videoBlock(stale(f.platformVideo.url), stale(f.platformImage.url)), richBlock(`<img src="${stale(f.platformImage.url)}"><video src="${stale(f.platformVideo.url)}"></video>`)]);
    const old = (await page())[0]; expect((await get(old.videoConfig.url)).response.status).toBe(200);
    vi.setSystemTime(new Date(now.getTime() + 901_000)); const fresh = (await page())[0]; expect(fresh.videoConfig.url).not.toBe(old.videoConfig.url); expect(fresh.imgConfig.url).not.toBe(old.imgConfig.url);
    expect((await get(old.videoConfig.url)).response.status).toBe(404); expect((await get(old.imgConfig.url)).response.status).toBe(404);
    expect((await get(fresh.videoConfig.url)).bytes).toEqual(f.mp4); expect((await get(fresh.imgConfig.url)).bytes).toEqual(f.png);
  });
  it('refuses image-as-video and MP4-as-poster/HTMLimg without confusing the separate actual slot kinds', async () => {
    await imported([videoBlock(f.platformImage.url, f.platformVideo.url), richBlock(`<img src="${f.platformVideo.url}"><video src="${f.platformImage.url}"></video>`)]);
    const value = await page(); expect(value[0].videoConfig.url).toBe(''); expect(value[0].imgConfig.url).toBe('');
    expect(diyPresentationHtmlMediaReferences(value[1].richText.val)).toEqual([]); expect(value[1].richText.val).not.toContain('/api/assets/');
  });
  it.each([
    ['private user', { type: 3, relationId: 11, moduleType: 3 }], ['foreign user', { type: 3, relationId: 22, moduleType: 3 }],
    ['supplier', { type: 4, relationId: 7 }], ['merchant', { type: 2, relationId: 91 }], ['platform wrong relation', { relationId: 11 }],
    ['foreign module', { moduleType: 3 }], ['image filetype', { fileType: 1 }], ['nonR2', { imageType: 0 }],
    ['MIME mismatch', { attType: 'image/png' }], ['active MIME', { attType: 'text/html' }], ['different video MIME', { attType: 'video/webm' }],
    ['wrong owner key', { name: 'attachments/admin/2/2026/10/00000000-0000-4000-8000-000000000001.mp4' }],
    ['traversal key', { name: 'attachments/admin/1/../video.mp4' }], ['nonUUID key', { name: 'attachments/admin/1/2026/10/not-a-uuid.mp4' }],
    ['extension mismatch', { name: 'attachments/admin/1/2026/10/00000000-0000-4000-8000-000000000001.png' }],
    ['canonical mismatch', { attDir: '/api/assets/999999' }], ['foreign canonical', { attDir: 'https://foreign.test/api/assets/1' }],
  ])('fresh current-owner projection refuses %s MP4 without metadata leakage or SQL/resource writes', async (_name, change) => {
    const [original] = await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, f.platformVideo.id));
    try { await f.db.update(systemAttachment).set(change).where(eq(systemAttachment.attId, original.attId));
      await imported([videoBlock(f.platformVideo.url, f.platformImage.url), richBlock(`<video src="${f.platformVideo.url}"></video>`)]);
      for (const actor of [0, 11, 22] as const) { const value = await page(2, actor); expect(value[0].videoConfig.url).toBe(''); expect(value[1].richText.val).not.toContain('/api/assets/'); expect(JSON.stringify(value)).not.toContain('attachments/'); }
    } finally { await f.db.update(systemAttachment).set(original).where(eq(systemAttachment.attId, original.attId)); }
  });
  it('withdraws deleted videos and actual private-owner image references from JSON and HTML even for their owner', async () => {
    const [original] = await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, f.platformVideo.id));
    try { await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, original.attId));
      await imported([videoBlock(f.platformVideo.url, f.image.url), richBlock(`<img src="${f.image.url}"><video src="${f.platformVideo.url}"></video>`)]);
      const value = await page(2, 11); expect(value[0].videoConfig.url).toBe(''); expect(value[0].imgConfig.url).toBe(''); expect(diyPresentationHtmlMediaReferences(value[1].richText.val)).toEqual([]);
    } finally { await f.db.insert(systemAttachment).values(original); }
  });
  it.each([{ type: 3, relationId: 11, moduleType: 3 }, { fileType: 2 }, { attType: 'image/jpeg' }, { name: 'attachments/admin/1/bad.svg' }, { attDir: '/api/assets/999999' }])('freshly refuses invalid platform poster/image identity %j in both JSON and HTML', async change => {
    const [original] = await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, f.platformImage.att_id));
    try { await f.db.update(systemAttachment).set(change).where(eq(systemAttachment.attId, original.attId));
      await imported([videoBlock(f.platformVideo.url, f.platformImage.url), richBlock(`<img src="${f.platformImage.url}">`)]);
      const value = await page(2, 11); expect(value[0].imgConfig.url).toBe(''); expect(diyPresentationHtmlMediaReferences(value[1].richText.val)).toEqual([]);
    } finally { await f.db.update(systemAttachment).set(original).where(eq(systemAttachment.attId, original.attId)); }
  });
  it('preserves safe HTTPS/static external references and links without remote I/O or signing foreign asset-shaped URLs', async () => {
    const foreign = 'https://foreign.test' + stale(f.platformVideo.url), image = 'https://images.test/' + 'x'.repeat(300) + '.png';
    const value = [videoBlock(foreign, image), richBlock(`<a href="${foreign}">链接</a><video src="${foreign}"></video><img src="${image}">`)];
    const result = await save(value); expectedSave(result, value); const published = await page(); expect(published[0]).toEqual(value[0]);
    expect(diyPresentationHtmlMediaReferences(published[1].richText.val)).toEqual([{ value: foreign, kind: 'video' }, { value: image, kind: 'image' }]);
    expect(published[1].richText.val).toContain('href="' + foreign.replaceAll('&', '&amp;') + '"');
  });
  it('does not decode JSON media as HTML or decode actual HTML src entities twice to grant a different local attachment', async () => {
    const encode = (id: number) => [...String(id)].map(char => `&#${char.codePointAt(0)};`).join('');
    const video = '/api/assets/' + encode(f.platformVideo.id), image = '/api/assets/' + encode(f.platformImage.att_id);
    await imported([videoBlock(video, image), richBlock(`<video src="${video.replaceAll('&', '&amp;')}"></video><img src="${image.replaceAll('&', '&amp;')}">`)]);
    const value = await page(); expect(value[0].videoConfig.url).toBe(''); expect(value[0].imgConfig.url).toBe(''); expect(diyPresentationHtmlMediaReferences(value[1].richText.val)).toEqual([]);
    const result = await save([videoBlock(video, image), richBlock(`<img src="${image.replaceAll('&', '&amp;')}">`)]);
    expect(result.body.status).toBe(200); const raw = JSON.parse(result.after.system_dise.find(row => row.id === 2)!.value);
    expect(raw[0].videoConfig.url).toBe(video); expect(raw[0].imgConfig.url).toBe(image); expect(raw[1].richText.val).toBe(`<img src="${image.replaceAll('&', '&amp;')}">`);
  });
  it('fails closed on malformed local references, protocol credentials, active schemes and control/oversize URLs', async () => {
    for (const ref of ['/api/assets/0', '/api/assets/999999', '/api/assets/1/../2', '/api/assets/2147483648', 'javascript:alert(1)', 'data:video/mp4,bad', 'http://foreign.test/a.mp4', 'https://user:pass@foreign.test/a.mp4', '//foreign.test/a', 'x'.repeat(4097), '/api/assets/1\\bad']) {
      await imported([videoBlock(ref, ref)]); const value = await page(); expect(value[0].videoConfig.url).toBe(''); expect(value[0].imgConfig.url).toBe('');
    }
  });
  it('actual Admin/public richText supports long author HTML beyond article200k without truncation or public active-code leakage', async () => {
    const text = '长段落'.repeat(30_000), source = `<p style="text-align:center;color:#123456"><em>${text}</em><img src="${f.platformImage.url}" onerror="bad()"><video src="${f.platformVideo.url}" autoplay></video></p>`;
    expect(Buffer.byteLength(source)).toBeGreaterThan(200_000); const value = [richBlock(source)], result = await save(value); expectedSave(result, value);
    const html = (await page())[0].richText.val; expect(html).toContain(text); expect(html).not.toMatch(/onerror|autoplay/u); expect(html).toContain('text-align:center'); expect(html).toContain('controls="controls"');
  });
  it('accepts exactly2MB UTF8 whole author JSON but atomically rejects one byte more through actual Admin and bounded public read', async () => {
    const value = [richBlock('<p>界</p>')], base = Buffer.byteLength(JSON.stringify(value)); value[0].richText.val = '<p>界' + 'x'.repeat(2_000_000 - base) + '</p>';
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(2_000_000); const result = await save(value); expectedSave(result, value); expect((await page())[0].richText.val).toContain('界' + 'x'.repeat(200_001));
    value[0].richText.val += 'x'; const failed = await save(value); expect(failed.body.status).toBe(400); expect(failed.after).toEqual(failed.before);
    await imported(value); expect(await page()).toEqual([]);
  }, 30_000);
  it('counts UTF8 bytes and preserves existing100k-node/depth64 atomic save guards without partial mutations', async () => {
    for (const value of [[richBlock('界'.repeat(666_667))], [{ name: 'blankPage', extra: Array.from({ length: 100_001 }, () => 0) }],
      [{ name: 'blankPage', extra: Array.from({ length: 65 }).reduce<unknown>(x => ({ next: x }), '') }]]) {
      const failed = await save(value); expect(failed.body.status).toBe(400); expect(failed.after).toEqual(failed.before);
    }
  });
  it('preserves all10000 HTML media in one valid source and signs all257 distinct real platform uploads including last actual pixels', async () => {
    const refs = Array.from({ length: 10000 }, (_, index) => f.batchImages[index % f.batchImages.length].url), value = [richBlock(refs.map(ref => `<img src="${ref}">`).join(''))];
    const result = await save(value); expectedSave(result, value); const actual = diyPresentationHtmlMediaReferences((await page())[0].richText.val);
    expect(actual).toHaveLength(10000); expect(new Set(actual.map(ref => ref.value.split('?')[0])).size).toBe(257); expect(actual[256].value).toContain(f.batchImages[256].url + '?expires=');
    expect((await get(actual[256].value)).bytes).toEqual(f.png); expect(actual.at(-1)!.value).toContain(refs.at(-1)! + '?expires=');
  }, 30_000);
  it('retains complete20000 presentation slots within independent capacity and rejects20001 before save/public partial adoption', async () => {
    expect(DIY_PRESENTATION_MEDIA_SLOT_LIMIT).toBe(20000);
    const html = `<img src="${f.platformImage.url}">`.repeat(10000), value = [richBlock(html), richBlock(html)];
    const result = await save(value); expectedSave(result, value); const published = await page(); expect(published).toHaveLength(2);
    expect(published.map(row => diyPresentationHtmlMediaReferences(row.richText.val).length)).toEqual([10000, 10000]);
    const exceeded = [...value, { name: 'videos', videoConfig: { url: f.platformVideo.url } }]; // exactly20001; no silent tail truncation
    const failed = await save(exceeded); expect(failed.body.status).toBe(400); expect(failed.after).toEqual(failed.before);
    await imported(exceeded); expect((await get('/api/diy/get_diy/2')).body().status).toBe(400);
  }, 30_000);
  it('rejects10001 media in one HTML group and excessive HTML tokens atomically before any saved field/version changes', async () => {
    for (const html of ['<img src="/static/logo.png">'.repeat(10001), '<br>'.repeat(100001)]) {
      const failed = await save([richBlock(html)]); expect(failed.body.status).toBe(400); expect(failed.after).toEqual(failed.before);
    }
  }, 30_000);
  it('a clearly injected second HMAC batch failure leaves the collected full schema/author HTML entirely unmodified', async () => {
    const value = [richBlock(f.batchImages.map(image => `<img src="${stale(image.url)}">`).join('')), videoBlock(stale(f.platformVideo.url), stale(f.platformImage.url))], before = JSON.stringify(value);
    const real = productMedia.renderProductPictures; let batches = 0; const signature = vi.spyOn(productMedia, 'renderProductPictures').mockImplementation(async (...args) => { if (++batches === 2) throw Error('explicit owned second-batch fault'); return real(...args); });
    try { await expect(renderDiyEditorialMedia(f.db, f.env.APP_KEY, value)).rejects.toThrow('explicit owned second-batch fault'); expect(batches).toBe(2); expect(JSON.stringify(value)).toBe(before); }
    finally { signature.mockRestore(); }
    // Provider-fault injection is separate from the real257-upload positive.
    expect(canonicalizeDiyPresentationHtml('<img src="' + stale(f.platformImage.url) + '">')).toBe('<img src="' + f.platformImage.url + '">');
  });
  it('station closure blocks public page/version without generating media or touching DB/queue; Admin auth remains separate', async () => {
    await f.station('0'); try { expect(await page(0, 0, 410010)).toEqual([]); expect(await page(2, 11, 410010)).toEqual([]);
      const version = await get('/api/diy/diy_version/0'); expect(version.body().status).toBe(410010);
    } finally { await f.station('1'); }
    expect(kinds(await page())).toHaveLength(5);
  });
  it('keeps get_script compatibility independent from safe rich HTML; no statistics script is evaluated by these read tests', async () => {
    const result = await get('/api/get_script'); expect(result.response.status).toBe(200); expect(new TextDecoder().decode(result.bytes)).toBe(f.statisticsScript); expect(result.response.headers.get('Content-Type')).toContain('application/javascript');
    expect(sanitizeDiyPresentationHtml('<script>mustNeverRun()</script><p>正文</p>')).toBe('<p>正文</p>');
  });
});
