import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { systemAttachment } from '@/models/schema';
import { R2_IMAGE_TYPE } from '@/services/system/AttachmentService';
import * as attachmentMedia from '@/services/system/AttachmentService';
import { canonicalizeDiyEditorialMedia, renderDiyEditorialMedia } from '@/services/content/DiyEditorialMediaPolicy';
import { financeMemoryPostgres } from './helpers/financePostgres';

const slots = ['imgBgConfig', 'imgConfig', 'imgColorConfig'] as const;
const appKey = 'owned-seckill-author-media-key';
const ticket = (id: number) => `/api/assets/${id}?expires=1&signature=historical`;
const signed = /^\/api\/assets\/1\?expires=\d+&signature=[A-Za-z0-9_-]{43}$/u;
function sample(reference = ticket(1), index = 0) {
  return {
    name: 'seckill', timestamp: String(index), isHide: index % 2 === 0,
    styleConfig: { tabVal: index % 2 }, titleConfig: { tabVal: index % 2 }, goodStyleConfig: { tabVal: index % 4 },
    imgBgConfig: { url: reference, name: '背景', info: '710x96', extra: ticket(4) },
    imgConfig: { url: reference, type: 'code', delType: 0 },
    imgColorConfig: { url: reference, name: '另一标题', unknown: { url: ticket(4) } },
    productList: [{ id: 7, title: '秒杀业务图片', image: ticket(4), price: '8.00', people: 3, sales: 7 }],
    image: ticket(4), imgConfig2: { url: ticket(5) }, activity_image: ticket(4), lightning: ticket(5), shandian: { url: ticket(4) },
    checkboxInfo: { type: index % 2 ? [0, 1, 2, 3] : [0, 2, 3], extra: ticket(5) }, seckillConfig: { tabVal: index % 2 },
    unknown: { image: ticket(4), url: ticket(5), keep: [false, 0, ''] }, link: ticket(5),
  };
}

describe('seckill author exact three complete JSON raster slots and unchanged business-image authority', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>;
  beforeAll(async () => { f = await financeMemoryPostgres([systemAttachment]); });
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(systemAttachment).values([
      { attId: 1, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: R2_IMAGE_TYPE, attDir: '/api/assets/1', name: 'attachments/admin/1/2026/10/public.png', attType: 'image/png' },
      { attId: 2, type: 1, relationId: 0, moduleType: 1, fileType: 2, imageType: R2_IMAGE_TYPE, attDir: '/api/assets/2', name: 'attachments/admin/1/2026/10/00000000-0000-4000-8000-000000000002.mp4', attType: 'video/mp4' },
      { attId: 4, type: 3, relationId: 11, moduleType: 3, fileType: 1, imageType: R2_IMAGE_TYPE, attDir: '/api/assets/4', name: 'attachments/user/11/2026/10/private.png', attType: 'image/png' },
      { attId: 5, type: 4, relationId: 9, moduleType: 1, fileType: 1, imageType: R2_IMAGE_TYPE, attDir: '/api/assets/5', name: 'attachments/supplier/9/2026/10/foreign.png', attType: 'image/png' },
    ]);
  });

  it('canonicalizes/signs all three precise slots while preserving their complete metadata product pictures and database rows', async () => {
    const block = sample(), before = structuredClone(block), rows = await f.db.select().from(systemAttachment);
    canonicalizeDiyEditorialMedia([block]); for (const slot of slots) expect(block[slot].url).toBe('/api/assets/1');
    await renderDiyEditorialMedia(f.db, appKey, [block]); for (const slot of slots) expect(block[slot].url).toMatch(signed);
    const expected = structuredClone(before); for (const slot of slots) expected[slot].url = block[slot].url;
    expect(block).toEqual(expected); expect(await f.db.select().from(systemAttachment)).toEqual(rows);
  });

  it('handles every hidden dormant and overflow component without clipping at public body200 or all four layout/title/button/check branches', async () => {
    const blocks = Array.from({ length: 251 }, (_, i) => sample(ticket(1), i)), before = structuredClone(blocks);
    canonicalizeDiyEditorialMedia(blocks); for (const block of blocks) for (const slot of slots) expect(block[slot].url).toBe('/api/assets/1');
    await renderDiyEditorialMedia(f.db, appKey, blocks);
    expect(blocks).toHaveLength(251);
    for (const [index, block] of blocks.entries()) { const expected = before[index]!; for (const slot of slots) { expect(block[slot].url).toMatch(signed); expected[slot].url = block[slot].url; } expect(block).toEqual(expected); }
  });

  it.each([
    ['private user', { type: 3, relationId: 11 }], ['supplier', { type: 4, relationId: 9 }],
    ['wrong platform relation', { relationId: 7 }], ['private module', { moduleType: 3 }], ['video file kind', { fileType: 2 }],
    ['nonR2 metadata', { imageType: 0 }], ['foreign canonical identity', { attDir: 'https://foreign.example/api/assets/1' }],
    ['wrong local identity', { attDir: '/api/assets/2' }], ['foreign owner key', { name: 'attachments/admin/2/2026/10/public.png' }],
    ['traversal key', { name: 'attachments/admin/1/2026/10/../public.png' }], ['SVG MIME', { attType: 'image/svg+xml' }],
    ['HTML MIME', { attType: 'text/html' }], ['contradictory JPEG MIME', { attType: 'image/jpeg' }],
    ['nonraster extension', { name: 'attachments/admin/1/2026/10/public.svg' }],
  ] as const)('checks current %s metadata for all slots rather than trusting an old signed ticket', async (_label, patch) => {
    const first = sample(); await renderDiyEditorialMedia(f.db, appKey, [first]); for (const slot of slots) expect(first[slot].url).toMatch(signed);
    await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId, 1));
    const next = sample(first.imgConfig.url); await renderDiyEditorialMedia(f.db, appKey, [next]); for (const slot of slots) expect(next[slot].url).toBe('');
    expect(next.productList).toEqual(first.productList); expect(next.unknown).toEqual(first.unknown); expect(next.activity_image).toEqual(first.activity_image); expect(next.lightning).toEqual(first.lightning); expect(next.shandian).toEqual(first.shandian);
  });

  it('denies video user supplier deleted and missing assets in each exact slot without signing business metadata', async () => {
    for (const id of [2, 4, 5, 999]) { const block = sample(ticket(id)), before = structuredClone(block); await renderDiyEditorialMedia(f.db, appKey, [block]); for (const slot of slots) expect(block[slot].url).toBe(''); expect(block.productList).toEqual(before.productList); expect(block.imgConfig2).toEqual(before.imgConfig2); }
    await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, 1)); const deleted = sample(); await renderDiyEditorialMedia(f.db, appKey, [deleted]); for (const slot of slots) expect(deleted[slot].url).toBe('');
  });

  it('keeps literal JSON entities intact without decoding a private asset identity SQL or HMAC', async () => {
    const select = vi.spyOn(f.db, 'select'), signing = vi.spyOn(attachmentMedia, 'signAttachmentReferences');
    try {
      for (const reference of ['/&#97;pi/assets/4', '/&#x61;pi/assets/4', '/api&#47;assets/4', '/&amp;#97;pi/assets/4', '/&amp;amp;#97;pi/assets/4', '/static/a&amp;b.png']) {
        const block = sample(reference), before = structuredClone(block); canonicalizeDiyEditorialMedia([block]); await renderDiyEditorialMedia(f.db, appKey, [block]); expect(block).toEqual(before); for (const slot of slots) expect(block[slot].url).not.toContain('signature=');
      }
      expect(select).not.toHaveBeenCalled(); expect(signing).not.toHaveBeenCalled();
    } finally { select.mockRestore(); signing.mockRestore(); }
  });

  it('never authorizes wrong case wrong slots nested seckill blocks malformed parents DTO images or business metadata and decorative font', async () => {
    const blocks: unknown[] = ['Seckill', 'barGain', 'BARGAIN', 'unknown', 'homeComb'].map(name => ({ ...sample(), name, child: sample() }));
    blocks.push(
      { name: 'seckill', imgConfig2: { url: ticket(1) }, logoConfig: { url: ticket(1) }, image: ticket(1), icon: ticket(1), fontConfig: { url: ticket(1) }, fire: { font: ticket(1), glyph: 'css-decoration' }, productList: [{ image: ticket(1) }], child: sample() },
      { name: 'seckill', imgConfig: { img: ticket(1), image: ticket(1), src: ticket(1), url: { value: ticket(1) } }, imgBgConfig: null, imgColorConfig: [ticket(1)] },
      { name: 'seckill', imgBgConfig: 1, imgConfig: false, imgColorConfig: { url: null }, unknown: { url: ticket(1) } },
    );
    const before = structuredClone(blocks), select = vi.spyOn(f.db, 'select'), signing = vi.spyOn(attachmentMedia, 'signAttachmentReferences');
    try { canonicalizeDiyEditorialMedia(blocks); await renderDiyEditorialMedia(f.db, appKey, blocks); expect(blocks).toEqual(before); expect(select).not.toHaveBeenCalled(); expect(signing).not.toHaveBeenCalled(); }
    finally { select.mockRestore(); signing.mockRestore(); }
  });

  it('rejects unsafe URL grammars and nonraster kind in all slots without network I/O', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No seckill media network I/O'));
    try { for (const reference of [ticket(2), 'javascript:alert(1)', '//foreign.example/x.png', 'data:image/png;base64,AA==', '/static/a\u00a0.png', '/static/a\u2028.png', '/static/a\\b.png', '&#47;api/assets/4']) { const block = sample(reference); await renderDiyEditorialMedia(f.db, appKey, [block]); for (const slot of slots) expect(block[slot].url).toBe(''); } expect(fetch).not.toHaveBeenCalled(); }
    finally { fetch.mockRestore(); }
  });

  it('accepts precisely2500 ordinary slots across all three seckill fields without clipping or touching unknown pictures', async () => {
    const blocks = Array.from({ length: 833 }, (_, i) => sample(ticket(1), i));
    const tail = { name: 'seckill', isHide: true, titleConfig: { tabVal: 1 }, imgColorConfig: { url: ticket(1) }, unknown: { image: ticket(4) } };
    const all = [...blocks, tail]; canonicalizeDiyEditorialMedia(all); await renderDiyEditorialMedia(f.db, appKey, all);
    const first = blocks[0]!.imgConfig.url; expect(first).toMatch(signed); expect(tail.imgColorConfig.url).toBe(first); expect(blocks).toHaveLength(833);
    for (const block of blocks) { for (const slot of slots) expect(block[slot].url).toBe(first); expect(block.productList[0]!.image).toBe(ticket(4)); }
  });

  it.each(['only-seckill', 'mixed-families'] as const)('rejects2501 complete ordinary slots from%s before canonical mutation SQL and HMAC', async mode => {
    const blocks: unknown[] = mode === 'only-seckill'
      ? [...Array.from({ length: 833 }, (_, i) => sample(ticket(1), i)), { name: 'seckill', imgConfig: { url: ticket(1) }, imgColorConfig: { url: ticket(1) } }]
      : [{ name: 'swipers', swiperConfig: { list: Array.from({ length: 2498 }, () => ({ img: ticket(1) })) } }, sample()];
    const before = structuredClone(blocks), select = vi.spyOn(f.db, 'select'), signing = vi.spyOn(attachmentMedia, 'signAttachmentReferences');
    try { expect(() => canonicalizeDiyEditorialMedia(blocks)).toThrow('DIY公开素材超过完整读取容量'); expect(blocks).toEqual(before); await expect(renderDiyEditorialMedia(f.db, appKey, blocks)).rejects.toThrow('DIY公开素材超过完整读取容量'); expect(blocks).toEqual(before); expect(select).not.toHaveBeenCalled(); expect(signing).not.toHaveBeenCalled(); }
    finally { select.mockRestore(); signing.mockRestore(); }
  });

  it('shares ordinary capacity with points promotion community while retaining footer navigation presentation and service budgets', async () => {
    const block = sample(), community = { name: 'community', imgConfig: { url: ticket(1) } }, points = { name: 'pointsMall', imgBgConfig: { url: ticket(1) }, imgConfig: { url: ticket(1) }, imgConfig2: { url: ticket(1) } }, promotion = { name: 'promotionList', tabConfig: { list: Array.from({ length: 2493 }, () => ({ image: ticket(1) })) } };
    const menu = { name: 'menus', menuConfig: { list: [{ img: ticket(1) }] } }, footer = { name: 'pageFoot', menuList: [{ imgList: [ticket(1), ticket(1)] }] }, service = { name: 'customerService', logoConfig: { url: ticket(1) } }, video = { name: 'videos', videoConfig: { url: ticket(2) }, imgConfig: { url: ticket(1) } };
    const all = [promotion, community, points, block, menu, footer, service, video]; canonicalizeDiyEditorialMedia(all); await renderDiyEditorialMedia(f.db, appKey, all);
    const first = block.imgConfig.url; expect(first).toMatch(signed); expect(community.imgConfig.url).toBe(first); expect(points.imgConfig2.url).toBe(first); expect(promotion.tabConfig.list.every(row => row.image === first)).toBe(true); expect(menu.menuConfig.list[0]!.img).toBe(first); expect(footer.menuList[0]!.imgList[1]).toBe(first); expect(service.logoConfig.url).toBe(first); expect(video.videoConfig.url).toMatch(/^\/api\/assets\/2\?expires=/u);
  });

  it('keeps saved canonical JSON and its raw source independent of a separately signed public clone', async () => {
    const source = [sample()], raw = JSON.stringify(source), before = structuredClone(source), saved = JSON.parse(raw);
    canonicalizeDiyEditorialMedia(saved); const savedValue = JSON.stringify(saved), published = JSON.parse(savedValue); await renderDiyEditorialMedia(f.db, appKey, published);
    for (const slot of slots) { expect(saved[0][slot].url).toBe('/api/assets/1'); expect(published[0][slot].url).toMatch(signed); }
    expect(JSON.stringify(source)).toBe(raw); expect(source).toEqual(before); expect(JSON.stringify(saved)).toBe(savedValue);
  });

  it('accepts exact bundled static and foreign HTTPS literals with no APP_KEY SQL HMAC fetch or nested identity promotion', async () => {
    const select = vi.spyOn(f.db, 'select'), signing = vi.spyOn(attachmentMedia, 'signAttachmentReferences'), fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No seckill foreign image I/O'));
    try { for (const reference of ['/static/images/diy/seckill-bg.png', '/static/images/diy/seckill-title.png', '/static/images/diy/seckill-title-alt.png', 'https://foreign.example/api/assets/4?A=1&amp;B=2', 'https://cdn.example/seckill.png']) { const block = sample(reference), before = structuredClone(block); canonicalizeDiyEditorialMedia([block]); await renderDiyEditorialMedia(f.db, undefined, [block]); expect(block).toEqual(before); } expect(select).not.toHaveBeenCalled(); expect(signing).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); }
    finally { select.mockRestore(); signing.mockRestore(); fetch.mockRestore(); }
  });
});
