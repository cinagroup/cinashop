import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { systemAttachment } from '@/models/schema';
import { R2_IMAGE_TYPE } from '@/services/system/AttachmentService';
import * as attachmentMedia from '@/services/system/AttachmentService';
import { canonicalizeDiyEditorialMedia, renderDiyEditorialMedia } from '@/services/content/DiyEditorialMediaPolicy';
import { financeMemoryPostgres } from './helpers/financePostgres';

const appKey = 'owned-promotion-author-media-key';
const ticket = (id: number) => `/api/assets/${id}?expires=1&signature=historical`;
const signed = /^\/api\/assets\/1\?expires=\d+&signature=[A-Za-z0-9_-]{43}$/u;
function sample(reference: string, index = 0) {
  const row = {
    image: reference, marker: index, tabVal: index % 5,
    chiild: [{ val: '选项卡', max: 4 }],
    goodsList: { ids: ['4'], list: [{ id: '4', image: ticket(4), image_preview: ticket(5) }] },
    productList: { list: [{ image: ticket(4), unknown: ticket(5) }] },
    goodsLabel: { activeValue: ['5'], list: [{ id: '5', image: ticket(5) }] },
    unknown: { image: ticket(4), empty: [], zero: 0, no: false },
  };
  return { row, block: { name: 'promotionList', isHide: index % 2 === 0, styleConfig: { tabVal: index % 5 }, tabConfig: { list: [row], tabCur: index, image: ticket(4) }, image: ticket(4), preview: ticket(5) } };
}

describe('promotion author exact complete JSON tab images and ordinary raster publication', () => {
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

  it('canonicalizes/signs only each exact tab image and leaves all business metadata and attachment rows unchanged', async () => {
    const entry = sample(ticket(1)), before = structuredClone(entry.block), rows = await f.db.select().from(systemAttachment);
    canonicalizeDiyEditorialMedia([entry.block]);
    expect(entry.row.image).toBe('/api/assets/1');
    await renderDiyEditorialMedia(f.db, appKey, [entry.block]);
    expect(entry.row.image).toMatch(signed);
    const expected = structuredClone(before); expected.tabConfig.list[0]!.image = entry.row.image;
    expect(entry.block).toEqual(expected);
    expect(await f.db.select().from(systemAttachment)).toEqual(rows);
  });

  it('processes every hidden nonstyle4 and overflow tab without clipping at the public first12 boundary', async () => {
    const tabs = Array.from({ length: 23 }, (_, index) => sample(ticket(1), index).row);
    const block = { name: 'promotionList', isHide: true, styleConfig: { tabVal: 0 }, tabConfig: { list: tabs, tabCur: '22', keep: false }, extra: [] };
    const before = structuredClone(block);
    canonicalizeDiyEditorialMedia([block]);
    expect(tabs).toHaveLength(23); expect(tabs.every(row => row.image === '/api/assets/1')).toBe(true);
    await renderDiyEditorialMedia(f.db, appKey, [block]);
    expect(tabs.every(row => signed.test(row.image))).toBe(true);
    const expected = structuredClone(before); expected.tabConfig.list.forEach((row, index) => { row.image = tabs[index]!.image; });
    expect(block).toEqual(expected);
  });

  it.each([
    ['private user', { type: 3, relationId: 11 }],
    ['supplier', { type: 4, relationId: 9 }],
    ['wrong platform relation', { relationId: 7 }],
    ['private module', { moduleType: 3 }],
    ['video file kind', { fileType: 2 }],
    ['nonR2 metadata', { imageType: 0 }],
    ['foreign canonical identity', { attDir: 'https://foreign.example/api/assets/1' }],
    ['wrong local identity', { attDir: '/api/assets/2' }],
    ['foreign owner key', { name: 'attachments/admin/2/2026/10/public.png' }],
    ['traversal key', { name: 'attachments/admin/1/2026/10/../public.png' }],
    ['SVG MIME', { attType: 'image/svg+xml' }],
    ['HTML MIME', { attType: 'text/html' }],
    ['contradictory JPEG MIME', { attType: 'image/jpeg' }],
    ['nonraster extension', { name: 'attachments/admin/1/2026/10/public.svg' }],
  ] as const)('rechecks current %s metadata rather than trusting the old tab ticket', async (_label, patch) => {
    const first = sample(ticket(1)); await renderDiyEditorialMedia(f.db, appKey, [first.block]); expect(first.row.image).toMatch(signed);
    await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId, 1));
    const second = sample(first.row.image); await renderDiyEditorialMedia(f.db, appKey, [second.block]); expect(second.row.image).toBe('');
  });

  it('denies video private supplier deleted/missing assets and never signs their nested business images', async () => {
    for (const id of [2, 4, 5, 999]) {
      const entry = sample(ticket(id)), before = structuredClone(entry.row);
      await renderDiyEditorialMedia(f.db, appKey, [entry.block]); expect(entry.row.image).toBe('');
      expect(entry.row.goodsList).toEqual(before.goodsList); expect(entry.row.productList).toEqual(before.productList); expect(entry.row.goodsLabel).toEqual(before.goodsLabel);
    }
    await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, 1));
    const deleted = sample(ticket(1)); await renderDiyEditorialMedia(f.db, appKey, [deleted.block]); expect(deleted.row.image).toBe('');
  });

  it('retains JSON entity literals without decoding them into private attachment IDs or fresh tickets', async () => {
    const references = ['/&#97;pi/assets/4', '/&#x61;pi/assets/4', '/api&#47;assets/4', '/&amp;#97;pi/assets/4', '/&amp;amp;#97;pi/assets/4', '/static/a&amp;b.png'];
    const select = vi.spyOn(f.db, 'select'), signing = vi.spyOn(attachmentMedia, 'signAttachmentReferences');
    try {
      for (const reference of references) {
        const entry = sample(reference); canonicalizeDiyEditorialMedia([entry.block]); expect(entry.row.image).toBe(reference);
        await renderDiyEditorialMedia(f.db, appKey, [entry.block]); expect(entry.row.image).toBe(reference); expect(entry.row.image).not.toContain('signature=');
      }
      expect(select).not.toHaveBeenCalled(); expect(signing).not.toHaveBeenCalled();
    } finally { select.mockRestore(); signing.mockRestore(); }
  });

  it('does not authorize wrong names wrong slots nested promotion blocks nonarray tabs or business preview pictures', async () => {
    const nested = sample(ticket(1)).block;
    const blocks: unknown[] = ['PromotionList', 'promotionlist', 'PROMOTIONLIST', 'goodList', 'unknown'].map(name => ({ name, tabConfig: { list: [{ image: ticket(1) }] }, child: structuredClone(nested) }));
    blocks.push(
      { name: 'promotionList', tabs: { list: [{ image: ticket(1) }] }, tabConfig: { image: ticket(1), list: [{ img: ticket(1), url: ticket(1), image: { url: ticket(1) }, unknown: { image: ticket(1) }, goodsList: { list: [{ image: ticket(1) }] }, productList: { list: [{ image: ticket(1) }] } }] }, child: nested },
      { name: 'promotionList', tabConfig: { list: { 0: { image: ticket(1) }, length: 1 } } },
      { name: 'promotionList', tabConfig: { list: [null, false, 9, ticket(1), { image: null }, { image: 1 }] } },
      { name: 'promotionList', imgConfig: { url: ticket(1) }, goodsList: { list: [{ image: ticket(1) }] } },
    );
    const before = structuredClone(blocks), select = vi.spyOn(f.db, 'select'), signing = vi.spyOn(attachmentMedia, 'signAttachmentReferences');
    try {
      canonicalizeDiyEditorialMedia(blocks); await renderDiyEditorialMedia(f.db, appKey, blocks);
      expect(blocks).toEqual(before); expect(select).not.toHaveBeenCalled(); expect(signing).not.toHaveBeenCalled();
    } finally { select.mockRestore(); signing.mockRestore(); }
  });

  it('rejects unsafe URL grammar and media kind without fetching any destination', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No promotion media network I/O'));
    try {
      for (const reference of [ticket(2), 'javascript:alert(1)', '//foreign.example/x.png', 'data:image/png;base64,AA==', '/static/a\u00a0.png', '/static/a\u2028.png', '/static/a\\b.png', '&#47;api/assets/4']) {
        const entry = sample(reference); await renderDiyEditorialMedia(f.db, appKey, [entry.block]); expect(entry.row.image).toBe('');
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it('accepts all2500 ordinary slots across complete promotion tabs without signing business pictures', async () => {
    const tabs = Array.from({ length: 2500 }, (_, index) => sample(ticket(1), index).row);
    const blocks = [{ name: 'promotionList', isHide: true, styleConfig: { tabVal: 1 }, tabConfig: { list: tabs } }];
    canonicalizeDiyEditorialMedia(blocks); expect(tabs.every(row => row.image === '/api/assets/1')).toBe(true);
    await renderDiyEditorialMedia(f.db, appKey, blocks);
    const first = tabs[0]!.image; expect(first).toMatch(signed);
    expect(tabs).toHaveLength(2500);
    expect(tabs.every((row, index) => row.image === first && row.marker === index && row.goodsList.list[0]!.image === ticket(4) && row.productList.list[0]!.image === ticket(4))).toBe(true);
  });

  it('counts promotion within the existing ordinary budget alongside community and carousels', async () => {
    const entry = sample(ticket(1)), slides = Array.from({ length: 2498 }, (_, index) => ({ img: ticket(1), index }));
    const community = { name: 'community', imgConfig: { url: ticket(1) } };
    const blocks = [{ name: 'swipers', swiperConfig: { list: slides } }, community, entry.block];
    canonicalizeDiyEditorialMedia(blocks); await renderDiyEditorialMedia(f.db, appKey, blocks);
    expect(entry.row.image).toMatch(signed); expect(community.imgConfig.url).toBe(entry.row.image);
    expect(slides.every((slide, index) => slide.index === index && slide.img === entry.row.image)).toBe(true);
  });

  it.each(['one-list', 'mixed-families'] as const)('rejects2501 complete ordinary slots from%s before any mutation SQL or HMAC', async mode => {
    const blocks: unknown[] = mode === 'one-list'
      ? [{ name: 'promotionList', isHide: true, styleConfig: { tabVal: 0 }, tabConfig: { list: Array.from({ length: 2501 }, (_, index) => ({ image: ticket(1), index })) } }]
      : [{ name: 'swipers', swiperConfig: { list: Array.from({ length: 2500 }, () => ({ img: ticket(1) })) } }, sample(ticket(1)).block];
    const before = structuredClone(blocks), select = vi.spyOn(f.db, 'select'), signing = vi.spyOn(attachmentMedia, 'signAttachmentReferences');
    try {
      expect(() => canonicalizeDiyEditorialMedia(blocks)).toThrow('DIY公开素材超过完整读取容量'); expect(blocks).toEqual(before);
      await expect(renderDiyEditorialMedia(f.db, appKey, blocks)).rejects.toThrow('DIY公开素材超过完整读取容量');
      expect(blocks).toEqual(before); expect(select).not.toHaveBeenCalled(); expect(signing).not.toHaveBeenCalled();
    } finally { select.mockRestore(); signing.mockRestore(); }
  });

  it('preserves independent navigation footer presentation and customer-service budgets beside2500 promotion slots', async () => {
    const tabs = Array.from({ length: 2500 }, () => ({ image: ticket(1) }));
    const menu = { name: 'menus', menuConfig: { list: [{ img: ticket(1) }] } }, footer = { name: 'pageFoot', menuList: [{ imgList: [ticket(1), ticket(1)] }] }, service = { name: 'customerService', logoConfig: { url: ticket(1) } }, presentation = { name: 'videos', imgConfig: { url: ticket(1) }, videoConfig: { url: ticket(2) } };
    const blocks = [{ name: 'promotionList', tabConfig: { list: tabs } }, menu, footer, service, presentation];
    canonicalizeDiyEditorialMedia(blocks); await renderDiyEditorialMedia(f.db, appKey, blocks);
    expect(tabs.every(row => signed.test(row.image))).toBe(true);
    expect(menu.menuConfig.list[0]!.img).toBe(tabs[0]!.image); expect(footer.menuList[0]!.imgList[1]).toBe(tabs[0]!.image); expect(service.logoConfig.url).toBe(tabs[0]!.image);
    expect(presentation.videoConfig.url).toMatch(/^\/api\/assets\/2\?expires=/u);
  });

  it('leaves saved canonical value and the source object independent from a newly signed public clone', async () => {
    const source = [sample(ticket(1)).block], rawValue = JSON.stringify(source), rawBefore = structuredClone(source);
    const saved = JSON.parse(rawValue); canonicalizeDiyEditorialMedia(saved);
    const savedValue = JSON.stringify(saved), savedBefore = structuredClone(saved), published = JSON.parse(savedValue);
    await renderDiyEditorialMedia(f.db, appKey, published);
    expect(published[0].tabConfig.list[0].image).toMatch(signed);
    expect(JSON.stringify(source)).toBe(rawValue); expect(source).toEqual(rawBefore);
    expect(JSON.stringify(saved)).toBe(savedValue); expect(saved).toEqual(savedBefore); expect(saved[0].tabConfig.list[0].image).toBe('/api/assets/1');
  });

  it('admits static and foreign HTTPS literals without APP_KEY SQL HMAC network or nested-ID reinterpretation', async () => {
    const select = vi.spyOn(f.db, 'select'), signing = vi.spyOn(attachmentMedia, 'signAttachmentReferences'), fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external promotion media I/O'));
    try {
      const entries = ['/static/images/diy/tab.png', 'https://foreign.example/api/assets/4?A=1&amp;B=2', 'https://cdn.example/tab.png'].map(reference => sample(reference));
      const before = entries.map(entry => structuredClone(entry.block));
      canonicalizeDiyEditorialMedia(entries.map(entry => entry.block)); await renderDiyEditorialMedia(f.db, undefined, entries.map(entry => entry.block));
      expect(entries.map(entry => entry.block)).toEqual(before);
      expect(select).not.toHaveBeenCalled(); expect(signing).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { select.mockRestore(); signing.mockRestore(); fetch.mockRestore(); }
  });
});
