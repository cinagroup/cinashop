import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemAttachment, systemDise } from '@/models/schema';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { diyCarouselFixture, DIY_CAROUSEL_FAMILIES, DIY_CAROUSEL_NOW } from './helpers/diyCarouselFixture';
import { sortedDiyState, type DiyStateRow as Row, type DiyStateViewer } from './helpers/diyStateFixture';

const requiredBlock = (blocks: Row[], timestamp: number): Row => {
  const value = blocks.find(row => row.timestamp === timestamp);
  if (!value) throw Error(`Missing owned carousel fixture block ${timestamp}`);
  return value;
};
function mediaValues(blocks: Row[]): string[] {
  return blocks.flatMap(block => DIY_CAROUSEL_FAMILIES.includes(block.name)
    ? [...block.swiperConfig.list.map((item: Row) => item.img), ...(block.name === 'homeComb' ? [block.logoConfig.url] : [])]
    : []);
}
function canonicalProjection(blocks: Row[]): Row[] {
  const value = structuredClone(blocks);
  for (const block of value) if (DIY_CAROUSEL_FAMILIES.includes(block.name)) {
    for (const item of block.swiperConfig.list) item.img = canonicalizePublishedAttachmentReference(item.img);
    if (block.name === 'homeComb') block.logoConfig.url = canonicalizePublishedAttachmentReference(block.logoConfig.url);
  }
  return value;
}
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned DIY carousel SQL'); return wiring.container;
} }));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native complete DIY carousel media contracts on owned PostgreSQL16', () => {
  let f: Awaited<ReturnType<typeof diyCarouselFixture>>;
  let schemas: Array<typeof systemDise.$inferSelect>;
  const app = createApp();
  beforeAll(async () => {
    vi.setSystemTime(DIY_CAROUSEL_NOW); f = await diyCarouselFixture(DIY_CAROUSEL_NOW); wiring.container = f.container;
    expect(f.tables).toHaveLength(50); expect(f.sequences).toHaveLength(46);
    schemas = await f.db.select().from(systemDise);
  }, 45_000);
  afterAll(async () => { wiring.container = undefined; vi.useRealTimers(); await f?.close(); }, 30_000);
  beforeEach(() => {
    vi.setSystemTime(DIY_CAROUSEL_NOW);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned DIY carousel fixture forbids external I/O'));
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
    expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial); return body;
  }
  async function schema(page: 0 | 2 = 0, viewer: DiyStateViewer = 0): Promise<Row[]> {
    return (await read(`/api/diy/get_diy/${page}`, viewer)).data.value;
  }

  it('reads actual home and micro pages with every persisted carousel family, layout and text-only typed tab contract for all actors', async () => {
    for (const page of [0, 2] as const) for (const viewer of [0, 11, 22] as const) {
      expect((await read(`/api/diy/diy_version/${page}`, viewer)).data).toEqual({ version: 'diy-carousel-1' });
      const blocks = await schema(page, viewer);
      expect(canonicalProjection(blocks)).toEqual(f.blocks);
      expect(blocks.filter(row => row.name === 'swipers').map(row => row.tabConfig.tabVal)).toEqual([0, 1]);
      expect(blocks.filter(row => row.name === 'swiperBg').map(row => row.styleConfig.tabVal)).toEqual([0, 1, 2]);
      expect(blocks.filter(row => row.name === 'homeComb').map(row => row.styleConfig.tabVal)).toEqual([0, 1]);
      expect(requiredBlock(blocks, 721).tabListConfig.list).toEqual(requiredBlock(f.blocks, 721).tabListConfig.list);
    }
  });

  it('freshly signs all real slide and homeComb logo slots for 900 seconds and serves their actual platform pixels with zero SQL/sequence/resource delta', async () => {
    const before = await f.snapshot(), initial = resources(), slots = mediaValues(await schema());
    expect(slots).toHaveLength(23);
    const signed = slots.filter(value => value.startsWith(f.platformImage.url + '?'));
    expect(signed).toHaveLength(9); expect(new Set(signed).size).toBe(1);
    for (const value of signed) expect(value).toMatch(new RegExp(`^${f.platformImage.url}\\?expires=${f.seconds + 900}&signature=[A-Za-z0-9_-]{43}$`));
    const image = await request(signed[0]); expect(image.status).toBe(200); expect(image.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(f.png);
    expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial);
  });

  it('preserves the complete legacy lists beyond the ten-item Admin editor bound instead of signing only a prefix', async () => {
    const blocks = DIY_CAROUSEL_FAMILIES.map((name, index) => ({ name, timestamp: 900 + index,
      swiperConfig: { list: Array.from({ length: 17 }, (_, i) => ({ img: f.platformImage.url, info: [{ value: `legacy-${i}` }, { value: '/pages/article/list' }] })) },
      ...(name === 'homeComb' ? { logoConfig: { url: f.platformImage.url } } : {}) }));
    expect((await f.saveSchema(2, blocks)).body.status).toBe(200);
    const projected = await schema(2);
    expect(projected.map(row => row.swiperConfig.list.length)).toEqual([17, 17, 17]);
    expect(mediaValues(projected)).toHaveLength(52);
    for (const value of mediaValues(projected)) expect(value).toMatch(new RegExp(`^${f.platformImage.url}\\?expires=`));
  });

  it('keeps every link, color, text tab, invented background/menu image and unrelated preview unchanged while refreshing only actual media', async () => {
    const blocks = structuredClone(f.blocks), stale = `${f.platformImage.url}?expires=1&signature=old-ticket`;
    for (const block of blocks.filter(row => DIY_CAROUSEL_FAMILIES.includes(row.name))) {
      block.swiperConfig.list[0].img = stale;
      for (const info of block.swiperConfig.list[0].info) { info.title = stale; info.value = stale; }
      block.swiperConfig.list[0].preview = stale; block.swiperConfig.preview = stale;
      block.backgroundConfig = { url: stale }; block.bgColor = { color: [{ item: stale }] };
      block.menuConfig = { list: [{ img: stale, link: stale }] }; block.unusedImage = stale;
      if (block.name === 'homeComb') { block.logoConfig.url = stale; block.tabListConfig.list[0].text.val = stale; }
      else block.logoConfig = { url: stale };
    }
    const foreign = `https://foreign.example/api/assets/${f.platformImage.att_id}?expires=1&signature=foreign-ticket`;
    requiredBlock(blocks, 712).swiperConfig.list[1].img = foreign;
    blocks.push({ name: 'unrelated-private-preview', timestamp: 999, swiperConfig: { list: [{ img: stale }] }, logoConfig: { url: stale } });
    const expected = canonicalProjection(blocks), result = await f.saveSchema(2, blocks);
    expect(result.body.status).toBe(200); expect(result.after.system_dise.find(row => row.id === 2)!.value).toBe(JSON.stringify(expected));
    const projected = await schema(2);
    expect(canonicalProjection(projected)).toEqual(expected);
    expect(requiredBlock(projected, 712).swiperConfig.list[1].img).toBe(foreign);
    for (const block of projected.filter(row => DIY_CAROUSEL_FAMILIES.includes(row.name))) {
      expect(block.menuConfig.list[0].img).toBe(stale); expect(block.backgroundConfig.url).toBe(stale);
      expect(block.swiperConfig.list[0].info.every((info: Row) => info.value === stale && info.title === stale)).toBe(true);
      if (block.name !== 'homeComb') expect(block.logoConfig.url).toBe(stale);
    }
  });

  it('canonicalizes signed read-edit-save media through the real Admin transaction with only the selected row/value/version/update_time changed', async () => {
    const blocks = await schema(), home = requiredBlock(blocks, 721);
    home.inputConfig.value = '真实更新搜索'; home.hotWords.list.push({ val: '新增真实热词' });
    const expectedValue = canonicalProjection(blocks), result = await f.saveSchema(2, blocks), expected = structuredClone(result.before);
    expect(result.response.status).toBe(200); expect(result.body.status).toBe(200);
    const saved = result.after.system_dise.find(row => row.id === 2)!;
    expect(saved.value).toBe(JSON.stringify(expectedValue)); expect(saved.value).not.toContain('signature=');
    expect(saved.version).not.toBe('diy-carousel-1');
    expected.system_dise = expected.system_dise.map(row => row.id === 2 ? { ...row, value: JSON.stringify(expectedValue), version: saved.version, update_time: saved.update_time } : row);
    expect(result.after).toEqual(sortedDiyState(expected));
    expect(canonicalProjection(await schema(2, 22))).toEqual(expectedValue);
    expect(canonicalProjection(await schema(0))).toEqual(f.blocks);
  });

  it('refreshes imported historical slide and logo tickets without rewriting their stored JSON or version', async () => {
    const blocks = structuredClone(f.blocks), stale = `${f.platformImage.url}?expires=1&signature=imported-ticket`;
    for (const block of blocks.filter(row => DIY_CAROUSEL_FAMILIES.includes(row.name))) {
      block.swiperConfig.list[0].img = stale;
      if (block.name === 'homeComb') block.logoConfig.url = stale;
    }
    await f.db.update(systemDise).set({ value: JSON.stringify(blocks) }).where(eq(systemDise.id, 2));
    const before = await f.snapshot(), projected = await schema(2);
    expect(canonicalProjection(projected)).toEqual(f.blocks);
    expect(mediaValues(projected).filter(value => value.startsWith(f.platformImage.url + '?'))).toHaveLength(9);
    expect(await f.snapshot()).toEqual(before);
    expect((await read('/api/diy/diy_version/2')).data).toEqual({ version: 'diy-carousel-1' });
  });

  it('issues fresh read capabilities after the old 900-second ticket expires while page version and all persisted data remain identical', async () => {
    const old = requiredBlock(await schema(), 721).logoConfig.url, before = await f.snapshot(), initial = resources();
    vi.setSystemTime(new Date(DIY_CAROUSEL_NOW.getTime() + 901_000));
    expect((await read('/api/diy/diy_version/0')).data).toEqual({ version: 'diy-carousel-1' });
    const fresh = requiredBlock(await schema(), 721).logoConfig.url;
    expect(fresh).not.toBe(old); expect(Number(new URL(fresh, 'http://localhost').searchParams.get('expires'))).toBe(f.seconds + 901 + 900);
    expect((await request(old)).status).toBe(404);
    const image = await request(fresh); expect(image.status).toBe(200); expect(new Uint8Array(await image.arrayBuffer())).toEqual(f.png);
    expect(await f.snapshot()).toEqual(before); expect(resources()).toEqual(initial);
  });

  it('refuses the actual private user attachment in every family even for its authenticated owner', async () => {
    const blocks = structuredClone(f.blocks);
    for (const block of blocks.filter(row => DIY_CAROUSEL_FAMILIES.includes(row.name))) {
      block.swiperConfig.list[0].img = f.image.url;
      if (block.name === 'homeComb') block.logoConfig.url = f.image.url;
    }
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
  ])('freshly rechecks %s and withdraws every slide/logo signature without exposing rows or writing resources', async (_label, patch) => {
    const original = (await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, f.platformImage.att_id)))[0];
    try {
      await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId, original.attId));
      const projected = await schema();
      expect(mediaValues(projected)).toEqual(mediaValues(f.blocks).map(value => value === f.platformImage.url ? '' : value));
      expect(JSON.stringify(projected)).not.toContain('attachments/admin/');
    } finally { await f.db.update(systemAttachment).set(original).where(eq(systemAttachment.attId, original.attId)); }
  });

  it('withdraws all carousel public signatures after attachment deletion while canonical schema/versions stay untouched', async () => {
    const original = (await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, f.platformImage.att_id)))[0];
    try {
      await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, original.attId));
      expect(mediaValues(await schema())).toEqual(mediaValues(f.blocks).map(value => value === f.platformImage.url ? '' : value));
    } finally { await f.db.insert(systemAttachment).values(original); }
  });

  it('supports all 200 UI components with every ten-slide homeComb plus logo, without the old 1000-slot truncation/failure', async () => {
    const blocks = Array.from({ length: 200 }, (_, index) => ({ name: 'homeComb', timestamp: 1000 + index,
      logoConfig: { url: f.platformImage.url }, swiperConfig: { list: Array.from({ length: 10 }, () => ({ img: f.platformImage.url, info: [{ value: '真实图' }, { value: '/pages/article/list' }] })) } }));
    expect((await f.saveSchema(2, blocks)).body.status).toBe(200);
    const projected = await schema(2); expect(projected).toHaveLength(200); expect(mediaValues(projected)).toHaveLength(2200);
    for (const value of mediaValues(projected)) expect(value).toMatch(new RegExp(`^${f.platformImage.url}\\?expires=`));
  });

  it('accepts the explicit 2500-slot legacy budget and rejects a 2501-slot Admin save atomically instead of persisting partial tickets', async () => {
    const blocks = [{ name: 'swipers', timestamp: 1000, swiperConfig: { list: Array.from({ length: 2500 }, () => ({ img: f.platformImage.url })) } }];
    expect((await f.saveSchema(2, blocks)).body.status).toBe(200);
    const projected = await schema(2); expect(mediaValues(projected)).toHaveLength(2500);
    expect(mediaValues(projected).every(value => value.startsWith(f.platformImage.url + '?expires='))).toBe(true);
    blocks[0].swiperConfig.list.push({ img: f.platformImage.url });
    const failed = await f.saveSchema(2, blocks);
    expect(failed.body.status).toBe(400); expect(failed.body.msg).toBe('DIY公开素材超过完整读取容量');
    expect(failed.after).toEqual(failed.before);
  });

  it('rejects an imported oversize schema read with no media tickets and zero complete database/sequence/resource delta', async () => {
    const blocks = [{ name: 'swipers', timestamp: 1000, swiperConfig: { list: Array.from({ length: 2501 }, () => ({ img: f.platformImage.url })) } }];
    await f.db.update(systemDise).set({ value: JSON.stringify(blocks) }).where(eq(systemDise.id, 2));
    const body = await read('/api/diy/get_diy/2', 0, 400);
    expect(body.msg).toBe('DIY公开素材超过完整读取容量'); expect(JSON.stringify(body)).not.toContain('signature=');
  });

  it('retains the actual station-first schema/version gate without material generation', async () => {
    try {
      await f.setConfig('station_open', '0');
      for (const page of [0, 2]) for (const endpoint of ['get_diy', 'diy_version']) {
        expect((await read(`/api/diy/${endpoint}/${page}`, 0, 410010)).msg).toBe('站点升级中，请稍候访问');
      }
    } finally { await f.setConfig('station_open', '1'); }
  });
});
