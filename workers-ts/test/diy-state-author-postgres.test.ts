import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemAttachment, systemDise, systemRole } from '@/models/schema';
import { diyStateAuthorFixture, stateAuthorBlock, editedStateAuthorBlock, DIY_STATE_AUTHOR_NAMES, DIY_STATE_AUTHOR_STYLES, DIY_STATE_AUTHOR_STATIC_RANKING } from './helpers/diyStateAuthorFixture';
import { sortedDiyState, stableDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned state author SQL'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned state author Admin SQL'); return { container: wiring.container, close: async () => {} }; } }));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => sha(stableDiyState(value));
const oldTicket = (reference: string) => reference + '?expires=1&signature=imported-state-author';
const stripTicket = (reference: string) => /^\/api\/assets\/[1-9]\d*(?:[?#]|$)/u.test(reference.trim()) ? reference.trim().split(/[?#]/u)[0]! : reference;
type Actor = 0 | 11 | 22 | 'admin' | 'minimal' | 'reader';

/** Test-side authority list is explicit: exactly two state fields plus the
 * preexisting two footer positions. All account/product/preview data is opaque. */
function images(value: Row[], transform: (reference: string) => string): Row[] {
  const result = structuredClone(value);
  for (const block of result) {
    if (block.name === 'userInfor' && typeof block.logoConfig?.url === 'string') block.logoConfig.url = transform(block.logoConfig.url);
    if (block.name === 'ranking' && typeof block.imgConfig?.url === 'string') block.imgConfig.url = transform(block.imgConfig.url);
    if (String(block.name).toLowerCase() === 'pagefoot' && Array.isArray(block.menuList)) for (const item of block.menuList) if (Array.isArray(item.imgList)) for (const index of [0, 1]) if (typeof item.imgList[index] === 'string') item.imgList[index] = transform(item.imgList[index]);
  }
  return result;
}
const canonical = (value: Row[]) => images(value, stripTicket);
const slot = (block: Row) => block[block.name === 'userInfor' ? 'logoConfig' : 'imgConfig'] as Row;
const mediaNames = ['userInfor', 'ranking'] as const;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('complete state author persistence on two real owned PG16 schema configurations', () => {
  describe.each(['isolated-search-path', 'public'] as const)('%s', namespace => {
    const app = createApp(), reads: Row[] = [], writes: Row[] = [], snapshots: Record<string, DiyStateSnapshot> = {};
    let f: Awaited<ReturnType<typeof diyStateAuthorFixture>>, directory = '', now: Date;
    let rows: Array<typeof systemDise.$inferSelect> = [], attachments: Array<typeof systemAttachment.$inferSelect> = [], roles: Array<typeof systemRole.$inferSelect> = [];
    const remember = (snapshot: DiyStateSnapshot) => { const hash = digest(snapshot); snapshots[hash] ??= structuredClone(snapshot); return hash; };
    beforeAll(async () => {
      now = new Date(); vi.setSystemTime(now); f = await diyStateAuthorFixture(now, namespace === 'public' ? { namespace: 'public' } : {}); wiring.container = f.container;
      rows = await f.db.select().from(systemDise); attachments = await f.db.select().from(systemAttachment); roles = await f.db.select().from(systemRole);
      directory = await mkdtemp(join(tmpdir(), 'cinashop-diy-state-author-native-'));
      const actualSchema = (await f.db.execute<{ schema: string }>(sql`SELECT current_schema() AS schema`))[0]!.schema;
      expect(actualSchema === 'public').toBe(namespace === 'public');
      const text = JSON.stringify({ namespace, actual_schema: actualSchema, inventory: { tables: f.tables, sequences: f.sequences }, setup: f.stateAuthorSetup,
        boundary: 'Owned maintenance SQL DI with actual createApp/middleware/JWT/transactions/public projection/PNG bytes. Does not claim production LOGIN grants; those remain in independent ACL suites. Every actual table and sequence is inventoried.' }, null, 2) + '\n';
      const path = join(directory, 'setup.json'); await writeFile(path, text); process.stdout.write('DIY_STATE_AUTHOR_NATIVE_SETUP ' + JSON.stringify({ path, sha256: sha(text), namespace, tables: f.tables.length, sequences: f.sequences.length }) + '\n');
    }, 90_000);
    afterAll(async () => {
      try { if (f && directory) {
        const text = JSON.stringify({ namespace, tables: f.tables, sequences: f.sequences, reads, writes, snapshots_by_sha256: snapshots, final: await f.snapshot(), resources: f.resources(),
          boundary: 'Completed GET JSON/asset bytes precede all-table/all-sequence/KV/R2/queue/IMAGES equality. Explicit fixture imports, metadata withdrawal and cleanup are separate from actual author POSTs.' }, null, 2) + '\n';
        const path = join(directory, 'execution.json'); await writeFile(path, text); process.stdout.write('DIY_STATE_AUTHOR_NATIVE_EXECUTION ' + JSON.stringify({ path, sha256: sha(text), namespace, reads: reads.length, writes: writes.length, all_reads_unchanged: reads.every(read => read.unchanged) }) + '\n');
      } } finally { wiring.container = undefined; vi.useRealTimers(); await f?.close(); }
    }, 30_000);
    beforeEach(() => { vi.setSystemTime(now); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned state author native forbids external I/O')); });
    afterEach(async () => {
      try { if (vi.isMockFunction(fetch)) expect(fetch).not.toHaveBeenCalled(); }
      finally { vi.restoreAllMocks();
        for (const row of rows) await f.db.update(systemDise).set(row).where(eq(systemDise.id, row.id));
        for (const row of attachments) await f.db.update(systemAttachment).set(row).where(eq(systemAttachment.attId, row.attId));
        for (const row of roles) await f.db.update(systemRole).set(row).where(eq(systemRole.id, row.id));
      }
    });
    const token = (actor: Actor) => actor === 'admin' ? f.adminToken : actor === 'minimal' ? f.minimalToken : actor === 'reader' ? f.readerToken : actor === 11 ? f.token : actor === 22 ? f.otherToken : undefined;
    async function request(path: string, method: 'GET' | 'POST', actor: Actor, body?: unknown) {
      const waits: Promise<unknown>[] = [], auth = token(actor), headers: Record<string, string> = { ...(auth ? { 'Authori-zation': 'Bearer ' + auth } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
      const response = await app.fetch(new Request('https://owned-state-author.local' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), f.env,
        { waitUntil: (work: Promise<unknown>) => { waits.push(work); }, passThroughOnException() {} } as unknown as ExecutionContext);
      await Promise.all(waits); const bytes = new Uint8Array(await response.arrayBuffer());
      return { response, bytes, body: response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(new TextDecoder().decode(bytes)) as Row : undefined };
    }
    async function get(path: string, actor: Actor = 0) {
      const before = await f.snapshot(), resources = f.resources(), initialReads = f.bucket.get.mock.calls.length, result = await request(path, 'GET', actor), after = await f.snapshot();
      expect(after).toEqual(before); expect(f.resources()).toEqual(resources);
      reads.push({ path, actor, http_status: result.response.status, status: result.body?.status ?? result.response.status, before: remember(before), after: remember(after), unchanged: true,
        body_sha256: sha(result.bytes), r2_reads: f.bucket.get.mock.calls.length - initialReads, resources_before: resources, resources_after: f.resources() }); return result;
    }
    async function page(id = 2, actor: Actor = 0) { const result = await get('/api/diy/get_diy/' + id, actor); expect(result.body?.status).toBe(200); expect(result.response.headers.get('Cache-Control')).toBe('no-store'); return result.body!.data as Row; }
    async function save(value: Row[], actor: Actor = 'admin', id = 2, extra: Row = {}) {
      const before = await f.snapshot(), resources = f.resources(), body = { id, value: JSON.stringify(value), ...extra }, result = await request('/adminapi/dise/save', 'POST', actor, body), after = await f.snapshot();
      expect(f.resources()).toEqual(resources); writes.push({ phase: 'actual Admin author POST', actor, request: body, status: result.body?.status, before: remember(before), after: remember(after), resources_before: resources, resources_after: f.resources() }); return { ...result, before, after };
    }
    function saved(result: Awaited<ReturnType<typeof save>>, value: Row[], id = 2) {
      expect(result.body?.status).toBe(200); const old = result.before.system_dise.find(row => row.id === id)!, actual = result.after.system_dise.find(row => row.id === id)!, wanted = structuredClone(result.before);
      expect(actual.version).not.toBe(old.version); expect(actual.update_time).toBeGreaterThan(old.update_time);
      Object.assign(wanted.system_dise.find(row => row.id === id)!, { value: JSON.stringify(canonical(value)), version: actual.version, update_time: actual.update_time }); expect(result.after).toEqual(sortedDiyState(wanted)); expect(actual.content).toBe(old.content); return actual;
    }
    async function imported(value: Row[]) {
      const before = await f.snapshot(), resources = f.resources(); await f.db.update(systemDise).set({ value: JSON.stringify(value) }).where(eq(systemDise.id, 2));
      const after = await f.snapshot(), wanted = structuredClone(before); wanted.system_dise.find(row => row.id === 2)!.value = JSON.stringify(value); expect(after).toEqual(sortedDiyState(wanted)); expect(f.resources()).toEqual(resources);
      writes.push({ phase: 'explicit owned imported-fixture setup; not author POST or GET', before: remember(before), after: remember(after), resources_before: resources, resources_after: f.resources() });
    }

    it('inventories every actual table and sequence with complete114-key PHP defaults, original ranking static path and separate account domains', async () => {
      const tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(r => r.name), sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(r => r.name), all = await f.snapshot();
      expect(f.tables).toEqual(tables); expect(f.sequences).toEqual(sequences); expect(Object.keys(all).sort()).toEqual([...tables, '__sequences'].sort()); expect(all.__sequences.map(r => r.name).sort()).toEqual(sequences);
      expect(DIY_STATE_AUTHOR_NAMES.map(kind => Object.keys(stateAuthorBlock(kind, 7)).length)).toEqual([22, 37, 22, 33]); expect(stateAuthorBlock('ranking', 7).imgConfig.url).toBe(DIY_STATE_AUTHOR_STATIC_RANKING);
      expect(all.user_sign).toHaveLength(2); expect(all.store_coupon_user).toHaveLength(4); expect(all.system_user_level).toHaveLength(2);
      for (const actor of [0, 11, 22] as const) for (const id of [0, 2]) {
        const actual = await page(id, actor), expected = id === 0 ? f.rootBlocks.filter(block => block.name !== 'pageFoot') : f.microBlocks;
        expect(canonical(actual.value)).toEqual(expected); expect(actual.content).toBeUndefined();
        expect((await get('/api/diy/diy_version/' + id, actor)).body?.data).toEqual({ version: 'state-author-initial' });
        if (id === 0) expect(actual.value.find((block: Row) => block.name === 'ranking').imgConfig.url).toBe(DIY_STATE_AUTHOR_STATIC_RANKING);
      }
    });
    it.each(DIY_STATE_AUTHOR_STYLES)('roundtrips complete%s style%s with every conditional color, radius, checkbox and metadata family preserved', async (kind, style) => {
      const value = structuredClone(f.rootBlocks), position = value.findIndex(row => row.name === kind); value[position] = editedStateAuthorBlock(kind, style, value[position]!.timestamp);
      if (kind === 'userInfor') value[position]!.logoConfig.url = f.platformImage.url;
      const id = style === 0 ? 1 : 2;
      saved(await save(value, 'minimal', id), value, id); expect(canonical((await page(id)).value)).toEqual(value);
      expect(Object.keys(value[position]!).filter(key => key !== 'authorExtra')).toEqual(Object.keys(stateAuthorBlock(kind, 0)));
    });
    it('retains duplicate ordinary state instances, complete imported arrays, unknown neighbors, footer ordering and independent content', async () => {
      const value = structuredClone(f.microBlocks); value.splice(2, 0, stateAuthorBlock('userInfor', 999)); value.push({ name: 'unsupported-state-array', timestamp: 1000, untouched: Array.from({ length: 2501 }, (_, index) => ({ image: oldTicket(f.image.url), index })) });
      saved(await save(value), value); expect(canonical((await page()).value)).toEqual(value); expect(value.filter(row => row.name === 'userInfor')).toHaveLength(3);
    });
    it('saves one unrelated imported title edit without normalizing Number strings, true radii, tiny values, longer labels or dormant branches', async () => {
      const value = structuredClone(f.microBlocks); value.find(row => row.name === 'titles')!.titleConfig.value = '微页只改正文';
      saved(await save(value, 'minimal'), value); expect(canonical((await page()).value)).toEqual(value);
      const rank = value.find(row => row.name === 'ranking')!; expect(rank.titleNumber.val).toBe('0.0005'); expect(rank.bntNumber.val).toBe('1e30'); expect(rank.filletImg.type).toBe(true); expect(rank.titleTxtConfig.value.length).toBeGreaterThan(6);
    });
    it.each(mediaNames)('publishes%s real platform gallery PNG after actual save and consumes its anonymous signed asset bytes without writes', async kind => {
      const value = structuredClone(f.rootBlocks), block = value.find(row => row.name === kind)!; slot(block).url = oldTicket(f.secondIcon.url);
      saved(await save(value), value); const actual = (await page()).value.find((row: Row) => row.name === kind)!, reference = slot(actual).url;
      expect(reference).toMatch(new RegExp('^' + f.secondIcon.url + '\\?expires=\\d+&signature=[A-Za-z0-9_-]{43}$', 'u'));
      const asset = await get(reference); expect(asset.response.status).toBe(200); expect(asset.response.headers.get('Content-Type')).toBe('image/png'); expect(asset.bytes).toEqual(f.png);
      expect(slot(value.find(row => row.name === kind)!).link).toBeUndefined();
    });
    it.each(mediaNames.flatMap(kind => (['private-user11', 'other-user22', 'supplier'] as const).map(owner => [kind, owner] as const)))('refuses%s %s attachment as public authority for all viewers while preserving the authored raw identity', async (kind, owner) => {
      const reference = owner === 'private-user11' ? f.image.url : owner === 'other-user22' ? f.foreignImage.url : f.supplierImage.url, value = structuredClone(f.rootBlocks); slot(value.find(row => row.name === kind)!).url = oldTicket(reference);
      const row = saved(await save(value), value); expect(slot(JSON.parse(row.value).find((block: Row) => block.name === kind)).url).toBe(reference);
      for (const actor of [0, 11, 22] as const) { const actual = (await page(2, actor)).value; expect(slot(actual.find((block: Row) => block.name === kind)).url).toBe(''); expect(actual.find((block: Row) => block.name === 'unsupported-state-author-neighbor').logoConfig.url).toBe(f.image.url); }
    });
    it.each(mediaNames)('rechecks%s current MIME and object-key metadata instead of treating an imported ticket as public permission', async kind => {
      const value = structuredClone(f.rootBlocks); slot(value.find(row => row.name === kind)!).url = f.platformImage.url; saved(await save(value), value);
      const row = attachments.find(item => item.attId === f.platformImage.att_id)!;
      for (const patch of [{ attType: 'text/html' }, { attType: 'image/svg+xml' }, { fileType: 2, attType: 'video/mp4' }, { name: 'attachments/admin/2/not-platform.png' }]) {
        await f.db.update(systemAttachment).set({ ...row, ...patch }).where(eq(systemAttachment.attId, row.attId)); expect(slot((await page()).value.find((block: Row) => block.name === kind)).url).toBe('');
      }
    });
    it.each(mediaNames)('keeps%s JSON entity-encoded private image literal without decoding or signing it on save and read', async kind => {
      const id = f.image.att_id;
      for (const reference of [`/&#97;pi/assets/${id}`, `/&amp;#97;pi/assets/${id}`, `/&amp;amp;#97;pi/assets/${id}`]) {
        const value = structuredClone(f.rootBlocks); slot(value.find(row => row.name === kind)!).url = reference;
        const before = await f.snapshot(); saved(await save(value), value); expect(slot((await page()).value.find((block: Row) => block.name === kind)).url).toBe(reference);
        // Separate explicit fixture reset keeps every later POST's version/time
        // comparison against an older stored row, rather than faking time drift.
        const row = rows.find(item => item.id === 2)!; await f.db.update(systemDise).set(row).where(eq(systemDise.id, 2)); expect((await f.snapshot()).__sequences).toEqual(before.__sequences);
      }
    });
    it('signs only exact two authored state slots and never account avatars, product material, preview rows, wrong slots or nested unknown blocks', async () => {
      const value: Row[] = [{ name: 'userInfor', timestamp: 1, logoConfig: { url: f.platformImage.url, link: oldTicket(f.image.url) }, imgConfig: { url: oldTicket(f.platformImage.url) }, avatar: oldTicket(f.platformImage.url), userInfo: { avatar: oldTicket(f.platformImage.url) } },
        { name: 'ranking', timestamp: 2, imgConfig: { url: f.platformImage.url }, logoConfig: { url: oldTicket(f.platformImage.url) }, productList: [{ image: oldTicket(f.platformImage.url) }] },
        ...['newVip', 'signIn', 'UserInfor', 'Ranking', 'unknown-state'].map(name => ({ name, logoConfig: { url: oldTicket(f.platformImage.url) }, imgConfig: { url: oldTicket(f.platformImage.url) }, nested: { name: 'ranking', imgConfig: { url: oldTicket(f.platformImage.url) } } }))];
      saved(await save(value), value); const actual = (await page()).value; expect(slot(actual[0]).url).toMatch(/signature=[A-Za-z0-9_-]{43}$/u); expect(slot(actual[1]).url).toMatch(/signature=[A-Za-z0-9_-]{43}$/u); expect(canonical(actual)).toEqual(value);
    });
    it.each(mediaNames)('strips%s old ticket only from its authorized JSON slot and emits a fresh output ticket without altering storage on GET', async kind => {
      const value = structuredClone(f.rootBlocks), block = value.find(row => row.name === kind)!; slot(block).url = oldTicket(f.platformImage.url); slot(block).link = oldTicket(f.platformImage.url);
      const row = saved(await save(value), value), stored = JSON.parse(row.value).find((item: Row) => item.name === kind); expect(slot(stored).url).toBe(f.platformImage.url); expect(slot(stored).link).toBe(oldTicket(f.platformImage.url));
      const actual = (await page()).value.find((item: Row) => item.name === kind); expect(slot(actual).url).toMatch(/signature=[A-Za-z0-9_-]{43}$/u); expect(slot(actual).url).not.toContain('imported-state-author'); expect(slot(actual).link).toBe(oldTicket(f.platformImage.url));
    });
    it.each(mediaNames)('withdraws%s image output immediately after current owner changes while leaving saved JSON and earlier off-slot references untouched', async kind => {
      const value = structuredClone(f.rootBlocks); slot(value.find(row => row.name === kind)!).url = f.platformImage.url; saved(await save(value), value);
      const ticket = slot((await page()).value.find((block: Row) => block.name === kind)).url; expect(ticket).toContain('signature=');
      await f.db.update(systemAttachment).set({ type: 3, relationId: 22, moduleType: 3 }).where(eq(systemAttachment.attId, f.platformImage.att_id));
      expect(slot((await page()).value.find((block: Row) => block.name === kind)).url).toBe('');
      const stored = (await f.db.select().from(systemDise).where(eq(systemDise.id, 2)))[0]!.value;
      expect(typeof stored).toBe('string'); if (typeof stored !== 'string') throw Error('Saved state author value is missing');
      expect(slot(JSON.parse(stored).find((block: Row) => block.name === kind)).url).toBe(f.platformImage.url);
    });
    it.each(mediaNames)('keeps%s full ordinary2500 capacity alongside independent footer, customer-service and navigation slots', async kind => {
      const block = stateAuthorBlock(kind, 1); slot(block).url = f.platformImage.url;
      const value = [block, { name: 'swipers', timestamp: 2, swiperConfig: { list: Array.from({ length: 2499 }, (_, index) => ({ img: f.platformImage.url, index })) } },
        { name: 'menus', timestamp: 3, menuConfig: { list: [{ img: f.platformImage.url }] } }, { name: 'customerService', timestamp: 4, logoConfig: { url: f.platformImage.url } }, structuredClone(f.rootBlocks.at(-1)!)];
      saved(await save(value), value); const actual = await page(); expect(actual.value[1].swiperConfig.list).toHaveLength(2499); expect(actual.value[1].swiperConfig.list.every((item: Row, index: number) => item.index === index && item.img.includes('signature='))).toBe(true); expect(slot(actual.value[0]).url).toContain('signature=');
      expect(actual.value.at(-1).menuList).toHaveLength(5);
    }, 45_000);
    it.each(mediaNames)('rejects%s combined ordinary2501 save and imported output atomically without mutating any table, sequence or resource', async kind => {
      const block = stateAuthorBlock(kind, 1); slot(block).url = oldTicket(f.platformImage.url);
      const value = [block, { name: 'swipers', timestamp: 2, swiperConfig: { list: Array.from({ length: 2500 }, () => ({ img: oldTicket(f.platformImage.url) })) } }], result = await save(value);
      expect(result.body?.status).toBe(400); expect(result.after).toEqual(result.before); await imported(value); const denied = await get('/api/diy/get_diy/2'); expect(denied.body?.status).toBe(400); expect(JSON.stringify(denied.body)).not.toMatch(/signature=[A-Za-z0-9_-]{43}/u);
    }, 45_000);
    it('allows only actual persisted dise.manage authors and refuses revoked permission, metadata and generic writer escalation without writes', async () => {
      for (const actor of [0, 11, 22, 'reader'] as const) { const result = await save(f.microBlocks, actor); expect(result.body?.status).not.toBe(200); expect(result.after).toEqual(result.before); }
      await f.db.update(systemRole).set({ rules: 'dise.view' }).where(eq(systemRole.id, 903)); const denied = await save(f.microBlocks, 'minimal'); expect(denied.body?.status).toBe(400011); expect(denied.after).toEqual(denied.before);
      for (const patch of [{ type: 1 }, { is_diy: 0 }, { template_name: 'default' }, { version: 'forged' }, { is_bg_color: true }, { bg_tab_val: 3 }]) { const result = await save(f.microBlocks, 'admin', 2, patch); expect(result.body?.status).toBe(400); expect(result.after).toEqual(result.before); }
    });
    it('enforces station-first state reads for all actors with no account side effects or cache/storage/sequence writes', async () => {
      try {
        await f.setStateAuthorConfig('station_open', '0');
        for (const actor of [0, 11, 22] as const) for (const path of ['/api/diy/get_diy/2', '/api/diy/user_info', '/api/diy/newcomer_list?page=1&limit=10', '/api/diy/product_rank?limit=3', '/api/diy/sign']) { const result = await get(path, actor); expect(result.body?.status).toBe(410010); expect(result.body?.msg).toBe('站点升级中，请稍候访问'); expect(result.response.headers.get('Cache-Control')).toContain('no-store'); }
      } finally { await f.setStateAuthorConfig('station_open', '1'); }
    }, 30_000);
    it('reads guest and both actual-account six metrics without serializing personal responses into authored JSON or creating user state', async () => {
      expect((await get('/api/diy/user_info', 0)).body!.data).toEqual([]);
      expect((await get('/api/diy/user_info', 11)).body!.data).toMatchObject({ uid: 11, nickname: '零值会员11', now_money: '0.00', integral: 0, exp: '0.00', level: 1, coupon_num: 2, collectCount: 1, visit_num: 0 });
      expect((await get('/api/diy/user_info', 22)).body!.data).toMatchObject({ uid: 22, nickname: '另一会员22', now_money: '88.00', integral: 50, exp: '50.00', level: 2, coupon_num: 1, collectCount: 1, visit_num: 1 });
    });
    it('reads newcomer zero points and real account-specific coupons/products without claims, grants, orders or author-document mutation', async () => {
      const guest = (await get('/api/diy/newcomer_list?page=1&limit=10', 0)).body!.data; expect(guest.newcomer_integral).toBe(0); expect(guest.newcomer_coupon.map((row: Row) => row.id)).toEqual([82, 81]);
      const own = (await get('/api/diy/newcomer_list?page=1&limit=10', 11)).body!.data; expect(own.newcomer_coupon.map((row: Row) => [row.id, row.uid])).toEqual([[92, 11], [91, 11]]); expect(own.newcomer_products).toMatchObject([{ id: 71, product_id: 301, price: '0.00' }]);
      expect((await get('/api/diy/newcomer_list?page=1&limit=10', 22)).body!.data).toEqual({ newcomer_products: [], newcomer_integral: [], newcomer_coupon: [] });
    });
    it('reads independent current public sales/star/collect ranks for all actors with no detail, analytics or selection writes', async () => {
      for (const actor of [0, 11, 22] as const) { const rank = (await get('/api/diy/product_rank?limit=3', actor)).body!.data;
        expect(rank.sales.map((row: Row) => row.id)).toEqual([301, 302, 303]); expect(rank.star.map((row: Row) => row.id)).toEqual([302, 601, 303]); expect(rank.collect.map((row: Row) => row.id)).toEqual([303, 301, 302]); expect(rank.sales[0].price).toBe('0.00'); }
    });
    it('reads the current Shanghai sign week, zero rewards and different account marks without signing, claiming or materializing state', async () => {
      for (const actor of [0, 11, 22] as const) { const state = (await get('/api/diy/sign', actor)).body!.data; expect(state.signList).toHaveLength(1); expect(state.signList[0]).toHaveLength(7);
        expect(state.signList[0].filter((day: Row) => day.sign_day)).toHaveLength(1); expect(state.signList[0].filter((day: Row) => day.is_sign)).toHaveLength(actor ? 1 : 0);
        expect(state.checkSign).toBe(actor === 22 || actor === 11 && f.shanghaiDay === f.monday); expect(state.sign_give_point).toBe(0); expect(state.nextContinuousSignRewardList).toEqual([{ id: 1, type: 0, days: 7, point: 0, exp: 3 }]); }
    });
    it('reads current level aliases for each account without activation, membership purchase or author JSON writes', async () => {
      for (const actor of [11, 22] as const) { const data = (await get('/api/user/level/info', actor)).body!.data; expect(data.level_info).toMatchObject({ id: actor === 11 ? 1 : 2, grade: actor === 11 ? 1 : 2, vip: true }); expect(data.currentExp).toBe(actor === 11 ? 0 : 50); expect(data.level_list.map((row: Row) => [row.id, row.grade, row.color])).toEqual([[1, 1, '#375a7f'], [2, 2, '#246e49']]); }
    });
  });
});
