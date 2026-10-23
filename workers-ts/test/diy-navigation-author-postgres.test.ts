import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemAttachment, systemDise, systemRole } from '@/models/schema';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { diyNavigationAuthorFixture, expectedNavigationRootEdit, expectedNavigationCustomEdit } from './helpers/diyNavigationAuthorFixture';
import { sortedDiyState, stableDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from './helpers/diyStateFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned navigation author SQL'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned navigation author Admin SQL'); return { container: wiring.container, close: async () => {} }; } }));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => sha(stableDiyState(value));
const oldTicket = (reference: string) => reference + '?expires=1&signature=imported-author';
// An independent list of the actual navigation slots; similarly named bridge,
// dormant fields, links and unsupported neighbors are deliberately untouched.
function images(value: Row[], transform: (reference: string) => string): Row[] {
  const result = structuredClone(value);
  for (const block of result) {
    if (block.name === 'headerSerch') block.logoConfig.url = transform(block.logoConfig.url);
    if (block.name === 'menus') for (const item of block.menuConfig.list) if (typeof item.img === 'string') item.img = transform(item.img);
    if (block.name === 'pictureCube') {
      for (const item of block.picStyle.picList) if (typeof item.image === 'string') item.image = transform(item.image);
      if ([11, '11'].includes(block.styleConfig.tabVal)) for (const item of block.picStyle.docPicList) if (typeof item.img === 'string') item.img = transform(item.img);
    }
    if (String(block.name).toLowerCase() === 'pagefoot') for (const item of block.menuList) for (const index of [0, 1]) item.imgList[index] = transform(item.imgList[index]);
  }
  return result;
}
const canonical = (value: Row[]) => images(value, canonicalizePublishedAttachmentReference);
type Actor = 0 | 11 | 22 | 'admin' | 'minimal' | 'reader';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('complete navigation author persistence on two real owned PG16 schema configurations', () => {
  describe.each(['isolated-search-path', 'public'] as const)('%s', namespace => {
    const app = createApp(), reads: Row[] = [], writes: Row[] = [], snapshots: Record<string, DiyStateSnapshot> = {};
    let f: Awaited<ReturnType<typeof diyNavigationAuthorFixture>>, directory = '', now: Date;
    let rows: Array<typeof systemDise.$inferSelect>, attachments: Array<typeof systemAttachment.$inferSelect>, roles: Array<typeof systemRole.$inferSelect>;
    const remember = (snapshot: DiyStateSnapshot) => { const hash = digest(snapshot); snapshots[hash] ??= structuredClone(snapshot); return hash; };
    beforeAll(async () => {
      now = new Date(); vi.setSystemTime(now); f = await diyNavigationAuthorFixture(now, namespace === 'public' ? { namespace: 'public' } : {}); wiring.container = f.container;
      rows = await f.db.select().from(systemDise); attachments = await f.db.select().from(systemAttachment); roles = await f.db.select().from(systemRole);
      directory = await mkdtemp(join(tmpdir(), 'cinashop-diy-navigation-author-native-'));
      const actualSchema = (await f.db.execute<{ schema: string }>(sql`SELECT current_schema() AS schema`))[0]!.schema;
      expect(actualSchema === 'public').toBe(namespace === 'public');
      const text = JSON.stringify({ namespace, actual_schema: actualSchema, inventory: { tables: f.tables, sequences: f.sequences }, setup: f.navigationAuthorSetup,
        boundary: 'Owned maintenance SQL DI, actual createApp/middleware/JWT/transactions/public projection/PNG bytes. Distinct production LOGIN grants are covered separately by admin-diy-author-options native tests. Dynamic inventory is not the old73/68 claim.' }, null, 2) + '\n';
      const path = join(directory, 'setup.json'); await writeFile(path, text); process.stdout.write('DIY_NAVIGATION_AUTHOR_NATIVE_SETUP ' + JSON.stringify({ path, sha256: sha(text), namespace, tables: f.tables.length, sequences: f.sequences.length }) + '\n');
    }, 90_000);
    afterAll(async () => {
      try { if (f && directory) {
        const text = JSON.stringify({ namespace, tables: f.tables, sequences: f.sequences, reads, writes, snapshots_by_sha256: snapshots, final: await f.snapshot(), resources: f.resources(),
          boundary: 'Every completed GET consumes real JSON/asset bytes before all-table/all-sequence/KV/R2/queue/IMAGES equality. Explicit fixture imports/cleanup and actual POST changes are recorded separately.' }, null, 2) + '\n';
        const path = join(directory, 'execution.json'); await writeFile(path, text); process.stdout.write('DIY_NAVIGATION_AUTHOR_NATIVE_EXECUTION ' + JSON.stringify({ path, sha256: sha(text), namespace, reads: reads.length, writes: writes.length, all_reads_unchanged: reads.every(read => read.unchanged) }) + '\n');
      } } finally { wiring.container = undefined; vi.useRealTimers(); await f?.close(); }
    }, 30_000);
    beforeEach(() => { vi.setSystemTime(now); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned navigation author native forbids external I/O')); });
    afterEach(async () => {
      try { expect(fetch).not.toHaveBeenCalled(); }
      finally {
        vi.restoreAllMocks();
        for (const row of rows) await f.db.update(systemDise).set(row).where(eq(systemDise.id, row.id));
        for (const row of attachments) await f.db.update(systemAttachment).set(row).where(eq(systemAttachment.attId, row.attId));
        for (const row of roles) await f.db.update(systemRole).set(row).where(eq(systemRole.id, row.id));
      }
    });
    const token = (actor: Actor) => actor === 'admin' ? f.adminToken : actor === 'minimal' ? f.minimalToken : actor === 'reader' ? f.readerToken : actor === 11 ? f.token : actor === 22 ? f.otherToken : undefined;
    async function request(path: string, method: 'GET' | 'POST', actor: Actor, body?: unknown) {
      const waits: Promise<unknown>[] = [], auth = token(actor), headers: Record<string, string> = { ...(auth ? { 'Authori-zation': 'Bearer ' + auth } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
      const response = await app.fetch(new Request('https://owned-navigation-author.local' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), f.env,
        { waitUntil: (work: Promise<unknown>) => { waits.push(work); }, passThroughOnException() {} } as unknown as ExecutionContext);
      await Promise.all(waits); const bytes = new Uint8Array(await response.arrayBuffer());
      return { response, bytes, body: response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(new TextDecoder().decode(bytes)) as Row : undefined };
    }
    async function get(path: string, actor: Actor = 0) {
      const before = await f.snapshot(), resources = f.resources(), initialReads = f.bucket.get.mock.calls.length, result = await request(path, 'GET', actor), after = await f.snapshot();
      expect(after).toEqual(before); expect(f.resources()).toEqual(resources);
      reads.push({ path, actor, status: result.body?.status ?? result.response.status, before: remember(before), after: remember(after), unchanged: true,
        body_sha256: sha(result.bytes), r2_reads: f.bucket.get.mock.calls.length - initialReads, resources_before: resources, resources_after: f.resources() }); return result;
    }
    async function page(id = 2, actor: Actor = 0) { const result = await get('/api/diy/get_diy/' + id, actor); expect(result.body?.status).toBe(200); expect(result.response.headers.get('Cache-Control')).toBe('no-store'); return result.body!.data as Row; }
    async function save(body: Row, actor: Actor = 'admin') {
      const before = await f.snapshot(), resources = f.resources(), result = await request('/adminapi/dise/save', 'POST', actor, body), after = await f.snapshot();
      expect(f.resources()).toEqual(resources); writes.push({ actor, request: body, status: result.body?.status, before: remember(before), after: remember(after), resources_before: resources, resources_after: f.resources() }); return { ...result, before, after };
    }
    function saved(result: Awaited<ReturnType<typeof save>>, value: Row[], id = 2) {
      expect(result.body?.status).toBe(200); const old = result.before.system_dise.find(row => row.id === id)!, actual = result.after.system_dise.find(row => row.id === id)!, wanted = structuredClone(result.before);
      expect(actual.version).not.toBe(old.version); expect(actual.update_time).toBeGreaterThan(old.update_time);
      Object.assign(wanted.system_dise.find(row => row.id === id)!, { value: JSON.stringify(value), version: actual.version, update_time: actual.update_time }); expect(result.after).toEqual(sortedDiyState(wanted));
      expect(actual.content).toBe(old.content); return actual;
    }
    async function imported(value: Row[]) {
      const before = await f.snapshot(), resources = f.resources(); await f.db.update(systemDise).set({ value: JSON.stringify(value) }).where(eq(systemDise.id, 2));
      const after = await f.snapshot(), wanted = structuredClone(before); wanted.system_dise.find(row => row.id === 2)!.value = JSON.stringify(value); expect(after).toEqual(sortedDiyState(wanted)); expect(f.resources()).toEqual(resources);
      writes.push({ phase: 'explicit owned imported-fixture setup, not author POST or GET', before: remember(before), after: remember(after), resources_before: resources, resources_after: f.resources() });
    }

    it('dynamically fences every actual table and sequence after real catalog/image/word setup', async () => {
      const tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row => row.name);
      const sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row => row.name);
      expect(f.tables).toEqual(tables); expect(f.sequences).toEqual(sequences); expect(tables.length).toBeGreaterThan(73); expect(sequences.length).toBeGreaterThan(68);
      const snapshot = await f.snapshot(); expect(Object.keys(snapshot).sort()).toEqual([...tables, '__sequences'].sort()); expect(snapshot.__sequences.map(row => row.name).sort()).toEqual(sequences);
      expect(snapshot.store_product_words.filter(row => row.type === 0 && row.relation_id === 0 && row.is_show === 1)).toHaveLength(25);
      for (const image of [f.platformImage, f.secondIcon, f.supplierImage]) expect(snapshot.system_attachment.some(row => row.att_id === image.att_id)).toBe(true);
    });
    it('serves actual homepage and imported micro four-family metadata to guests and both owners without modifying SQL, sequences or resources', async () => {
      for (const id of [0, 2]) for (const actor of [0, 11, 22] as const) {
        const expected = id === 0 ? f.rootBlocks.filter(block => block.name !== 'pageFoot') : f.microBlocks, actual = await page(id, actor);
        expect(canonical(actual.value)).toEqual(expected); expect(actual.title).toBe(id === 0 ? '导航作者首页' : '导航作者导入微页');
        expect(actual.is_show).toBe(1); expect(actual.is_bg_color).toBe(1); expect(actual.is_bg_pic).toBe(1); expect(actual.bg_pic).toMatch(/\?expires=\d+&signature=/u);
        expect(actual.content).toBeUndefined(); expect((await get('/api/diy/diy_version/' + id, actor)).body?.data.version).toBe('navigation-author-initial');
      }
    });
    it.each(Array.from({ length: 12 }, (_, index) => index))('actual Admin save and anonymous/owner projection retain all4 author families and complete cube style%d', async style => {
      const value = structuredClone(f.microBlocks), cube = value.find(block => block.name === 'pictureCube')!, counts = [2, 2, 3, 3, 3, 3, 3, 4, 5, 4, 1, 16];
      cube.styleConfig.tabVal = style; cube.styleConfig.count = counts[style];
      cube.picStyle.picList = Array.from({ length: counts[style]! }, (_, index) => ({ image: index % 2 ? f.secondIcon.url : f.platformImage.url, link: '/pages/index/index', imported: { keep: index } }));
      cube.picStyle.docPicList = [{ img: f.platformImage.url, link: '/pages/index/index', doc: { startX: 0.25, startY: ' 0.5 ', w: 0.0005, h: '1.875e2' }, geometryUnknown: [] }];
      const row = saved(await save({ id: 2, value: JSON.stringify(value) }), value);
      for (const actor of [0, 22] as const) { const actual = await page(2, actor); expect(canonical(actual.value)).toEqual(value); expect((await get('/api/diy/diy_version/2', actor)).body?.data.version).toBe(row.version); }
    });
    it('roundtrips full4 root edits, typed id/name and custom dual image slots while retaining independent content, all metadata and unknown neighbors', async () => {
      for (const value of [expectedNavigationRootEdit(f), expectedNavigationCustomEdit(f)]) {
        saved(await save({ id: 2, value: JSON.stringify(value) }), value); expect(canonical((await page()).value)).toEqual(value);
        const tabs = value.find(row => row.name === 'tabNav')!.tabListConfig.list;
        expect(tabs[0].microPage).toEqual({ ...f.rootBlocks.find(row => row.name === 'tabNav')!.tabListConfig.list[0].microPage, id: 2, name: '导航作者微页' });
        expect(tabs[1].classPage).toMatchObject({ id: 84022, name: '作者子分类', dormantUnknown: 'keep-category' });
      }
    });
    it('retains imported tiny/exponent/whitespace geometry,0/101 durations,true corners and dormant branches after an unrelated minimal-author save', async () => {
      const value = structuredClone(f.microBlocks); value.find(row => row.name === 'menus')!.menuConfig.list[0].info[0].value = '微页保留';
      saved(await save({ id: 2, value: JSON.stringify(value) }, 'minimal'), value); expect(canonical((await page()).value)).toEqual(value);
      expect(value.find(row => row.name === 'pictureCube')!.picStyle.docPicList).toEqual(f.microBlocks.find(row => row.name === 'pictureCube')!.picStyle.docPicList);
    });
    it('preserves imported capacities beyond normal author add limits and beyond200 consumer blocks without silently slicing storage/public JSON', async () => {
      const value = structuredClone(f.microBlocks), header = value.find(row => row.name === 'headerSerch')!, tabs = value.find(row => row.name === 'tabNav')!, menus = value.find(row => row.name === 'menus')!, cube = value.find(row => row.name === 'pictureCube')!;
      header.hotWords.list = Array.from({ length: 21 }, (_, index) => ({ val: '导入词' + index, unknown: index }));
      tabs.tabListConfig.list = Array.from({ length: 101 }, () => structuredClone(tabs.tabListConfig.list[0]));
      menus.menuConfig.list = Array.from({ length: 101 }, () => structuredClone(menus.menuConfig.list[0]));
      cube.picStyle.docPicList = Array.from({ length: 17 }, () => structuredClone(cube.picStyle.docPicList[0]));
      while (value.length < 201) value.push({ name: 'unsupported-imported-capacity', timestamp: 1000 + value.length, zero: 0, preserve: [] });
      saved(await save({ id: 2, value: JSON.stringify(value) }), value); expect(canonical((await page()).value)).toEqual(value);
    });
    it('canonicalizes only real public media slots and refreshes owner-approved raster tickets while bridge/link/dormant/unknown strings remain exact', async () => {
      const value = images(f.microBlocks, reference => reference ? oldTicket(reference) : reference), cube = value.find(row => row.name === 'pictureCube')!;
      cube.menuConfig.list[0].img = oldTicket(f.secondIcon.url); cube.picStyle.picList[0].link = oldTicket(f.platformImage.url);
      value.find(row => row.name === 'tabNav')!.tabListConfig.list[0].preview = oldTicket(f.image.url);
      const expected = canonical(value); saved(await save({ id: 2, value: JSON.stringify(value) }), expected);
      const actual = await page(), logo = actual.value[0].logoConfig.url; expect(logo).toMatch(/\?expires=\d+&signature=/u); expect(canonical(actual.value)).toEqual(expected);
      const image = await get(logo); expect(image.response.status).toBe(200); expect(image.bytes).toEqual(f.png);
      await f.db.update(systemAttachment).set({ type: 3, relationId: 11, moduleType: 3 }).where(eq(systemAttachment.attId, f.platformImage.att_id));
      for (const actor of [0, 11, 22] as const) { const pageValue = (await page(2, actor)).value; expect(pageValue[0].logoConfig.url).toBe(''); expect(pageValue.find((row: Row) => row.name === 'pictureCube').menuConfig.list[0].img).toBe(oldTicket(f.secondIcon.url)); }
    });
    it('keeps the complete20000-navigation-image budget independent of footer and atomically refuses20001 rather than partially saving or signing', async () => {
      const menus = Array.from({ length: 200 }, (_, index) => ({ name: 'menus', timestamp: 1000 + index, menuConfig: { list: Array.from({ length: 100 }, () => ({ img: f.platformImage.url })) } }));
      const value = [...menus, structuredClone(f.microBlocks.find(row => row.name === 'pageFoot')!)]; saved(await save({ id: 2, value: JSON.stringify(value) }), value);
      expect(canonical((await page()).value)).toEqual(value);
      menus[0]!.menuConfig.list.push({ img: f.platformImage.url }); const result = await save({ id: 2, value: JSON.stringify([...menus, value.at(-1)]) }); expect(result.body?.status).toBe(400); expect(result.after).toEqual(result.before);
      await imported([...menus, value.at(-1)!]); const failed = await get('/api/diy/get_diy/2'); expect(failed.body?.status).toBe(400); expect(failed.body?.data?.value).toBeUndefined();
    }, 45_000);
    it('retains the exact2MB UTF8 storage boundary and structural protections for four-family imports with atomic rejection above them', async () => {
      const value = structuredClone(f.microBlocks); value.push({ name: 'unsupported-author-payload', note: '界' }); const block = value.at(-1)!;
      block.note += 'a'.repeat(2_000_000 - Buffer.byteLength(JSON.stringify(value))); expect(Buffer.byteLength(JSON.stringify(value))).toBe(2_000_000);
      saved(await save({ id: 2, value: JSON.stringify(value) }), value);
      for (const bad of [JSON.stringify([...value.slice(0, -1), { ...block, note: block.note + 'a' }]), JSON.stringify([{ name: 'menus', payload: Array(100001).fill(0) }]), JSON.stringify(Array.from({ length: 65 }).reduce<unknown>(next => ({ next }), ''))]) {
        const result = await save({ id: 2, value: bad }); expect(result.body?.status).toBe(400); expect(result.after).toEqual(result.before);
      }
    }, 45_000);
    it.each([0, 11, 22, 'reader'] as const)('rejects save by actor%s without any SQL/sequence/resource write', async actor => {
      const result = await save({ id: 2, value: JSON.stringify(expectedNavigationRootEdit(f)) }, actor); expect(result.body?.status).not.toBe(200); expect(result.after).toEqual(result.before);
    });
    it('rechecks the persisted minimal role and protects generic page identity/metadata from forged author requests', async () => {
      await f.db.update(systemRole).set({ rules: 'dise.view' }).where(eq(systemRole.id, 903));
      const denied = await save({ id: 2, value: JSON.stringify(f.microBlocks) }, 'minimal'); expect(denied.body?.status).toBe(400011); expect(denied.after).toEqual(denied.before);
      for (const patch of [{ type: 1 }, { is_diy: 0 }, { template_name: 'default' }, { version: 'forged' }, { is_bg_color: true }, { bg_tab_val: 3 }]) {
        const result = await save({ id: 2, value: JSON.stringify(f.microBlocks), ...patch }); expect(result.body?.status).toBe(400); expect(result.after).toEqual(result.before);
      }
    });
  });
});
