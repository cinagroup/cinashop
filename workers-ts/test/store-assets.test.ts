import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import * as signing from '@/services/system/AttachmentService';
import { storeImageInput, assertStoreImageChange, publicStoreImageReferences, renderStoreImageReferences } from '@/services/store/StoreAssetPolicy';
import { financeMemoryPostgres } from './helpers/financePostgres';

const key = 'owned-store-image-preview-key';
const ticket = (id: number) => `/api/assets/${id}?expires=1&signature=old-ticket`;
const signed = (id: number) => new RegExp(`^/api/assets/${id}\\?expires=\\d+&signature=[A-Za-z0-9_-]{43}$`, 'u');
const raster = (id: number) => ({ attId: id, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
  attDir: `/api/assets/${id}`, sattDir: `/api/assets/${id}`, name: `attachments/admin/1/2026/10/store-${id}.png`, attType: 'image/png' });

describe('pickup-store exact image author slot and separately requested read-only images', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>;
  beforeAll(async () => { f = await financeMemoryPostgres([systemAttachment]); });
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(systemAttachment).values([raster(1), raster(2), { ...raster(3), type: 3, relationId: 11, moduleType: 3,
      name: 'attachments/user/11/2026/10/private.png' }]);
  });
  it('projects and signs only image without mutating the input or metadata, even when other object fields contain assets', async () => {
    const source = [{ image: ticket(1), oblong_image: ticket(3), unknown: '/api/assets/2', business: { image: ticket(3) } }];
    const before = structuredClone(source), metadata = await f.db.select().from(systemAttachment);
    const refs = await publicStoreImageReferences(f.db, source);
    expect(refs).toEqual([{ image: '/api/assets/1' }]);
    const preview = await renderStoreImageReferences(key, refs);
    expect(preview).toEqual([{ image: expect.stringMatching(signed(1)) }]);
    expect(source).toEqual(before); expect(await f.db.select().from(systemAttachment)).toEqual(metadata);
  });
  it('separately requested existing oblong values use the same platform metadata rules without becoming author fields', async () => {
    const row = { image: '/api/assets/1', oblong_image: '/api/assets/3' }, before = structuredClone(row);
    const refs = await publicStoreImageReferences(f.db, [{ image: row.image }, { image: row.oblong_image }]);
    expect(refs).toEqual([{ image: '/api/assets/1' }, { image: '' }]);
    expect(Object.keys(refs[0]!)).toEqual(['image']); expect(row).toEqual(before);
  });
  it.each([
    ['user owner', { type: 3, relationId: 11, moduleType: 3 }], ['supplier owner', { type: 4, relationId: 9 }],
    ['foreign platform relation', { relationId: 1 }], ['private module', { moduleType: 2 }], ['video kind', { fileType: 2 }],
    ['non-R2 metadata', { imageType: 1 }], ['another admin key folder', { name: 'attachments/admin/2/2026/10/x.png' }],
    ['traversal key', { name: 'attachments/admin/1/2026/10/../x.png' }], ['SVG extension', { name: 'attachments/admin/1/2026/10/x.svg' }],
    ['SVG MIME', { attType: 'image/svg+xml' }], ['MIME mismatch', { attType: 'image/jpeg' }],
    ['another canonical id', { attDir: '/api/assets/2' }], ['current database ticket', { attDir: ticket(1) }],
    ['entity disguised metadata path', { attDir: '/&#97;pi/assets/1' }], ['absolute metadata path', { attDir: 'https://foreign.example/api/assets/1' }],
  ] as const)('refuses %s before preview signing or changed-image commit', async (_name, patch) => {
    await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId, 1));
    const source = [{ image: ticket(1) }], before = structuredClone(source);
    expect(await publicStoreImageReferences(f.db, source)).toEqual([{ image: '' }]);
    await expect(f.db.transaction(tx => assertStoreImageChange(tx as unknown as DbClient, '', '/api/assets/1'))).rejects.toThrow();
    expect(source).toEqual(before);
  });
  it('does not resurrect a missing attachment; retained legacy empty MIME is still compatible with raster metadata', async () => {
    await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, 1));
    await f.db.update(systemAttachment).set({ attType: '' }).where(eq(systemAttachment.attId, 2));
    expect(await publicStoreImageReferences(f.db, [{ image: ticket(1) }, { image: '/api/assets/2' }]))
      .toEqual([{ image: '' }, { image: '/api/assets/2' }]);
  });
  it('keeps historical HTTP and entities as raw input, with a safe display-only HTTPS upgrade and no SQL or signature', async () => {
    const source = [{ image: 'http://legacy.example/a.png?x=1&y=2' }, { image: 'https://cdn.example/a.png?x=1&amp;y=2' },
      { image: '/&#97;pi/assets/3' }, { image: '/static/a&amp;b.png' }], before = structuredClone(source);
    const query = vi.spyOn(f.db, 'select'), sign = vi.spyOn(signing, 'signAttachmentReferences');
    try {
      const refs = await publicStoreImageReferences(f.db, source);
      expect(await renderStoreImageReferences(undefined, refs)).toEqual([{ image: 'https://legacy.example/a.png?x=1&y=2' },
        { image: 'https://cdn.example/a.png?x=1&amp;y=2' }, { image: '/&#97;pi/assets/3' }, { image: '/static/a&amp;b.png' }]);
      expect(source).toEqual(before); expect(query).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
    } finally { query.mockRestore(); sign.mockRestore(); }
  });
  it.each(['javascript:alert(1)', '//remote.example/a.png', 'data:image/png;base64,AA==', 'blob:private', 'file:///private',
    'https://user:password@example.test/a.png', '/static/a b.png', '/static/a\\b.png', '/api/assets/0', '/api/assets/2147483648',
    '/api/assets/01', '/api/assets/1/extra'])('keeps unsafe historical %s untouched while displaying no image', async image => {
    const source = [{ image }], before = structuredClone(source);
    expect(await publicStoreImageReferences(f.db, source)).toEqual([{ image: '' }]); expect(source).toEqual(before);
  });
  it('preserves unchanged bad history without SQL, while changed/new values require stable references', async () => {
    const query = vi.spyOn(f.db, 'select');
    try {
      for (const prior of ['http://legacy.example/a.png', 'javascript:old', ticket(3)]) {
        await assertStoreImageChange(f.db, prior, prior);
      }
      expect(query).not.toHaveBeenCalled();
    } finally { query.mockRestore(); }
    await f.db.transaction(tx => assertStoreImageChange(tx as unknown as DbClient, 'javascript:old', '/api/assets/1'));
    for (const next of [ticket(1), '/api/assets/3', 'http://legacy.example/new.png']) {
      await expect(assertStoreImageChange(f.db, null, next)).rejects.toThrow();
    }
    await expect(assertStoreImageChange(f.db, null, '/static/a.png')).resolves.toBeUndefined();
    expect(storeImageInput('/api/assets/1')).toBe('/api/assets/1');
  });
  it('rejects non-string and over-budget new input without coercion or HTML entity decoding', () => {
    for (const input of [null, undefined, 1, {}, [], 'x'.repeat(256)]) expect(() => storeImageInput(input)).toThrow();
    expect(storeImageInput('/static/a&amp;b.png')).toBe('/static/a&amp;b.png');
    expect(storeImageInput('https://cdn.example/a.png')).toBe('https://cdn.example/a.png');
    expect(storeImageInput('')).toBe('');
  });
  it('requires APP_KEY only for a currently authorized canonical image', async () => {
    await expect(renderStoreImageReferences(undefined, await publicStoreImageReferences(f.db, [{ image: '/api/assets/1' }]))).rejects.toThrow(/APP_KEY/);
    await expect(renderStoreImageReferences(undefined, [{ image: '/static/a.png' }])).resolves.toEqual([{ image: '/static/a.png' }]);
  });
  it('retains every5000 duplicate/dormant row and rejects5001 before metadata I/O or signing', async () => {
    const rows = Array.from({ length: 5000 }, () => ({ image: '/api/assets/1' })), before = structuredClone(rows);
    const refs = await publicStoreImageReferences(f.db, rows);
    expect(refs).toHaveLength(5000); expect(refs[4999]).toEqual({ image: '/api/assets/1' }); expect(rows).toEqual(before);
    const query = vi.spyOn(f.db, 'select'), sign = vi.spyOn(signing, 'signAttachmentReferences');
    try {
      await expect(publicStoreImageReferences(f.db, [...rows, rows[0]!])).rejects.toThrow(/容量/);
      await expect(renderStoreImageReferences(key, [...refs, refs[0]!])).rejects.toThrow(/容量/);
      expect(query).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
    } finally { query.mockRestore(); sign.mockRestore(); }
  });
});
