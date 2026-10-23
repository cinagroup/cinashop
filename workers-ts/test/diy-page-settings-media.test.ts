import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
const authority = vi.hoisted(() => ({ image: vi.fn<(db: unknown, refs: string[]) => Promise<string[]>>(), sign: vi.fn<(key: string | undefined, refs: string[]) => Promise<string[]>>() }));
vi.mock('@/services/content/DiyPresentationVideoPolicy', () => ({ publicDiyPresentationImages: authority.image, publicDiyPresentationVideos: vi.fn(async (_db, refs: string[]) => refs) }));
vi.mock('@/services/system/AttachmentService', async original => ({ ...await original<typeof import('@/services/system/AttachmentService')>(), signAttachmentReferences: authority.sign }));
import { renderDiyPageBackground } from '@/services/content/DiyPageAppearancePolicy';
import { renderDiyEditorialMedia } from '@/services/content/DiyEditorialMediaPolicy';
const db = { select: vi.fn(() => { throw Error('Use the asserted current-owner boundary'); }) } as unknown as Pick<DbClient, 'select'>;
describe('the single explicit row background media authority', () => {
  beforeEach(() => { authority.image.mockReset().mockImplementation(async (_db, refs) => refs); authority.sign.mockReset().mockImplementation(async (_key, refs) => refs.map(ref => ref.startsWith('/api/assets/') ? ref + '?expires=900&signature=fresh' : ref)); });
  it('canonicalizes the one row background and resolves current raster owner before signing rather than trusting copied tickets', async () => {
    const row = { bg_pic: '/api/assets/7?expires=1&signature=old', link: '/api/assets/8', value: [{ bg_pic: '/api/assets/9' }] }, before = structuredClone(row);
    expect(await renderDiyPageBackground(db, 'key', row.bg_pic)).toBe('/api/assets/7?expires=900&signature=fresh');
    expect(authority.image).toHaveBeenCalledExactlyOnceWith(db, ['/api/assets/7']); expect(authority.sign).toHaveBeenCalledExactlyOnceWith('key', ['/api/assets/7']); expect(row).toEqual(before);
  });
  it('does not convert an image owner refusal into the original local ticket or a different kind grant', async () => {
    authority.image.mockResolvedValue(['']); expect(await renderDiyPageBackground(db, 'key', '/api/assets/7')).toBe(''); expect(authority.sign).not.toHaveBeenCalled();
  });
  it('never grants neighbouring fields or decodes hostile JSON references through the old HTML parser', async () => {
    for (const value of [undefined, [], {}, '/api/assets/&#55;', '/api/assets/&amp;#55;', '/api/assets/2147483648', '/api/assets/2147483648?expires=1&signature=old', '/api/assets/9007199254740991', 'javascript:alert(1)', '/api/assets/7\\x']) expect(await renderDiyPageBackground(db, 'key', value)).toBe('');
    expect(authority.image).not.toHaveBeenCalled(); expect(authority.sign).not.toHaveBeenCalled();
  });
  it('retains static and foreign HTTPS asset-shaped paths without interpreting them as a local signature', async () => {
    for (const ref of ['/static/logo.png', 'https://foreign.example/api/assets/7?expires=1']) expect(await renderDiyPageBackground(db, undefined, ref)).toBe(ref);
    expect(authority.sign).not.toHaveBeenCalled();
  });
  it('never HTML-decodes an encoded asset prefix after its actual JSON reference admission or sends such literal paths to HMAC signing', async () => {
    for (const ref of ['/&#97;pi/assets/7', '/api&#47;assets/7', '/&#x61;pi/assets/7', '/&amp;#97;pi/assets/7', '/static/a.png?x=1&amp;y=2']) expect(await renderDiyPageBackground(db, 'key', ref)).toBe(ref);
    expect(authority.sign).not.toHaveBeenCalled();
  });
  it('performs no authority/signing work for an empty or oversized imported slot', async () => {
    for (const ref of ['', 'https://image.example/' + 'a'.repeat(256)]) expect(await renderDiyPageBackground(db, undefined, ref)).toBe('');
    expect(authority.image).not.toHaveBeenCalled(); expect(authority.sign).not.toHaveBeenCalled();
  });
  it('propagates actual owner lookup failure before signing without mutating the saved metadata', async () => {
    const row = { bg_pic: '/api/assets/7?signature=old', is_bg_pic: 1 }, before = structuredClone(row);
    authority.image.mockRejectedValue(Error('owner unavailable')); await expect(renderDiyPageBackground(db, 'key', row.bg_pic)).rejects.toThrow('owner unavailable'); expect(authority.sign).not.toHaveBeenCalled(); expect(row).toEqual(before);
  });
  it('never returns partially projected metadata after a synthetic signer failure', async () => {
    const row = { bg_pic: '/api/assets/7?signature=old', is_bg_pic: 1 }, before = structuredClone(row);
    authority.sign.mockRejectedValue(Error('synthetic signing failure')); await expect(renderDiyPageBackground(db, 'key', row.bg_pic)).rejects.toThrow('synthetic signing failure'); expect(row).toEqual(before);
  });
  it('collects the complete row and component budgets before any media owner lookup or HMAC instead of presigning an oversize schema', async () => {
    const blocks = Array.from({ length: 2501 }, () => ({ name: 'news', imgConfig: { url: '/static/logo.png' } })), row = { bg_pic: '/api/assets/7?signature=old' };
    const before = JSON.stringify({ blocks, row });
    await expect(renderDiyEditorialMedia(db, 'key', blocks, row)).rejects.toThrow('完整读取容量');
    expect(authority.image).not.toHaveBeenCalled(); expect(authority.sign).not.toHaveBeenCalled(); expect(JSON.stringify({ blocks, row })).toBe(before);
  });
  it('resolves the late row owner before the first component signature and cannot partially commit when that owner lookup fails', async () => {
    const blocks = [{ name: 'customerService', logoConfig: { url: '/api/assets/7?signature=old' } }], row = { bg_pic: '/api/assets/8?signature=old' };
    const before = JSON.stringify({ blocks, row });
    authority.image.mockImplementation(async (_db, refs) => { if (refs.includes('/api/assets/8')) throw Error('row owner unavailable'); return refs; });
    await expect(renderDiyEditorialMedia(db, 'key', blocks, row)).rejects.toThrow('row owner unavailable');
    expect(authority.image.mock.calls.map(call => call[1])).toEqual([['/api/assets/7?signature=old'], ['/api/assets/8']]);
    expect(authority.sign).not.toHaveBeenCalled(); expect(JSON.stringify({ blocks, row })).toBe(before);
  });
  it('commits neither sanitized component HTML nor row canonical output when the final row signer rejects', async () => {
    const blocks = [{ name: 'richText', richText: { val: '<p onclick="author-value">正文</p>' } }], row = { bg_pic: '/api/assets/7?signature=old' };
    const before = JSON.stringify({ blocks, row }); authority.sign.mockRejectedValue(Error('row signing unavailable'));
    await expect(renderDiyEditorialMedia(db, 'key', blocks, row)).rejects.toThrow('row signing unavailable');
    expect(authority.sign).toHaveBeenCalledExactlyOnceWith('key', ['/api/assets/7']); expect(JSON.stringify({ blocks, row })).toBe(before);
  });
});
