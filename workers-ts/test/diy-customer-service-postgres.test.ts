import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemAttachment, systemConfig, systemDise, systemRole } from '@/models/schema';
import { DIY_CUSTOMER_SERVICE_MEDIA_SLOT_LIMIT, renderDiyEditorialMedia } from '@/services/content/DiyEditorialMediaPolicy';
import * as productMedia from '@/services/activity/ProductAssetPolicy';
import { canonicalDiyPresentationReference } from '../../view/common/diyPresentationHtml';
import { diyCustomerServiceFixture, DIY_CUSTOMER_CONFIG_DEFAULTS, DIY_CUSTOMER_CONFIG_KEYS } from './helpers/diyCustomerServiceFixture';
import { sortedDiyState, stableDiyState, type DiyStateRow as Row, type DiyStateSnapshot } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing real owned customer-service SQL'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing real owned customer-service Admin SQL'); return { container: wiring.container, close: async () => {} }; } }));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const historical = (value: string) => value + '?expires=1&signature=historical';
const compact = (image: string): Row => ({ name: 'customerService', logoConfig: { url: image } });
function canonical(value: Row[]): Row[] {
  const result = structuredClone(value);
  for (const row of result) {
    if (row.name === 'customerService' && typeof row.logoConfig?.url === 'string') row.logoConfig.url = canonicalDiyPresentationReference(row.logoConfig.url);
    if (row.name === 'pageFoot' && Array.isArray(row.menuList)) for (const item of row.menuList) {
      if (Array.isArray(item.imgList)) for (const index of [0, 1]) if (typeof item.imgList[index] === 'string') item.imgList[index] = canonicalDiyPresentationReference(item.imgList[index]);
    }
  }
  return result;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('real owned PG16 per-page customer-service author, media and existing configuration API', () => {
  let f: Awaited<ReturnType<typeof diyCustomerServiceFixture>>, now: Date, schemas: Array<typeof systemDise.$inferSelect>, configs: Array<typeof systemConfig.$inferSelect>;
  const app = createApp(), snapshots = new Map<string, DiyStateSnapshot>();
  const reads: Array<{ path: string; actor: number; http_status: number; before: string; after: string; resources_before: ReturnType<Awaited<ReturnType<typeof diyCustomerServiceFixture>>['resources']>; resources_after: ReturnType<Awaited<ReturnType<typeof diyCustomerServiceFixture>>['resources']>; r2_reads: number; unchanged: boolean }> = [];
  let proofDirectory = '';
  beforeAll(async () => {
    now = new Date(); vi.setSystemTime(now); f = await diyCustomerServiceFixture(now); wiring.container = f.container;
    expect(f.tables).toHaveLength(73); expect(f.sequences).toHaveLength(68);
    schemas = await f.db.select().from(systemDise); configs = await f.db.select().from(systemConfig);
    proofDirectory = await mkdtemp(join(tmpdir(), 'cinashop-diy-customer-service-native-'));
    const text = JSON.stringify({ tables: f.tables, sequences: f.sequences, inherited_setup: { before: f.beforeBrowserSetup, after: f.afterBrowserSetup,
      resources_before: f.beforeBrowserSetupResources, resources_after: f.afterBrowserSetupResources }, customer_setup: f.setup, image_setup: f.imageSetup }, null, 2) + '\n';
    const path = join(proofDirectory, 'setup.json'); await writeFile(path, text);
    process.stdout.write('DIY_CUSTOMER_SERVICE_SETUP ' + JSON.stringify({ path, sha256: sha(text), tables: f.tables.length, sequences: f.sequences.length, image_uploads: f.batchImages.length }) + '\n');
  }, 60_000);
  afterAll(async () => {
    try {
      if (f && proofDirectory) {
        const text = JSON.stringify({ reads, snapshots: [...snapshots].map(([sha256, value]) => ({ sha256, value })), tables: f.tables, sequences: f.sequences,
          final: await f.snapshot(), resources: f.resources(), note: 'Real API/byte reads consume the full body then compare every owned table, sequence and resource-write counter. R2 reads are separate. Setup/config/actual Admin POSTs are not counted as public reads.' }, null, 2) + '\n';
        const path = join(proofDirectory, 'reads.json'); await writeFile(path, text);
        process.stdout.write('DIY_CUSTOMER_SERVICE_READS ' + JSON.stringify({ path, sha256: sha(text), count: reads.length, all_unchanged: reads.every(row => row.unchanged) }) + '\n');
      }
    } finally { wiring.container = undefined; vi.useRealTimers(); await f?.close(); }
  }, 30_000);
  beforeEach(() => { vi.setSystemTime(now); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned customer-service suite forbids external network')); });
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally {
      vi.restoreAllMocks(); await f.db.delete(systemDise); await f.db.insert(systemDise).values(schemas);
      await f.db.delete(systemConfig); await f.db.insert(systemConfig).values(configs); f.cache.clear();
    }
  });
  function remember(value: DiyStateSnapshot) { const key = sha(stableDiyState(value)); snapshots.set(key, value); return key; }
  async function request(path: string, options: { method?: string; body?: unknown; token?: string } = {}) {
    const waits: Promise<unknown>[] = [], headers: Record<string, string> = {};
    if (options.token) headers['Authori-zation'] = 'Bearer ' + options.token;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await app.fetch(new Request('https://owned-customer-service.local' + path, { method: options.method ?? 'GET', headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }), f.env,
      { waitUntil: (work: Promise<unknown>) => { waits.push(work); }, passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(waits); return response;
  }
  async function get(path: string, actor: 0 | 11 | 22 = 0) {
    const before = await f.snapshot(), initial = f.resources(), count = f.bucket.get.mock.calls.length;
    const response = await request(path, { token: actor === 11 ? f.token : actor === 22 ? f.otherToken : undefined });
    const bytes = new Uint8Array(await response.arrayBuffer()), after = await f.snapshot(), resources = f.resources();
    expect(after).toEqual(before); expect(resources).toEqual(initial);
    reads.push({ path, actor, http_status: response.status, before: remember(before), after: remember(after), resources_before: initial, resources_after: resources,
      r2_reads: f.bucket.get.mock.calls.length - count, unchanged: true });
    return { response, bytes, body: () => JSON.parse(new TextDecoder().decode(bytes)) as Row };
  }
  async function page(id = 2, actor: 0 | 11 | 22 = 0, status = 200): Promise<Row[]> {
    const result = await get('/api/diy/get_diy/' + id, actor); expect(result.response.status).toBe(200); expect(result.body().status).toBe(status);
    expect(result.response.headers.get('Cache-Control')).toContain('no-store'); return result.body().data?.value ?? [];
  }
  async function imported(value: Row[], id = 2) { await f.db.update(systemDise).set({ value: JSON.stringify(value) }).where(eq(systemDise.id, id)); }
  async function save(value: Row[], options: { id?: number; token?: string | null; extra?: Row } = {}) {
    const before = await f.snapshot(), resources = f.resources(), response = await request('/adminapi/dise/save', { method: 'POST', token: options.token === null ? undefined : options.token ?? f.adminToken,
      body: { id: options.id ?? 2, value: JSON.stringify(value), ...options.extra } });
    const body = await response.json() as Row, after = await f.snapshot(); expect(f.resources()).toEqual(resources); return { before, after, body, response };
  }
  function expectedSave(result: { before: DiyStateSnapshot; after: DiyStateSnapshot; body: Row }, value: Row[], id = 2) {
    expect(result.body.status).toBe(200); const old = result.before.system_dise.find(row => row.id === id)!, saved = result.after.system_dise.find(row => row.id === id)!;
    expect(saved.value).toBe(JSON.stringify(value)); expect(saved.version).not.toBe(old.version); expect(saved.update_time).toBeGreaterThan(old.update_time);
    const expected = structuredClone(result.before); expected.system_dise = expected.system_dise.map(row => row.id === id ? { ...row, value: saved.value, version: saved.version, update_time: saved.update_time } : row);
    expect(result.after).toEqual(sortedDiyState(expected)); return saved;
  }

  it('records 257 actual platform image uploads with only owned attachment/sequence and R2 setup writes', () => {
    const setup = f.imageSetup, expected = structuredClone(setup.before); expected.system_attachment = setup.after.system_attachment;
    expected.__sequences = expected.__sequences.map(row => row.name === 'system_attachment_att_id_seq' ? setup.after.__sequences.find(next => next.name === row.name)! : row);
    expect(setup.after).toEqual(sortedDiyState(expected)); expect(setup.count).toBe(257); expect(new Set(f.batchImages.map(row => row.att_id)).size).toBe(257);
    expect(setup.after.system_attachment.length - setup.before.system_attachment.length).toBe(257);
    expect(setup.resources_after.puts - setup.resources_before.puts).toBe(257); expect(setup.resources_after.queue).toBe(setup.resources_before.queue); expect(setup.resources_after.deletes).toBe(setup.resources_before.deletes);
  });
  it('reads the exact authored customer component for home0/micro2 and guest/two owners with fresh platform logo and unchanged full SQL/sequence snapshots', async () => {
    for (const id of [0, 2]) for (const actor of [0, 11, 22] as const) {
      const value = await page(id, actor), customer = value.find(row => row.name === 'customerService')!;
      const expected = structuredClone(f.blocks[0]); expected.routine_contact_type = 0;
      expect(canonical([customer])[0]).toEqual(expected); expect(customer.logoConfig.url).toMatch(new RegExp('^' + f.platformImage.url + '\\?expires='));
      expect(value.find(row => row.name === 'unknown-neighbor')).toEqual(f.blocks[1]); expect(value.some(row => row.name === 'pageFoot')).toBe(id === 2);
      const version = await get('/api/diy/diy_version/' + id, actor); expect(version.body().data.version).toBe('diy-customer-service-1');
    }
  });
  it.each([0, 1, 2, 3])('uses actual get_customer_type for configured mode%d across guest and both actors, returning no private user projection', async type => {
    await f.setCustomerConfig({ customer_type: String(type) });
    for (const actor of [0, 11, 22] as const) {
      const result = await get('/api/get_customer_type', actor); expect(result.response.status).toBe(200); expect(result.body().status).toBe(200);
      expect(result.response.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=300');
      expect(result.body().data).toEqual({ routine_contact_type: 0, customer_type: type, customer_phone: DIY_CUSTOMER_CONFIG_DEFAULTS.customer_phone,
        customer_url: DIY_CUSTOMER_CONFIG_DEFAULTS.customer_url, wechat_work_corpid: DIY_CUSTOMER_CONFIG_DEFAULTS.wechat_work_corpid, userInfo: [] });
    }
  });
  it.each([0, 1])('injects current server routine%d independently of forged author/config mode without modifying the saved JSON', async routine => {
    await f.setCustomerConfig({ routine_contact_type: String(routine), customer_type: '3' });
    for (const id of [0, 2]) {
      const value = await page(id), row = value.find(item => item.name === 'customerService')!; expect(row.routine_contact_type).toBe(routine); expect(row.buttonConfig.tabVal).toBe(0);
      const result = await get('/api/get_customer_type'); expect(result.body().data.routine_contact_type).toBe(routine); expect(result.body().data.customer_type).toBe(3);
    }
    const savedValue = (await f.db.select().from(systemDise).where(eq(systemDise.id, 2)))[0].value;
    expect(savedValue).toBeTypeOf('string');
    expect(JSON.parse(savedValue!)[0].routine_contact_type).toBe(91);
  });
  it('preserves the existing missing-config defaults, text bounds and safe public URL projection at the real endpoint', async () => {
    await f.db.delete(systemConfig).where(and(eq(systemConfig.menuName, 'customer_type'), eq(systemConfig.isStore, 0))); f.cache.clear();
    expect((await get('/api/get_customer_type')).body().data.customer_type).toBe(0);
    await f.setCustomerConfig({ customer_phone: ' ' + '1'.repeat(80) + '\n', customer_url: 'javascript:alert(1)', wechat_work_corpid: ' x'.repeat(100) });
    const value = (await get('/api/get_customer_type')).body().data; expect(value.customer_phone).toBe('1'.repeat(64)); expect(value.customer_url).toBe(''); expect(value.wechat_work_corpid.length).toBe(128); expect(value.userInfo).toEqual([]);
  });
  it('keeps store-scoped shadow configuration from overriding the actual global public service authority', async () => {
    await f.db.insert(systemConfig).values(DIY_CUSTOMER_CONFIG_KEYS.map(menuName => ({ menuName, value: JSON.stringify('store-only-shadow'), isStore: 1, sort: 9999, status: 1 })));
    const value = (await get('/api/get_customer_type', 22)).body().data;
    expect(value).toEqual({ routine_contact_type: 0, customer_type: 0, customer_phone: DIY_CUSTOMER_CONFIG_DEFAULTS.customer_phone,
      customer_url: DIY_CUSTOMER_CONFIG_DEFAULTS.customer_url, wechat_work_corpid: DIY_CUSTOMER_CONFIG_DEFAULTS.wechat_work_corpid, userInfo: [] });
    expect((await page(2, 22))[0].routine_contact_type).toBe(0);
  });
  it('preserves existing non-executing config integers and safe HTTPS/relative grammar without turning arbitrary customer values into a fallback chat grant', async () => {
    await f.setCustomerConfig({ customer_type: '9', routine_contact_type: '2', customer_url: '/pages/article/list?from=customer' });
    const value = (await get('/api/get_customer_type')).body().data; expect(value.customer_type).toBe(9); expect(value.routine_contact_type).toBe(2); expect(value.customer_url).toBe('/pages/article/list?from=customer');
    await f.setCustomerConfig({ customer_type: 'not-a-number', customer_url: 'https://user:pass@foreign.example.test/' });
    expect((await get('/api/get_customer_type')).body().data).toMatchObject({ customer_type: 0, customer_url: '' });
    // Rejecting unsupported UI modes is a consuming controller responsibility;
    // this suite preserves, rather than silently expands, the existing API DTO.
  });
  it('actual authenticated Admin edits every runtime author field while preserving unrelated JSON/content and all immutable row metadata', async () => {
    const value = structuredClone(f.blocks), customer = value[0]; customer.buttonConfig.tabVal = 1; customer.locationConfig.tabVal = 0; customer.topConfig.val = 67;
    customer.logoConfig.url = f.secondIcon.url; customer.logoConfig.link = '/pages/index/index'; customer.setUp.tabVal = 1;
    const result = await save(value), saved = expectedSave(result, value); expect(saved.content).toBe('independent-owned-customer-content'); expect(saved.type).toBe(2); expect(saved.status).toBe(1);
    const published = (await page())[0]; expect(published).toMatchObject({ buttonConfig: { tabVal: 1 }, locationConfig: { tabVal: 0 }, topConfig: { val: 67 } });
    expect(canonical([published])[0]).toEqual({ ...value[0], routine_contact_type: 0 });
  });
  it('signed-read/edit/save stores only canonical logo while link, preview, unknown and other component fields retain their exact bytes', async () => {
    const value = await page(); value[0].topConfig.val = 35; value[0].logoConfig.link = historical(f.platformImage.url); value[0].preview = historical(f.platformImage.url);
    const expected = canonical(value), result = await save(value); expectedSave(result, expected);
    const raw = JSON.parse(result.after.system_dise.find(row => row.id === 2)!.value); expect(raw[0].logoConfig.url).toBe(f.platformImage.url);
    expect(raw[0].logoConfig.link).toBe(historical(f.platformImage.url)); expect(raw[0].preview).toBe(historical(f.platformImage.url));
    // The inherited exact footer is also managed by its own prior policy.
    expect(raw.find((row: Row) => row.name === 'unknown-neighbor')).toEqual(f.blocks[1]);
  });
  it.each(['missing', 'reader', 'api-user', 'invalid'] as const)('refuses actual Admin save with %s authority without any state/resource change', async kind => {
    const token = kind === 'missing' ? null : kind === 'reader' ? f.readerToken : kind === 'api-user' ? f.token : 'invalid.jwt';
    const result = await save([compact(f.platformImage.url)], { token }); expect(result.body.status).not.toBe(200); expect(result.after).toEqual(result.before);
  });
  it('checks the live Admin role and rejects immutable metadata at the existing actual controller', async () => {
    const [role] = await f.db.select().from(systemRole).where(eq(systemRole.id, 901));
    try { await f.db.update(systemRole).set({ rules: 'dise.view,attachment.view' }).where(eq(systemRole.id, 901));
      const result = await save([]); expect(result.body.status).not.toBe(200); expect(result.after).toEqual(result.before);
    } finally { await f.db.update(systemRole).set(role).where(eq(systemRole.id, 901)); }
    for (const extra of [{ type: 1 }, { template_name: 'default' }, { is_diy: 0 }, { version: 'forged' }, { status: true }]) {
      const result = await save([compact(f.platformImage.url)], { extra }); expect(result.body.status).toBe(400); expect(result.after).toEqual(result.before);
    }
  });
  it('serves actual platform raster pixels and refreshes expired901-second tickets without changing canonical JSON/page version', async () => {
    await imported([compact(historical(f.platformImage.url))]); const before = await f.snapshot(), old = (await page())[0].logoConfig.url;
    expect((await get(old)).bytes).toEqual(f.png); vi.setSystemTime(new Date(now.getTime() + 901_000)); const fresh = (await page())[0].logoConfig.url;
    expect(fresh).not.toBe(old); expect((await get(old)).response.status).toBe(404); const bytes = await get(fresh);
    expect(bytes.response.status).toBe(200); expect(bytes.response.headers.get('Content-Type')).toBe('image/png'); expect(bytes.bytes).toEqual(f.png); expect(await f.snapshot()).toEqual(before);
  });
  it.each([
    ['private user', { type: 3, relationId: 11, moduleType: 3 }], ['foreign user', { type: 3, relationId: 22, moduleType: 3 }],
    ['merchant', { type: 2, relationId: 7 }], ['supplier', { type: 4, relationId: 7 }], ['foreign relation', { relationId: 11 }],
    ['foreign module', { moduleType: 3 }], ['video filetype', { fileType: 2 }], ['nonR2', { imageType: 0 }],
    ['MIME mismatch', { attType: 'image/jpeg' }], ['bad key', { name: 'attachments/admin/1/not-real.svg' }], ['foreign attDir', { attDir: '/api/assets/999999' }],
  ] as const)('fresh public projection refuses %s metadata even when the author imports a former signed platform ticket', async (_name, change) => {
    const [original] = await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, f.platformImage.att_id));
    const old = (await page())[0].logoConfig.url;
    try { await f.db.update(systemAttachment).set(change).where(eq(systemAttachment.attId, original.attId)); await imported([compact(old)]);
      for (const actor of [0, 11, 22] as const) expect((await page(2, actor))[0].logoConfig.url).toBe('');
    } finally { await f.db.update(systemAttachment).set(original).where(eq(systemAttachment.attId, original.attId)); }
  });
  it('fresh owner lookup rejects a deleted attachment and never persists a rejected slot or signs bystanders', async () => {
    const [row] = await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, f.platformImage.att_id)); const old = (await page())[0].logoConfig.url;
    try { await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, row.attId)); await imported([{ ...compact(old), link: old }, { name: 'customer-service', logoConfig: { url: old } }]);
      const result = await page(); expect(result[0].logoConfig.url).toBe(''); expect(result[0].link).toBe(old); expect(result[1].logoConfig.url).toBe(old);
    } finally { await f.db.insert(systemAttachment).values(row); }
  });
  it('a missing actual R2 object returns no pixels rather than a synthetic image while the full measured read remains write-free', async () => {
    const [row] = await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, f.platformImage.att_id));
    const object = f.objects.get(row.name)!; const signed = (await page())[0].logoConfig.url;
    try { f.objects.delete(row.name); const result = await get(signed); expect(result.response.status).toBe(404); expect(result.bytes).not.toEqual(f.png); }
    finally { f.objects.set(row.name, object); }
  });
  it('keeps safe external/static/4096-length images and foreign asset-shaped URLs exact without fetching them or granting local signatures', async () => {
    const foreign = 'https://foreign.example.test' + historical(f.platformImage.url), prefix = 'https://images.example.test/';
    const long = prefix + 'a'.repeat(4096 - prefix.length - 4) + '.png'; expect(long).toHaveLength(4096);
    const value = [compact(foreign), compact(long), compact('/static/logo.png')]; expectedSave(await save(value), value);
    expect((await page()).map(row => row.logoConfig.url)).toEqual([foreign, long, '/static/logo.png']);
  });
  it('rejects malformed/encoded local IDs, unsafe protocols, credentials, controls and oversize image references without resolving another local owner', async () => {
    const encoded = '/api/assets/' + [...String(f.platformImage.att_id)].map(char => `&#${char.codePointAt(0)};`).join('');
    const refs = [encoded, encoded.replaceAll('&', '&amp;'), '/api/assets/0', '/api/assets/999999', '/api/assets/2147483648', '/api/assets/1/../2', '/api/assets/1\\bad',
      'javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://foreign.example.test/a.png', 'https://user:pass@foreign.example.test/a.png', '//foreign.example.test/a', 'x'.repeat(4097), '/api/assets/1\n'];
    await imported(refs.map(compact)); expect((await page()).map(row => row.logoConfig.url)).toEqual(refs.map(() => ''));
  });
  it('only exact logoConfig.url is canonical/public authority; link, similarly named fields, unknown types and preview data remain spectators', async () => {
    const old = historical(f.platformImage.url), value = [{ ...compact(old), logoConfig: { url: old, link: old, preview: old, extra: { url: old } },
      imgConfig: { url: old }, logo: old, preview: old, authorExtra: old }, { name: 'CustomerService', logoConfig: { url: old } }];
    const expected = canonical(value); expectedSave(await save(value), expected); const result = await page(); expect(result[0].logoConfig.url).toContain('?expires=');
    result[0].logoConfig.url = f.platformImage.url; result[0].routine_contact_type = 91;
    expect(result[0]).toEqual({ ...expected[0], routine_contact_type: 91 }); expect(result[1]).toEqual(expected[1]);
  });
  it('retains every257 distinct genuinely uploaded platform image across the second HMAC batch, including actual last bytes', async () => {
    const value = f.batchImages.map(row => compact(row.url)); expectedSave(await save(value), value); const result = await page(); expect(result).toHaveLength(257);
    expect(result.map(row => canonicalDiyPresentationReference(row.logoConfig.url))).toEqual(f.batchImages.map(row => row.url));
    expect(new Set(result.map(row => row.logoConfig.url)).size).toBe(257); expect((await get(result[256].logoConfig.url)).bytes).toEqual(f.png);
  });
  it('a separately labeled synthetic second-signature fault cannot partially mutate the collected schema', async () => {
    const value = f.batchImages.map(row => compact(historical(row.url))), original = JSON.stringify(value), resources = f.resources(), before = await f.snapshot();
    const real = productMedia.renderProductPictures; let batches = 0;
    const spy = vi.spyOn(productMedia, 'renderProductPictures').mockImplementation(async (...args) => { if (++batches === 2) throw Error('explicit owned customer second-batch fault'); return real(...args); });
    try { await expect(renderDiyEditorialMedia(f.db, f.env.APP_KEY, value)).rejects.toThrow('explicit owned customer second-batch fault'); expect(batches).toBe(2); expect(JSON.stringify(value)).toBe(original); }
    finally { spy.mockRestore(); }
    expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(resources);
  });
  it('preserves complete compact20000-slot Admin imports and independently rejects20001 before any save or public mutation', async () => {
    expect(DIY_CUSTOMER_SERVICE_MEDIA_SLOT_LIMIT).toBe(20000); const value = Array.from({ length: 20000 }, () => compact(f.platformImage.url));
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(2_000_000); expectedSave(await save(value), value); const result = await page(); expect(result).toHaveLength(20000);
    expect(result.every(row => row.logoConfig.url.includes('?expires='))).toBe(true); const exceeded = [...value, compact(f.platformImage.url)];
    const failed = await save(exceeded); expect(failed.body.status).toBe(400); expect(failed.after).toEqual(failed.before);
    const local = structuredClone(exceeded), copy = JSON.stringify(local); await expect(renderDiyEditorialMedia(f.db, f.env.APP_KEY, local)).rejects.toThrow(); expect(JSON.stringify(local)).toBe(copy);
    await imported(exceeded); expect((await get('/api/diy/get_diy/2')).body().status).toBe(400);
    // 20000 imported policy slots are not 20000 UI controls: normal PHP editor
    // has one, and the existing Uni component renderer still has its200 cap.
  }, 30_000);
  it('covers both10000-reference owner batches without silently losing a valid last local image', async () => {
    const value = Array.from({ length: 20000 }, (_, index) => compact(index === 19999 ? f.platformImage.url : '/api/assets/' + (1_000_000 + index)));
    await imported(value); const result = await page(); expect(result).toHaveLength(20000); expect(result.slice(0, -1).every(row => row.logoConfig.url === '')).toBe(true);
    expect(canonicalDiyPresentationReference(result[19999].logoConfig.url)).toBe(f.platformImage.url); expect((await get(result[19999].logoConfig.url)).bytes).toEqual(f.png);
  }, 30_000);
  it('does not consume prior ordinary/navigation/footer/presentation capacity or authorize their neighboring link fields', async () => {
    const value = [...Array.from({ length: 2500 }, () => ({ name: 'news', imgConfig: { url: '/static/logo.png' } })),
      ...Array.from({ length: 20000 }, () => compact('/static/logo.png'))], original = JSON.stringify(value), before = await f.snapshot(), resources = f.resources();
    await renderDiyEditorialMedia(f.db, f.env.APP_KEY, value); expect(JSON.stringify(value)).toBe(original); expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(resources);
  });
  it('preserves2MB UTF8,100k-node anddepth64 Admin entrance rejection atomically rather than increasing global parser limits', async () => {
    const base = compact(f.platformImage.url), value = [{ ...base, authorText: '界' }], size = Buffer.byteLength(JSON.stringify(value)); value[0].authorText += 'x'.repeat(2_000_000 - size);
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(2_000_000); expectedSave(await save(value), value); expect((await page())[0].authorText).toBe(value[0].authorText);
    value[0].authorText += 'x'; const failed = await save(value); expect(failed.body.status).toBe(400); expect(failed.after).toEqual(failed.before);
    await imported(value); expect(await page()).toEqual([]);
    for (const extra of [Array.from({ length: 100001 }, () => 0), Array.from({ length: 65 }).reduce<unknown>(x => ({ next: x }), '')]) {
      const result = await save([{ ...base, authorExtra: extra }]); expect(result.body.status).toBe(400); expect(result.after).toEqual(result.before);
    }
  }, 30_000);
  it('station closure rejects page/version/config reads without media work; exact reopening returns fresh real public state', async () => {
    await f.station('0'); try {
      for (const path of ['/api/diy/get_diy/0', '/api/diy/get_diy/2', '/api/diy/diy_version/0', '/api/get_customer_type']) {
        const result = await get(path); expect(result.body().status).toBe(410010);
      }
    } finally { await f.station('1'); }
    expect((await page(0))[0].logoConfig.url).toContain('?expires='); expect((await get('/api/get_customer_type')).body().status).toBe(200);
  });
});
