import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemAttachment, systemDise } from '@/models/schema';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { renderDiyEditorialMedia } from '@/services/content/DiyEditorialMediaPolicy';
import { AttachmentService, adminAttachmentScope } from '@/services/system/AttachmentService';
import { diyNavigationFixture, DIY_NAVIGATION_FAMILIES, DIY_NAVIGATION_NOW } from './helpers/diyNavigationFixture';
import { sortedDiyState, type DiyStateRow as Row, type DiyStateViewer } from './helpers/diyStateFixture';

const requiredBlock = (blocks: Row[], timestamp: number): Row => {
  const value = blocks.find(row => row.timestamp === timestamp);
  if (!value) throw Error(`Missing owned navigation fixture block ${timestamp}`);
  return value;
};
function mapMedia(blocks: Row[], transform: (value: string) => string): Row[] {
  const value = structuredClone(blocks);
  for (const block of value) {
    if (block.name === 'headerSerch') block.logoConfig.url = transform(block.logoConfig.url);
    else if (block.name === 'menus') for (const item of block.menuConfig.list) item.img = transform(item.img);
    else if (block.name === 'pictureCube') {
      for (const item of block.picStyle.picList) item.image = transform(item.image);
      if (block.styleConfig.tabVal === 11 || block.styleConfig.tabVal === '11') {
        for (const item of block.picStyle.docPicList) item.img = transform(item.img);
      }
    }
  }
  return value;
}
function mediaValues(blocks: Row[]): string[] {
  return blocks.flatMap(block => block.name === 'headerSerch' ? [block.logoConfig.url]
    : block.name === 'menus' ? block.menuConfig.list.map((item: Row) => item.img)
      : block.name === 'pictureCube' ? [...block.picStyle.picList.map((item: Row) => item.image),
        ...([11, '11'].includes(block.styleConfig.tabVal) ? block.picStyle.docPicList.map((item: Row) => item.img) : [])] : []);
}
const canonicalProjection = (blocks: Row[]) => mapMedia(blocks, canonicalizePublishedAttachmentReference);
const fullMenu = (image: string) => ({ img: image, show: true, info: [{ value: '图' }, { value: '/' }] });
const menuBlocks = (image: string, complete = false) => Array.from({ length: 200 }, (_, index) => ({ name: 'menus', timestamp: 1000 + index,
  menuStyleConfig: { tabVal: 1 }, menuConfig: { maxList: 100, list: Array.from({ length: 100 }, () => complete ? fullMenu(image) : { img: image }) } }));

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned DIY navigation SQL'); return wiring.container;
} }));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native complete DIY navigation media contracts on owned PostgreSQL16', () => {
  let f: Awaited<ReturnType<typeof diyNavigationFixture>>;
  let schemas: Array<typeof systemDise.$inferSelect>;
  const batchMedia: Array<{ att_id: number; url: string }> = [];
  const app = createApp();
  beforeAll(async () => {
    vi.setSystemTime(DIY_NAVIGATION_NOW); f = await diyNavigationFixture(DIY_NAVIGATION_NOW); wiring.container = f.container;
    expect(f.tables).toHaveLength(50); expect(f.sequences).toHaveLength(46);
    // Explicit owned setup, outside every measured GET. Real uploads exercise
    // raster detection, R2 put, metadata transaction/sequence and platform key.
    const before = await f.snapshot(), beforeStorage = resources(), uploader = new AttachmentService(f.container, f.env);
    for (let index = 0; index < 257; index++) batchMedia.push(await uploader.uploadImage(adminAttachmentScope(),
      new File([f.png], `navigation-batch-${index}.png`, { type: 'image/png' }), 0));
    const after = await f.snapshot(), want = structuredClone(before), afterStorage = resources();
    want.system_attachment = after.system_attachment;
    want.__sequences = want.__sequences.map(row => row.name === 'system_attachment_att_id_seq'
      ? after.__sequences.find(next => next.name === row.name)! : row);
    expect(after).toEqual(sortedDiyState(want));
    expect(after.system_attachment.filter(row => !before.system_attachment.some(old => old.att_id === row.att_id))).toHaveLength(257);
    expect(new Set(batchMedia.map(row => row.att_id)).size).toBe(257);
    expect(Number(after.__sequences.find(row => row.name === 'system_attachment_att_id_seq')!.last))
      .toBe(Number(before.__sequences.find(row => row.name === 'system_attachment_att_id_seq')!.last) + 257);
    expect(afterStorage.puts).toBe(beforeStorage.puts + 257); expect(afterStorage.objects).toHaveLength(beforeStorage.objects.length + 257);
    expect(afterStorage.objects.filter(row => beforeStorage.objects.some(old => old.key === row.key))).toEqual(beforeStorage.objects);
    expect({ ...afterStorage, puts: beforeStorage.puts, objects: beforeStorage.objects }).toEqual(beforeStorage);
    const directory = await mkdtemp(join(tmpdir(), 'cinashop-diy-navigation-native-batch-')), path = join(directory, 'setup.json');
    const receipt = JSON.stringify({ phase: 'owned-fixture-setup-only', method: 'actual AttachmentService.uploadImage(adminAttachmentScope)',
      count: 257, allowed: ['system_attachment rows', 'system_attachment_att_id_seq', '257 owned R2 puts'],
      before, after, storage_before: beforeStorage, storage_after: afterStorage, images: batchMedia }, null, 2) + '\n';
    await writeFile(path, receipt);
    process.stdout.write('DIY_NAVIGATION_ATTACHMENT_BATCH_SETUP ' + JSON.stringify({ path, sha256: createHash('sha256').update(receipt).digest('hex'), count: 257 }) + '\n');
    schemas = await f.db.select().from(systemDise);
  }, 45_000);
  afterAll(async () => { wiring.container = undefined; vi.useRealTimers(); await f?.close(); }, 30_000);
  beforeEach(() => {
    vi.setSystemTime(DIY_NAVIGATION_NOW);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned DIY navigation fixture forbids external I/O'));
  });
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally {
      vi.restoreAllMocks();
      for (const row of schemas) await f.db.update(systemDise).set(row).where(eq(systemDise.id, row.id));
    }
  });
  const resources = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length,
    objects: [...f.objects].map(([key, item]) => ({ key, type: item.type, bytes: [...item.bytes] })),
    imageInfo: f.rendering.info.mock.calls.length, imageInput: f.rendering.input.mock.calls.length,
    imageOutput: f.rendering.output.mock.calls.length, queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length });
  async function request(path: string, viewer: DiyStateViewer = 0) {
    const waits: Promise<unknown>[] = [];
    const response = await app.fetch(new Request(`http://localhost${path}`, { headers: viewer ? { 'Authori-zation': `Bearer ${viewer === 11 ? f.token : f.otherToken}` } : {} }),
      f.env, { waitUntil: (work: Promise<unknown>) => { waits.push(work); }, passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(waits); return response;
  }
  async function read(path: string, viewer: DiyStateViewer = 0, status = 200) {
    const before = await f.snapshot(), initial = resources(), response = await request(path, viewer), body = await response.json() as Row;
    expect(response.status).toBe(200); expect(body.status).toBe(status);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial); return body;
  }
  async function schema(page: 0 | 2 = 0, viewer: DiyStateViewer = 0): Promise<Row[]> {
    return (await read(`/api/diy/get_diy/${page}`, viewer)).data.value;
  }
  async function importSchema(blocks: Row[]) {
    await f.db.update(systemDise).set({ value: JSON.stringify(blocks) }).where(eq(systemDise.id, 2));
  }

  it('reads home0/micro2 actual header/search, tabs, all menu modes and all twelve cubes for guest and both owners with no GET writes', async () => {
    for (const page of [0, 2] as const) for (const viewer of [0, 11, 22] as const) {
      expect((await read(`/api/diy/diy_version/${page}`, viewer)).data).toEqual({ version: 'diy-navigation-1' });
      const blocks = await schema(page, viewer);
      expect(canonicalProjection(blocks)).toEqual(f.blocks);
      expect(DIY_NAVIGATION_FAMILIES.map(name => blocks.filter(row => row.name === name).length)).toEqual([3, 3, 6, 12]);
      expect(blocks.filter(row => row.name === 'headerSerch').map(row => row.styleConfig.tabVal)).toEqual([0, 1, 2]);
      expect(blocks.filter(row => row.name === 'tabNav').map(row => row.styleConfig.tabVal)).toEqual([0, 1, 2]);
      expect(blocks.filter(row => row.name === 'menus').map(row => [row.menuStyleConfig.tabVal, row.showConfig.tabVal])).toEqual([[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1]]);
      expect(blocks.filter(row => row.name === 'menus').map(row => row.number.tabVal)).toEqual([0, 0, 1, 1, 2, 2]);
      expect(blocks.filter(row => row.name === 'pictureCube').map(row => row.styleConfig.tabVal)).toEqual(Array.from({ length: 12 }, (_, i) => i));
      expect(requiredBlock(blocks, 811).tabListConfig.list).toEqual(requiredBlock(f.blocks, 811).tabListConfig.list);
    }
  });

  it('freshly signs exactly the actual header/menu/cube slots and serves real platform raster pixels for 900 seconds without SQL/sequence/R2/queue changes', async () => {
    const before = await f.snapshot(), initial = resources(), slots = mediaValues(await schema());
    expect(slots).toHaveLength(60);
    const signed = slots.filter(value => value.startsWith(f.platformImage.url + '?'));
    expect(signed).toHaveLength(26); expect(new Set(signed).size).toBe(1);
    for (const value of signed) expect(value).toMatch(new RegExp(`^${f.platformImage.url}\\?expires=${f.seconds + 900}&signature=[A-Za-z0-9_-]{43}$`));
    const image = await request(signed[0]); expect(image.status).toBe(200); expect(image.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(f.png);
    expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial);
  });

  it('canonicalizes real Admin signed read/edit/save media while changing only intended config and selected row version/update_time', async () => {
    const blocks = await schema();
    requiredBlock(blocks, 801).titleConfig.value = '真实更新商城';
    requiredBlock(blocks, 821).menuConfig.list[0].info[0].value = '更新导航';
    requiredBlock(blocks, 852).picStyle.docPicList[0].doc.w = 148;
    const expectedValue = canonicalProjection(blocks), result = await f.saveSchema(2, blocks), expected = structuredClone(result.before);
    expect(result.response.status).toBe(200); expect(result.body.status).toBe(200);
    const saved = result.after.system_dise.find(row => row.id === 2)!;
    expect(saved.value).toBe(JSON.stringify(expectedValue)); expect(saved.value).not.toContain('signature=');
    expect(saved.version).not.toBe('diy-navigation-1');
    expected.system_dise = expected.system_dise.map(row => row.id === 2 ? { ...row, value: JSON.stringify(expectedValue), version: saved.version, update_time: saved.update_time } : row);
    expect(result.after).toEqual(sortedDiyState(expected));
    expect(canonicalProjection(await schema(2, 22))).toEqual(expectedValue);
    expect(canonicalProjection(await schema(0))).toEqual(f.blocks);
  });

  it('refreshes imported old signed media without persisting tickets, touching canonical/by-standing JSON, or incrementing the page version', async () => {
    const blocks = mapMedia(f.blocks, value => value === f.platformImage.url ? `${value}?expires=1&signature=imported-ticket` : value);
    await importSchema(blocks);
    const before = await f.snapshot(), projected = await schema(2);
    expect(canonicalProjection(projected)).toEqual(f.blocks);
    expect(mediaValues(projected).filter(value => value.startsWith(f.platformImage.url + '?'))).toHaveLength(26);
    expect(await f.snapshot()).toEqual(before);
    expect((await read('/api/diy/diy_version/2')).data).toEqual({ version: 'diy-navigation-1' });
  });

  it('renews real capabilities after 900 seconds even when canonical schema and version stay fixed, withdrawing the expired capability', async () => {
    const old = requiredBlock(await schema(), 801).logoConfig.url, before = await f.snapshot(), initial = resources();
    vi.setSystemTime(new Date(DIY_NAVIGATION_NOW.getTime() + 901_000));
    expect((await read('/api/diy/diy_version/0')).data).toEqual({ version: 'diy-navigation-1' });
    const fresh = requiredBlock(await schema(), 801).logoConfig.url;
    expect(fresh).not.toBe(old); expect(Number(new URL(fresh, 'http://localhost').searchParams.get('expires'))).toBe(f.seconds + 901 + 900);
    expect((await request(old)).status).toBe(404);
    const image = await request(fresh); expect(image.status).toBe(200); expect(new Uint8Array(await image.arrayBuffer())).toEqual(f.png);
    expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial);
  });

  it('leaves links/info, inactive custom rows, cube picker previews, tabNav images and unrelated schema strings unchanged on save and public read', async () => {
    const stale = `${f.platformImage.url}?expires=1&signature=bystander-ticket`, blocks = structuredClone(f.blocks);
    for (const block of blocks) {
      block.linkConfig = { value: stale }; block.backgroundConfig = { url: stale }; block.preview = stale;
      if (block.name === 'menus') for (const item of block.menuConfig.list) {
        item.link = stale; item.image = stale; for (const info of item.info) { info.title = stale; info.value = stale; }
      }
      if (block.name === 'pictureCube') {
        block.menuConfig.list[0].img = stale; block.picStyle.url = stale;
        for (const item of block.picStyle.picList) { item.img = stale; item.link = stale; }
        for (const item of block.picStyle.docPicList) { item.image = stale; item.link = stale; }
        if (block.styleConfig.tabVal !== 11) block.picStyle.docPicList = [{ img: stale, link: stale }];
      }
      if (block.name === 'tabNav') { block.logoConfig = { url: stale }; block.menuConfig = { list: [{ img: stale }] }; block.tabListConfig.list[0].img = stale; }
      if (block.name === 'headerSerch') { block.logoConfig.preview = stale; block.imgConfig.url = stale; }
    }
    blocks.push({ name: 'unrelated-private-preview', logoConfig: { url: stale }, menuConfig: { list: [{ img: stale }] }, picStyle: { picList: [{ image: stale }] } });
    const result = await f.saveSchema(2, blocks);
    expect(result.body.status).toBe(200); expect(result.after.system_dise.find(row => row.id === 2)!.value).toBe(JSON.stringify(blocks));
    expect(canonicalProjection(await schema(2))).toEqual(blocks);
    expect(requiredBlock(await schema(2), 841).picStyle.docPicList[0].img).toBe(stale);
  });

  it.each([11, '11', 0, '0', false, null, {}, [], '011', 11.5].map(style => ({ style })))('admits custom docPicList media only for exact style11, with raw style $style', async ({ style }) => {
    const stale = `${f.platformImage.url}?expires=1&signature=old-custom`, blocks = [{ name: 'pictureCube', styleConfig: { tabVal: style },
      picStyle: { picList: [{ image: stale, link: stale }], docPicList: [{ img: stale, link: stale }] } }];
    expect((await f.saveSchema(2, blocks)).body.status).toBe(200);
    const saved = JSON.parse((await f.snapshot()).system_dise.find(row => row.id === 2)!.value)[0];
    expect(saved.picStyle.picList[0].image).toBe(f.platformImage.url);
    expect(saved.picStyle.docPicList[0].img).toBe(style === 11 || style === '11' ? f.platformImage.url : stale);
    const projected = (await schema(2))[0];
    expect(projected.picStyle.picList[0].image).toContain('?expires=');
    expect(projected.picStyle.docPicList[0].img).toBe(style === 11 || style === '11' ? projected.picStyle.picList[0].image : stale);
    expect(projected.picStyle.picList[0].link).toBe(stale); expect(projected.picStyle.docPicList[0].link).toBe(stale);
  });

  it('keeps complete imported menus and both custom-cube arrays beyond Admin list bounds instead of signing only a prefix', async () => {
    const blocks = [{ name: 'menus', menuConfig: { maxList: 100, list: Array.from({ length: 137 }, () => fullMenu(f.platformImage.url)) } },
      { name: 'pictureCube', styleConfig: { tabVal: 11 }, picStyle: {
        picList: Array.from({ length: 137 }, () => ({ image: f.platformImage.url, link: '/' })),
        docPicList: Array.from({ length: 137 }, () => ({ img: f.platformImage.url, link: '/', doc: { startX: 0, startY: 0, w: 10, h: 10 } })) } }];
    expect((await f.saveSchema(2, blocks)).body.status).toBe(200);
    const projected = await schema(2); expect(mediaValues(projected)).toHaveLength(411);
    expect(mediaValues(projected).every(value => value.startsWith(f.platformImage.url + '?expires='))).toBe(true);
  });

  it('saves and reads the full compact 200-component by 100-menu 20000-slot budget through real Admin without truncation', async () => {
    const blocks = menuBlocks(f.platformImage.url), result = await f.saveSchema(2, blocks);
    expect(Buffer.byteLength(JSON.stringify(blocks))).toBeLessThan(2_000_000);
    expect(result.body.status).toBe(200);
    const projected = await schema(2); expect(projected).toHaveLength(200);
    expect(projected.every(block => block.menuConfig.list.length === 100)).toBe(true);
    expect(mediaValues(projected)).toHaveLength(20000); expect(new Set(mediaValues(projected)).size).toBe(1);
    expect(mediaValues(projected)[19999]).toContain(`${f.platformImage.url}?expires=`);
    expect(canonicalProjection(projected)).toEqual(blocks);
  });

  it('projects every complete 200-by-100 imported menu while retaining the existing atomic Admin 100000-node protection', async () => {
    const blocks = menuBlocks(f.platformImage.url, true);
    expect(Buffer.byteLength(JSON.stringify(blocks))).toBeLessThan(2_000_000);
    const rejected = await f.saveSchema(2, blocks);
    expect(rejected.body.status).toBe(400); expect(rejected.body.msg).toBe('value结构过于复杂'); expect(rejected.after).toEqual(rejected.before);
    await importSchema(blocks);
    const projected = await schema(2);
    expect(mediaValues(projected)).toHaveLength(20000);
    expect(mediaValues(projected).every(value => value.startsWith(f.platformImage.url + '?expires='))).toBe(true);
    expect(canonicalProjection(projected)).toEqual(blocks);
  });

  it('keeps the original 2MB and depth64 Admin bounds atomic without relaxing them to fit expanded navigation media', async () => {
    for (const blocks of [[{ name: 'headerSerch', logoConfig: { url: f.platformImage.url }, content: 'x'.repeat(2_000_000) }],
      [{ name: 'headerSerch', logoConfig: { url: f.platformImage.url }, content: Array.from({ length: 65 }).reduce<unknown>(value => ({ child: value }), '') }]]) {
      const failed = await f.saveSchema(2, blocks);
      expect(failed.body.status).toBe(400); expect(failed.after).toEqual(failed.before);
      expect(['value内容过长', 'value结构过于复杂']).toContain(failed.body.msg);
    }
  });

  it('rejects navigation slot20001 atomically on real Admin save and imported GET with no partial capability output', async () => {
    const blocks = menuBlocks(f.platformImage.url); blocks[199].menuConfig.list.push({ img: f.platformImage.url });
    const rejected = await f.saveSchema(2, blocks);
    expect(rejected.body.status).toBe(400); expect(rejected.body.msg).toBe('DIY公开素材超过完整读取容量'); expect(rejected.after).toEqual(rejected.before);
    await importSchema(blocks);
    const body = await read('/api/diy/get_diy/2', 0, 400);
    expect(body.msg).toBe('DIY公开素材超过完整读取容量'); expect(JSON.stringify(body)).not.toContain('signature=');
  });

  it('keeps the old 2500-slot family limit independent while projecting all 22500 mixed navigation/carousel slots', async () => {
    const blocks: Row[] = menuBlocks(f.platformImage.url);
    blocks.push({ name: 'swipers', swiperConfig: { list: Array.from({ length: 2500 }, () => ({ img: f.platformImage.url })) } });
    expect((await f.saveSchema(2, blocks)).body.status).toBe(200);
    const projected = await schema(2);
    expect(mediaValues(projected)).toHaveLength(20000);
    expect(projected[200].swiperConfig.list).toHaveLength(2500);
    const ticket = mediaValues(projected)[19999]; expect(ticket).toContain('?expires=');
    expect(projected[200].swiperConfig.list.every((item: Row) => item.img === ticket)).toBe(true);
    blocks[200].swiperConfig.list.push({ img: f.platformImage.url });
    const failed = await f.saveSchema(2, blocks);
    expect(failed.body.status).toBe(400); expect(failed.body.msg).toBe('DIY公开素材超过完整读取容量'); expect(failed.after).toEqual(failed.before);
  });

  it('resolves 20000 distinct authored references in bounded owner-check batches and still signs the real final slot', async () => {
    const blocks = menuBlocks(f.platformImage.url);
    for (let index = 0; index < 19999; index++) blocks[Math.floor(index / 100)].menuConfig.list[index % 100].img = `/api/assets/${100000 + index}`;
    expect((await f.saveSchema(2, blocks)).body.status).toBe(200);
    const slots = mediaValues(await schema(2)); expect(slots).toHaveLength(20000);
    expect(slots.slice(0, -1).every(value => value === '')).toBe(true);
    expect(slots[19999]).toContain(`${f.platformImage.url}?expires=`);
  });

  it('signs all257 distinct real uploaded platform assets through both HMAC batches and serves the final actual raster with zero GET delta', async () => {
    expect(batchMedia).toHaveLength(257);
    const blocks = [{ name: 'menus', menuConfig: { list: batchMedia.map(image => fullMenu(image.url)) } }];
    expect((await f.saveSchema(2, blocks)).body.status).toBe(200);
    const before = await f.snapshot(), initial = resources(), slots = mediaValues(await schema(2));
    expect(slots).toHaveLength(257); expect(new Set(slots).size).toBe(257);
    for (let index = 0; index < slots.length; index++) expect(slots[index]).toMatch(new RegExp(`^${batchMedia[index].url}\\?expires=${f.seconds + 900}&signature=[A-Za-z0-9_-]{43}$`));
    const last = await request(slots[256]); expect(last.status).toBe(200); expect(last.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await last.arrayBuffer())).toEqual(f.png);
    expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial);
  });

  it('keeps the complete projection canonical when a clearly synthetic HMAC failure occurs at the first operation of batch2', async () => {
    const blocks = [{ name: 'menus', menuConfig: { list: batchMedia.map(image => fullMenu(image.url)) } }], originalBlocks = structuredClone(blocks);
    const before = await f.snapshot(), initial = resources(), sign = crypto.subtle.sign.bind(crypto.subtle); let count = 0;
    const fault = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args: Parameters<typeof crypto.subtle.sign>) => {
      if (++count === 257) throw Error('Owned synthetic HMAC batch2 failure; no provider claim');
      return sign(...args);
    });
    try {
      await expect(renderDiyEditorialMedia(f.db, f.env.APP_KEY, blocks)).rejects.toThrow('Owned synthetic HMAC batch2 failure');
      expect(count).toBe(257); expect(blocks).toEqual(originalBlocks); expect(JSON.stringify(blocks)).not.toContain('signature=');
      expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial);
    } finally { fault.mockRestore(); }
  });

  it('never treats foreign HTTPS asset-shaped URLs or their query tickets as this platform attachment', async () => {
    const foreign = `https://foreign.example/api/assets/${f.platformImage.att_id}?expires=1&signature=foreign-ticket`;
    const blocks = mapMedia(f.blocks, () => foreign);
    expect((await f.saveSchema(2, blocks)).body.status).toBe(200);
    expect(await schema(2)).toEqual(blocks);
  });

  it('withdraws malformed, unsafe, overlong and nonexistent local media references across every real navigation slot without fetching them', async () => {
    for (const reference of ['javascript:alert(1)', 'http://external.example/image.png', '//external.example/image.png', '/api/assets/0',
      '/api/assets/2147483648', '/api/assets/2/../3', '/api/assets/999999', '/api/assets/2\\evil', '/static/a\n.png', 'x'.repeat(4097)]) {
      await importSchema(mapMedia(f.blocks, () => reference));
      expect(mediaValues(await schema(2)).every(value => value === '')).toBe(true);
    }
  });

  it('refuses actual private user media in every real slot even to its authenticated owner, preserving canonical config', async () => {
    const blocks = mapMedia(f.blocks, value => value === f.platformImage.url ? f.image.url : value);
    expect((await f.saveSchema(2, blocks)).body.status).toBe(200);
    const expected = mediaValues(blocks).map(value => value === f.image.url ? '' : value);
    for (const actor of [0, 11, 22] as const) expect(mediaValues(await schema(2, actor))).toEqual(expected);
  });

  it.each([
    ['private user', { type: 3, relationId: 11, moduleType: 3 }],
    ['foreign user', { type: 3, relationId: 22, moduleType: 3 }],
    ['merchant owner', { type: 4, relationId: 703 }],
    ['wrong platform relation', { type: 1, relationId: 11 }],
    ['foreign module', { moduleType: 5 }],
    ['non-image file', { fileType: 2 }],
    ['non-R2 raster', { imageType: 0 }],
    ['contradictory raster MIME', { attType: 'image/jpeg' }],
    ['active MIME', { attType: 'text/html' }],
    ['foreign object folder', { name: 'attachments/admin/2/foreign.png' }],
    ['traversing object key', { name: 'attachments/admin/1/../foreign.png' }],
    ['backslash object key', { name: 'attachments/admin/1/foreign\\image.png' }],
    ['non-raster object extension', { name: 'attachments/admin/1/foreign.svg' }],
    ['mismatched canonical relation', { attDir: '/api/assets/999999' }],
  ])('freshly rechecks %s and withdraws header/menu/ordinary/custom-cube signatures without exposing owner rows', async (_label, patch) => {
    const original = (await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, f.platformImage.att_id)))[0];
    try {
      await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId, original.attId));
      const projected = await schema();
      expect(mediaValues(projected)).toEqual(mediaValues(f.blocks).map(value => value === f.platformImage.url ? '' : value));
      expect(JSON.stringify(projected)).not.toContain('attachments/admin/');
    } finally { await f.db.update(systemAttachment).set(original).where(eq(systemAttachment.attId, original.attId)); }
  });

  it('withdraws every public navigation capability after actual attachment deletion without rewriting canonical page data/version', async () => {
    const original = (await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, f.platformImage.att_id)))[0];
    try {
      await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, original.attId));
      expect(mediaValues(await schema())).toEqual(mediaValues(f.blocks).map(value => value === f.platformImage.url ? '' : value));
      expect((await read('/api/diy/diy_version/0')).data).toEqual({ version: 'diy-navigation-1' });
    } finally { await f.db.insert(systemAttachment).values(original); }
  });

  it('keeps legacy empty raster MIME compatible only with the existing explicit platform image/key/extension proof', async () => {
    const original = (await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, f.platformImage.att_id)))[0];
    try {
      await f.db.update(systemAttachment).set({ attType: '' }).where(eq(systemAttachment.attId, original.attId));
      expect(canonicalProjection(await schema())).toEqual(f.blocks);
      expect(mediaValues(await schema()).filter(value => value.startsWith(f.platformImage.url + '?'))).toHaveLength(26);
    } finally { await f.db.update(systemAttachment).set(original).where(eq(systemAttachment.attId, original.attId)); }
  });

  it('retains raw configured get_script JavaScript compatibility and zero-write reads instead of a new JSON hydration envelope', async () => {
    for (const actor of [0, 11, 22] as const) {
      const before = await f.snapshot(), initial = resources(), response = await request('/api/get_script', actor);
      expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff'); expect(await response.text()).toBe(f.statisticsScript);
      expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial);
    }
  });

  it('retains station-first real schema/version rejection for both callers without signing or materializing navigation resources', async () => {
    try {
      await f.setConfig('station_open', '0');
      for (const page of [0, 2]) for (const endpoint of ['get_diy', 'diy_version']) {
        expect((await read(`/api/diy/${endpoint}/${page}`, 0, 410010)).msg).toBe('站点升级中，请稍候访问');
      }
    } finally { await f.setConfig('station_open', '1'); }
  });
});
