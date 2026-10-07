import { Hono } from 'hono';
import { vi } from 'vitest';
import type { AppVariables, Env } from '../../src/env';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { systemAdmin, systemAttachment, systemAttachmentCategory, systemMenus, systemRole } from '../../src/models/schema';
import * as Attachment from '../../src/controllers/system/AttachmentController';
import { adminAuthMiddleware } from '../../src/middleware/admin-auth';
import { AttachmentService } from '../../src/services/system/AttachmentService';
import { ApiException } from '../../src/utils/errors';
import { createToken, md5 } from '../../src/utils/jwt';
import { financePostgres } from './financePostgres';

export async function attachmentLibraryMoveFixture() {
  const f = await financePostgres([systemAttachment, systemAttachmentCategory, systemAdmin, systemRole, systemMenus]);
  const objects = { get: vi.fn(), head: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() };
  const queue = { send: vi.fn() };
  const env = { APP_KEY: 'owned-attachment-library-fixture', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
    ASSETS_BUCKET: objects, ORDER_QUEUE: queue } as unknown as Env;
  const container = createContainerFromDb(f.db);
  const serviceFor = (db: DbClient = f.db) => new AttachmentService(createContainerFromDb(db), env);
  const tokens = await Promise.all([1, 2, 3].map(async id =>
    (await createToken(id, 'admin', md5('attachment-fixture-password'), env.APP_KEY)).token));
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use('*', async (c, next) => { c.set('container', container); await next(); });
  app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
  for (const prefix of ['/adminapi', '/api/admin']) {
    const auth = adminAuthMiddleware();
    app.put(`${prefix}/file/file/do_move`, auth, Attachment.adminMove);
    app.put(`${prefix}/file/file/update/:id`, auth, Attachment.adminRename);
  }
  const reset = async () => {
    await f.reset();
    await f.db.insert(systemRole).values([
      { id: 1, roleName: 'attachment reader', rules: 'attachment.view' },
      { id: 2, roleName: 'attachment manager', rules: 'attachment.manage' },
      { id: 3, roleName: 'unrelated manager', rules: 'community.manage' },
    ]);
    await f.db.insert(systemAdmin).values([1, 2, 3].map(id => ({ id, account: `attachment-admin-${id}`,
      pwd: 'attachment-fixture-password', level: 1, roles: String(id), adminType: 1 })));
    await f.db.insert(systemAttachmentCategory).values([
      { id: 10, type: 1, relationId: 0, fileType: 1, name: 'source-one' },
      { id: 11, type: 1, relationId: 0, fileType: 1, name: 'source-two' },
      { id: 12, type: 1, relationId: 0, fileType: 1, name: 'destination' },
      { id: 20, type: 1, relationId: 0, fileType: 2, name: 'video' },
      { id: 30, type: 4, relationId: 9, fileType: 1, name: 'supplier-private' },
    ]);
    await f.db.insert(systemAttachment).values([
      { attId: 1, type: 1, relationId: 0, moduleType: 1, fileType: 1, pid: 10 },
      { attId: 2, type: 1, relationId: 0, moduleType: 1, fileType: 1, pid: 11 },
      { attId: 3, type: 1, relationId: 0, moduleType: 2, fileType: 1, pid: 10 },
      { attId: 4, type: 4, relationId: 9, moduleType: 1, fileType: 1, pid: 30 },
      { attId: 5, type: 1, relationId: 7, moduleType: 1, fileType: 1, pid: 10 },
      { attId: 6, type: 1, relationId: 0, moduleType: 1, fileType: 2, pid: 20 },
      { attId: 7, type: 1, relationId: 0, moduleType: 5, fileType: 1, pid: 10 },
    ].map(row => ({ ...row, name: `unchanged-object-${row.attId}`, attDir: `/api/assets/${row.attId}`,
      sattDir: `/api/assets/${row.attId}`, imageType: 8, attType: row.fileType === 1 ? 'image/png' : 'video/mp4',
      attSize: '1024', realName: `original-${row.attId}`, time: 1_700_000_000 })));
    for (const method of Object.values(objects)) method.mockClear();
    queue.send.mockClear();
  };
  const snapshot = async () => ({ attachments: await f.db.select().from(systemAttachment).orderBy(systemAttachment.attId),
    categories: await f.db.select().from(systemAttachmentCategory).orderBy(systemAttachmentCategory.id) });
  const request = async (path: string, body: unknown, role: 'manager' | 'reader' | 'other' = 'manager', prefix = '/adminapi') => {
    const token = tokens[role === 'reader' ? 0 : role === 'manager' ? 1 : 2];
    const response = await app.request(`${prefix}/file/file/${path}`, { method: 'PUT',
      headers: { 'Authori-zation': `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);
    return response.json<{ status: number; msg: string; data: unknown }>();
  };
  try { await reset(); return { ...f, env, objects, queue, serviceFor, snapshot, request, reset }; }
  catch (error) { await f.close(); throw error; }
}
