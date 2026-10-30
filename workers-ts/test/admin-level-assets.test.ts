import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAttachment, systemUserLevel, systemConfig, user } from '@/models/schema';
import * as signing from '@/services/system/AttachmentService';
import { levelImageInput, publicLevelImageReferences, renderLevelImageReferences, assertLevelImageChanges } from '@/services/user/LevelAssetPolicy';
import { UserLevelService } from '@/services/user/UserLevelService';
import { financeMemoryPostgres } from './helpers/financePostgres';

const key = 'owned-level-public-preview-key';
const ticket = (id: number) => `/api/assets/${id}?expires=1&signature=old-ticket`;
const signed = (id: number) => new RegExp(`^/api/assets/${id}\\?expires=\\d+&signature=[A-Za-z0-9_-]{43}$`, 'u');
const raster = (id: number) => ({ attId: id, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
  attDir: `/api/assets/${id}`, sattDir: `/api/assets/${id}`, name: `attachments/admin/1/2026/10/level-${id}.png`, attType: 'image/png' });

describe('ordinary member level exact icon/image stable media and public DTO projection', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>;
  beforeAll(async () => { f = await financeMemoryPostgres([systemAttachment, systemUserLevel, systemConfig, user]); });
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(systemAttachment).values([raster(1), raster(2), { ...raster(3), type: 3, relationId: 11, moduleType: 3,
      name: 'attachments/user/11/2026/10/private.png' }]);
  });
  it('signs only two exact properties while retaining source objects and every database row', async () => {
    const source = [{ icon: ticket(1), image: ticket(2), unknown: ticket(3), business: { image: ticket(3) } }];
    const original = structuredClone(source), metadata = await f.db.select().from(systemAttachment);
    const refs = await publicLevelImageReferences(f.db, source);
    expect(refs).toEqual([{ icon: '/api/assets/1', image: '/api/assets/2' }]);
    const preview = await renderLevelImageReferences(key, refs);
    expect(preview[0]!.icon).toMatch(signed(1)); expect(preview[0]!.image).toMatch(signed(2));
    expect(source).toEqual(original); expect(await f.db.select().from(systemAttachment)).toEqual(metadata);
    expect(Object.keys(preview[0]!)).toEqual(['icon', 'image']);
  });
  it.each([
    ['private user owner', { type: 3, relationId: 11, moduleType: 3 }], ['supplier owner', { type: 4, relationId: 9 }],
    ['wrong platform relation', { relationId: 1 }], ['private module', { moduleType: 2 }], ['video kind', { fileType: 2 }],
    ['nonR2', { imageType: 1 }], ['foreign key folder', { name: 'attachments/admin/2/2026/10/x.png' }],
    ['traversal key', { name: 'attachments/admin/1/2026/10/../x.png' }], ['SVG extension', { name: 'attachments/admin/1/2026/10/x.svg' }],
    ['SVG MIME', { attType: 'image/svg+xml' }], ['MIME mismatch', { attType: 'image/jpeg' }],
    ['wrong canonical id', { attDir: '/api/assets/2' }], ['copied database ticket', { attDir: ticket(1) }],
    ['entity disguised current path', { attDir: '/&#97;pi/assets/1' }], ['absolute foreign metadata URL', { attDir: 'https://foreign.example/api/assets/1' }],
  ] as const)('never authorizes current %s even with an old valid-looking ticket', async (_label, patch) => {
    await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId, 1));
    const source = { icon: ticket(1), image: '/api/assets/1' }, before = structuredClone(source);
    expect(await publicLevelImageReferences(f.db, [source])).toEqual([{ icon: '', image: '' }]);
    expect(source).toEqual(before);
    await expect(f.db.transaction(tx => assertLevelImageChanges(tx as unknown as DbClient, { icon: '', image: '' }, { icon: '/api/assets/1', image: '' }))).rejects.toThrow();
  });
  it('deleted/missing attachments cannot be resurrected by signatures', async () => {
    await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, 1));
    expect(await publicLevelImageReferences(f.db, [{ icon: ticket(1), image: ticket(999) }])).toEqual([{ icon: '', image: '' }]);
  });
  it('old MIME-less raster metadata remains compatible without weakening contradictory MIME checks', async () => {
    await f.db.update(systemAttachment).set({ attType: '' }).where(eq(systemAttachment.attId, 1));
    expect(await publicLevelImageReferences(f.db, [{ icon: '/api/assets/1', image: '' }])).toEqual([{ icon: '/api/assets/1', image: '' }]);
  });
  it('keeps historical HTTP and external bytes separate from display-only HTTPS upgrade without SQL or signing', async () => {
    const source = [{ icon: 'http://legacy.example/a.png?x=1&y=2', image: 'https://cdn.example/a.png?x=1&amp;y=2' }], before = structuredClone(source);
    const query = vi.spyOn(f.db, 'select'), sign = vi.spyOn(signing, 'signAttachmentReferences');
    try {
      const refs = await publicLevelImageReferences(f.db, source);
      expect(await renderLevelImageReferences(undefined, refs)).toEqual([{ icon: 'https://legacy.example/a.png?x=1&y=2', image: 'https://cdn.example/a.png?x=1&amp;y=2' }]);
      expect(source).toEqual(before); expect(query).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
    } finally { query.mockRestore(); sign.mockRestore(); }
  });
  it('does not decode literal JSON entities into asset identifiers or request a signature', async () => {
    const query = vi.spyOn(f.db, 'select'), sign = vi.spyOn(signing, 'signAttachmentReferences');
    try {
      for (const reference of ['/&#97;pi/assets/3', '/api&#47;assets/3', '/static/a&amp;b.png']) {
        const result = await publicLevelImageReferences(f.db, [{ icon: reference, image: '' }]);
        expect(await renderLevelImageReferences(undefined, result)).toEqual([{ icon: reference, image: '' }]);
      }
      expect(query).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
    } finally { query.mockRestore(); sign.mockRestore(); }
  });
  it.each(['javascript:alert(1)', '//remote.example/a.png', 'data:image/png;base64,AA==', 'blob:private', 'file:///private',
    'https://user:password@example.test/a.png', '/static/a b.png', '/static/a\\b.png', '/api/assets/0', '/api/assets/2147483648',
    '/api/assets/01', '/api/assets/1/extra'])('fails closed for unsafe historical display %s without modifying it', async reference => {
    const source = { icon: reference, image: reference }, before = structuredClone(source);
    expect(await publicLevelImageReferences(f.db, [source])).toEqual([{ icon: '', image: '' }]); expect(source).toEqual(before);
  });
  it('requires a signing key only if a currently approved canonical image will be displayed', async () => {
    await expect(renderLevelImageReferences(undefined, await publicLevelImageReferences(f.db, [{ icon: '/api/assets/1', image: '' }]))).rejects.toThrow(/APP_KEY/);
    await expect(renderLevelImageReferences(undefined, [{ icon: '/static/a.png', image: '' }])).resolves.toEqual([{ icon: '/static/a.png', image: '' }]);
  });
  it('validates only explicit changed slots; unchanged bad history is retained and requires no attachment query', async () => {
    const history = { icon: 'http://legacy.example/a.png', image: 'javascript:old' }, before = structuredClone(history);
    const query = vi.spyOn(f.db, 'select');
    try { await assertLevelImageChanges(f.db, history, { ...history }); expect(query).not.toHaveBeenCalled(); }
    finally { query.mockRestore(); }
    await f.db.transaction(tx => assertLevelImageChanges(tx as unknown as DbClient, history, { ...history, icon: '/api/assets/1' }));
    expect(history).toEqual(before);
    await expect(assertLevelImageChanges(f.db, history, { ...history, image: 'javascript:new' })).rejects.toThrow();
  });
  it('allows new stable public paths but rejects persisted picker tickets, foreign assets and new HTTP', async () => {
    await expect(assertLevelImageChanges(f.db, null, { icon: '/static/a.png', image: 'https://cdn.example/bg.png' })).resolves.toBeUndefined();
    for (const icon of [ticket(1), '/api/assets/3', 'http://legacy.example/new.png']) await expect(assertLevelImageChanges(f.db, null, { icon, image: '' })).rejects.toThrow();
    expect(levelImageInput('/api/assets/1')).toBe('/api/assets/1');
  });
  it('handles the complete5000-row pair budget without dropping dormant or duplicate references and rejects5001 atomically', async () => {
    const rows = Array.from({ length: 5000 }, () => ({ icon: '/api/assets/1', image: '/static/a.png' })), before = structuredClone(rows);
    const result = await publicLevelImageReferences(f.db, rows); expect(result).toHaveLength(5000);
    expect(result[4999]).toEqual({ icon: '/api/assets/1', image: '/static/a.png' }); expect(rows).toEqual(before);
    const query = vi.spyOn(f.db, 'select');
    try { await expect(publicLevelImageReferences(f.db, [...rows, rows[0]!])).rejects.toThrow(/容量/); expect(query).not.toHaveBeenCalled(); }
    finally { query.mockRestore(); }
  });
  it('actual grade/info project approved images while preserving0/95.5/100 pricing and every stored author value', async () => {
    await f.db.insert(systemUserLevel).values([
      { id: 1, name: 'Raw95.5', grade: 1, expNum: 1, discount: '95.50', isShow: 1, icon: '/api/assets/1', image: 'http://legacy.example/bg.png' },
      { id: 2, name: 'Raw0', grade: 2, expNum: 2, discount: '0.00', isShow: 1, icon: '/api/assets/3', image: 'javascript:old' },
      { id: 3, name: 'Raw100', grade: 3, expNum: 3, discount: '100.00', isShow: 1 },
      { id: 4, name: 'Hidden', grade: 4, expNum: 4, discount: '50.00', isShow: 0, icon: '/api/assets/1' },
    ]);
    await f.db.insert(systemConfig).values({ menuName: 'member_func_status', value: '1' });
    await f.db.insert(user).values({ uid: 11, level: 1, levelStatus: 1 });
    const rows = await f.db.select().from(systemUserLevel), service = new UserLevelService(createContainerFromDb(f.db), { APP_KEY: key } as Env);
    const grade = await service.gradeList(); expect(grade.map(row => row.discount)).toEqual([95.5, 100, 100]);
    expect(grade[0]!.icon).toMatch(signed(1)); expect(grade[0]!.image).toBe('https://legacy.example/bg.png');
    expect(grade[1]).toMatchObject({ icon: '', image: '' });
    const info = await service.userLevelInfo(11);
    expect(info.level_info).toMatchObject({ icon: expect.stringMatching(signed(1)), vip_icon: expect.stringMatching(signed(1)) });
    expect(info.level_list[0]).toMatchObject({ image: 'https://legacy.example/bg.png', discount: 95.5 });
    expect(await service.getLevel(1)).toEqual({ id: 1, name: 'Raw95.5', grade: 1, discount: 95.5 });
    expect(await f.db.select().from(systemUserLevel)).toEqual(rows);
  });
});
