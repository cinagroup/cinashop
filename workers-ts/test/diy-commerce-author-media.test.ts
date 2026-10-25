import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { systemAttachment } from '@/models/schema';
import { R2_IMAGE_TYPE } from '@/services/system/AttachmentService';
import { canonicalizeDiyEditorialMedia, DIY_COMMERCE_MEDIA_SLOT_LIMIT, renderDiyEditorialMedia } from '@/services/content/DiyEditorialMediaPolicy';
import { financeMemoryPostgres } from './helpers/financePostgres';

const names = ['seckill', 'combination', 'bargain', 'presale', 'pointsMall', 'promotionList'] as const;
type Name = typeof names[number];
const historical = (id: number) => `/api/assets/${id}?expires=1&signature=old`;
const appKey = 'commerce-author-owned-media-test';
function sample(name: Name, image: string) {
  const holders: Array<Record<string, unknown>> = [], block: Record<string, unknown> = { name, timestamp: 17, isHide: true,
    link: historical(1), productList: { list: [{ image: historical(1), img: historical(1) }] }, opaque: { imgConfig: { url: historical(1) } } };
  const key = name === 'promotionList' ? 'image' : 'url';
  if (name === 'promotionList') block.tabConfig = { list: Array.from({ length: 17 }, (_, i) => {
    const row = { image, chiild: [{ val: `标题${i}` }], goodsList: { list: [{ image: historical(1) }] }, link: historical(1), extra: { empty: [], i } };
    holders.push(row); return row;
  }) };
  else for (const field of name === 'pointsMall' ? ['imgBgConfig', 'imgConfig', 'imgConfig2'] : ['imgBgConfig', 'imgConfig', 'imgColorConfig']) {
    const row = { url: image, link: historical(1), extra: { empty: [], zero: 0 } }; holders.push(row); block[field] = row;
  }
  return { block, holders, key, refs: () => holders.map(row => row[key]) };
}

describe('commerce author exact legacy image slots and independent complete capacity', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>;
  beforeAll(async () => { f = await financeMemoryPostgres([systemAttachment]); });
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => { await f.reset(); await f.db.insert(systemAttachment).values([
    { attId: 1, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: R2_IMAGE_TYPE, attDir: '/api/assets/1', name: 'attachments/admin/1/2026/10/public.png', attType: 'image/png' },
    { attId: 2, type: 1, relationId: 0, moduleType: 1, fileType: 2, imageType: R2_IMAGE_TYPE, attDir: '/api/assets/2', name: 'attachments/admin/1/2026/10/00000000-0000-4000-8000-000000000002.mp4', attType: 'video/mp4' },
    { attId: 4, type: 3, relationId: 11, moduleType: 3, fileType: 1, imageType: R2_IMAGE_TYPE, attDir: '/api/assets/4', name: 'attachments/user/11/2026/10/private.png', attType: 'image/png' },
    { attId: 5, type: 4, relationId: 9, moduleType: 1, fileType: 1, imageType: R2_IMAGE_TYPE, attDir: '/api/assets/5', name: 'attachments/supplier/9/2026/10/foreign.png', attType: 'image/png' },
  ]); });

  it.each(names)('canonicalizes and signs every%s actual/dormant image including imported tail without changing DB or bystanders', async name => {
    const x = sample(name, historical(1)), expected = structuredClone(x.block), rows = await f.db.select().from(systemAttachment);
    canonicalizeDiyEditorialMedia([x.block]); expect(x.refs().every(url => url === '/api/assets/1')).toBe(true);
    await renderDiyEditorialMedia(f.db, appKey, [x.block]); const signed = String(x.refs()[0]); expect(signed).toMatch(/^\/api\/assets\/1\?expires=\d+&signature=[A-Za-z0-9_-]{43}$/u); expect(x.refs().every(url => url === signed)).toBe(true);
    for (const holder of x.holders) holder[x.key] = historical(1);
    expect(x.block).toEqual(expected); expect(await f.db.select().from(systemAttachment)).toEqual(rows);
  });

  it.each(names)('uses the existing%s legacy entity grammar and rechecks the decoded private owner', async name => {
    const x = sample(name, '/&#97;pi/assets/1?expires=1&amp;signature=old'); canonicalizeDiyEditorialMedia([x.block]); expect(x.refs().every(url => url === '/api/assets/1')).toBe(true);
    await renderDiyEditorialMedia(f.db, appKey, [x.block]); expect(x.refs().every(url => /^\/api\/assets\/1\?expires=/u.test(String(url)))).toBe(true);
    const privateImage = sample(name, '/&#x61;pi/assets/4'); await renderDiyEditorialMedia(f.db, appKey, [privateImage.block]); expect(privateImage.refs().every(url => url === '')).toBe(true);
  });

  it.each(names)('does not trust%s historical signatures for videos, user/supplier images or missing objects', async name => {
    for (const id of [2, 4, 5, 999]) { const x = sample(name, historical(id)); await renderDiyEditorialMedia(f.db, appKey, [x.block]); expect(x.refs().every(url => url === '')).toBe(true); }
  });

  it('rechecks current platform raster MIME/key and scope after an authored image was previously public', async () => {
    const original = (await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, 1)))[0]!;
    for (const patch of [{ type: 3, relationId: 11 }, { moduleType: 3 }, { fileType: 2 }, { imageType: 0 }, { name: 'attachments/admin/2/foreign.png' }, { attType: 'image/svg+xml' }, { attType: 'text/html' }]) {
      await f.db.update(systemAttachment).set({ ...original, ...patch }).where(eq(systemAttachment.attId, 1));
      const x = sample('seckill', historical(1)); await renderDiyEditorialMedia(f.db, appKey, [x.block]); expect(x.refs()).toEqual(['', '', '']);
    }
  });

  it('never grants author-media authority to coupon/live API rows, product snapshots, wrong cases, nested components or object-like lists', async () => {
    const value = ['coupon', 'liveBroadcast', 'Community', 'Seckill', 'pointsmall', 'unknown'].map(name => ({ name,
      imgConfig: { url: historical(1) }, imgBgConfig: { url: historical(1) }, imgColorConfig: { url: historical(1) }, imgConfig2: { url: historical(1) },
      tabConfig: { list: [{ image: historical(1) }] }, products: [{ image: historical(1) }], rooms: [{ cover_img: historical(1) }], child: sample('seckill', historical(1)).block }));
    const malformed = [{ name: 'promotionList', tabConfig: { list: { 0: { image: historical(1) } } } }, { name: 'seckill', imgBgConfig: [{ url: historical(1) }], imgConfig2: { url: historical(1) } }, { name: 'pointsMall', imgColorConfig: { url: historical(1) } }];
    const blocks = [...value, ...malformed], before = structuredClone(blocks), select = vi.spyOn(f.db, 'select');
    try { canonicalizeDiyEditorialMedia(blocks); await renderDiyEditorialMedia(f.db, appKey, blocks); expect(blocks).toEqual(before); expect(select).not.toHaveBeenCalled(); } finally { select.mockRestore(); }
  });

  it('preserves static/external literal references without signing, fetching or requiring APP_KEY', async () => {
    const select = vi.spyOn(f.db, 'select'), fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No commerce media network I/O'));
    try { for (const name of names) for (const ref of ['/static/images/diy/seckill01.png', 'https://foreign.example/api/assets/4?keep=1']) {
      const x = sample(name, ref); canonicalizeDiyEditorialMedia([x.block]); await renderDiyEditorialMedia(f.db, undefined, [x.block]); expect(x.refs().every(url => url === ref)).toBe(true);
    } expect(select).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); } finally { select.mockRestore(); fetch.mockRestore(); }
  });

  it('keeps all20000 commerce tab icons alongside the unchanged2500 ordinary budget without clipping either list', async () => {
    expect(DIY_COMMERCE_MEDIA_SLOT_LIMIT).toBe(20000);
    const tabs = Array.from({ length: 20000 }, (_, index) => ({ image: historical(1), index })), slides = Array.from({ length: 2500 }, (_, index) => ({ img: historical(1), index }));
    const blocks = [{ name: 'promotionList', tabConfig: { list: tabs } }, { name: 'swipers', swiperConfig: { list: slides } }];
    canonicalizeDiyEditorialMedia(blocks); await renderDiyEditorialMedia(f.db, appKey, blocks);
    expect(tabs).toHaveLength(20000); expect(slides).toHaveLength(2500); expect(tabs.every((tab, i) => tab.index === i && tab.image === tabs[0]!.image)).toBe(true);
    expect(slides.every((slide, i) => slide.index === i && slide.img === tabs[0]!.image)).toBe(true); expect(tabs[19999]!.image).toMatch(/^\/api\/assets\/1\?expires=/u);
  });

  it('rejects commerce20001 atomically before canonicalization, any owner SQL or signature, retaining other-family raw bytes', async () => {
    const blocks = [{ name: 'promotionList', tabConfig: { list: Array.from({ length: 20001 }, () => ({ image: historical(1) })) } }, { name: 'news', imgConfig: { url: historical(1) } }], before = structuredClone(blocks);
    expect(() => canonicalizeDiyEditorialMedia(blocks)).toThrow('DIY公开素材超过完整读取容量'); expect(blocks).toEqual(before);
    const select = vi.spyOn(f.db, 'select'); try { await expect(renderDiyEditorialMedia(f.db, appKey, blocks)).rejects.toThrow('DIY公开素材超过完整读取容量'); expect(select).not.toHaveBeenCalled(); expect(blocks).toEqual(before); } finally { select.mockRestore(); }
  });

  it('does not enlarge the old ordinary2500 budget when commerce images are present', async () => {
    const blocks = [{ name: 'swipers', swiperConfig: { list: Array.from({ length: 2501 }, () => ({ img: historical(1) })) } }, sample('promotionList', historical(1)).block], before = structuredClone(blocks);
    expect(() => canonicalizeDiyEditorialMedia(blocks)).toThrow('DIY公开素材超过完整读取容量'); expect(blocks).toEqual(before);
  });
});
