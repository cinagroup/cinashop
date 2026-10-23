import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';

const authority = vi.hoisted(() => ({
  image: vi.fn<(db: unknown, references: string[]) => Promise<string[]>>(),
  video: vi.fn<(db: unknown, references: string[]) => Promise<string[]>>(),
  legacy: vi.fn<(db: unknown, references: Array<{ image: string; type: number; relationId: number }>) => Promise<string[]>>(),
  sign: vi.fn<(key: string | undefined, references: string[]) => Promise<string[]>>(),
}));
vi.mock('@/services/content/DiyPresentationVideoPolicy', () => ({
  publicDiyPresentationImages: authority.image,
  publicDiyPresentationVideos: authority.video,
}));
vi.mock('@/services/activity/ProductAssetPolicy', () => ({
  publicProductPictures: authority.legacy,
}));
vi.mock('@/services/system/AttachmentService', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/system/AttachmentService')>(),
  signAttachmentReferences: authority.sign,
}));
import { canonicalizeDiyEditorialMedia, DIY_CUSTOMER_SERVICE_MEDIA_SLOT_LIMIT, renderDiyEditorialMedia } from '@/services/content/DiyEditorialMediaPolicy';

const old = (id: number) => `/api/assets/${id}?expires=1&signature=old`;
const canonical = (value: string) => /^\/api\/assets\/[1-9]\d*\?/u.test(value) ? value.split('?')[0]! : value;
const fresh = (value: string) => value.startsWith('/api/assets/') ? `${value}?expires=9999999999&signature=current-platform-proof` : value;
const customer = (url: string) => ({ name: 'customerService', logoConfig: { url, link: old(99), preview: old(98) }, unknown: old(97) });
const db = { select: vi.fn(() => { throw Error('This policy-orchestration suite must use the explicit owner boundary'); }) } as unknown as Pick<DbClient, 'select'>;
const appKey = 'customer-policy-orchestration-key';

// The native42 suite exercises real attachments, role/owner metadata and bytes.
// These tests isolate the policy's slot selection, atomicity and bounded calls;
// the explicit owner/signing adapters are assertions, not provider proof.
describe('customer-service media orchestration without extending adjacent schema authority', () => {
  beforeEach(() => {
    for (const mock of Object.values(authority)) mock.mockReset();
    authority.image.mockImplementation(async (_db, references) => references.map(canonical));
    authority.video.mockImplementation(async (_db, references) => references.map(canonical));
    authority.legacy.mockImplementation(async (_db, references) => references.map(reference => canonical(reference.image)));
    authority.sign.mockImplementation(async (_key, references) => references.map(fresh));
  });

  it('canonicalizes only exact customer logoConfig.url and preserves case variants, malformed containers, links and every neighbouring field', () => {
    const blocks = [customer(old(18)), { name: 'CustomerService', logoConfig: { url: old(19) } },
      { name: 'customerService', logoConfig: [old(20)] }, { name: 'customerService', logoConfig: { url: 21 } },
      { name: 'extension', logoConfig: { url: old(22) }, customerService: { logoConfig: { url: old(23) } } }, null];
    const expected = structuredClone(blocks); (expected[0] as ReturnType<typeof customer>).logoConfig = { url: '/api/assets/18', link: old(99), preview: old(98) };
    canonicalizeDiyEditorialMedia(blocks);
    expect(blocks).toEqual(expected);
    expect(Object.values(authority).every(mock => mock.mock.calls.length === 0)).toBe(true);
  });

  it('preserves foreign HTTPS author URLs and JSON entity bytes rather than converting them into local attachment authority', () => {
    const urls = ['https://foreign.example' + old(18), '&#47;api/assets/18', '&amp;#47;api/assets/18', '/static/icon.png'];
    const blocks = urls.map(customer), before = structuredClone(blocks);
    canonicalizeDiyEditorialMedia(blocks);
    expect(blocks).toEqual(before);
  });

  it('routes customer images through the raster image owner boundary, deduplicates within that kind and leaves destination tickets untouched', async () => {
    const blocks = [customer(old(18)), customer(old(18)), { name: 'extension', imgConfig: { url: old(19) } }];
    await renderDiyEditorialMedia(db, appKey, blocks);
    expect(authority.image).toHaveBeenCalledExactlyOnceWith(db, [old(18)]);
    expect(authority.legacy).not.toHaveBeenCalled(); expect(authority.video).not.toHaveBeenCalled();
    expect(authority.sign).toHaveBeenCalledExactlyOnceWith(appKey, ['/api/assets/18']);
    expect(blocks.slice(0, 2)).toEqual([customer(fresh('/api/assets/18')), customer(fresh('/api/assets/18'))]);
    expect(blocks[2]).toEqual({ name: 'extension', imgConfig: { url: old(19) } });
  });

  it('never converts an image refusal into a video or legacy grant for the same authored reference', async () => {
    authority.image.mockResolvedValue(['']);
    authority.video.mockResolvedValue(['/api/assets/18']);
    const icon = customer(old(18)), video = { name: 'videos', videoConfig: { url: old(18) } }, blocks = [icon, video];
    await renderDiyEditorialMedia(db, appKey, blocks);
    expect(authority.image).toHaveBeenCalledExactlyOnceWith(db, [old(18)]);
    expect(authority.video).toHaveBeenCalledExactlyOnceWith(db, [old(18)]);
    expect(icon.logoConfig.url).toBe('');
    expect(video.videoConfig.url).toBe(fresh('/api/assets/18'));
    expect(icon.logoConfig.link).toBe(old(99));
  });

  it('does not read owners or sign when only links, preview strings and unsupported customer containers exist', async () => {
    const blocks = [{ name: 'customerService', logoConfig: { link: old(18), preview: old(19) } },
      { name: 'customerService', logoConfig: [{ url: old(20) }] },
      { name: 'other', logoConfig: { url: old(21) } }], before = structuredClone(blocks);
    await renderDiyEditorialMedia(db, undefined, blocks);
    expect(blocks).toEqual(before);
    expect(Object.values(authority).every(mock => mock.mock.calls.length === 0)).toBe(true);
  });

  it('counts all20000 authored customer slots before deduplication and accepts the complete tail without using another family allowance', async () => {
    expect(DIY_CUSTOMER_SERVICE_MEDIA_SLOT_LIMIT).toBe(20_000);
    const blocks = Array.from({ length: DIY_CUSTOMER_SERVICE_MEDIA_SLOT_LIMIT }, (_, index) => customer(old(index === 19_999 ? 19 : 18)));
    await renderDiyEditorialMedia(db, appKey, blocks);
    expect(blocks).toHaveLength(20_000);
    expect(blocks[0]!.logoConfig.url).toBe(fresh('/api/assets/18'));
    expect(blocks[19_999]!.logoConfig.url).toBe(fresh('/api/assets/19'));
    expect(authority.image).toHaveBeenCalledExactlyOnceWith(db, [old(18), old(19)]);
  });

  it.each(['canonical-save', 'public-read'])('rejects slot20001 atomically before owner or signing work on %s, even when all references are identical', async mode => {
    const blocks = [customer(old(18)), ...Array.from({ length: DIY_CUSTOMER_SERVICE_MEDIA_SLOT_LIMIT }, () => customer(old(18)))];
    const before = JSON.stringify(blocks);
    if (mode === 'canonical-save') expect(() => canonicalizeDiyEditorialMedia(blocks)).toThrow('完整读取容量');
    else await expect(renderDiyEditorialMedia(db, appKey, blocks)).rejects.toThrow('完整读取容量');
    expect(JSON.stringify(blocks)).toBe(before);
    expect(Object.values(authority).every(mock => mock.mock.calls.length === 0)).toBe(true);
  });

  it.each(['ordinary', 'navigation', 'footer', 'presentation'])('does not consume the existing full %s budget when a customer icon is added', async family => {
    const ordinary = family === 'ordinary' ? Array.from({ length: 2500 }, () => ({ name: 'news', imgConfig: { url: old(1) } })) : [];
    const other = family === 'navigation' ? [{ name: 'menus', menuConfig: { list: Array.from({ length: 20_000 }, () => ({ img: old(1) })) } }]
      : family === 'footer' ? [{ name: 'pageFoot', menuList: Array.from({ length: 10_000 }, () => ({ imgList: [old(1), old(1)] })) }]
        : family === 'presentation' ? Array.from({ length: 10_000 }, () => ({ name: 'videos', videoConfig: { url: old(2) }, imgConfig: { url: old(1) } })) : [];
    const blocks = [...ordinary, ...other, customer(old(18))];
    await renderDiyEditorialMedia(db, appKey, blocks);
    expect((blocks.at(-1) as ReturnType<typeof customer>).logoConfig.url).toBe(fresh('/api/assets/18'));
    expect(authority.image.mock.calls.flatMap(call => call[1])).toContain(old(18));
  });

  it('resolves every owner before the first signature and leaves all schemas unchanged if a later owner check rejects', async () => {
    const blocks = [{ name: 'news', imgConfig: { url: old(1) } }, customer(old(18)),
      { name: 'richText', richText: { val: '<p onclick="bad()">原HTML</p><video src="/api/assets/2"></video>' } }];
    const before = JSON.stringify(blocks), order: string[] = [];
    authority.legacy.mockImplementation(async (_db, references) => { order.push('legacy'); return references.map(reference => canonical(reference.image)); });
    authority.image.mockImplementation(async (_db, references) => { order.push('image'); return references.map(canonical); });
    authority.video.mockImplementation(async () => { order.push('video-refusal'); throw Error('owner lookup unavailable'); });
    await expect(renderDiyEditorialMedia(db, appKey, blocks)).rejects.toThrow('owner lookup unavailable');
    expect(order).toEqual(['legacy', 'image', 'video-refusal']);
    expect(authority.sign).not.toHaveBeenCalled();
    expect(JSON.stringify(blocks)).toBe(before);
  });

  it('uses bounded256 signing batches and commits no partial customer, neighbouring media or sanitized HTML on a synthetic second-batch failure', async () => {
    const blocks = [...Array.from({ length: 257 }, (_, index) => customer(`/api/assets/${index + 1}`)),
      { name: 'richText', richText: { val: '<p onclick="bad()">原作者文字</p>' } }];
    const before = JSON.stringify(blocks);
    authority.sign.mockImplementationOnce(async (_key, references) => references.map(fresh)).mockRejectedValueOnce(Error('synthetic second signing batch failure'));
    await expect(renderDiyEditorialMedia(db, appKey, blocks)).rejects.toThrow('synthetic second signing batch failure');
    expect(authority.sign.mock.calls.map(call => call[1].length)).toEqual([256, 1]);
    expect(authority.image).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(blocks)).toBe(before);
  });

  it('bounds distinct customer owner lookups to10000 without dropping the second batch or signing before its approval', async () => {
    const blocks = Array.from({ length: DIY_CUSTOMER_SERVICE_MEDIA_SLOT_LIMIT }, (_, index) => customer(`/api/assets/${index + 1}`));
    const order: string[] = [];
    authority.image.mockImplementation(async (_db, references) => { order.push(`owner:${references.length}`); return references; });
    authority.sign.mockImplementation(async (_key, references) => { order.push(`sign:${references.length}`); return references.map(fresh); });
    await renderDiyEditorialMedia(db, appKey, blocks);
    expect(authority.image.mock.calls.map(call => call[1].length)).toEqual([10_000, 10_000]);
    expect(order.slice(0, 2)).toEqual(['owner:10000', 'owner:10000']);
    expect(authority.sign.mock.calls).toHaveLength(79);
    expect(authority.sign.mock.calls.every(call => call[1].length <= 256)).toBe(true);
    expect(authority.sign.mock.calls.flatMap(call => call[1])).toHaveLength(20_000);
    expect(blocks[19_999]!.logoConfig.url).toBe(fresh('/api/assets/20000'));
  });
});
