import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemAttachment, systemDise } from '@/models/schema';
import { diyPresentationHtmlMediaReferences } from '../../view/common/diyPresentationHtml';
import { diyMediaReferenceFixture } from './helpers/diyMediaReferenceFixture';
import { sortedDiyState, stableDiyState, type DiyStateRow as Row, type DiyStateSnapshot } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned media-reference SQL'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned media-reference Admin SQL'); return { container: wiring.container, close: async () => {} }; } }));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const encoded = (path: string, layers = 1) => path.replace('/api/', '/' + (layers === 1 ? '&#97;' : layers === 2 ? '&amp;#97;' : '&amp;amp;#97;') + 'pi/');
const oldTicket = (reference: string) => reference + '?expires=1&signature=historical';
type Actor = 0 | 11 | 22 | 'admin' | 'reader';
type Slot = 'customer-logo' | 'video-poster' | 'video-source' | 'news' | 'menus' | 'footer' | 'html-image' | 'html-video';
function block(slot: Slot, reference: string): Row {
  const base = { timestamp: 100, isHide: false, authorNote: { keep: ['unknown', 0, false] }, link: reference, preview: reference };
  if (slot === 'customer-logo') return { ...base, name: 'customerService', logoConfig: { url: reference, link: reference } };
  if (slot === 'video-poster' || slot === 'video-source') return { ...base, name: 'videos', imgConfig: { url: slot === 'video-poster' ? reference : '' }, videoConfig: { url: slot === 'video-source' ? reference : '' } };
  if (slot === 'news') return { ...base, name: 'news', imgConfig: { url: reference } };
  if (slot === 'menus') return { ...base, name: 'menus', menuConfig: { list: [{ img: reference, link: reference, title: '真实菜单' }] } };
  if (slot === 'footer') return { ...base, name: 'pageFoot', menuList: [{ imgList: [reference, reference, reference], link: reference, name: '真实页脚' }] };
  return { ...base, name: 'richText', richText: { val: `<p>保留作者正文<a href="${reference}">作者链接</a></p><${slot === 'html-image' ? 'img' : 'video'} src="${reference}"${slot === 'html-video' ? ' controls' : ''}><p>保留后文</p>` } };
}
function media(slot: Slot, value: Row): string {
  if (slot === 'customer-logo') return value.logoConfig.url;
  if (slot === 'video-poster') return value.imgConfig.url;
  if (slot === 'video-source') return value.videoConfig.url;
  if (slot === 'news') return value.imgConfig.url;
  if (slot === 'menus') return value.menuConfig.list[0].img;
  if (slot === 'footer') return value.menuList[0].imgList[0];
  return diyPresentationHtmlMediaReferences(value.richText.val)[0]?.value ?? '';
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual DIY reference authority before capability minting on owned PG16', () => {
  const app = createApp(), registry = new Map<string, DiyStateSnapshot>(), reads: Row[] = [], writes: Row[] = [], observations: Row[] = [];
  let f: Awaited<ReturnType<typeof diyMediaReferenceFixture>>, now: Date, directory = '', schemas: Array<typeof systemDise.$inferSelect>, attachments: Array<typeof systemAttachment.$inferSelect>;
  const remember = (value: DiyStateSnapshot) => { const hash = sha(stableDiyState(value)); registry.set(hash, value); return hash; };
  beforeAll(async () => {
    now = new Date(); vi.setSystemTime(now); f = await diyMediaReferenceFixture(now); wiring.container = f.container;
    expect(f.tables).toHaveLength(73); expect(f.sequences).toHaveLength(68);
    schemas = await f.db.select().from(systemDise); attachments = await f.db.select().from(systemAttachment);
    directory = await mkdtemp(join(tmpdir(), 'cinashop-diy-media-reference-native-'));
    const setup = { tables: f.tables, sequences: f.sequences, inherited: { before: f.beforeBrowserSetup, after: f.afterBrowserSetup,
      resources_before: f.beforeBrowserSetupResources, resources_after: f.afterBrowserSetupResources }, customer: f.setup, page: f.pageSettingsSetup,
      additional_real_uploads: f.mediaReferenceSetup, images: { platform: f.platformImage, private11: f.image, private22: f.foreignImage }, video: f.privateVideo,
      png: { bytes: f.png.length, sha256: sha(f.png) }, mp4: { bytes: f.mp4.length, sha256: sha(f.mp4) },
      note: 'All uploads, persisted rows and role/JWT setup are actual services; no fabricated business API DTO or attachment metadata. The new fixture retains73tables68sequences.' };
    const text = JSON.stringify(setup, null, 2) + '\n', path = join(directory, 'setup.json'); await writeFile(path, text);
    process.stdout.write('DIY_MEDIA_REFERENCE_SETUP ' + JSON.stringify({ path, sha256: sha(text), tables: f.tables.length, sequences: f.sequences.length }) + '\n');
  }, 60_000);
  afterAll(async () => {
    try {
      if (f && directory) {
        const proof = { reads, writes, observations, snapshots: [...registry].map(([sha256, value]) => ({ sha256, value })), tables: f.tables, sequences: f.sequences,
          final: await f.snapshot(), resources: f.resources(), serialization: 'sha256(stableDiyState(snapshot)): actual Node helper, all table rows and all sequence state',
          note: 'Desired strict assertions run after evidence collection. A failed old-source case retains its actual minted HMAC and anonymous private bytes. GET resource writes are never allowed; R2 reads are recorded separately. Setup/import/real authenticated Admin save writes are explicit.' };
        const text = JSON.stringify(proof, null, 2) + '\n', path = join(directory, 'proof.json'); await writeFile(path, text);
        process.stdout.write('DIY_MEDIA_REFERENCE_PROOF ' + JSON.stringify({ path, sha256: sha(text), count: reads.length,
          all_unchanged: reads.every(value => value.unchanged), minted_unapproved: observations.filter(value => value.unapproved && value.minted && value.hmac_valid && value.actual_bytes_match).length }) + '\n');
      }
    } finally { wiring.container = undefined; vi.useRealTimers(); await f?.close(); }
  }, 30_000);
  beforeEach(() => { vi.setSystemTime(now); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned media-reference suite forbids external I/O')); });
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f.db.delete(systemDise); await f.db.insert(systemDise).values(schemas);
      await f.db.delete(systemAttachment); await f.db.insert(systemAttachment).values(attachments); f.cache.clear(); }
  });
  const token = (actor: Actor) => actor === 'admin' ? f.adminToken : actor === 'reader' ? f.readerToken : actor === 11 ? f.token : actor === 22 ? f.otherToken : undefined;
  async function request(path: string, actor: Actor = 0, method = 'GET', body?: Row) {
    const waits: Promise<unknown>[] = [], headers: Record<string, string> = {}, auth = token(actor);
    if (auth) headers['Authori-zation'] = 'Bearer ' + auth;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await app.fetch(new Request('https://owned-media-reference.local' + path, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), f.env,
      { waitUntil: (work: Promise<unknown>) => { waits.push(work); }, passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(waits); return response;
  }
  async function get(path: string, actor: Actor = 0) {
    const before = await f.snapshot(), resourcesBefore = f.resources(), initialReads = f.bucket.get.mock.calls.length;
    const response = await request(path, actor), bytes = new Uint8Array(await response.arrayBuffer()), after = await f.snapshot(), resourcesAfter = f.resources();
    const unchanged = stableDiyState(before) === stableDiyState(after) && stableDiyState(resourcesBefore) === stableDiyState(resourcesAfter);
    reads.push({ path, actor, http_status: response.status, before: remember(before), after: remember(after), unchanged,
      r2_reads: f.bucket.get.mock.calls.length - initialReads, bytes: bytes.length, body_sha256: sha(bytes), resources_before: resourcesBefore, resources_after: resourcesAfter });
    expect(after).toEqual(before); expect(resourcesAfter).toEqual(resourcesBefore);
    return { response, bytes, body: () => JSON.parse(new TextDecoder().decode(bytes)) as Row };
  }
  async function page(slot: Slot, id = 2, actor: Actor = 0) {
    const result = await get('/api/diy/get_diy/' + id, actor); expect(result.response.status).toBe(200); expect(result.body().status).toBe(200);
    expect(result.response.headers.get('Cache-Control')).toBe('no-store');
    const value = result.body().data.value.find((value: Row) => value.name === block(slot, '').name); expect(value).toBeDefined(); return value as Row;
  }
  async function navigation() {
    const result = await get('/api/navigation'); expect(result.response.status).toBe(200); expect(result.body().status).toBe(200);
    expect(result.response.headers.get('Cache-Control')).toBe('no-store'); return result.body().data as Row;
  }
  async function install(value: Row[], id = 2) {
    const before = await f.snapshot(), resources = f.resources();
    await f.db.update(systemDise).set({ value: JSON.stringify(value) }).where(eq(systemDise.id, id)); const after = await f.snapshot();
    const expected = structuredClone(before); expected.system_dise = expected.system_dise.map(row => row.id === id ? { ...row, value: JSON.stringify(value) } : row);
    expect(after).toEqual(sortedDiyState(expected)); expect(f.resources()).toEqual(resources);
    writes.push({ phase: 'explicit imported-schema owned setup', id, before: remember(before), after: remember(after), resources_before: resources, resources_after: f.resources() });
  }
  async function save(value: Row[], expectedValue = value, id = 2, actor: Actor = 'admin') {
    const before = await f.snapshot(), resources = f.resources(), response = await request('/adminapi/dise/save', actor, 'POST', { id, value: JSON.stringify(value) });
    const body = await response.json() as Row, after = await f.snapshot();
    writes.push({ phase: 'actual authenticated Admin save', actor, id, http_status: response.status, api_status: body.status,
      before: remember(before), after: remember(after), resources_before: resources, resources_after: f.resources() });
    expect(f.resources()).toEqual(resources);
    if (actor !== 'admin') { expect(body.status).not.toBe(200); expect(after).toEqual(before); return; }
    expect(body.status).toBe(200); const row = after.system_dise.find(row => row.id === id)!;
    const expected = structuredClone(before); expected.system_dise = expected.system_dise.map(old => old.id === id ? { ...old, value: JSON.stringify(expectedValue), version: row.version, update_time: row.update_time } : old);
    expect(after).toEqual(sortedDiyState(expected)); expect(row.version).not.toBe(before.system_dise.find(row => row.id === id)!.version);
    expect(row.value).toBe(JSON.stringify(expectedValue));
  }
  async function capability(label: string, value: string, asset: { att_id: number; url: string }, wanted: Uint8Array, unapproved: boolean, assertDenied = true) {
    const match = new RegExp('^/api/assets/' + asset.att_id + '\\?expires=([0-9]+)&signature=([A-Za-z0-9_-]+)$', 'u').exec(value);
    const observation: Row = { label, projected: value, target_id: asset.att_id, unapproved, minted: !!match };
    observations.push(observation);
    if (match) {
      observation.expires = Number(match[1]); observation.hmac_valid = match[2] === createHmac('sha256', f.env.APP_KEY!).update(`GET\n/api/assets/${asset.att_id}\n${match[1]}`).digest('base64url');
      expect(observation.hmac_valid).toBe(true); expect(observation.expires).toBe(Math.floor(Date.now() / 1000) + 900);
      const result = await get(value); observation.asset_http_status = result.response.status; observation.actual_bytes_match = sha(result.bytes) === sha(wanted);
      observation.bytes = result.bytes.length; observation.sha256 = sha(result.bytes); observation.content_type = result.response.headers.get('Content-Type');
      expect(result.response.status).toBe(200); expect(result.bytes).toEqual(wanted); expect(result.response.headers.get('Cache-Control')).toBe('private, no-store');
    }
    // Keep this after HMAC and real bytes so the first red run is a concrete
    // owner-boundary proof, rather than an assumption inferred from a URL.
    if (unapproved && assertDenied) expect(observation.minted, label + ': unapproved attachment must not receive an actual capability').toBe(false);
    else if (!unapproved) expect(observation.minted, label + ': approved current platform media must receive a usable ticket').toBe(true);
    return value;
  }
  async function strict(slot: Slot, value: Row, asset = f.image, label: string = slot) {
    // Verify every actual fixture slot before a rejection assertion, including
    // both footer icons and every HTML attribute, rather than only firstpick.
    const values: string[] = slot === 'footer' ? value.menuList.flatMap((item: Row) => item.imgList.slice(0, 2))
      : slot === 'menus' ? value.menuConfig.list.map((item: Row) => item.img)
      : slot.startsWith('html-') ? diyPresentationHtmlMediaReferences(value.richText.val).map(item => item.value) : [media(slot, value)];
    for (const [index, reference] of values.entries()) await capability(label + ' slot' + index, reference, asset, f.png, true, false);
    expect(values.some(reference => new RegExp('^/api/assets/' + asset.att_id + '\\?expires=[0-9]+&signature=[A-Za-z0-9_-]{43}$', 'u').test(reference)), label + ': no actual slot may mint the unapproved image').toBe(false);
    expect(JSON.stringify(value), label + ': no neighboring or later field acquires a new signature').not.toMatch(/signature=[A-Za-z0-9_-]{43}/u);
  }

  it('retains the actual73-table68-sequence scope and service-uploaded private PNG and MP4 setup', () => {
    for (const [asset, bytes, mime] of [[f.image, f.png, 'image/png'], [f.foreignImage, f.png, 'image/png'], [f.privateVideo, f.mp4, 'video/mp4']] as const) {
      const row = attachments.find(row => row.attId === asset.att_id)!; expect(row.type).toBe(3); expect(row.moduleType).toBe(3);
      expect(row.attType.trim()).toBe(mime); expect(f.objects.get(row.name)?.bytes).toEqual(bytes); expect(row.relationId).toBe(asset === f.foreignImage ? 22 : 11);
    }
    expect(f.mediaReferenceSetup.resources_after.puts - f.mediaReferenceSetup.resources_before.puts).toBe(2);
  });
  it('actual Admin save and public reads issue usable current platform PNG tickets across ordinary, navigation, JSON and rich slots', async () => {
    const slots: Slot[] = ['news', 'menus', 'customer-logo', 'video-poster', 'html-image'];
    for (const slot of slots) {
      const value = block(slot, f.platformImage.url); await save([value]);
      await capability('approved ' + slot, media(slot, await page(slot)), f.platformImage, f.png, false);
    }
    await save([block('footer', f.platformImage.url)], undefined, 1); await capability('approved navigation', media('footer', await navigation()), f.platformImage, f.png, false);
  });
  it.each([0, 'reader'] as const)('rejects actor%s saving a crafted schema without granting Admin authority or writes', async actor => { await save([block('customer-logo', encoded(f.image.url))], undefined, 2, actor); });
  it.each(['customer-logo', 'video-poster', 'video-source'] as const)('rejects canonical private PNG in actual JSON %s slots', async slot => {
    await install([block(slot, f.image.url)]); for (const actor of [0, 11, 22] as const) await strict(slot, await page(slot, 2, actor));
  });
  it.each(['customer-logo', 'video-poster', 'video-source'] as const)('does not decode a JSON prefix after owner approval for imported %s', async slot => {
    await install([block(slot, encoded(f.image.url))]); await strict(slot, await page(slot), f.image, 'JSON single-layer imported ' + slot);
  });
  it.each(['customer-logo', 'video-poster', 'video-source'] as const)('real Admin save does not grant JSON entity references authority in %s', async slot => {
    const value = block(slot, encoded(f.image.url)); await save([value]); await strict(slot, await page(slot), f.image, 'JSON single-layer authenticated save ' + slot);
  });
  it('does not grant foreign user22 PNG authority through a JSON encoded prefix saved by real Admin', async () => {
    const value = block('customer-logo', encoded(f.foreignImage.url)); await save([value]); await strict('customer-logo', await page('customer-logo'), f.foreignImage, 'foreign user22 JSON prefix');
  });
  it('does not grant private user MP4 authority through a JSON video prefix despite real decodable uploaded bytes', async () => {
    await save([block('video-source', encoded(f.privateVideo.url))]); await capability('private real MP4 JSON prefix', media('video-source', await page('video-source')), f.privateVideo, f.mp4, true);
  });
  it('legacy single-layer decoding occurs before owner lookup and refuses the now-canonical private image', async () => {
    await install([block('news', encoded(f.image.url))]); await strict('news', await page('news'), f.image, 'legacy single-layer owner control');
  });
  it.each(['news', 'menus', 'footer'] as const)('does not perform a second owner-bypassing decode for imported legacy %s', async slot => {
    const id = slot === 'footer' ? 1 : 2; await install([block(slot, encoded(f.image.url, 2))], id);
    await strict(slot, slot === 'footer' ? await navigation() : await page(slot), f.image, 'legacy double-layer import ' + slot);
  });
  it('real Admin legacy save preserves the established one decode while later projection cannot mint a private capability', async () => {
    const source = block('news', encoded(f.image.url, 3)), stored = block('news', encoded(f.image.url, 3)); stored.imgConfig.url = encoded(f.image.url, 2);
    await save([source], [stored]); await strict('news', await page('news'), f.image, 'legacy triple-layer authenticated save');
  });
  it.each(['html-image', 'html-video'] as const)('actual HTML once-decoded canonical private attributes are refused in %s', async slot => {
    await install([block(slot, encoded(f.image.url))]); await strict(slot, await page(slot), f.image, 'HTML legitimate one attribute decode control ' + slot);
  });
  it.each(['html-image', 'html-video'] as const)('actual HTML attribute decoding does not authorize a later entity expansion in imported %s', async slot => {
    await install([block(slot, encoded(f.image.url, 2))]); await strict(slot, await page(slot), f.image, 'HTML layered attribute import ' + slot);
  });
  it('authenticated rich HTML save retains nonmedia author bytes while preventing late private image signing', async () => {
    const source = block('html-image', encoded(f.image.url, 2)); await save([source]); await strict('html-image', await page('html-image'), f.image, 'HTML layered authenticated save');
  });
  it('only actual footer positions are image authority and retains navigation row/template selection', async () => {
    const footer = block('footer', f.platformImage.url); footer.menuList[0].imgList[2] = encoded(f.image.url, 2); await install([footer], 1);
    const published = await navigation(); await capability('navigation selected platform', published.menuList[0].imgList[0], f.platformImage, f.png, false);
    expect(published.menuList[0].imgList[2]).toBe(footer.menuList[0].imgList[2]); expect(published.menuList[0].link).toBe(footer.menuList[0].link);
  });
  it('does not interpret links, preview or unknown neighboring strings as image slots', async () => {
    const reference = encoded(f.image.url), known = block('customer-logo', '/static/logo.png'), unknown = { name: 'unknown', timestamp: 120, logoConfig: { url: reference }, richText: { val: `<img src="${reference}">` } };
    known.logoConfig.link = reference; known.preview = reference; await install([known, unknown]);
    const result = (await get('/api/diy/get_diy/2')).body().data.value; expect(result.find((item: Row) => item.name === 'unknown')).toEqual(unknown);
    expect(result[0].logoConfig).toEqual({ url: '/static/logo.png', link: reference }); expect(result[0].preview).toBe(reference);
  });
  it('row background already preserves encoded static references without issuing a private ticket', async () => {
    const value = encoded(f.image.url); await f.db.update(systemDise).set({ bgPic: value }).where(eq(systemDise.id, 2));
    const published = (await get('/api/diy/get_diy/2')).body().data; expect(published.bg_pic).toBe(value); await capability('strict row JSON control', published.bg_pic, f.image, f.png, true);
  });
  it('safe static and foreign JSON strings retain literal entity bytes without being fed to an HTML decoder', async () => {
    for (const reference of ['/static/a&amp;b.png', 'https://foreign.example.test/&#97;pi/assets/' + f.image.att_id]) {
      await install([block('customer-logo', reference)]); const value = media('customer-logo', await page('customer-logo'));
      observations.push({ label: 'literal static/foreign JSON bytes', input: reference, projected: value, unapproved: true, minted: false }); expect(value).toBe(reference);
    }
  });
  it('fresh owner lookup withdraws a previously approved platform capability after current metadata becomes private', async () => {
    await install([block('customer-logo', oldTicket(f.platformImage.url))]); await capability('before owner replacement', media('customer-logo', await page('customer-logo')), f.platformImage, f.png, false);
    await f.db.update(systemAttachment).set({ type: 3, relationId: 11, moduleType: 3 }).where(eq(systemAttachment.attId, f.platformImage.att_id));
    const value = media('customer-logo', await page('customer-logo')); expect(value).toBe(''); await capability('current owner replacement', value, f.platformImage, f.png, true);
  });
  it('same-version reread mints a new platform ticket while the actual old capability is rejected after901seconds', async () => {
    await install([block('customer-logo', f.platformImage.url)]); const old = media('customer-logo', await page('customer-logo'));
    await capability('old platform ticket', old, f.platformImage, f.png, false); vi.setSystemTime(new Date(now.getTime() + 901_000)); expect((await get(old)).response.status).toBe(404);
    const fresh = media('customer-logo', await page('customer-logo')); expect(fresh).not.toBe(old); await capability('fresh platform ticket', fresh, f.platformImage, f.png, false);
  });
  it('preserves closed-station DIY refusal and navigation own public-read contract without business or resource writes', async () => {
    await install([block('footer', f.platformImage.url)], 1); await f.station('0');
    for (const path of ['/api/diy/get_diy/0', '/api/diy/get_diy/2']) expect((await get(path)).body().status).toBe(410010);
    const footer = await navigation();
    for (const [index, reference] of footer.menuList[0].imgList.slice(0, 2).entries()) {
      await capability('existing closed-station navigation icon' + index, reference, f.platformImage, f.png, false);
    }
  });
});
