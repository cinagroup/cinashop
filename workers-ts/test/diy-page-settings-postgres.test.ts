import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemAttachment, systemDise, systemRole } from '@/models/schema';
import * as attachmentsService from '@/services/system/AttachmentService';
import * as presentationMedia from '@/services/content/DiyPresentationVideoPolicy';
import { diyPageSettingsFixture } from './helpers/diyPageSettingsFixture';
import { sortedDiyState, stableDiyState, type DiyStateRow as Row, type DiyStateSnapshot } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned page-settings SQL'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned page-settings Admin SQL'); return { container: wiring.container, close: async () => {} }; } }));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const oldTicket = (reference: string) => reference + '?expires=1&signature=historical';
const canonical = (reference: string) => reference.split(/[?#]/u, 1)[0];
type Actor = 0 | 11 | 22 | 'admin' | 'reader';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual row-level page settings Admin and public contracts on owned PG16', () => {
  const app = createApp(), registry = new Map<string, DiyStateSnapshot>();
  let f: Awaited<ReturnType<typeof diyPageSettingsFixture>>, now: Date, schemas: Array<typeof systemDise.$inferSelect>, attachments: Array<typeof systemAttachment.$inferSelect>, roles: Array<typeof systemRole.$inferSelect>, directory = '';
  const reads: Array<{ path: string; actor: Actor; http_status: number; before: string; after: string; unchanged: boolean; r2_reads: number;
    resources_before: ReturnType<Awaited<ReturnType<typeof diyPageSettingsFixture>>['resources']>; resources_after: ReturnType<Awaited<ReturnType<typeof diyPageSettingsFixture>>['resources']> }> = [];
  beforeAll(async () => {
    now = new Date(); vi.setSystemTime(now); f = await diyPageSettingsFixture(now); wiring.container = f.container;
    expect(f.tables).toHaveLength(73); expect(f.sequences).toHaveLength(68);
    schemas = await f.db.select().from(systemDise); attachments = await f.db.select().from(systemAttachment); roles = await f.db.select().from(systemRole);
    directory = await mkdtemp(join(tmpdir(), 'cinashop-diy-page-settings-native-'));
    const text = JSON.stringify({ tables: f.tables, sequences: f.sequences, inherited_setup: { before: f.beforeBrowserSetup, after: f.afterBrowserSetup,
      resources_before: f.beforeBrowserSetupResources, resources_after: f.afterBrowserSetupResources }, customer_setup: f.setup,
      page_settings_setup: f.pageSettingsSetup, background_images: [f.platformImage, f.secondIcon],
      note: 'The inherited AttachmentService really uploaded these platform raster bytes. Role, image, row and serial alignment are setup, never measured GET work.' }, null, 2) + '\n';
    const path = join(directory, 'setup.json'); await writeFile(path, text); process.stdout.write('DIY_PAGE_SETTINGS_SETUP ' + JSON.stringify({ path, sha256: sha(text), tables: f.tables.length, sequences: f.sequences.length }) + '\n');
  }, 60_000);
  afterAll(async () => {
    try {
      if (f && directory) {
        const text = JSON.stringify({ reads, snapshots: [...registry].map(([sha256, value]) => ({ sha256, value })), tables: f.tables, sequences: f.sequences,
          final: await f.snapshot(), resources: f.resources(), note: 'Every complete real GET body/asset byte read is fenced by all owned tables/sequences and resource-write snapshots. R2 reads are recorded separately. Actual Admin mutations and explicit setup are separate.' }, null, 2) + '\n';
        const path = join(directory, 'reads.json'); await writeFile(path, text); process.stdout.write('DIY_PAGE_SETTINGS_READS ' + JSON.stringify({ path, sha256: sha(text), count: reads.length, all_unchanged: reads.every(read => read.unchanged) }) + '\n');
      }
    } finally { wiring.container = undefined; vi.useRealTimers(); await f?.close(); }
  }, 30_000);
  beforeEach(() => { vi.setSystemTime(now); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned page-settings suite forbids external network')); });
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally {
      vi.restoreAllMocks();
      await f.db.delete(systemDise); await f.db.insert(systemDise).values(schemas);
      await f.db.delete(systemAttachment); await f.db.insert(systemAttachment).values(attachments);
      await f.db.delete(systemRole); await f.db.insert(systemRole).values(roles); f.cache.clear();
    }
  });
  const remember = (snapshot: DiyStateSnapshot) => { const hash = sha(stableDiyState(snapshot)); registry.set(hash, snapshot); return hash; };
  const token = (actor: Actor) => actor === 'admin' ? f.adminToken : actor === 'reader' ? f.readerToken : actor === 11 ? f.token : actor === 22 ? f.otherToken : undefined;
  async function request(path: string, options: { method?: string; actor?: Actor; token?: string; body?: unknown } = {}) {
    const waits: Promise<unknown>[] = [], headers: Record<string, string> = {}, auth = options.token ?? token(options.actor ?? 0);
    if (auth) headers['Authori-zation'] = 'Bearer ' + auth;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await app.fetch(new Request('https://owned-page-settings.local' + path, { method: options.method ?? 'GET', headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }), f.env,
      { waitUntil: (work: Promise<unknown>) => { waits.push(work); }, passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(waits); return response;
  }
  async function get(path: string, actor: Actor = 0) {
    const before = await f.snapshot(), resourcesBefore = f.resources(), initialReads = f.bucket.get.mock.calls.length;
    const response = await request(path, { actor }), bytes = new Uint8Array(await response.arrayBuffer()), after = await f.snapshot(), resourcesAfter = f.resources();
    expect(after).toEqual(before); expect(resourcesAfter).toEqual(resourcesBefore);
    reads.push({ path, actor, http_status: response.status, before: remember(before), after: remember(after), unchanged: true,
      r2_reads: f.bucket.get.mock.calls.length - initialReads, resources_before: resourcesBefore, resources_after: resourcesAfter });
    return { response, bytes, body: () => JSON.parse(new TextDecoder().decode(bytes)) as Row };
  }
  async function page(id = 2, actor: Actor = 0) {
    const result = await get('/api/diy/get_diy/' + id, actor); expect(result.response.status).toBe(200); expect(result.body().status).toBe(200);
    expect(result.response.headers.get('Cache-Control')).toBe('no-store'); return result.body().data as Row;
  }
  async function save(body: Row, actor: Actor = 'admin', customToken?: string) {
    const before = await f.snapshot(), resources = f.resources(), response = await request('/adminapi/dise/save', { method: 'POST', actor, token: customToken, body });
    const json = await response.json() as Row, after = await f.snapshot(); expect(f.resources()).toEqual(resources); return { before, after, response, body: json };
  }
  function edited(result: Awaited<ReturnType<typeof save>>, patch: Row, id = 2) {
    expect(result.body.status).toBe(200); const old = result.before.system_dise.find(row => row.id === id)!, row = result.after.system_dise.find(value => value.id === id)!;
    expect(row.version).not.toBe(old.version); expect(row.update_time).toBeGreaterThan(old.update_time);
    const expected = structuredClone(result.before); expected.system_dise = expected.system_dise.map(value => value.id === id ? { ...value, ...patch, version: row.version, update_time: row.update_time } : value);
    expect(result.after).toEqual(sortedDiyState(expected)); return row;
  }
  async function imported(patch: Partial<typeof systemDise.$inferInsert>, id = 2) { await f.db.update(systemDise).set(patch).where(eq(systemDise.id, id)); }

  it('keeps owned setup limited to intended row appearance/body fields and serial alignment, with no resource writes', () => {
    const setup = f.pageSettingsSetup, expected = structuredClone(setup.before);
    expected.system_dise = setup.after.system_dise; expected.__sequences = expected.__sequences.map(row => row.name === 'system_dise_id_seq' ? setup.after.__sequences.find(next => next.name === row.name)! : row);
    expect(setup.after).toEqual(sortedDiyState(expected)); expect(setup.resources_after).toEqual(setup.resources_before);
    for (const image of [f.platformImage, f.secondIcon]) { const attachment = attachments.find(row => row.attId === image.att_id)!;
      expect(attachment.type).toBe(1); expect(attachment.relationId).toBe(0); expect(attachment.moduleType).toBe(1); expect(attachment.fileType).toBe(1); expect(attachment.attType).toBe('image/png'.padEnd(30, ' ')); expect(f.objects.get(attachment.name)?.bytes).toEqual(f.png);
    }
  });
  it('public home0 and micro2 expose their actual row metadata and fresh raster tickets to guests and both owners with complete GET zero-write proof', async () => {
    for (const id of [0, 2]) for (const actor of [0, 11, 22] as const) {
      const result = await page(id, actor), wanted = id === 0 ? f.homeAppearance : f.microAppearance;
      expect({ ...result, value: undefined, bg_pic: canonical(result.bg_pic) }).toMatchObject({ ...wanted, bg_pic: wanted.bg_pic, title: id === 0 ? '真实背景首页' : '真实背景微页' });
      expect(result.bg_pic).toMatch(/\?expires=\d+&signature=/u); expect(result.value[0]).toEqual(f.blocks[0]);
      const version = await get('/api/diy/diy_version/' + id, actor); expect(version.body().data.version).toBe('diy-page-settings-1'); expect(version.response.headers.get('Cache-Control')).toBe('no-store');
    }
  });
  it('actual Admin list returns raw canonical appearance separately from unchanged component value and legacy content', async () => {
    const result = await get('/adminapi/dise/list', 'reader'); expect(result.body().status).toBe(200); expect(result.response.headers.get('Cache-Control')).toBe('private, no-store');
    const row = result.body().data.find((value: Row) => value.id === 2); expect(row).toMatchObject({ ...f.microAppearance, value: JSON.stringify(f.blocks), content: 'independent-owned-page-settings-content' }); expect(row.bg_pic).not.toContain('signature=');
  });
  it('authenticated metadata-only edit changes all six actual author fields and title with only target row/version/updateTime writes', async () => {
    const patch = { title: '作者新标题', is_show: 1, is_bg_color: 1, is_bg_pic: 1, color_picker: '#663399', bg_pic: f.platformImage.url, bg_tab_val: 2 };
    const row = edited(await save({ id: 2, ...patch }), patch); expect(row.value).toBe(JSON.stringify(f.blocks)); expect(row.content).toBe('independent-owned-page-settings-content'); expect(row.type).toBe(2); expect(row.status).toBe(1);
    expect(await page()).toMatchObject({ ...patch, bg_pic: expect.stringContaining('?expires=') });
  });
  it('composes real old component canonical save with row appearance while preserving all unknown/media-neighbour and content bytes', async () => {
    const value = structuredClone(f.blocks); value[0].authorUnknown = { reference: oldTicket(f.secondIcon.url), zero: 0 };
    const row = edited(await save({ id: 2, value: JSON.stringify(value), bg_pic: oldTicket(f.platformImage.url), color_picker: '#1234' }),
      { value: JSON.stringify(value), bg_pic: f.platformImage.url, color_picker: '#1234' });
    expect(JSON.parse(row.value).find((block: Row) => block.name === 'unknown-neighbor')).toEqual(f.blocks.find(block => block.name === 'unknown-neighbor'));
  });
  it.each([0, 1, 2])('actual save/read mode%d roundtrip preserves the independent colour/image flags and component document', async mode => {
    edited(await save({ id: 2, bg_tab_val: mode }), { bg_tab_val: mode }); expect((await page()).bg_tab_val).toBe(mode);
  });
  it('old title-only/status-only callers preserve every new metadata field and current raw body/content', async () => {
    edited(await save({ id: 2, title: '只改原标题' }), { title: '只改原标题' });
    edited(await save({ id: 2, status: 0 }), { status: 0 }); const result = await page(); expect(canonical(result.bg_pic)).toBe(f.secondIcon.url); expect(result.is_show).toBe(1);
    // The pre-existing explicit-ID public lookup does not treat status as ACL.
  });
  it('turning independent page and background flags off retains canonical author values and does not silently replace status', async () => {
    const row = edited(await save({ id: 2, is_show: 0, is_bg_color: 0, is_bg_pic: 0 }), { is_show: 0, is_bg_color: 0, is_bg_pic: 0 });
    expect(row.bg_pic).toBe(f.secondIcon.url); expect(row.color_picker).toBe(f.microAppearance.color_picker); expect(row.status).toBe(1);
    expect(await page()).toMatchObject({ is_show: 0, is_bg_color: 0, is_bg_pic: 0, bg_pic: expect.stringContaining('?expires=') });
    edited(await save({ id: 2, is_show: 1, is_bg_pic: 1 }), { is_show: 1, is_bg_pic: 1 }); expect(canonical((await page()).bg_pic)).toBe(f.secondIcon.url);
  });
  it('explicit empty metadata remains an empty stored/list value while create defaults stay hidden/stopped and use existing serial allocation', async () => {
    edited(await save({ id: 2, bg_pic: '', color_picker: '' }), { bg_pic: '', color_picker: '' });
    const list = (await get('/adminapi/dise/list', 'admin')).body().data; expect(list.find((row: Row) => row.id === 2)).toMatchObject({ bg_pic: '', color_picker: '' });
    const result = await save({ create_kind: 'diy_page', name: '真实新增页', value: JSON.stringify(f.blocks), is_show: 0, is_bg_color: 1,
      color_picker: '#f5f5f5', bg_pic: oldTicket(f.platformImage.url), is_bg_pic: 1, bg_tab_val: 2 });
    expect(result.body.status).toBe(200); const row = result.after.system_dise.find(value => value.id === result.body.data.id)!;
    expect(row).toMatchObject({ type: 1, is_diy: 1, status: 0, is_show: 0, title: '真实新增页', color_picker: '#f5f5f5', bg_pic: f.platformImage.url, bg_tab_val: 2 });
    const expected = structuredClone(result.before); expected.system_dise.push(row); expected.__sequences = expected.__sequences.map(value => value.name === 'system_dise_id_seq' ? result.after.__sequences.find(next => next.name === value.name)! : value); expect(result.after).toEqual(sortedDiyState(expected));
  });
  it('creates default metadata without enabling visibility, painting a background, copying content or altering immutable domain defaults', async () => {
    const result = await save({ create_kind: 'diy_page', name: '默认新页面', value: '[]' }); expect(result.body.status).toBe(200);
    const row = result.after.system_dise.find(value => value.id === result.body.data.id)!; expect(row).toMatchObject({ status: 0, is_show: 0, is_bg_color: 0, is_bg_pic: 0, bg_tab_val: 0, bg_pic: '', color_picker: '', content: '', type: 1, is_diy: 1 });
  });
  it('reads actual current PNG bytes and expires an old901-second capability while equal-version row reread returns a fresh usable ticket', async () => {
    const before = await f.snapshot(), old = (await page()).bg_pic; expect((await get(old)).bytes).toEqual(f.png);
    vi.setSystemTime(new Date(now.getTime() + 901_000)); expect((await get(old)).response.status).toBe(404);
    const fresh = (await page()).bg_pic; expect(fresh).not.toBe(old); expect((await get(fresh)).bytes).toEqual(f.png); expect((await get(fresh)).response.headers.get('Content-Type')).toBe('image/png'); expect(await f.snapshot()).toEqual(before);
  });
  it('read/edit/save canonicalizes only actual bg_pic tickets without persisting them or altering value/content/cover/other row fields', async () => {
    const published = await page(), row = edited(await save({ id: 2, bg_pic: published.bg_pic, bg_tab_val: 2 }), { bg_pic: f.secondIcon.url, bg_tab_val: 2 });
    expect(row.value).toBe(JSON.stringify(f.blocks)); expect(row.content).toBe('independent-owned-page-settings-content'); expect(row.bg_pic).not.toContain('signature');
  });
  it.each([
    ['private user', { type: 3, relationId: 11, moduleType: 3 }], ['foreign user', { type: 3, relationId: 22, moduleType: 3 }],
    ['merchant', { type: 2, relationId: 7 }], ['supplier', { type: 4, relationId: 7 }], ['foreign relation', { relationId: 11 }],
    ['foreign module', { moduleType: 3 }], ['video filetype', { fileType: 2 }], ['nonR2', { imageType: 0 }],
    ['MIME mismatch', { attType: 'image/jpeg' }], ['bad raster object key', { name: 'attachments/admin/1/not-an-image.svg' }], ['foreign attDir', { attDir: '/api/assets/999999' }],
  ] as const)('fresh row background owner lookup rejects %s, including an imported old ticket and disabled image flag', async (_name, change) => {
    const old = (await page()).bg_pic; await imported({ bgPic: old, isBgPic: 0 }); await f.db.update(systemAttachment).set(change).where(eq(systemAttachment.attId, f.secondIcon.att_id));
    for (const actor of [0, 11, 22] as const) expect((await page(2, actor)).bg_pic).toBe('');
  });
  it('rejects a deleted attachment rather than returning a canonical private ID, and a missing R2 object yields real404 rather than synthetic pixels', async () => {
    const old = (await page()).bg_pic, image = attachments.find(row => row.attId === f.secondIcon.att_id)!, object = f.objects.get(image.name)!;
    f.objects.delete(image.name); try { expect((await get(old)).response.status).toBe(404); } finally { f.objects.set(image.name, object); }
    await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, image.attId)); await imported({ bgPic: old }); expect((await page()).bg_pic).toBe('');
  });
  it('retains safe256-character external/static and foreign asset-shaped URLs verbatim without network access or local signatures', async () => {
    const prefix = 'https://image.example.test/', exact = prefix + 'a'.repeat(256 - prefix.length);
    for (const reference of ['/static/logo.png', exact, 'https://foreign.example.test' + oldTicket(f.platformImage.url)]) {
      edited(await save({ id: 2, bg_pic: reference }), { bg_pic: reference }); expect((await page()).bg_pic).toBe(reference);
    }
  });
  it('refuses malformed and encoded imported asset IDs instead of expanding row media authority to arbitrary strings or HTML entities', async () => {
    // The inclusive column-ID boundary is valid author syntax, but a nonexistent
    // attachment still receives no public capability after its actual lookup.
    edited(await save({ id: 2, bg_pic: '/api/assets/2147483647' }), { bg_pic: '/api/assets/2147483647' });
    expect((await page()).bg_pic).toBe('');
    for (const reference of ['/api/assets/&#49;', '/api/assets/&amp;#49;', '/api/assets/%31', '/api/assets/0', '/api/assets/2147483648', oldTicket('/api/assets/2147483648'), '/api/assets/9007199254740991', 'javascript:alert(1)', '//foreign.example.test/a.png', 'https://user:pass@foreign.example.test/a.png']) {
      const failed = await save({ id: 2, bg_pic: reference }); expect(failed.body.status).toBe(400); expect(failed.after).toEqual(failed.before);
      await imported({ bgPic: reference }); expect((await page()).bg_pic).toBe('');
    }
  });
  it('keeps encoded local-asset prefixes literal after an actual save/read and never signs the private attachment hidden by those JSON bytes', async () => {
    const privateImage = attachments.find(row => row.type === 3 && row.relationId === 11 && row.fileType === 1)!;
    expect(privateImage).toBeDefined();
    for (const reference of [`/&#97;pi/assets/${privateImage.attId}`, `/api&#47;assets/${privateImage.attId}`, `/&#x61;pi/assets/${privateImage.attId}`, `/&amp;#97;pi/assets/${privateImage.attId}`]) {
      edited(await save({ id: 2, bg_pic: reference }), { bg_pic: reference });
      for (const actor of [0, 11, 22] as const) { const row = await page(2, actor); expect(row.bg_pic).toBe(reference); expect(row.bg_pic).not.toContain('signature='); }
    }
  });
  it('does not sign cover_image or nested background-like/link neighbours from an actual row save and public read', async () => {
    const value = [{ name: 'extension', bg_pic: oldTicket(f.platformImage.url), logoConfig: { url: oldTicket(f.platformImage.url) }, link: oldTicket(f.platformImage.url) }];
    await imported({ value: JSON.stringify(value), coverImage: oldTicket(f.platformImage.url) });
    edited(await save({ id: 2, bg_pic: oldTicket(f.secondIcon.url) }), { bg_pic: f.secondIcon.url }); expect((await page()).value).toEqual(value);
  });
  it('adds one row slot without consuming the old complete2500 ordinary component budget or silently permitting its slot2501', async () => {
    const value = Array.from({ length: 2500 }, () => ({ name: 'news', imgConfig: { url: '/static/logo.png' } })); await imported({ value: JSON.stringify(value) });
    const result = await page(); expect(result.value).toHaveLength(2500); expect(result.bg_pic).toContain('?expires=');
    await imported({ value: JSON.stringify([...value, value[0]]) });
    const owners = vi.spyOn(presentationMedia, 'publicDiyPresentationImages'), signatures = vi.spyOn(attachmentsService, 'signAttachmentReferences');
    expect((await get('/api/diy/get_diy/2')).body().status).toBe(400);
    expect(owners).not.toHaveBeenCalled(); expect(signatures).not.toHaveBeenCalled();
  });
  it('propagates a synthetic row-signing failure with no partial public DTO, database/sequence mutation or resource write', async () => {
    vi.spyOn(attachmentsService, 'signAttachmentReferences').mockRejectedValueOnce(Error('synthetic row signature unavailable'));
    const result = await get('/api/diy/get_diy/2'); expect(result.body().status).not.toBe(200); expect(result.body().data?.bg_pic).toBeUndefined();
  });
  it.each([0, 'reader', 11, 22] as const)('refuses actual Admin save by actor%s without broadening ACL or changing any state', async actor => {
    const result = await save({ id: 2, is_show: 1, bg_pic: f.platformImage.url }, actor); expect(result.body.status).not.toBe(200); expect(result.after).toEqual(result.before);
  });
  it('uses the live editor role and retains immutable/special-domain protections at the actual transaction', async () => {
    await f.db.update(systemRole).set({ rules: 'dise.view,attachment.view' }).where(eq(systemRole.id, 901));
    const denied = await save({ id: 2, bg_tab_val: 2 }); expect(denied.body.status).not.toBe(200); expect(denied.after).toEqual(denied.before);
    await f.db.update(systemRole).set(roles.find(row => row.id === 901)!).where(eq(systemRole.id, 901));
    for (const patch of [{ type: 1 }, { template_name: 'default' }, { is_diy: 0 }, { version: 'forged' }]) { const failed = await save({ id: 2, bg_tab_val: 2, ...patch }); expect(failed.body.status).toBe(400); expect(failed.after).toEqual(failed.before); }
    for (const templateName of ['suspended_window', 'color_change', 'category', 'product_detail', 'member']) { await imported({ templateName }); const failed = await save({ id: 2, is_show: 1 }); expect(failed.body.status).toBe(400); expect(failed.after).toEqual(failed.before); }
    await imported({ templateName: '', type: 3 }); const reserved = await save({ id: 2, bg_tab_val: 0 }); expect(reserved.body.status).toBe(400); expect(reserved.after).toEqual(reserved.before);
  });
  it('rejects invalid author primitives, overlong columns, unsafe colours and attempts to enable new rows atomically', async () => {
    for (const patch of [{ is_show: '1' }, { is_bg_color: true }, { is_bg_pic: [] }, { bg_tab_val: '2' }, { bg_tab_val: 3 }, { color_picker: 'url(/api/assets/1)' }, { color_picker: 'a'.repeat(51) }, { bg_pic: '/static/' + 'a'.repeat(249) }]) {
      const failed = await save({ id: 2, ...patch }); expect(failed.body.status).toBe(400); expect(failed.after).toEqual(failed.before);
    }
    for (const patch of [{ is_show: 1 }, { status: 1 }]) { const failed = await save({ create_kind: 'diy_page', name: '拒绝自动启用', value: '[]', ...patch }); expect(failed.body.status).toBe(400); expect(failed.after).toEqual(failed.before); }
  });
  it('retains2MB UTF8/100k-node/depth64 validation and rejects metadata-only updates to an already corrupt persisted component document', async () => {
    const value = [{ name: 'unknown', note: '界' }], size = Buffer.byteLength(JSON.stringify(value)); value[0].note += 'a'.repeat(2_000_000 - size);
    edited(await save({ id: 2, value: JSON.stringify(value), bg_tab_val: 2 }), { value: JSON.stringify(value), bg_tab_val: 2 });
    for (const bad of [JSON.stringify([{ ...value[0], note: value[0].note + 'a' }]), JSON.stringify(Array(100001).fill(0)), JSON.stringify(Array.from({ length: 65 }).reduce<unknown>(next => ({ next }), ''))]) { const failed = await save({ id: 2, value: bad, is_show: 1 }); expect(failed.body.status).toBe(400); expect(failed.after).toEqual(failed.before); }
    await imported({ value: '{broken' }); const failed = await save({ id: 2, bg_tab_val: 0 }); expect(failed.body.status).toBe(400); expect(failed.after).toEqual(failed.before);
  }, 30_000);
  it('preserves default homepage lookup/fallback and station gate without accepting a guessed version or writing a read', async () => {
    await f.db.update(systemDise).set({ status: 0 }).where(eq(systemDise.id, 1)); expect((await page(0)).title).toBe('真实背景首页');
    expect((await page(999999)).title).toBe('真实背景首页');
    await f.station('0'); try { for (const path of ['/api/diy/get_diy/0', '/api/diy/get_diy/2', '/api/diy/diy_version/0']) expect((await get(path)).body().status).toBe(410010); }
    finally { await f.station('1'); }
    expect((await page(0)).bg_pic).toContain('?expires=');
  });
});
