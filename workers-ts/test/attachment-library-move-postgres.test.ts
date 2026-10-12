import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminAttachmentScope } from '../src/services/system/AttachmentService';
import { NotFoundException, ValidateException } from '../src/utils/errors';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { attachmentLibraryMoveFixture } from './helpers/attachmentLibraryMoveFixture';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('attachment library mutations on independent owned PG16 backends', () => {
  let f: Awaited<ReturnType<typeof attachmentLibraryMoveFixture>>;
  const scope = adminAttachmentScope();
  beforeAll(async () => { f = await attachmentLibraryMoveFixture(); }, 30_000);
  beforeEach(async () => { await f.reset(); });
  afterEach(() => { for (const method of Object.values(f.objects)) expect(method).not.toHaveBeenCalled();
    expect(f.queue.send).not.toHaveBeenCalled(); });
  afterAll(async () => { await f?.close(); }, 30_000);

  it.each(['move-first', 'delete-first'] as const)('serializes destination category deletion in %s order', async order => {
    const before = await f.snapshot();
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(505610,0)');
      try {
        const moving = order === 'move-first' ? first : second;
        const deleting = order === 'move-first' ? second : first;
        const firstResult = outcome<unknown>(order === 'move-first'
          ? f.serviceFor(moving.db).move(scope, [2, 1], 12)
          : f.serviceFor(deleting.db).deleteCategory(scope, 12));
        await waitForFinanceBlock(f.db, first.pid, blocker.pid);
        const secondResult = outcome<unknown>(order === 'move-first'
          ? f.serviceFor(deleting.db).deleteCategory(scope, 12)
          : f.serviceFor(moving.db).move(scope, [2, 1], 12));
        await waitForFinanceBlock(f.db, second.pid, first.pid);
        await blocker.exec('COMMIT');
        const a = await firstResult, b = await secondResult;
        expect(a.ok).toBe(true); expect(b.ok).toBe(false);
        if (!b.ok) expect(b.error).toBeInstanceOf(order === 'move-first' ? ValidateException : NotFoundException);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    expect(await f.snapshot()).toEqual(order === 'move-first'
      ? { ...before, attachments: before.attachments.map(row => row.attId < 3 ? { ...row, pid: 12 } : row) }
      : { ...before, categories: before.categories.filter(row => row.id !== 12) });
  }, 30_000);

  it.each([10, 11, 12])('rechecks committed removal of original or target category %s after its row lock waits', async id => {
    const before = await f.snapshot();
    await withFinancePeers(f.db, async ([writer, moving]) => {
      await writer.exec(`BEGIN; DELETE FROM system_attachment_category WHERE id=${id}`);
      try {
        const pending = outcome(f.serviceFor(moving.db).move(scope, [1, 2], 12));
        await waitForFinanceBlock(f.db, moving.pid, writer.pid);
        await writer.exec('COMMIT');
        const result = await pending;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(NotFoundException);
      } finally { await writer.exec('ROLLBACK'); }
    });
    expect(await f.snapshot()).toEqual({ ...before, categories: before.categories.filter(row => row.id !== id) });
  }, 30_000);

  it.each(['move', 'rename'] as const)('rejects %s after an already locked selected attachment is deleted', async action => {
    const before = await f.snapshot();
    await withFinancePeers(f.db, async ([writer, mutating]) => {
      await writer.exec('BEGIN; DELETE FROM system_attachment WHERE att_id=1');
      try {
        const pending = outcome<unknown>(action === 'move'
          ? f.serviceFor(mutating.db).move(scope, [1, 2], 12)
          : f.serviceFor(mutating.db).rename(scope, 1, 'late-name'));
        await waitForFinanceBlock(f.db, mutating.pid, writer.pid);
        await writer.exec('COMMIT');
        const result = await pending;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(NotFoundException);
      } finally { await writer.exec('ROLLBACK'); }
    });
    expect(await f.snapshot()).toEqual({ ...before, attachments: before.attachments.filter(row => row.attId !== 1) });
  }, 30_000);

  it.each(['move', 'rename'] as const)('rechecks %s scope after a selected row commits a different module', async action => {
    const before = await f.snapshot();
    await withFinancePeers(f.db, async ([writer, mutating]) => {
      await writer.exec('BEGIN; UPDATE system_attachment SET module_type=2 WHERE att_id=1');
      try {
        const pending = outcome<unknown>(action === 'move'
          ? f.serviceFor(mutating.db).move(scope, [1, 2], 12)
          : f.serviceFor(mutating.db).rename(scope, 1, 'late-name'));
        await waitForFinanceBlock(f.db, mutating.pid, writer.pid);
        await writer.exec('COMMIT');
        const result = await pending;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(NotFoundException);
      } finally { await writer.exec('ROLLBACK'); }
    });
    expect(await f.snapshot()).toEqual({ ...before, attachments: before.attachments.map(row =>
      row.attId === 1 ? { ...row, moduleType: 2 } : row) });
  }, 30_000);

  it('commits every moved ID before a later deletion obtains its selected row', async () => {
    const before = await f.snapshot();
    await withFinancePeers(f.db, async ([blocker, moving, deleting]) => {
      await blocker.exec('BEGIN; SELECT att_id FROM system_attachment WHERE att_id=2 FOR UPDATE');
      try {
        const pending = outcome(f.serviceFor(moving.db).move(scope, [2, 1], 12));
        await waitForFinanceBlock(f.db, moving.pid, blocker.pid);
        const removed = outcome(deleting.exec('DELETE FROM system_attachment WHERE att_id=2 RETURNING att_id'));
        await waitForFinanceBlock(f.db, deleting.pid, moving.pid);
        await blocker.exec('COMMIT');
        const result = await pending;
        expect(result).toEqual({ ok: true, value: { ids: [2, 1], pid: 12 } });
        expect((await removed).ok).toBe(true);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    expect(await f.snapshot()).toEqual({ ...before, attachments: before.attachments.filter(row => row.attId !== 2)
      .map(row => row.attId === 1 ? { ...row, pid: 12 } : row) });
  }, 30_000);

  it('serializes a reversed-ID move and overlapping rename without changing object metadata', async () => {
    const before = await f.snapshot();
    await withFinancePeers(f.db, async ([blocker, moving, renaming]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(505610,0)');
      try {
        const move = outcome(f.serviceFor(moving.db).move(scope, [2, 1], 12));
        await waitForFinanceBlock(f.db, moving.pid, blocker.pid);
        const rename = outcome(f.serviceFor(renaming.db).rename(scope, 1, 'serialized-name'));
        await waitForFinanceBlock(f.db, renaming.pid, moving.pid);
        await blocker.exec('COMMIT');
        expect(await move).toEqual({ ok: true, value: { ids: [2, 1], pid: 12 } });
        expect(await rename).toEqual({ ok: true, value: { id: 1, real_name: 'serialized-name' } });
      } finally { await blocker.exec('ROLLBACK'); }
    });
    expect(await f.snapshot()).toEqual({ ...before, attachments: before.attachments.map(row =>
      row.attId === 1 ? { ...row, pid: 12, realName: 'serialized-name' } : row.attId === 2 ? { ...row, pid: 12 } : row) });
  }, 30_000);
});
