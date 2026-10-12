import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { systemAttachment } from '../src/models/schema';
import { adminAttachmentScope } from '../src/services/system/AttachmentService';
import { attachmentLibraryMoveFixture } from './helpers/attachmentLibraryMoveFixture';

describe('attachment library move and rename SQL/HTTP contracts', () => {
  let f: Awaited<ReturnType<typeof attachmentLibraryMoveFixture>>;
  const scope = adminAttachmentScope();
  beforeAll(async () => { f = await attachmentLibraryMoveFixture(); }, 30_000);
  beforeEach(async () => { await f.reset(); });
  afterEach(() => { for (const method of Object.values(f.objects)) expect(method).not.toHaveBeenCalled();
    expect(f.queue.send).not.toHaveBeenCalled(); });
  afterAll(async () => { await f?.close(); }, 30_000);

  it.each(['/adminapi', '/api/admin'])('moves the exact selection and renames only the displayed name on %s', async prefix => {
    const before = await f.snapshot();
    expect(await f.request('do_move', { ids: [2, 1, 2], pid: 12 }, 'manager', prefix))
      .toMatchObject({ status: 200, data: { ids: [2, 1], pid: 12 } });
    expect(await f.request('update/1', { real_name: '  chosen-name.png  ' }, 'manager', prefix))
      .toMatchObject({ status: 200, data: { id: 1, real_name: 'chosen-name.png' } });
    expect(await f.snapshot()).toEqual({ ...before, attachments: before.attachments.map(row =>
      row.attId === 1 ? { ...row, pid: 12, realName: 'chosen-name.png' } : row.attId === 2 ? { ...row, pid: 12 } : row) });
  });

  it.each(['/adminapi', '/api/admin'])('rejects a reader and an unrelated manager through real auth on %s', async prefix => {
    const before = await f.snapshot();
    for (const role of ['reader', 'other'] as const) {
      expect((await f.request('do_move', { ids: [1, 2], pid: 12 }, role, prefix)).status).toBe(400011);
      expect((await f.request('update/1', { real_name: 'forbidden' }, role, prefix)).status).toBe(400011);
    }
    expect(await f.snapshot()).toEqual(before);
  });

  it('preserves the legacy images alias and moving to the unclassified root', async () => {
    expect(await f.request('do_move', { images: [1, 2], pid: 0 })).toMatchObject({ status: 200, data: { ids: [1, 2], pid: 0 } });
    expect((await f.snapshot()).attachments.filter(row => row.attId < 3).map(row => row.pid)).toEqual([0, 0]);
  });

  it.each([3, 4, 5, 7, 999])('rejects a batch containing out-of-scope or absent attachment %s without a partial move', async id => {
    const before = await f.snapshot();
    await expect(f.serviceFor().move(scope, [1, id], 12)).rejects.toThrow('一个或多个附件不存在');
    await expect(f.serviceFor().rename(scope, id, 'forbidden')).rejects.toThrow('附件不存在');
    expect(await f.snapshot()).toEqual(before);
  });

  it.each([20, 30, 999])('rejects a wrong-type, foreign or absent destination %s', async pid => {
    const before = await f.snapshot();
    await expect(f.serviceFor().move(scope, [1, 2], pid)).rejects.toThrow('素材原分类或目标分类不存在');
    expect(await f.snapshot()).toEqual(before);
  });

  it('fails closed on an invalid original folder and a mixed image/video selection', async () => {
    await f.db.update(systemAttachment).set({ pid: 999 }).where(eq(systemAttachment.attId, 1));
    const before = await f.snapshot();
    await expect(f.serviceFor().move(scope, [1, 2], 12)).rejects.toThrow('素材原分类或目标分类不存在');
    await expect(f.serviceFor().move(scope, [2, 6], 0)).rejects.toThrow('图片与视频不能同时移动');
    expect(await f.snapshot()).toEqual(before);
  });

  it('keeps a 50-attachment bound and validates names before any metadata change', async () => {
    await f.db.insert(systemAttachment).values(Array.from({ length: 51 }, (_, n) => ({ attId: 100 + n,
      type: 1, relationId: 0, moduleType: 1, fileType: 1, pid: 10, realName: `bounded-${n}` })));
    const ids = Array.from({ length: 50 }, (_, n) => 100 + n);
    expect(await f.serviceFor().move(scope, ids, 12)).toEqual({ ids, pid: 12 });
    const before = await f.snapshot();
    await expect(f.serviceFor().move(scope, [...ids, 150], 11)).rejects.toThrow('请选择1至50个附件');
    await expect(f.serviceFor().rename(scope, 1, 'x'.repeat(256))).rejects.toThrow();
    await expect(f.serviceFor().rename(scope, 1, '   ')).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
  });

  it.each(['skip', 'redirect', 'scope'] as const)('rolls the whole move back when real RETURNING is %s', async mode => {
    const body = mode === 'skip' ? 'RETURN NULL;' : mode === 'redirect' ? 'NEW.pid := 11; RETURN NEW;' : 'NEW.module_type := 2; RETURN NEW;';
    await f.exec(`CREATE FUNCTION owned_attachment_move_returning() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.att_id=2 THEN ${body} END IF; RETURN NEW; END $$;
      CREATE TRIGGER owned_attachment_move_returning BEFORE UPDATE ON system_attachment FOR EACH ROW EXECUTE FUNCTION owned_attachment_move_returning()`);
    try {
      const before = await f.snapshot();
      await expect(f.serviceFor().move(scope, [1, 2], 12)).rejects.toThrow('素材已变更，请刷新后重试');
      expect(await f.snapshot()).toEqual(before);
    } finally { await f.exec('DROP TRIGGER owned_attachment_move_returning ON system_attachment; DROP FUNCTION owned_attachment_move_returning()'); }
  });

  it.each(['skip', 'rewrite'] as const)('rolls a %s rename back instead of reporting a successful name', async mode => {
    const body = mode === 'skip' ? 'RETURN NULL;' : "NEW.real_name := 'unexpected-name'; RETURN NEW;";
    await f.exec(`CREATE FUNCTION owned_attachment_rename_returning() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; CREATE TRIGGER owned_attachment_rename_returning BEFORE UPDATE ON system_attachment FOR EACH ROW EXECUTE FUNCTION owned_attachment_rename_returning()`);
    try {
      const before = await f.snapshot();
      await expect(f.serviceFor().rename(scope, 1, 'requested-name')).rejects.toThrow('素材已变更，请刷新后重试');
      expect(await f.snapshot()).toEqual(before);
    } finally { await f.exec('DROP TRIGGER owned_attachment_rename_returning ON system_attachment; DROP FUNCTION owned_attachment_rename_returning()'); }
  });
});
