import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { systemAttachment } from '../src/models/schema';
import {
  adminAttachmentScope, kefuAttachmentScope, supplierAttachmentScope, userAttachmentScope,
  visitorAttachmentScope, type AttachmentScope,
} from '../src/services/system/AttachmentService';
import { assistedFormAttachmentScope, belongsToAssistedFormScope } from '../src/services/system/AssistedFormAttachmentScope';
import { ValidateException } from '../src/utils/errors';
import { attachmentUploadCategoryFixture, pngFile } from './helpers/attachmentUploadCategoryFixture';

const owners: Array<{ label: string; scope: AttachmentScope; folder: string }> = [
  { label: 'Admin', scope: adminAttachmentScope(), folder: 'admin' },
  { label: 'Supplier', scope: supplierAttachmentScope(77), folder: 'supplier' },
  { label: 'User', scope: userAttachmentScope(111), folder: 'user' },
  { label: 'Kefu', scope: kefuAttachmentScope(112), folder: 'kefu' },
  { label: 'Visitor', scope: visitorAttachmentScope(111), folder: 'visitor' },
];

/** Real SQL, with an explicit in-memory R2/queue boundary. Independent backend
 * locks and COMMIT acknowledgement faults live in the native PostgreSQL file. */
describe('ordinary image upload ownership and canonical response contracts', () => {
  let f: Awaited<ReturnType<typeof attachmentUploadCategoryFixture>>;
  beforeAll(async () => { f = await attachmentUploadCategoryFixture(); });
  beforeEach(async () => { await f.reset(); });
  afterAll(async () => { if (f) await f.close(); });

  it.each(owners.flatMap(owner => [
    { ...owner, destination: 'root', pid: 0 },
    { ...owner, destination: 'child category', pid: 52 },
  ]))('persists the full $label metadata in $destination and returns only a signed preview separately', async ({ scope, folder, pid, label }) => {
    if (pid) {
      await f.seedCategory({ id: 51, type: scope.type, relationId: scope.relationId, fileType: 1, name: 'parent' });
      await f.seedCategory({ id: 52, type: scope.type, relationId: scope.relationId, fileType: 1, pid: 51, name: 'child' });
    }
    const before = await f.snapshot(), file = pngFile(`原图-${label}.png`);
    const startedAt = Math.floor(Date.now() / 1000);
    const result = await f.serviceFor().uploadImage(scope, file, pid);
    const finishedAt = Math.floor(Date.now() / 1000);
    const rows = await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, result.att_id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(Number.isSafeInteger(result.att_id) && result.att_id > 0).toBe(true);
    expect(row).toMatchObject({ type: scope.type, relationId: scope.relationId, moduleType: scope.moduleType,
      fileType: 1, pid, imageType: 8, realName: file.name, attDir: `/api/assets/${result.att_id}`,
      sattDir: `/api/assets/${result.att_id}` });
    expect(row.attType.trim()).toBe('image/png');
    expect(row.attSize.trim()).toBe(String(file.size));
    expect(row.time).toBeGreaterThanOrEqual(startedAt);
    expect(row.time).toBeLessThanOrEqual(finishedAt);
    expect(row.name).toMatch(new RegExp(`^attachments/${folder}/${scope.relationId || 1}/\\d{4}/\\d{2}/[a-f0-9-]+\\.png$`));
    expect(result).toMatchObject({ name: file.name, size: file.size, type: 'image/png', url: row.attDir });
    expect(result.src).toMatch(new RegExp(`^/api/assets/${result.att_id}\\?expires=\\d+&signature=`));
    expect(row.attDir).not.toContain('?');
    expect(row.sattDir).not.toBe(result.src);
    expect(f.objects.get(row.name)).toMatchObject({ bytes: new Uint8Array(await file.arrayBuffer()),
      httpMetadata: { contentType: 'image/png', cacheControl: 'private, no-store' },
      customMetadata: { ownerType: String(scope.type), ownerId: String(scope.relationId), originalName: file.name } });
    const after = await f.snapshot();
    expect(after.attachments.filter(r => r.attId !== result.att_id)).toEqual(before.attachments);
    expect(after.categories).toEqual(before.categories);
    expect(f.objects.has(f.unrelatedKey)).toBe(true);
    expect(f.bucket.delete).not.toHaveBeenCalled();
    expect(f.queue.send).not.toHaveBeenCalled();
  });

  it.each([20, 30, 40, 999])('rejects non-image, foreign or absent category %s before writing an object', async pid => {
    const before = await f.snapshot();
    await expect(f.serviceFor().uploadImage(adminAttachmentScope(), pngFile(), pid)).rejects.toThrow('附件分类不存在');
    expect(await f.snapshot()).toEqual(before);
    expect([...f.objects.keys()]).toEqual([f.unrelatedKey]);
    expect(f.bucket.put).not.toHaveBeenCalled();
    expect(f.bucket.delete).not.toHaveBeenCalled();
    expect(f.queue.send).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, '1 OR 1=1', Number.MAX_SAFE_INTEGER + 1])('rejects malformed category %s without external side effects', async pid => {
    const before = await f.snapshot();
    await expect(f.serviceFor().uploadImage(adminAttachmentScope(), pngFile(), pid)).rejects.toThrow('分类ID');
    expect(await f.snapshot()).toEqual(before);
    expect([...f.objects.keys()]).toEqual([f.unrelatedKey]);
    expect(f.bucket.put).not.toHaveBeenCalled();
    expect(f.bucket.delete).not.toHaveBeenCalled();
    expect(f.queue.send).not.toHaveBeenCalled();
  });

  it.each(['empty', 'wrong-mime', 'too-large'] as const)('rejects %s image before object or metadata writes', async reason => {
    const file = reason === 'empty' ? new File([], 'empty.png', { type: 'image/png' })
      : reason === 'wrong-mime' ? new File([await pngFile().arrayBuffer()], 'misdeclared.jpg', { type: 'image/jpeg' })
        : new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' });
    const before = await f.snapshot();
    await expect(f.serviceFor().uploadImage(adminAttachmentScope(), file, 0)).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
    expect(f.bucket.put).not.toHaveBeenCalled();
    expect(f.bucket.delete).not.toHaveBeenCalled();
    expect(f.queue.send).not.toHaveBeenCalled();
  });

  it('keeps registered-user and visitor namespaces separate for the same numeric identity', async () => {
    const user = await f.serviceFor().uploadImage(userAttachmentScope(111), pngFile('member.png'), 0);
    const visitor = await f.serviceFor().uploadImage(visitorAttachmentScope(111), pngFile('visitor.png'), 0);
    const rows = await f.db.select().from(systemAttachment);
    const memberRow = rows.find(row => row.attId === user.att_id)!;
    const visitorRow = rows.find(row => row.attId === visitor.att_id)!;
    expect(memberRow).toMatchObject({ type: 3, relationId: 111, moduleType: 3 });
    expect(visitorRow).toMatchObject({ type: 3, relationId: 111, moduleType: 4 });
    expect(memberRow.name).toContain('/user/111/');
    expect(visitorRow.name).toContain('/visitor/111/');
    expect(memberRow.name).not.toBe(visitorRow.name);
    expect(f.objects.has(memberRow.name) && f.objects.has(visitorRow.name)).toBe(true);
    expect(f.bucket.delete).not.toHaveBeenCalled();
    expect(f.queue.send).not.toHaveBeenCalled();
  });

  it('preserves the R2 error without inserting metadata when the object write fails', async () => {
    const originalError = Error('owned R2 write rejected'), before = await f.snapshot();
    f.bucket.put.mockRejectedValueOnce(originalError);
    await expect(f.serviceFor().uploadImage(adminAttachmentScope(), pngFile(), 12)).rejects.toBe(originalError);
    expect(await f.snapshot()).toEqual(before);
    expect([...f.objects.keys()]).toEqual([f.unrelatedKey]);
    expect(f.bucket.delete).not.toHaveBeenCalled();
    expect(f.queue.send).not.toHaveBeenCalled();
  });

  it('does not clean an already committed image when preview signing fails', async () => {
    const originalKey = f.env.APP_KEY;
    f.env.APP_KEY = '';
    try {
      await expect(f.serviceFor().uploadImage(adminAttachmentScope(), pngFile(), 12)).rejects.toThrow('APP_KEY未配置');
      const rows = await f.db.select().from(systemAttachment);
      expect(rows).toHaveLength(2);
      const uploaded = rows.find(row => row.attId !== 1)!;
      expect(uploaded).toMatchObject({ pid: 12, attDir: `/api/assets/${uploaded.attId}`, sattDir: `/api/assets/${uploaded.attId}` });
      expect(f.objects.has(uploaded.name)).toBe(true);
      expect(f.objects.has(f.unrelatedKey)).toBe(true);
      expect(f.bucket.delete).not.toHaveBeenCalled();
      expect(f.queue.send).not.toHaveBeenCalled();
    } finally { f.env.APP_KEY = originalKey; }
  });

  it('keeps module5 authorization after object storage and before the same transaction inserts metadata', async () => {
    const scope = await assistedFormAttachmentScope({ adminId: 7, uid: 11, touristUid: '',
      key: 'a'.repeat(32), systemFormId: 3 });
    let putKey = '', authorized = 0;
    f.onPut(async key => { putKey = key; });
    const result = await f.serviceFor().uploadAssistedFormImage(scope, pngFile('form.png'), async tx => {
      authorized++;
      expect(f.objects.has(putKey)).toBe(true);
      expect(await tx.select().from(systemAttachment).where(eq(systemAttachment.name, putKey))).toEqual([]);
    });
    expect(authorized).toBe(1);
    const [row] = await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, result.att_id));
    expect(row).toMatchObject({ type: 1, relationId: 7, moduleType: 5, fileType: 1, pid: 0 });
    expect(belongsToAssistedFormScope(row!.name, scope)).toBe(true);
    expect(f.bucket.delete).not.toHaveBeenCalled();
    expect(f.queue.send).not.toHaveBeenCalled();
  });

  it('cleans only the new module5 object on final authorization rejection and preserves that error', async () => {
    const scope = await assistedFormAttachmentScope({ adminId: 7, uid: 0, touristUid: 'owned-guest',
      key: 'b'.repeat(32), systemFormId: 3 });
    const originalError = new ValidateException('owned final form authorization rejected'), before = await f.snapshot();
    let newKey = '';
    f.onPut(async key => { newKey = key; });
    await expect(f.serviceFor().uploadAssistedFormImage(scope, pngFile(), async () => { throw originalError; })).rejects.toBe(originalError);
    expect(await f.snapshot()).toEqual(before);
    expect(newKey).not.toBe(f.unrelatedKey);
    expect(f.bucket.delete).toHaveBeenCalledExactlyOnceWith(newKey);
    expect([...f.objects.keys()]).toEqual([f.unrelatedKey]);
    expect(f.queue.send).not.toHaveBeenCalled();
  });
});
