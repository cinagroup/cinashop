import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { systemAttachment } from '@/models/schema';
import { R2_IMAGE_TYPE } from '@/services/system/AttachmentService';
import * as attachmentMedia from '@/services/system/AttachmentService';
import { canonicalizeDiyEditorialMedia, renderDiyEditorialMedia } from '@/services/content/DiyEditorialMediaPolicy';
import { financeMemoryPostgres } from './helpers/financePostgres';

const slots = ['imgBgConfig', 'imgConfig', 'imgConfig2'] as const;
const appKey = 'owned-points-author-media-key';
const ticket = (id: number) => `/api/assets/${id}?expires=1&signature=historical`;
const signed = /^\/api\/assets\/1\?expires=\d+&signature=[A-Za-z0-9_-]{43}$/u;
function sample(reference = ticket(1), index = 0) {
  return {
    name: 'pointsMall', timestamp: String(index), isHide: index % 2 === 0,
    styleConfig: { tabVal: index % 2 }, titleConfig: { tabVal: index % 2 }, goodStyleConfig: { tabVal: index % 3 },
    imgBgConfig: { url: reference, name: '背景', info: '710x96', extra: ticket(4) },
    imgConfig: { url: reference, type: 'code', delType: 0 },
    imgConfig2: { url: reference, name: '另一标题', unknown: { url: ticket(4) } },
    productList: [{ id: 7, product_id: 103, image: ticket(4), price: '8.00' }],
    image: ticket(4), imgColorConfig: { url: ticket(5) }, icon: '/static/images/diy/points-icon.png',
    unknown: { image: ticket(4), url: ticket(5), keep: [false, 0, ''] }, link: ticket(5),
  };
}

describe('points author exact three complete JSON raster slots and unchanged business-image authority', () => {
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

  it('handles every hidden dormant and overflow component without clipping at public body200 or layout/title branches', async () => {
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
    expect(next.productList).toEqual(first.productList); expect(next.unknown).toEqual(first.unknown);
  });

  it('denies video user supplier deleted and missing assets in each exact slot without signing business metadata', async () => {
    for (const id of [2, 4, 5, 999]) { const block = sample(ticket(id)), before = structuredClone(block); await renderDiyEditorialMedia(f.db, appKey, [block]); for (const slot of slots) expect(block[slot].url).toBe(''); expect(block.productList).toEqual(before.productList); expect(block.imgColorConfig).toEqual(before.imgColorConfig); }
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

  it('never authorizes wrong case wrong slots nested points blocks malformed parents DTO images or decorative icons', async () => {
    const blocks: unknown[] = ['PointsMall', 'pointsmall', 'POINTSMALL', 'unknown'].map(name => ({ ...sample(), name, child: sample() }));
    blocks.push(
      { name: 'pointsMall', imgColorConfig: { url: ticket(1) }, logoConfig: { url: ticket(1) }, image: ticket(1), icon: ticket(1), productList: [{ image: ticket(1) }], child: sample() },
      { name: 'pointsMall', imgConfig: { img: ticket(1), image: ticket(1), src: ticket(1), url: { value: ticket(1) } }, imgBgConfig: null, imgConfig2: [ticket(1)] },
      { name: 'pointsMall', imgBgConfig: 1, imgConfig: false, imgConfig2: { url: null }, unknown: { url: ticket(1) } },
    );
    const before = structuredClone(blocks), select = vi.spyOn(f.db, 'select'), signing = vi.spyOn(attachmentMedia, 'signAttachmentReferences');
    try { canonicalizeDiyEditorialMedia(blocks); await renderDiyEditorialMedia(f.db, appKey, blocks); expect(blocks).toEqual(before); expect(select).not.toHaveBeenCalled(); expect(signing).not.toHaveBeenCalled(); }
    finally { select.mockRestore(); signing.mockRestore(); }
  });

  it('rejects unsafe URL grammars and nonraster kind in all slots without network I/O', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No points media network I/O'));
    try { for (const reference of [ticket(2), 'javascript:alert(1)', '//foreign.example/x.png', 'data:image/png;base64,AA==', '/static/a\u00a0.png', '/static/a\u2028.png', '/static/a\\b.png', '&#47;api/assets/4']) { const block = sample(reference); await renderDiyEditorialMedia(f.db, appKey, [block]); for (const slot of slots) expect(block[slot].url).toBe(''); } expect(fetch).not.toHaveBeenCalled(); }
    finally { fetch.mockRestore(); }
  });

  it('accepts precisely2500 ordinary slots across all three points fields without clipping or touching unknown pictures', async () => {
    const blocks = Array.from({ length: 833 }, (_, i) => sample(ticket(1), i));
    const tail = { name: 'pointsMall', isHide: true, titleConfig: { tabVal: 1 }, imgConfig2: { url: ticket(1) }, unknown: { image: ticket(4) } };
    const all = [...blocks, tail]; canonicalizeDiyEditorialMedia(all); await renderDiyEditorialMedia(f.db, appKey, all);
    const first = blocks[0]!.imgConfig.url; expect(first).toMatch(signed); expect(tail.imgConfig2.url).toBe(first); expect(blocks).toHaveLength(833);
    for (const block of blocks) { for (const slot of slots) expect(block[slot].url).toBe(first); expect(block.productList[0]!.image).toBe(ticket(4)); }
  });

  it.each(['only-points', 'mixed-families'] as const)('rejects2501 complete ordinary slots from%s before canonical mutation SQL and HMAC', async mode => {
    const blocks: unknown[] = mode === 'only-points'
      ? [...Array.from({ length: 833 }, (_, i) => sample(ticket(1), i)), { name: 'pointsMall', imgConfig: { url: ticket(1) }, imgConfig2: { url: ticket(1) } }]
      : [{ name: 'swipers', swiperConfig: { list: Array.from({ length: 2498 }, () => ({ img: ticket(1) })) } }, sample()];
    const before = structuredClone(blocks), select = vi.spyOn(f.db, 'select'), signing = vi.spyOn(attachmentMedia, 'signAttachmentReferences');
    try { expect(() => canonicalizeDiyEditorialMedia(blocks)).toThrow('DIY公开素材超过完整读取容量'); expect(blocks).toEqual(before); await expect(renderDiyEditorialMedia(f.db, appKey, blocks)).rejects.toThrow('DIY公开素材超过完整读取容量'); expect(blocks).toEqual(before); expect(select).not.toHaveBeenCalled(); expect(signing).not.toHaveBeenCalled(); }
    finally { select.mockRestore(); signing.mockRestore(); }
  });

  it('shares the ordinary budget with promotion/community while retaining independent footer navigation presentation and service budgets', async () => {
    const block = sample(), community = { name: 'community', imgConfig: { url: ticket(1) } }, promotion = { name: 'promotionList', tabConfig: { list: Array.from({ length: 2496 }, () => ({ image: ticket(1) })) } };
    const menu = { name: 'menus', menuConfig: { list: [{ img: ticket(1) }] } }, footer = { name: 'pageFoot', menuList: [{ imgList: [ticket(1), ticket(1)] }] }, service = { name: 'customerService', logoConfig: { url: ticket(1) } }, video = { name: 'videos', videoConfig: { url: ticket(2) }, imgConfig: { url: ticket(1) } };
    const all = [promotion, community, block, menu, footer, service, video]; canonicalizeDiyEditorialMedia(all); await renderDiyEditorialMedia(f.db, appKey, all);
    const first = block.imgConfig.url; expect(first).toMatch(signed); expect(community.imgConfig.url).toBe(first); expect(promotion.tabConfig.list.every(row => row.image === first)).toBe(true); expect(menu.menuConfig.list[0]!.img).toBe(first); expect(footer.menuList[0]!.imgList[1]).toBe(first); expect(service.logoConfig.url).toBe(first); expect(video.videoConfig.url).toMatch(/^\/api\/assets\/2\?expires=/u);
  });

  it('keeps saved canonical JSON and its raw source independent of a separately signed public clone', async () => {
    const source = [sample()], raw = JSON.stringify(source), before = structuredClone(source), saved = JSON.parse(raw);
    canonicalizeDiyEditorialMedia(saved); const savedValue = JSON.stringify(saved), published = JSON.parse(savedValue); await renderDiyEditorialMedia(f.db, appKey, published);
    for (const slot of slots) { expect(saved[0][slot].url).toBe('/api/assets/1'); expect(published[0][slot].url).toMatch(signed); }
    expect(JSON.stringify(source)).toBe(raw); expect(source).toEqual(before); expect(JSON.stringify(saved)).toBe(savedValue);
  });

  it('accepts exact bundled static and foreign HTTPS literals with no APP_KEY SQL HMAC fetch or nested identity promotion', async () => {
    const select = vi.spyOn(f.db, 'select'), signing = vi.spyOn(attachmentMedia, 'signAttachmentReferences'), fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No points foreign image I/O'));
    try { for (const reference of ['/static/images/diy/points-bg.png', '/static/images/diy/points-title.png', '/static/images/diy/points-title-alt.png', 'https://foreign.example/api/assets/4?A=1&amp;B=2', 'https://cdn.example/points.png']) { const block = sample(reference), before = structuredClone(block); canonicalizeDiyEditorialMedia([block]); await renderDiyEditorialMedia(f.db, undefined, [block]); expect(block).toEqual(before); } expect(select).not.toHaveBeenCalled(); expect(signing).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); }
    finally { select.mockRestore(); signing.mockRestore(); fetch.mockRestore(); }
  });
});
