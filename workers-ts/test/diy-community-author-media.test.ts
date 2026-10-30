import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { systemAttachment } from '@/models/schema';
import { R2_IMAGE_TYPE } from '@/services/system/AttachmentService';
import { canonicalizeDiyEditorialMedia, renderDiyEditorialMedia } from '@/services/content/DiyEditorialMediaPolicy';
import { financeMemoryPostgres } from './helpers/financePostgres';

const names = ['community'] as const;
type Name = typeof names[number];
const appKey = 'owned-community-author-media-key';
const ticket = (id: number) => `/api/assets/${id}?expires=1&signature=historical`;
function sample(name: Name, reference: string) {
  const key = 'imgConfig';
  const field = { url: reference, link: ticket(4), unknown: { empty: [], zero: 0, reference: ticket(5) } };
  const block = { name, [key]: field, preview: ticket(4), authorExtra: { url: ticket(5) } };
  return { block, field, pick: () => field.url };
}

describe('community author exact JSON image slots and unchanged ordinary-media boundary', () => {
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

  it.each(names)('canonicalizes only%s exact image slot and signs the currently public platform raster without changing its metadata or DB', async name => {
    const entry = sample(name, ticket(1)), before = structuredClone(entry.block), rows = await f.db.select().from(systemAttachment);
    canonicalizeDiyEditorialMedia([entry.block]); expect(entry.pick()).toBe('/api/assets/1');
    await renderDiyEditorialMedia(f.db, appKey, [entry.block]); expect(entry.pick()).toMatch(/^\/api\/assets\/1\?expires=\d+&signature=[A-Za-z0-9_-]{43}$/u);
    const expected = structuredClone(before); (expected.imgConfig as typeof entry.field).url = entry.pick();
    expect(entry.block).toEqual(expected); expect(await f.db.select().from(systemAttachment)).toEqual(rows);
  });

  it.each(names)('rechecks%s current owner, raster, key and MIME instead of trusting a historical signed reference', async name => {
    const row = (await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, 1)))[0]!;
    for (const patch of [{ type: 3, relationId: 11 }, { moduleType: 3 }, { fileType: 2 }, { imageType: 0 },
      { name: 'attachments/admin/2/foreign.png' }, { attType: 'image/svg+xml' }, { attType: 'text/html' }, { attType: 'image/jpeg' }]) {
      await f.db.update(systemAttachment).set({ ...row, ...patch }).where(eq(systemAttachment.attId, 1));
      const entry = sample(name, ticket(1)); await renderDiyEditorialMedia(f.db, appKey, [entry.block]); expect(entry.pick()).toBe('');
    }
    for (const id of [2, 4, 5, 999]) { const entry = sample(name, ticket(id)); await renderDiyEditorialMedia(f.db, appKey, [entry.block]); expect(entry.pick()).toBe(''); }
  });

  it.each(names)('preserves%s JSON entity bytes with no HTML decode, private-ID reinterpretation or fresh signature', async name => {
    for (const reference of ['/&#97;pi/assets/4', '/&#x61;pi/assets/4', '/api&#47;assets/4', '/&amp;#97;pi/assets/4', '/&amp;amp;#97;pi/assets/4', '/static/a&amp;b.png']) {
      const entry = sample(name, reference); canonicalizeDiyEditorialMedia([entry.block]); expect(entry.pick()).toBe(reference);
      await renderDiyEditorialMedia(f.db, appKey, [entry.block]); expect(entry.pick()).toBe(reference); expect(entry.pick()).not.toContain('signature=');
    }
  });

  it('never promotes community data, unknown names, wrong slot names, preview lists or nested children into image authority', async () => {
    const blocks = ['newVip', 'signIn', 'unknown-community', 'Community', 'COMMUNITY'].map(name => ({ name, imgConfig: { url: ticket(1) },
      productList: { list: [{ image: ticket(1) }] }, child: sample('community', ticket(1)).block }));
    blocks.push({ name: 'community', logoConfig: { url: ticket(1) } } as unknown as typeof blocks[number]);
    const before = structuredClone(blocks); canonicalizeDiyEditorialMedia(blocks); await renderDiyEditorialMedia(f.db, appKey, blocks); expect(blocks).toEqual(before);
  });

  it('keeps image/video kind and unsafe URL rejection in both community slot without using or fetching the destination', async () => {
    for (const name of names) for (const reference of [ticket(2), 'javascript:alert(1)', '//foreign.example/x.png', 'data:image/png;base64,AA==', '/static/a\u00a0.png', '/static/a\u2028.png', '/static/a\\b.png']) {
      const entry = sample(name, reference); await renderDiyEditorialMedia(f.db, appKey, [entry.block]); expect(entry.pick()).toBe('');
    }
  });

  it.each(names)('includes%s in the existing full2500 ordinary budget without clipping a legacy imported list', async name => {
    const entry = sample(name, ticket(1)), slides = Array.from({ length: 2499 }, (_, index) => ({ img: ticket(1), index }));
    const blocks = [{ name: 'swipers', swiperConfig: { list: slides } }, entry.block];
    canonicalizeDiyEditorialMedia(blocks); await renderDiyEditorialMedia(f.db, appKey, blocks);
    expect(slides).toHaveLength(2499); expect(slides.every((slide, index) => slide.index === index && slide.img === entry.pick())).toBe(true);
    expect(entry.pick()).toMatch(/^\/api\/assets\/1\?expires=/u);
  });

  it.each(names)('rejects2501 ordinary slots including%s atomically before canonical mutation, owner SQL or signing', async name => {
    const entry = sample(name, ticket(1)), blocks = [{ name: 'swipers', swiperConfig: { list: Array.from({ length: 2500 }, () => ({ img: ticket(1) })) } }, entry.block], before = structuredClone(blocks);
    expect(() => canonicalizeDiyEditorialMedia(blocks)).toThrow('DIY公开素材超过完整读取容量'); expect(blocks).toEqual(before);
    const select = vi.spyOn(f.db, 'select'); try { await expect(renderDiyEditorialMedia(f.db, appKey, blocks)).rejects.toThrow('DIY公开素材超过完整读取容量'); expect(select).not.toHaveBeenCalled(); expect(blocks).toEqual(before); } finally { select.mockRestore(); }
  });

  it('retains separate navigation, footer, presentation and customer-service budgets beside a full ordinary community budget', async () => {
    const entry = sample('community', ticket(1)), blocks = [{ name: 'swipers', swiperConfig: { list: Array.from({ length: 2499 }, () => ({ img: ticket(1) })) } }, entry.block,
      { name: 'menus', menuConfig: { list: [{ img: ticket(1) }] } }, { name: 'pageFoot', menuList: [{ imgList: [ticket(1), ticket(1)] }] },
      { name: 'customerService', logoConfig: { url: ticket(1) } }, { name: 'videos', imgConfig: { url: ticket(1) }, videoConfig: { url: ticket(2) } }];
    canonicalizeDiyEditorialMedia(blocks); await renderDiyEditorialMedia(f.db, appKey, blocks); expect(entry.pick()).toMatch(/^\/api\/assets\/1\?expires=/u);
    expect(JSON.stringify(blocks)).toContain('"preview":"/api/assets/4?expires=1&signature=historical"');
    expect(JSON.stringify(blocks)).toContain('/api/assets/2?expires=');
  });

  it('allows the exact original community static path and foreign HTTPS literal without APP_KEY, owner SQL or network I/O', async () => {
    const select = vi.spyOn(f.db, 'select'), fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external community media I/O'));
    try { const a = sample('community', '/static/images/diy/community.png'), b = sample('community', 'https://foreign.example/api/assets/4?A=1&amp;B=2');
      canonicalizeDiyEditorialMedia([a.block, b.block]); await renderDiyEditorialMedia(f.db, undefined, [a.block, b.block]);
      expect(a.pick()).toBe('/static/images/diy/community.png'); expect(b.pick()).toBe('https://foreign.example/api/assets/4?A=1&amp;B=2'); expect(select).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { select.mockRestore(); fetch.mockRestore(); }
  });
});
