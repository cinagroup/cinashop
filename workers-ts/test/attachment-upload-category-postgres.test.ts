import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { systemAttachment } from '../src/models/schema';
import { adminAttachmentScope, kefuAttachmentScope, supplierAttachmentScope, userAttachmentScope,
  visitorAttachmentScope } from '../src/services/system/AttachmentService';
import { assistedFormAttachmentScope, belongsToAssistedFormScope } from '../src/services/system/AssistedFormAttachmentScope';
import { NotFoundException, ValidateException } from '../src/utils/errors';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { attachmentUploadCategoryFixture } from './helpers/attachmentUploadCategoryFixture';

function databaseError(error: unknown): { code?: unknown; message?: unknown } | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    if ('code' in current) return current;
    current = 'cause' in current ? current.cause : undefined;
  }
}

const ordinaryScopes = [
  ['admin', adminAttachmentScope()], ['supplier', supplierAttachmentScope(9)], ['user', userAttachmentScope(11)],
  ['kefu', kefuAttachmentScope(17)], ['visitor', visitorAttachmentScope(19)],
] as const;
const commitFailures = ordinaryScopes.flatMap(([name, scope]) => [undefined, '40003', '08006'].map(code => ({ name, scope, code })));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('image uploads and category races on independent owned PG16 backends', () => {
  let f: Awaited<ReturnType<typeof attachmentUploadCategoryFixture>>;
  const scope = adminAttachmentScope();
  beforeAll(async () => { f = await attachmentUploadCategoryFixture(); }, 30_000);
  beforeEach(async () => { await f.reset(); });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); }, 30_000);
  const newObjectKey = () => {
    expect(f.bucket.put).toHaveBeenCalledTimes(1);
    const key = f.bucket.put.mock.calls[0][0];
    expect(key).not.toBe(f.unrelatedKey);
    return key;
  };
  const onlyUnrelatedObject = () => expect([...f.objects.keys()]).toEqual([f.unrelatedKey]);

  it('commits an image into a valid nested category with canonical URLs and exact streamed bytes', async () => {
    await f.seedCategory({ id: 13, type: 1, relationId: 0, fileType: 1, pid: 12, name: 'nested-target' });
    const result = await f.serviceFor().uploadImage(scope, f.pngFile('nested.png'), 13);
    const row = (await f.snapshot()).attachments.find(attachment => attachment.attId === result.att_id)!;
    expect(row).toMatchObject({ type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, pid: 13,
      attDir: `/api/assets/${result.att_id}`, sattDir: `/api/assets/${result.att_id}`, realName: 'nested.png' });
    expect(f.objects.get(row.name)?.bytes).toEqual(new Uint8Array(await f.pngFile().arrayBuffer()));
    expect(f.objects.get(row.name)?.httpMetadata).toMatchObject({ contentType: 'image/png', cacheControl: 'private, no-store' });
    expect(result.url).toBe(`/api/assets/${row.attId}`); expect(result.src).toContain(result.url + '?');
    expect(f.bucket.delete).not.toHaveBeenCalled(); expect(f.queue.send).not.toHaveBeenCalled();
  });

  it.each([99, 20, 30, 40])('rejects missing/wrong-file-type/foreign categories before R2, category=%i', async id => {
    const before = await f.snapshot();
    await expect(f.serviceFor().uploadImage(scope, f.pngFile(), id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await f.snapshot()).toEqual(before); onlyUnrelatedObject();
    expect(f.bucket.put).not.toHaveBeenCalled(); expect(f.bucket.delete).not.toHaveBeenCalled();
    expect(f.queue.send).not.toHaveBeenCalled();
  });

  it('rejects and compensates only the new key when category deletion commits during R2 PUT', async () => {
    const before = await f.snapshot();
    f.onPut(async () => { await f.serviceFor().deleteCategory(scope, 12); });
    await expect(f.serviceFor().uploadImage(scope, f.pngFile(), 12)).rejects.toBeInstanceOf(NotFoundException);
    expect(await f.snapshot()).toEqual({ ...before, categories: before.categories.filter(row => row.id !== 12) });
    expect(f.bucket.delete).toHaveBeenCalledExactlyOnceWith(newObjectKey());
    expect(f.queue.send).not.toHaveBeenCalled(); onlyUnrelatedObject();
  });

  it('holds the category scope lock until upload commits, so a real waiting delete refuses the nonempty category', async () => {
    await f.installInsertBarrier();
    await withFinancePeers(f.db, async ([blocker, uploading, deleting]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(505699,0)');
      try {
        const upload = outcome(f.serviceFor(uploading.db).uploadImage(scope, f.pngFile(), 12));
        // The INSERT trigger is blocked only after upload's category lock/check.
        await waitForFinanceBlock(f.db, uploading.pid, blocker.pid);
        const removal = outcome(f.serviceFor(deleting.db).deleteCategory(scope, 12));
        await waitForFinanceBlock(f.db, deleting.pid, uploading.pid);
        await blocker.exec('COMMIT');
        const uploaded = await upload, removed = await removal;
        expect(uploaded.ok).toBe(true); expect(removed.ok).toBe(false);
        if (!removed.ok) expect(removed.error).toBeInstanceOf(ValidateException);
        if (uploaded.ok) expect((await f.snapshot()).attachments.find(row => row.attId === uploaded.value.att_id)?.pid).toBe(12);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    expect((await f.snapshot()).categories.some(row => row.id === 12)).toBe(true);
    expect(f.bucket.delete).not.toHaveBeenCalled(); expect(f.queue.send).not.toHaveBeenCalled();
    expect(f.objects.has(newObjectKey())).toBe(true); expect(f.objects.has(f.unrelatedKey)).toBe(true);
  }, 30_000);

  it.each([
    ['deleted', 'DELETE FROM system_attachment_category WHERE id=12'],
    ['scope type', 'UPDATE system_attachment_category SET type=4 WHERE id=12'],
    ['foreign owner', 'UPDATE system_attachment_category SET relation_id=7 WHERE id=12'],
    ['file type', 'UPDATE system_attachment_category SET file_type=2 WHERE id=12'],
  ] as const)('rechecks committed target %s after a real category row-lock wait', async (_change, mutation) => {
    const before = await f.snapshot();
    await withFinancePeers(f.db, async ([writer, uploading]) => {
      await writer.exec(`BEGIN; ${mutation}`);
      try {
        const pending = outcome(f.serviceFor(uploading.db).uploadImage(scope, f.pngFile(), 12));
        await waitForFinanceBlock(f.db, uploading.pid, writer.pid);
        await writer.exec('COMMIT');
        const result = await pending;
        expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(NotFoundException);
      } finally { await writer.exec('ROLLBACK'); }
    });
    expect((await f.snapshot()).attachments).toEqual(before.attachments);
    expect(f.bucket.delete).toHaveBeenCalledExactlyOnceWith(newObjectKey());
    expect(f.queue.send).not.toHaveBeenCalled(); onlyUnrelatedObject();
  }, 30_000);

  it.each([
    ['insert', 'P0001'], ['canonical-update', 'P0001'], ['insert', '23514'], ['canonical-update', '23514'],
  ] as const)('compensates a real %s trigger rollback, including SQLSTATE %s', async (phase, code) => {
    const before = await f.snapshot();
    await f.installMetadataFailure(phase, code);
    const result = await outcome(f.serviceFor().uploadImage(scope, f.pngFile(), 0));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(databaseError(result.error)).toMatchObject({ code, message: `owned metadata ${phase} rejection` });
    expect(await f.snapshot()).toEqual(before);
    expect(f.bucket.delete).toHaveBeenCalledExactlyOnceWith(newObjectKey());
    expect(f.queue.send).not.toHaveBeenCalled(); onlyUnrelatedObject();
  });

  it.each(commitFailures)('retains committed metadata/object on lost COMMIT reply for $name, code=$code', async ({ scope: uploadScope, code }) => {
    const original = f.db.transaction.bind(f.db);
    const lostReply = Object.assign(Error('owned lost COMMIT acknowledgement'), { code });
    let committed = false;
    const transaction = vi.spyOn(f.db, 'transaction').mockImplementation(async (...args) => {
      await original(...args); // This awaits the real postgres.js COMMIT, not a fake INSERT result.
      committed = true;
      throw lostReply;
    });
    const result = await (async () => {
      try { return await outcome(f.serviceFor().uploadImage(uploadScope, f.pngFile(), 0)); }
      finally { transaction.mockRestore(); }
    })();
    expect(committed).toBe(true); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(lostReply);
    const key = newObjectKey(), row = (await f.snapshot()).attachments.find(attachment => attachment.name === key)!;
    expect(row).toMatchObject({ type: uploadScope.type, relationId: uploadScope.relationId, moduleType: uploadScope.moduleType,
      attDir: `/api/assets/${row.attId}`, sattDir: `/api/assets/${row.attId}`, pid: 0 });
    expect(f.objects.has(key)).toBe(true); expect(f.objects.has(f.unrelatedKey)).toBe(true);
    expect(f.bucket.delete).not.toHaveBeenCalled(); expect(f.queue.send).not.toHaveBeenCalled();
  });

  it.each(['insert-pid', 'insert-owner', 'insert-key', 'insert-null', 'update-null', 'update-canonical'] as const)(
    'rejects a real silent %s trigger change before metadata acknowledgement and rolls back the entire row', async kind => {
      const before = await f.snapshot();
      await f.installMetadataMutation(kind);
      const result = await outcome(f.serviceFor().uploadImage(scope, f.pngFile(), 0));
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(Error);
      expect(await f.snapshot()).toEqual(before);
      expect(f.bucket.delete).toHaveBeenCalledExactlyOnceWith(newObjectKey());
      expect(f.queue.send).not.toHaveBeenCalled(); onlyUnrelatedObject();
    });

  it.each(['insert', 'canonical-update'] as const)('queues only the new key after %s rollback cleanup fails, retaining the original SQL error', async phase => {
    const before = await f.snapshot();
    await f.installMetadataFailure(phase);
    f.bucket.delete.mockRejectedValueOnce(Error('owned direct cleanup failure'));
    const result = await outcome(f.serviceFor().uploadImage(scope, f.pngFile(), 0));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(databaseError(result.error)).toMatchObject({ code: 'P0001', message: `owned metadata ${phase} rejection` });
    expect(await f.snapshot()).toEqual(before);
    const key = newObjectKey();
    expect(f.bucket.delete).toHaveBeenCalledExactlyOnceWith(key);
    expect(f.queue.send).toHaveBeenCalledExactlyOnceWith({ action: 'deleteAttachmentObjects', keys: [key] });
    expect(f.objects.has(key)).toBe(true); expect(f.objects.has(f.unrelatedKey)).toBe(true);
    await f.serviceFor().processObjectCleanup({ action: 'deleteAttachmentObjects', keys: [key] });
    onlyUnrelatedObject();
  });

  it.each(['insert', 'canonical-update'] as const)('preserves the original %s SQL error and object when direct cleanup and enqueue both fail', async phase => {
    const before = await f.snapshot();
    await f.installMetadataFailure(phase);
    const cleanupError = Error('owned direct cleanup failure'), enqueueError = Error('owned enqueue failure');
    f.bucket.delete.mockRejectedValueOnce(cleanupError); f.queue.send.mockRejectedValueOnce(enqueueError);
    const result = await outcome(f.serviceFor().uploadImage(scope, f.pngFile(), 0));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toBe(cleanupError); expect(result.error).not.toBe(enqueueError);
      expect(databaseError(result.error)).toMatchObject({ code: 'P0001', message: `owned metadata ${phase} rejection` });
    }
    expect(await f.snapshot()).toEqual(before);
    const key = newObjectKey();
    expect(f.bucket.delete).toHaveBeenCalledExactlyOnceWith(key);
    expect(f.queue.send).toHaveBeenCalledExactlyOnceWith({ action: 'deleteAttachmentObjects', keys: [key] });
    expect([...f.objects.keys()]).toEqual([f.unrelatedKey, key]);
  });

  it('does not begin metadata or compensation when the R2 PUT itself rejects', async () => {
    const before = await f.snapshot(), writeError = Error('owned R2 PUT rejection');
    f.bucket.put.mockRejectedValueOnce(writeError);
    const result = await outcome(f.serviceFor().uploadImage(scope, f.pngFile(), 12));
    expect(result).toEqual({ ok: false, error: writeError }); expect(await f.snapshot()).toEqual(before);
    expect(f.bucket.delete).not.toHaveBeenCalled(); expect(f.queue.send).not.toHaveBeenCalled(); onlyUnrelatedObject();
  });

  it('still runs module5 authorization after PUT inside the exact metadata backend, and excludes its row from material operations', async () => {
    const assistedScope = await assistedFormAttachmentScope({ adminId: 17, uid: 0, touristUid: 'owned_guest',
      key: 'a'.repeat(32), systemFormId: 77 });
    await withFinancePeers(f.db, async ([, uploading]) => {
      const authorize = vi.fn(async (tx: typeof f.db) => {
        expect(f.bucket.put).toHaveBeenCalledTimes(1);
        const [identity] = await tx.select({ pid: sql<number>`pg_backend_pid()` }).from(sql`(values (1)) AS probe(n)`);
        expect(identity.pid).toBe(uploading.pid);
        expect(await tx.select().from(systemAttachment)).toHaveLength(1);
      });
      const result = await f.serviceFor(uploading.db).uploadAssistedFormImage(assistedScope, f.pngFile(), authorize);
      expect(authorize).toHaveBeenCalledTimes(1);
      const row = (await f.snapshot()).attachments.find(attachment => attachment.attId === result.att_id)!;
      expect(row).toMatchObject({ type: 1, relationId: 17, moduleType: 5, pid: 0, fileType: 1, imageType: 8 });
      expect(belongsToAssistedFormScope(row.name, assistedScope)).toBe(true);
      const before = await f.snapshot(), service = f.serviceFor();
      const materialScope = kefuAttachmentScope(17); // Same type/owner; only the module domain differs.
      expect((await service.list(materialScope, {})).list.map(item => item.att_id)).not.toContain(result.att_id);
      await expect(service.rename(materialScope, result.att_id, 'forbidden')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.move(materialScope, [result.att_id], 0)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.delete(materialScope, [result.att_id])).rejects.toBeInstanceOf(NotFoundException);
      expect(await f.snapshot()).toEqual(before);
      expect(f.objects.has(row.name)).toBe(true);
    });
    expect(f.bucket.delete).not.toHaveBeenCalled(); expect(f.queue.send).not.toHaveBeenCalled();
  }, 30_000);

  it('still compensates a module5 pre-INSERT authorization rejection without replacing its error', async () => {
    const assistedScope = await assistedFormAttachmentScope({ adminId: 17, uid: 11, touristUid: '',
      key: 'a'.repeat(32), systemFormId: 77 });
    const before = await f.snapshot(), rejection = new ValidateException('owned final authorization rejected');
    const authorize = vi.fn(async (tx: typeof f.db) => {
      await tx.execute(sql`SELECT 1`);
      throw rejection;
    });
    const result = await outcome(f.serviceFor().uploadAssistedFormImage(assistedScope, f.pngFile(), authorize));
    expect(result).toEqual({ ok: false, error: rejection }); expect(authorize).toHaveBeenCalledTimes(1);
    expect(await f.snapshot()).toEqual(before); expect(f.bucket.delete).toHaveBeenCalledExactlyOnceWith(newObjectKey());
    expect(f.queue.send).not.toHaveBeenCalled(); onlyUnrelatedObject();
  });
});
