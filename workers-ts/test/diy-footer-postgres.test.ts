import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeCart, systemAttachment, systemDise } from '@/models/schema';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { renderDiyEditorialMedia, DIY_FOOTER_MEDIA_SLOT_LIMIT } from '@/services/content/DiyEditorialMediaPolicy';
import { AttachmentService, adminAttachmentScope } from '@/services/system/AttachmentService';
import { diyFooterBlock, diyFooterFixture, DIY_FOOTER_NOW } from './helpers/diyFooterFixture';
import { sortedDiyState, type DiyStateRow as Row, type DiyStateViewer } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned footer SQL'); return wiring.container;
} }));
const footerSlots = (footer: Row): string[] => footer.menuList.flatMap((item: Row) => Array.isArray(item.imgList) ? item.imgList.slice(0, 2).filter((x: unknown) => typeof x === 'string') : []);
function mapped(footer: Row, transform: (value: string) => string): Row {
  const copy = structuredClone(footer);
  for (const item of copy.menuList) if (Array.isArray(item.imgList)) for (const index of [0, 1]) if (typeof item.imgList[index] === 'string') item.imgList[index] = transform(item.imgList[index]);
  return copy;
}
const canonical = (footer: Row) => mapped(footer, canonicalizePublishedAttachmentReference);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native complete pageFoot/global navigation and private cart quantity contracts', () => {
  let f: Awaited<ReturnType<typeof diyFooterFixture>>, schemas: Array<typeof systemDise.$inferSelect>, carts: Array<typeof storeCart.$inferSelect>;
  const batch: Array<{ att_id: number; url: string }> = [], app = createApp();
  const resources = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length,
    objects: [...f.objects].map(([key, item]) => ({ key, type: item.type, bytes: [...item.bytes] })),
    info: f.rendering.info.mock.calls.length, input: f.rendering.input.mock.calls.length, transform: f.rendering.transform.mock.calls.length,
    draw: f.rendering.draw.mock.calls.length, output: f.rendering.output.mock.calls.length, queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length });
  beforeAll(async () => {
    vi.setSystemTime(DIY_FOOTER_NOW); f = await diyFooterFixture(DIY_FOOTER_NOW); wiring.container = f.container;
    expect(f.tables).toHaveLength(50); expect(f.sequences).toHaveLength(46);
    const before = await f.snapshot(), initial = resources(), upload = new AttachmentService(f.container, f.env);
    for (let index = 0; index < 257; index++) batch.push(await upload.uploadImage(adminAttachmentScope(), new File([f.png], `footer-real-${index}.png`, { type: 'image/png' }), 0));
    const after = await f.snapshot(), want = structuredClone(before), afterResources = resources();
    want.system_attachment = after.system_attachment;
    want.__sequences = want.__sequences.map(row => row.name === 'system_attachment_att_id_seq' ? after.__sequences.find(next => next.name === row.name)! : row);
    expect(after).toEqual(sortedDiyState(want)); expect(after.system_attachment.length - before.system_attachment.length).toBe(257);
    expect(Number(after.__sequences.find(row => row.name === 'system_attachment_att_id_seq')!.last) - Number(before.__sequences.find(row => row.name === 'system_attachment_att_id_seq')!.last)).toBe(257);
    expect(afterResources.puts - initial.puts).toBe(257); expect(afterResources.objects.length - initial.objects.length).toBe(257);
    expect({ ...afterResources, puts: initial.puts, objects: initial.objects }).toEqual(initial);
    const directory = await mkdtemp(join(tmpdir(), 'cinashop-diy-footer-setup-')), path = join(directory, 'setup.json');
    const text = JSON.stringify({ phase: 'owned-setup-only', actualUploadCount: 257, allowed: ['system_attachment', 'system_attachment_att_id_seq', '257 owned R2 puts'], before, after, resources_before: initial, resources_after: afterResources, images: batch }, null, 2) + '\n';
    await writeFile(path, text); process.stdout.write('DIY_FOOTER_ATTACHMENT_BATCH_SETUP ' + JSON.stringify({ path, sha256: createHash('sha256').update(text).digest('hex'), count: 257 }) + '\n');
    schemas = await f.db.select().from(systemDise); carts = await f.db.select().from(storeCart);
  }, 60_000);
  afterAll(async () => { wiring.container = undefined; vi.useRealTimers(); await f?.close(); }, 30_000);
  beforeEach(() => { vi.setSystemTime(DIY_FOOTER_NOW); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned footer fixture forbids external I/O')); });
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally {
      vi.restoreAllMocks(); await f.db.delete(systemDise); await f.db.insert(systemDise).values(schemas);
      await f.db.delete(storeCart); await f.db.insert(storeCart).values(carts);
    }
  });
  async function request(path: string, actor: DiyStateViewer = 0) {
    const waits: Promise<unknown>[] = [];
    const response = await app.fetch(new Request('http://localhost' + path, { headers: actor ? { 'Authori-zation': `Bearer ${actor === 11 ? f.token : f.otherToken}` } : {} }), f.env,
      { waitUntil: (work: Promise<unknown>) => { waits.push(work); }, passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(waits); return response;
  }
  async function read(path: string, actor: DiyStateViewer = 0, status = 200) {
    const before = await f.snapshot(), initial = resources(), response = await request(path, actor), body = await response.json() as Row;
    expect(response.status).toBe(200); expect(body.status).toBe(status);
    if (status !== 410000) expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial); return { body, response };
  }
  const navigation = async (template = '', actor: DiyStateViewer = 0): Promise<Row> => (await read('/api/navigation' + (template ? '/' + template : ''), actor)).body.data;
  const microFooter = async (actor: DiyStateViewer = 0): Promise<Row> => (await read('/api/diy/get_diy/2', actor)).body.data.value.find((x: Row) => typeof x.name === 'string' && x.name.toLowerCase() === 'pagefoot');
  async function imported(value: unknown, id = 2) { await f.db.update(systemDise).set({ value: typeof value === 'string' ? value : JSON.stringify(value) }).where(eq(systemDise.id, id)); }

  it('reads real global navigation and explicit micro footer for guest and two JWT owners while default home0 still strips pageFoot', async () => {
    for (const actor of [0, 11, 22] as const) {
      expect(canonical(await navigation('', actor))).toEqual(f.blocks[1]); expect(canonical(await microFooter(actor))).toEqual(f.blocks[1]);
      expect((await read('/api/diy/get_diy/0', actor)).body.data.value.some((x: Row) => x.name === 'pageFoot')).toBe(false);
    }
  });
  it('signs both exact icon slots with fresh platform capabilities and serves real uploaded pixels with full50/46 zero delta', async () => {
    const before = await f.snapshot(), initial = resources(), footer = await navigation();
    expect(footerSlots(footer)).toHaveLength(10); expect(new Set(footerSlots(footer)).size).toBe(1);
    expect(footerSlots(footer).every(x => x.startsWith(f.platformImage.url + '?expires='))).toBe(true);
    const image = await request(footerSlots(footer)[9]); expect(image.status).toBe(200); expect(image.headers.get('Content-Type')).toBe('image/png'); expect(new Uint8Array(await image.arrayBuffer())).toEqual(f.png);
    expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial);
  });
  it('real Admin signed-read/edit/save canonicalizes both icons and changes only intended value/version/update_time', async () => {
    const footer = await microFooter(), value = [structuredClone(f.blocks[0]), footer]; footer.menuList[0].name = '更新首页';
    const result = await f.saveSchema(2, value), expected = structuredClone(result.before); expect(result.body.status).toBe(200);
    const saved = result.after.system_dise.find(row => row.id === 2)!, want = [value[0], canonical(footer)];
    expect(saved.value).toBe(JSON.stringify(want)); expect(saved.version).not.toBe('diy-footer-1'); expect(saved.value).not.toContain('signature=');
    expected.system_dise = expected.system_dise.map(row => row.id === 2 ? { ...row, value: saved.value, version: saved.version, update_time: saved.update_time } : row);
    expect(result.after).toEqual(sortedDiyState(expected)); expect(canonical(await microFooter())).toEqual(want[1]);
  });
  it.each(['pageFoot', 'PAGEFOOT', 'PageFoot'])('keeps case-compatible %s and chooses the first global footer rather than a later duplicate', async name => {
    const footer = { ...diyFooterBlock(f.platformImage.url), name }, later = { ...diyFooterBlock('/static/logo.png'), name: 'pageFoot' };
    expect((await f.saveSchema(1, [footer, later])).body.status).toBe(200); expect(canonical(await navigation())).toEqual(footer);
  });
  it('preserves index2,links,names,preview,numeric-key object and foreign asset-shaped URLs on real save/public read', async () => {
    const stale = f.platformImage.url + '?expires=1&signature=old', foreign = 'https://foreign.test' + stale;
    const footer = { ...diyFooterBlock(f.platformImage.url), preview: stale, link: stale, menuList: [
      { name: stale, link: stale, imgList: [stale, stale, stale], img: stale }, { imgList: { 0: stale, 1: stale } }, { imgList: [foreign, '/static/logo.png'] }] };
    const result = await f.saveSchema(2, [footer]); expect(result.body.status).toBe(200); const saved = JSON.parse(result.after.system_dise.find(row => row.id === 2)!.value)[0];
    expect(saved).toEqual(canonical(footer)); expect(canonical(await microFooter())).toEqual(saved); expect((await microFooter()).menuList[0].imgList[2]).toBe(stale);
  });
  it('refreshes imported historical signed icons and withdraws expired old capabilities without schema/version or sequence writes', async () => {
    const footer = mapped(diyFooterBlock(f.platformImage.url), x => x + '?expires=1&signature=historical'); await imported([footer], 1);
    const before = await f.snapshot(), old = footerSlots(await navigation())[0]; vi.setSystemTime(new Date(DIY_FOOTER_NOW.getTime() + 901_000));
    const fresh = footerSlots(await navigation())[0]; expect(fresh).not.toBe(old); expect((await request(old)).status).toBe(404);
    const image = await request(fresh); expect(image.status).toBe(200); expect(new Uint8Array(await image.arrayBuffer())).toEqual(f.png); expect(await f.snapshot()).toEqual(before);
  });
  it.each([
    ['private user', { type: 3, relationId: 11, moduleType: 3 }], ['foreign user', { type: 3, relationId: 22, moduleType: 3 }],
    ['supplier', { type: 2, relationId: 91 }], ['merchant', { type: 4, relationId: 703 }], ['wrong admin relation', { type: 1, relationId: 11 }],
    ['foreign module', { moduleType: 5 }], ['nonimage', { fileType: 2 }], ['nonR2', { imageType: 0 }],
    ['MIME mismatch', { attType: 'image/jpeg' }], ['active MIME', { attType: 'text/html' }], ['bad owner key', { name: 'attachments/admin/2/x.png' }],
    ['traversal', { name: 'attachments/admin/1/../x.png' }], ['backslash', { name: 'attachments/admin/1/a\\b.png' }],
    ['SVG', { name: 'attachments/admin/1/x.svg' }], ['canonical mismatch', { attDir: '/api/assets/999999' }],
  ])('freshly refuses %s for both global/micro icons without exposing attachment metadata', async (_name, patch) => {
    const original = (await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, f.platformImage.att_id)))[0];
    try { await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId, original.attId));
      for (const footer of [await navigation(), await microFooter(11)]) { expect(footerSlots(footer)).toEqual(Array(10).fill('')); expect(JSON.stringify(footer)).not.toContain('attachments/'); }
    } finally { await f.db.update(systemAttachment).set(original).where(eq(systemAttachment.attId, original.attId)); }
  });
  it('withdraws deleted and actual private-user icons even to the private attachment owner', async () => {
    await imported([mapped(diyFooterBlock(f.platformImage.url), () => f.image.url)]); expect(footerSlots(await microFooter(11))).toEqual(Array(10).fill(''));
    const original = (await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, f.platformImage.att_id)))[0];
    try { await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, original.attId)); expect(footerSlots(await navigation())).toEqual(Array(10).fill('')); }
    finally { await f.db.insert(systemAttachment).values(original); }
  });
  it('fails closed for malformed/local missing references and preserves only approved external/static shapes', async () => {
    for (const reference of ['javascript:alert(1)', '//foreign.test/x.png', 'http://foreign.test/x.png', '/api/assets/0', '/api/assets/999999', '/api/assets/2/../3', 'x'.repeat(4097)]) {
      await imported([mapped(diyFooterBlock(f.platformImage.url), () => reference)], 1); expect(footerSlots(await navigation())).toEqual(Array(10).fill(''));
    }
  });
  it('preserves own navigation row predicates/descending id/template selection independently of unchanged version0', async () => {
    const footer = (title: string) => ({ ...diyFooterBlock('/static/logo.png'), menuList: [{ name: title, link: '/', imgList: ['/static/logo.png', '/static/logo.png'] }] });
    await f.db.insert(systemDise).values([{ id: 20, templateName: 'published-other', status: 1, type: 1, isDel: 0, isDiy: 0, value: JSON.stringify([footer('较新导航')]), version: 'other' },
      { id: 21, templateName: 'deleted', status: 1, type: 1, isDel: 1, value: JSON.stringify([footer('已删不得读取')]) },
      { id: 22, templateName: 'explicit-hidden', status: 0, type: 2, isDel: 0, value: JSON.stringify([footer('明确模板')]) }]);
    expect((await navigation()).menuList[0].name).toBe('较新导航'); expect((await navigation('explicit-hidden')).menuList[0].name).toBe('明确模板');
    expect((await read('/api/diy/diy_version/0')).body.data).toEqual({ version: 'diy-footer-1' });
    await f.db.update(systemDise).set({ value: JSON.stringify([footer('相同version0新导航')]) }).where(eq(systemDise.id, 20));
    expect((await navigation()).menuList[0].name).toBe('相同version0新导航'); expect((await read('/api/diy/diy_version/0')).body.data.version).toBe('diy-footer-1');
  });
  it.each(['', '0'])('uses PHP-empty raw value %j as default fallback but not arbitrary parse failures', async value => {
    await f.db.insert(systemDise).values({ id: 20, templateName: 'empty', status: 1, type: 1, isDel: 0, isDiy: 0, value });
    expect(canonical(await navigation())).toEqual(f.blocks[1]); expect(canonical(await navigation('empty'))).toEqual(f.blocks[1]);
  });
  it.each(['broken-json', 'false', 'null', '1', ' 0 ', '{}', '[]'])('does not silently fallback for nonempty invalid/nonarray/no-footer source %s', async value => {
    await f.db.insert(systemDise).values({ id: 20, templateName: 'nonempty', status: 1, type: 1, isDel: 0, isDiy: 0, value }); expect(await navigation()).toEqual({});
  });
  it('reads footer after2000 components through the exact2MB UTF8 Admin/public entrance, preserving source and separate body contract', async () => {
    const value = [...Array.from({ length: 2001 }, () => ({ name: 'blankPage' })), diyFooterBlock(f.platformImage.url)] as Row[];
    value[0].padding = ''; const base = Buffer.byteLength(JSON.stringify(value)); value[0].padding = 'x'.repeat(2_000_000 - base);
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(2_000_000); expect((await f.saveSchema(1, value)).body.status).toBe(200);
    expect(canonical(await navigation())).toEqual(value.at(-1)); await imported(value, 2); expect(canonical(await microFooter())).toEqual(value.at(-1));
    value[0].padding += 'x'; const rejected = await f.saveSchema(1, value); expect(rejected.body.status).toBe(400); expect(rejected.after).toEqual(rejected.before);
    await imported(value, 1); expect(await navigation()).toEqual({}); // Existing bounded read returns no partial/footer fallback.
  }, 30_000);
  it('uses UTF8 bytes rather than JS character count and retains Admin node/depth rejection atomically', async () => {
    const value = [{ name: 'blankPage', text: '界'.repeat(666_667) }, diyFooterBlock(f.platformImage.url)];
    expect(JSON.stringify(value).length).toBeLessThan(1_000_000); const failed = await f.saveSchema(1, value); expect(failed.body.status).toBe(400); expect(failed.after).toEqual(failed.before);
    await imported(value, 1); expect(await navigation()).toEqual({});
    for (const content of [Array.from({ length: 100_001 }, () => 0), Array.from({ length: 65 }).reduce<unknown>(x => ({ child: x }), '')]) {
      const rejected = await f.saveSchema(2, [{ name: 'blankPage', content }, diyFooterBlock(f.platformImage.url)]); expect(rejected.body.status).toBe(400); expect(rejected.after).toEqual(rejected.before);
    }
  });
  it('saves/reads all10000 renderable imported items and all20000 exact footer slots without silent truncation', async () => {
    const footer = { ...diyFooterBlock(f.platformImage.url), menuList: Array.from({ length: DIY_FOOTER_MEDIA_SLOT_LIMIT / 2 }, (_, index) => ({ name: '项' + index, link: '/', imgList: [f.platformImage.url, f.platformImage.url] })) };
    expect((await f.saveSchema(1, [footer])).body.status).toBe(200); const projected = await navigation(); expect(projected.menuList).toHaveLength(10000);
    expect(footerSlots(projected)).toHaveLength(20000); expect(footerSlots(projected)[19999]).toContain('?expires='); expect(canonical(projected)).toEqual(footer);
  });
  it('keeps full42500 mixed slots independent and rejects footer20001 atomically before partial signatures/save', async () => {
    const footer = { name: 'pageFoot', menuList: Array.from({ length: 10000 }, () => ({ imgList: [f.platformImage.url, f.platformImage.url] })) };
    const blocks = [{ name: 'menus', menuConfig: { list: Array.from({ length: 20000 }, () => ({ img: f.platformImage.url })) } },
      { name: 'swipers', swiperConfig: { list: Array.from({ length: 2500 }, () => ({ img: f.platformImage.url })) } }, footer];
    expect((await f.saveSchema(2, blocks)).body.status).toBe(200); const projected = (await read('/api/diy/get_diy/2')).body.data.value;
    expect(projected[0].menuConfig.list).toHaveLength(20000); expect(projected[1].swiperConfig.list).toHaveLength(2500); expect(footerSlots(projected[2])).toHaveLength(20000);
    footer.menuList.push({ imgList: [f.platformImage.url] }); const rejected = await f.saveSchema(2, blocks); expect(rejected.body.status).toBe(400); expect(rejected.after).toEqual(rejected.before);
    await imported(blocks); const refused = await read('/api/diy/get_diy/2', 0, 400); expect(JSON.stringify(refused.body)).not.toContain('signature=');
    await imported([footer], 1); expect((await read('/api/navigation', 0, 400)).body.msg).toBe('DIY公开素材超过完整读取容量');
  }, 30_000);
  it('signs257 real approved uploaded icons across batch2 and serves its final raster with no GET delta', async () => {
    const footer = { name: 'pageFoot', menuList: batch.map(x => ({ imgList: [x.url] })) }; expect((await f.saveSchema(1, [footer])).body.status).toBe(200);
    const before = await f.snapshot(), initial = resources(), slots = footerSlots(await navigation()); expect(new Set(slots).size).toBe(257);
    const response = await request(slots[256]); expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.png);
    expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial);
  });
  it('does not partially project a clearly synthetic second-HMAC-batch failure', async () => {
    const blocks = [{ name: 'pageFoot', menuList: batch.map(x => ({ imgList: [x.url] })) }], original = structuredClone(blocks), before = await f.snapshot(), initial = resources();
    const sign = crypto.subtle.sign.bind(crypto.subtle); let count = 0; const fault = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args: Parameters<typeof crypto.subtle.sign>) => {
      if (++count === 257) throw Error('Synthetic owned footer HMAC batch2 failure'); return sign(...args);
    });
    try { await expect(renderDiyEditorialMedia(f.db, f.env.APP_KEY, blocks)).rejects.toThrow('Synthetic owned footer HMAC batch2 failure'); expect(count).toBe(257); expect(blocks).toEqual(original); expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial); }
    finally { fault.mockRestore(); }
  });
  it('counts actual private actor quantities independently of public navigation and old row-count variants with no cleanup writes', async () => {
    for (const [actor, sum, rows, oldScoped, oldUnscoped] of [[11, 7, 2, 3, 4], [22, 4, 1, 1, 1]] as const) {
      for (const [query, expected] of [['scope=cart&numType=0', sum], ['numType=0', sum], ['scope=cart&numType=1', rows], ['scope=cart', oldScoped], ['', oldUnscoped]] as const) {
        const { body, response } = await read('/api/cart/count' + (query ? '?' + query : ''), actor); expect(body.data).toEqual({ count: expected }); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      }
    }
    expect((await read('/api/cart/count?scope=cart&numType=0', 0, 410000)).body.data).toBeNull();
  });
  it.each(['scope=cart&scope=cart', 'numType=0&numType=1', 'scope=cart&numType=false', 'scope=cart&numType=00', 'scope=other&numType=0'])('rejects actual invalid/duplicated footer selector %s without DB or resource delta', async query => { await read('/api/cart/count?' + query, 11, 400); });
  it('does not gate public navigation or private read count on the DIY station middleware, and retains raw get_script', async () => {
    await f.setConfig('station_open', '0');
    expect(canonical(await navigation())).toEqual(f.blocks[1]); expect((await read('/api/cart/count?numType=0', 11)).body.data.count).toBe(7);
    expect((await read('/api/diy/diy_version/0', 0, 410010)).body.data).toBeNull();
    const before = await f.snapshot(), initial = resources(), response = await request('/api/get_script'); expect(await response.text()).toBe(f.statisticsScript); expect(response.headers.get('Content-Type')).toContain('application/javascript'); expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial);
    await f.setConfig('station_open', '1');
  });
});
