import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createApp } from '@/app';
import type { Container, DbClient } from '@/lib/di';
import { systemAdmin, systemAttachment, systemRole } from '@/models/schema';
import { installProductVideoUpload } from '@/migrations/adminProductVideoUpload';
import { AttachmentService, adminAttachmentScope, isAttachmentObjectCleanupMessage } from '@/services/system/AttachmentService';
import { isProductVideoCleanupMessage } from '@/services/admin/AdminProductVideoUploadService';
import { ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { OwnedFixedLengthStream, productVideoFixture, videoBytes, videoManifest } from './helpers/adminProductVideoUpload';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned video App fixture'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned video App fixture'); return { container: wiring.container, close: async () => {} }; } }));
const cleanup = (uploadId: string) => ({ action: 'cleanupProductVideoUpload' as const, uploadId });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Upload stream did not settle within two seconds')), 2000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('durable Admin product video upload on actual PG16 and explicit memory R2/Queue boundaries', () => {
  let f: Awaited<ReturnType<typeof productVideoFixture>>;
  beforeAll(() => { vi.stubGlobal('FixedLengthStream', OwnedFixedLengthStream); });
  beforeEach(async () => { f = await productVideoFixture(); wiring.container = f.container; vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider network in owned video tests')); }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); wiring.container = undefined; await f?.close(); } }, 30000);
  afterAll(() => { vi.unstubAllGlobals(); });
  const prepare = async (size = 43, chunk = 16, pid = 20) => {
    const bytes = videoBytes(size), source = videoManifest(bytes, chunk, pid), id = crypto.randomUUID();
    await f.serviceFor().initialize(id, source.manifest, f.actors[1]); return { id, bytes, ...source };
  };
  const upload = async (size = 43, chunk = 16, pid = 20) => {
    const source = await prepare(size, chunk, pid);
    for (const [index, bytes] of source.chunks.entries()) await f.serviceFor().putPart(source.id, index + 1, bytes, f.actors[1]);
    return source;
  };
  const assets = () => f.db.select().from(systemAttachment).orderBy(systemAttachment.attId);
  const app = createApp();
  const http = async (path: string, method = 'GET', body?: BodyInit, extra: Record<string, string> = {}, actor = 1) => {
    const response = await app.request('https://owned-video.local/adminapi/file/' + path, { method,
      headers: { 'Authori-zation': 'Bearer ' + f.tokens[actor], ...extra }, ...(body === undefined ? {} : { body }) }, f.env);
    return { http: response.status, headers: response.headers, body: await response.json<{ status: number; msg: string; data: any }>() };
  };

  it.each([[12, 12], [43, 16]])('publishes exact ordered %i-byte content in %i-byte chunks and replays every phase into one attachment', async (size, chunk) => {
    const source = await prepare(size, chunk), service = f.serviceFor();
    const initialized = await service.query(source.id, f.actors[1]);
    expect(await service.initialize(source.id, source.manifest, f.actors[1])).toEqual(initialized);
    for (const [index, bytes] of source.chunks.entries()) {
      const first = await service.putPart(source.id, index + 1, bytes, f.actors[1]);
      expect(await service.putPart(source.id, index + 1, bytes, f.actors[1])).toEqual(first);
    }
    const result = await service.complete(source.id, f.actors[1]), [asset] = await assets();
    expect(result).toMatchObject({ state: 'committed', result: { id: asset.attId, url: '/api/assets/' + asset.attId, size } });
    expect(asset).toMatchObject({ type: 1, relationId: 0, moduleType: 1, fileType: 2, imageType: 8, pid: 20,
      attDir: result.result!.url, realName: 'owned.mp4' });
    expect(asset.attType.trim()).toBe('video/mp4');
    expect(f.objects.get(asset.name)?.bytes).toEqual(source.bytes); expect(asset.name.length).toBeLessThan(100);
    expect(await service.initialize(source.id, source.manifest, f.actors[1])).toEqual(result);
    for (const [index, bytes] of source.chunks.entries()) expect(await service.putPart(source.id, index + 1, bytes, f.actors[1])).toEqual(result);
    expect(await service.complete(source.id, f.actors[1])).toEqual(result); expect(await assets()).toHaveLength(1);
    const preview = await service.preview(source.id, f.actors[1]); expect(preview.url).toBe(result.result!.url); expect(preview.src).toContain(preview.url + '?expires=');
    expect(JSON.stringify(await f.rows())).not.toContain('signature='); expect(f.bucket.delete).not.toHaveBeenCalled();
  });

  it('rejects changed manifests, wrong hashes, missing parts and invalid MP4 markers before publication', async () => {
    const source = await prepare(), service = f.serviceFor(), before = await f.snapshot();
    for (const changed of [{ ...source.manifest, filename: 'changed.mp4' }, { ...source.manifest, pid: 0 }, { ...source.manifest, sha256: [...source.manifest.sha256].reverse() }])
      await expect(service.initialize(source.id, changed, f.actors[1])).rejects.toMatchObject({ httpStatus: 409 });
    const wrong = source.chunks[0].slice(); wrong[15] ^= 1;
    await expect(service.putPart(source.id, 1, wrong, f.actors[1])).rejects.toMatchObject({ httpStatus: 409 });
    await expect(service.complete(source.id, f.actors[1])).rejects.toMatchObject({ httpStatus: 409 });
    expect(await f.snapshot()).toEqual(before); expect(f.bucket.put).not.toHaveBeenCalled();
    const invalid = new Uint8Array(16), manifest = videoManifest(invalid, 16), id = crypto.randomUUID();
    await service.initialize(id, manifest.manifest, f.actors[1]);
    await expect(service.putPart(id, 1, invalid, f.actors[1])).rejects.toThrow('MP4'); expect(await assets()).toEqual([]);
  });

  it('adapts the actual eight legacy fields, retries nonfinal code1/final code2 and keeps the original attachment identity', async () => {
    const source = videoManifest(videoBytes(), 16), service = f.serviceFor();
    const input = (index: number) => ({ chunkNumber: String(index), chunkSize: '16', currentChunkSize: String(source.chunks[index - 1].length),
      file: new File([source.chunks[index - 1]], 'blob', { type: 'application/octet-stream' }), filename: 'legacy.mp4', totalChunks: String(source.chunks.length), md5: 'a'.repeat(32), pid: '20' });
    await expect(service.legacyUpload(input(2), f.actors[1])).rejects.toThrow('第一片');
    let final: Record<string, any> | undefined;
    for (const index of [1, 1, 2, 2, 3]) {
      const result = await service.legacyUpload(input(index), f.actors[1]); expect(result.code).toBe(index === 3 ? 2 : 1);
      if (index === 3) final = result;
    }
    const [asset] = await assets(); expect(f.objects.get(asset.name)?.bytes).toEqual(videoBytes()); expect(final!.canonical_url).toBe('/api/assets/' + asset.attId);
    expect(final!.file_path).toContain(final!.canonical_url + '?expires=');
    for (const index of [1, 2, 3]) {
      const replay = await service.legacyUpload(input(index), f.actors[1]); expect(replay.code).toBe(index === 3 ? 2 : 1);
      if (index === 3) expect(replay.att_id).toBe(asset.attId);
    }
    const before = await f.snapshot();
    await expect(service.legacyUpload({ ...input(1), pid: '0' }, f.actors[1])).rejects.toMatchObject({ httpStatus: 409 });
    const changed = source.chunks[1].slice(); changed[0] ^= 1;
    await expect(service.legacyUpload({ ...input(2), file: new File([changed], 'blob') }, f.actors[1])).rejects.toMatchObject({ httpStatus: 409 });
    expect(await f.snapshot()).toEqual(before); expect(await assets()).toHaveLength(1);
  });

  it.each(['initialize', 'part', 'complete'] as const)('recovers a real committed %s transaction after its acknowledgement is discarded', async phase => {
    const bytes = videoBytes(12), source = videoManifest(bytes, 12), id = crypto.randomUUID();
    if (phase !== 'initialize') await f.serviceFor().initialize(id, source.manifest, f.actors[1]);
    if (phase === 'complete') await f.serviceFor().putPart(id, 1, bytes, f.actors[1]);
    const lost = Object.assign(Error('Owned real COMMIT acknowledgement discarded'), { code: '40003' }); let discarded = false;
    const db = new Proxy(f.db, { get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return async (callback: Parameters<DbClient['transaction']>[0], options: Parameters<DbClient['transaction']>[1]) => {
        const result = await target.transaction(callback, options);
        if (!discarded && result && typeof result === 'object' && 'state' in result && (phase === 'complete' ? result.state === 'committed'
          : phase === 'initialize' ? result.state === 'active' : 'confirmed' in result && Array.isArray(result.confirmed) && result.confirmed.includes(1))) {
          discarded = true; throw lost;
        }
        return result;
      };
    } });
    const uncertain = f.serviceFor(db);
    await expect(phase === 'initialize' ? uncertain.initialize(id, source.manifest, f.actors[1])
      : phase === 'part' ? uncertain.putPart(id, 1, bytes, f.actors[1]) : uncertain.complete(id, f.actors[1])).rejects.toBe(lost);
    expect(discarded).toBe(true); const recovered = await f.serviceFor().query(id, f.actors[1]);
    expect(recovered.state).toBe(phase === 'complete' ? 'committed' : 'active');
    if (phase !== 'initialize') expect(recovered.confirmed).toEqual([1]);
    if (phase === 'complete') {
      const [asset] = await assets(); expect(f.objects.get(asset.name)?.bytes).toEqual(bytes);
      expect(await f.serviceFor().complete(id, f.actors[1])).toEqual(recovered); expect(await assets()).toHaveLength(1);
    } else expect(await assets()).toHaveLength(0);
    expect(f.bucket.delete).not.toHaveBeenCalled();
    if (phase === 'complete') {
      const [asset] = await assets(); await f.serviceFor().cleanup(cleanup(id));
      expect(f.objects.get(asset.name)?.bytes).toEqual(bytes);
      expect(f.bucket.delete.mock.calls.flatMap(([keys]) => typeof keys === 'string' ? [keys] : keys)).not.toContain(asset.name);
      expect(await f.serviceFor().query(id, f.actors[1])).toEqual(recovered);
    }
  });

  it('requires a durable cleanup enqueue before part writes and composition, and resumes the reserved part after queue recovery', async () => {
    const source = await prepare(12, 12), service = f.serviceFor(), failure = Error('Owned queue unavailable');
    f.queue.send.mockRejectedValueOnce(failure);
    await expect(service.putPart(source.id, 1, source.bytes, f.actors[1])).rejects.toBe(failure);
    expect(f.bucket.put).not.toHaveBeenCalled(); expect((await service.query(source.id, f.actors[1])).confirmed).toEqual([]);
    expect((await f.rows())[0].parts).toHaveProperty('1');
    await service.putPart(source.id, 1, source.bytes, f.actors[1]); f.bucket.put.mockClear();
    f.queue.send.mockRejectedValueOnce(failure); await expect(service.complete(source.id, f.actors[1])).rejects.toBe(failure);
    expect(f.bucket.put).not.toHaveBeenCalled(); expect(await assets()).toHaveLength(0);
    expect((await service.complete(source.id, f.actors[1])).state).toBe('committed');
  });

  it.each(['part', 'final'] as const)('reports an unknown result when cleanup enqueue fails after the %s provider write, retaining bytes for recovery', async phase => {
    const source = phase === 'final' ? await upload(12, 12) : await prepare(12, 12), service = f.serviceFor(), failure = Error('Owned post-write queue unavailable');
    f.queue.send.mockClear(); f.queue.send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    await expect(phase === 'final' ? service.complete(source.id, f.actors[1]) : service.putPart(source.id, 1, source.bytes, f.actors[1])).rejects.toBe(failure);
    expect(f.queue.send).toHaveBeenCalledTimes(2); expect(f.bucket.delete).not.toHaveBeenCalled(); expect(await assets()).toHaveLength(0);
    const written = [...f.objects].find(([key]) => key.endsWith(phase === 'final' ? '.mp4' : '.part'))!;
    expect(written[1].bytes).toEqual(source.bytes);
    const known = await service.query(source.id, f.actors[1]); expect(known.state).toBe('active'); expect(known.confirmed).toEqual(phase === 'final' ? [1] : []);
    if (phase === 'part') await service.putPart(source.id, 1, source.bytes, f.actors[1]);
    const committed = await service.complete(source.id, f.actors[1]); expect(committed.state).toBe('committed'); expect(await assets()).toHaveLength(1);
    const [asset] = await assets(); await service.cleanup(cleanup(source.id)); expect(f.objects.get(asset.name)?.bytes).toEqual(source.bytes);
  });

  it.each(['part', 'final'] as const)('settles an early R2 %s rejection without hanging the stream or publishing metadata', async phase => {
    const source = phase === 'final' ? await upload(12, 12) : await prepare(12, 12), failure = Error('Owned early R2 rejection');
    f.bucket.put.mockRejectedValueOnce(failure);
    await expect(bounded(phase === 'final' ? f.serviceFor().complete(source.id, f.actors[1])
      : f.serviceFor().putPart(source.id, 1, source.bytes, f.actors[1]))).rejects.toBe(failure);
    expect(await assets()).toHaveLength(0); expect((await f.serviceFor().query(source.id, f.actors[1])).state).toBe('active');
  });

  it.each([
    ['part', 'permission', "UPDATE public.system_role SET rules='' WHERE id=1"],
    ['final', 'permission', "UPDATE public.system_role SET rules='' WHERE id=1"],
    ['part', 'category', 'DELETE FROM public.system_attachment_category WHERE id=20'],
    ['final', 'category', 'UPDATE public.system_attachment_category SET relation_id=7 WHERE id=20'],
  ] as const)('rechecks %s I/O after concurrent %s revocation without publishing an attachment', async (phase, _kind, mutation) => {
    const source = phase === 'final' ? await upload(12, 12) : await prepare(12, 12);
    await withFinancePeers(f.db, async ([writer]) => {
      let changed = false; f.onPut(async key => { if (!changed && key.endsWith(phase === 'final' ? '.mp4' : '.part')) { changed = true; await writer.exec(mutation); } });
      await expect(phase === 'final' ? f.serviceFor().complete(source.id, f.actors[1])
        : f.serviceFor().putPart(source.id, 1, source.bytes, f.actors[1])).rejects.toThrow();
      expect(changed).toBe(true); expect(await assets()).toHaveLength(0);
      if (phase === 'part') expect((await f.rows())[0].confirmed).toEqual([]);
    });
  });

  it('isolates actors and keeps recovery/cancellation available after manage revocation while rejecting disabled or rotated identities', async () => {
    const source = await prepare(12, 12), service = f.serviceFor(), before = await f.snapshot();
    for (const work of [() => service.query(source.id, f.actors[2]), () => service.cancel(source.id, f.actors[2]),
      () => service.initialize(source.id, source.manifest, f.actors[2]), () => service.putPart(source.id, 1, source.bytes, f.actors[2]),
      () => service.complete(source.id, f.actors[2]), () => service.preview(source.id, f.actors[2])]) await expect(work()).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before); expect(f.bucket.put).not.toHaveBeenCalled();
    await f.db.update(systemRole).set({ rules: '' }).where(eq(systemRole.id, 1));
    expect((await service.query(source.id, f.actors[1])).state).toBe('active');
    await expect(service.putPart(source.id, 1, source.bytes, f.actors[1])).rejects.toThrow('权限');
    expect((await service.cancel(source.id, f.actors[1])).state).toBe('cancelled');
    await f.db.update(systemAdmin).set({ status: 0 }).where(eq(systemAdmin.id, 1)); await expect(service.query(source.id, f.actors[1])).rejects.toThrow('身份');
    await f.db.update(systemAdmin).set({ status: 1, pwd: 'rotated-owned-password' }).where(eq(systemAdmin.id, 1)); await expect(service.query(source.id, f.actors[1])).rejects.toThrow('凭据');
  });

  it('creates an immutable cancellation tombstone and refuses late initialization or a part returning from I/O', async () => {
    const service = f.serviceFor(), never = crypto.randomUUID(), source = await prepare(12, 12);
    expect((await service.query(never, f.actors[1])).state).toBe('unknown'); expect((await service.cancel(never, f.actors[1])).state).toBe('cancelled');
    await expect(service.initialize(never, source.manifest, f.actors[1])).rejects.toMatchObject({ httpStatus: 409 });
    f.onPut(async key => { if (key.endsWith('.part')) await service.cancel(source.id, f.actors[1]); });
    await expect(service.putPart(source.id, 1, source.bytes, f.actors[1])).rejects.toMatchObject({ httpStatus: 409 });
    expect((await service.query(source.id, f.actors[1])).state).toBe('cancelled'); expect(await assets()).toHaveLength(0);
    await service.cleanup(cleanup(source.id)); expect(f.objects.size).toBe(0);
    expect((await service.query(never, f.actors[1])).manifest).toBeNull();
  });

  it('uses the actual database clock to expire a seeded session and retains its cancellation evidence after cleanup', async () => {
    const source = await f.seedExpired(), service = f.serviceFor(); f.objects.set(source.key, { bytes: videoBytes(12) });
    expect((await service.query(source.id, f.actors[1])).state).toBe('expired');
    await expect(service.putPart(source.id, 1, videoBytes(12), f.actors[1])).rejects.toMatchObject({ httpStatus: 409 });
    expect(await service.cleanup(cleanup(source.id))).toMatchObject({ deferred: false });
    expect(f.objects.has(source.key)).toBe(false); expect((await service.query(source.id, f.actors[1])).state).toBe('cancelled'); expect(await f.rows()).toHaveLength(1);
  });

  it.each(['missing', 'corrupt'] as const)('rejects %s confirmed R2 bytes and repairs them through the original part request', async kind => {
    const source = await upload(), key = [...f.objects.keys()].find(key => key.endsWith('/2.part'))!;
    if (kind === 'missing') f.objects.delete(key); else f.objects.get(key)!.bytes[0] ^= 1;
    await expect(bounded(f.serviceFor().complete(source.id, f.actors[1]))).rejects.toMatchObject({ httpStatus: 409 }); expect(await assets()).toHaveLength(0);
    await f.serviceFor().putPart(source.id, 2, source.chunks[1], f.actors[1]);
    const result = await f.serviceFor().complete(source.id, f.actors[1]), [asset] = await assets();
    expect(result.state).toBe('committed'); expect(f.objects.get(asset.name)?.bytes).toEqual(source.bytes);
  });

  it('defers active cleanup and protects every committed final-key reference until the last library metadata row is removed', async () => {
    const source = await upload(12, 12), service = f.serviceFor();
    expect(await service.cleanup(cleanup(source.id))).toEqual({ deleted: 0, deferred: true }); expect(f.bucket.delete).not.toHaveBeenCalled();
    const committed = await service.complete(source.id, f.actors[1]), [asset] = await assets();
    await service.cleanup(cleanup(source.id)); expect(f.objects.get(asset.name)?.bytes).toEqual(source.bytes);
    await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, asset.attId));
    const [alias] = await f.db.insert(systemAttachment).values({ type: 4, relationId: 7, moduleType: 1, fileType: 1, imageType: 8,
      name: asset.name, attDir: '/api/assets/777', attType: 'image/png' }).returning();
    await service.cleanup(cleanup(source.id)); expect(f.objects.get(asset.name)?.bytes).toEqual(source.bytes);
    expect((await service.query(source.id, f.actors[1])).result).toEqual(committed.result);
    await expect(service.preview(source.id, f.actors[1])).rejects.toThrow('不存在');
    expect(f.bucket.delete.mock.calls.flatMap(([keys]) => typeof keys === 'string' ? [keys] : keys)).not.toContain(asset.name);
    await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, alias.attId));
    await service.cleanup(cleanup(source.id)); expect(f.objects.has(asset.name)).toBe(false);
    expect((await service.query(source.id, f.actors[1])).result).toEqual(committed.result);
    expect(f.bucket.delete.mock.calls.flatMap(([keys]) => typeof keys === 'string' ? [keys] : keys)).toContain(asset.name);
  });

  it('collects a late duplicate composition after actual library deletion using only the new guarded post-write cleanup message', async () => {
    const source = await upload(12, 12), reached = deferred(), release = deferred(), service = f.serviceFor();
    f.queue.send.mockClear();
    f.bucket.put.mockImplementationOnce(async (key, body, options) => {
      expect(key.endsWith('.mp4')).toBe(true);
      // Drain the native fixed stream, then hold provider persistence. A later
      // finalizer can commit and library deletion can finish before this put.
      const bytes = body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(await new Response(body).arrayBuffer());
      reached.resolve(); await release.promise; return f.write(key, bytes, options);
    });
    await withFinancePeers(f.db, async ([latePeer, firstPeer]) => {
      const late = outcome(f.serviceFor(latePeer.db).complete(source.id, f.actors[1]));
      try {
        await bounded(reached.promise);
        const first = await f.serviceFor(firstPeer.db).complete(source.id, f.actors[1]), [asset] = await assets();
        expect(first.state).toBe('committed'); expect(f.objects.get(asset.name)?.bytes).toEqual(source.bytes);
        const earlier = f.queue.send.mock.calls.map(([message]) => message).filter(isProductVideoCleanupMessage);
        expect(earlier).toHaveLength(3);
        await service.cleanup(earlier[0]); expect(f.objects.get(asset.name)?.bytes).toEqual(source.bytes);
        const library = new AttachmentService(f.container, f.env);
        expect(await library.delete(adminAttachmentScope(), [asset.attId])).toEqual({ ids: [asset.attId], deleted: 1 });
        const deletion = f.queue.send.mock.calls.map(([message]) => message).find(isAttachmentObjectCleanupMessage);
        expect(deletion).toBeTruthy(); await library.processObjectCleanup(deletion!);
        expect(f.objects.has(asset.name)).toBe(false); expect(await assets()).toHaveLength(0);
        // Every message enqueued before the late write has already run. Only
        // a fresh post-write message can converge the resurrected object.
        for (const message of earlier.slice(1)) await service.cleanup(message);
        const beforeLate = f.queue.send.mock.calls.length; expect(f.objects.size).toBe(0);
        release.resolve(); const result = await late;
        expect(result.ok).toBe(true); if (result.ok) expect(result.value).toEqual(first);
        expect(f.objects.get(asset.name)?.bytes).toEqual(source.bytes); expect(await assets()).toHaveLength(0);
        const fresh = f.queue.send.mock.calls.slice(beforeLate).map(([message]) => message).filter(isProductVideoCleanupMessage);
        expect(fresh).toEqual([cleanup(source.id)]); await service.cleanup(fresh[0]);
        expect(f.objects.size).toBe(0); expect(await f.rows()).toHaveLength(1);
        expect((await service.query(source.id, f.actors[1])).result).toEqual(first.result);
      } finally { release.resolve(); await late; }
    });
  }, 30000);

  it('refuses a final-key cleanup decision while an independent library writer holds the real table fence', async () => {
    const source = await upload(12, 12), service = f.serviceFor(); await service.complete(source.id, f.actors[1]);
    const [asset] = await assets();
    await withFinancePeers(f.db, async ([writer, cleaning]) => {
      await writer.exec('BEGIN; UPDATE public.system_attachment SET pid=pid WHERE false');
      try { await expect(f.serviceFor(cleaning.db).cleanup(cleanup(source.id))).rejects.toThrow(); }
      finally { await writer.exec('ROLLBACK'); }
    });
    expect(f.bucket.delete).not.toHaveBeenCalled(); expect(f.objects.get(asset.name)?.bytes).toEqual(source.bytes);
    await service.cleanup(cleanup(source.id)); expect(f.objects.get(asset.name)?.bytes).toEqual(source.bytes);
  }, 30000);

  it('rejects missing or drifted addons before any provider I/O', async () => {
    const missing = await productVideoFixture({ install: false });
    try {
      await expect(missing.serviceFor().initialize(crypto.randomUUID(), videoManifest(videoBytes()).manifest, missing.actors[1])).rejects.toMatchObject({ httpStatus: 503 });
      expect(missing.bucket.put).not.toHaveBeenCalled(); expect(missing.queue.send).not.toHaveBeenCalled();
    } finally { await missing.close(); }
    await f.exec('ALTER TABLE public.admin_product_video_upload_v1 DISABLE TRIGGER apvu_rows');
    await expect(f.serviceFor().initialize(crypto.randomUUID(), videoManifest(videoBytes()).manifest, f.actors[1])).rejects.toMatchObject({ httpStatus: 503 });
    expect(f.bucket.put).not.toHaveBeenCalled(); expect(f.queue.send).not.toHaveBeenCalled();
  });

  it('rejects real concurrent writers of authority, upload facts and library tables before starting provider writes', async () => {
    const source = await prepare(12, 12);
    await withFinancePeers(f.db, async ([writer, uploading]) => {
      for (const mutation of ["UPDATE public.system_role SET rules=rules WHERE id=1", 'UPDATE public.system_admin SET real_name=real_name WHERE id=1',
        `UPDATE public.admin_product_video_upload_v1 SET updated_at=updated_at WHERE upload_id='${source.id}'`,
        'UPDATE public.system_attachment_category SET name=name WHERE id=20', 'UPDATE public.system_attachment SET pid=pid WHERE false']) {
        await writer.exec('BEGIN');
        try {
          await writer.exec(mutation);
          await expect(f.serviceFor(uploading.db).putPart(source.id, 1, source.bytes, f.actors[1])).rejects.toMatchObject({ httpStatus: 409 });
        } finally { await writer.exec('ROLLBACK'); }
      }
    });
    expect(f.bucket.put).not.toHaveBeenCalled(); expect(await assets()).toHaveLength(0);
  }, 30000);

  it('holds real authority/category/attachment fences through the publishing metadata transaction', async () => {
    const source = await upload(12, 12);
    await f.exec(`CREATE FUNCTION public.owned_video_publish_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(505700,0); RETURN NEW; END $$;
      CREATE TRIGGER owned_video_publish_barrier BEFORE INSERT ON public.system_attachment FOR EACH ROW EXECUTE FUNCTION public.owned_video_publish_barrier()`);
    await withFinancePeers(f.db, async ([blocker, publishing, writer]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(505700,0)');
      const pending = outcome(f.serviceFor(publishing.db).complete(source.id, f.actors[1]));
      try {
        await waitForFinanceBlock(f.db, publishing.pid, blocker.pid); await writer.exec("SET lock_timeout='100ms'");
        for (const mutation of ["UPDATE public.system_role SET rules='' WHERE id=1", 'DELETE FROM public.system_attachment_category WHERE id=20', 'UPDATE public.system_attachment SET pid=0 WHERE false'])
          await expect(writer.exec(mutation)).rejects.toMatchObject({ code: '55P03' });
        await blocker.exec('COMMIT'); const result = await pending;
        expect(result.ok).toBe(true); if (result.ok) expect(result.value.state).toBe('committed');
      } finally { await blocker.exec('ROLLBACK'); await pending; }
    });
    expect(await assets()).toHaveLength(1);
  }, 30000);

  it('uploads and recovers with an independent restricted LOGIN and no addon DELETE/TRUNCATE or schema ownership', async () => {
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!), [origin] = await f.db.execute(sql`SELECT current_database() AS database,current_schema() AS schema`);
    if (!ownsFinanceFixtureTarget(String(origin.database), String(origin.schema), base.href)) throw Error('Unowned video service LOGIN target');
    const role = 'video_service_' + crypto.randomUUID().replaceAll('-', ''), password = crypto.randomUUID().replaceAll('-', '');
    await f.exec(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    let client: ReturnType<typeof postgres> | undefined;
    try {
      await f.exec(`GRANT USAGE ON SCHEMA public TO "${role}";
        GRANT SELECT,UPDATE ON public.system_admin,public.system_role,public.system_attachment_category TO "${role}";
        GRANT SELECT ON public.system_menus TO "${role}";
        GRANT SELECT,INSERT,UPDATE ON public.system_attachment,public.admin_product_video_upload_v1 TO "${role}";
        GRANT USAGE ON SEQUENCE public.system_attachment_att_id_seq TO "${role}"`);
      expect(await f.db.transaction(tx => installProductVideoUpload(tx, role))).toEqual({ applied: false });
      const url = new URL(base); url.pathname = '/' + origin.database; url.username = role; url.password = password;
      client = postgres(url.href, { max: 1, prepare: false, connect_timeout: 5 });
      const [identity] = await client`SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
      expect(identity).toEqual({ login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false, rolbypassrls: false });
      // Use the same production container wiring as every ordinary service call.
      const real = f.serviceFor(drizzle(client) as unknown as DbClient), id = crypto.randomUUID(), bytes = videoBytes(12), source = videoManifest(bytes, 12);
      await real.initialize(id, source.manifest, f.actors[1]); await real.putPart(id, 1, bytes, f.actors[1]);
      const result = await real.complete(id, f.actors[1]); expect(await real.query(id, f.actors[1])).toEqual(result); expect(result.state).toBe('committed');
      for (const statement of ['DELETE FROM public.admin_product_video_upload_v1', 'TRUNCATE public.admin_product_video_upload_v1'])
        await expect(client.unsafe(statement)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client?.end({ timeout: 5 });
      await f.exec(`REVOKE ALL ON public.system_admin,public.system_role,public.system_attachment_category,public.system_menus,public.system_attachment,public.admin_product_video_upload_v1 FROM "${role}";
        REVOKE ALL ON SEQUENCE public.system_attachment_att_id_seq FROM "${role}"; REVOKE ALL ON SCHEMA public FROM "${role}"; DROP ROLE "${role}"`);
    }
  }, 30000);

  it('runs initialize raw parts complete query and preview through the actual App and signed Admin JWT', async () => {
    const id = crypto.randomUUID(), source = videoManifest(videoBytes(), 16), prefix = 'video_uploads/' + id;
    const initialized = await http(prefix, 'POST', JSON.stringify(source.manifest), { 'content-type': 'application/json' });
    expect(initialized.body.status, initialized.body.msg).toBe(200); expect(initialized.body.data).toMatchObject({ upload_id: id, actor_id: 1, state: 'active' });
    expect(initialized.headers.get('Cache-Control')).toContain('no-store');
    for (const [index, chunk] of source.chunks.entries()) {
      const result = await http(prefix + '/parts/' + (index + 1), 'PUT', new Blob([chunk]), { 'content-type': 'application/octet-stream', 'content-length': String(chunk.length) });
      expect(result.body.status, result.body.msg).toBe(200);
    }
    const committed = await http(prefix + '/complete', 'POST'); expect(committed.body.status, committed.body.msg).toBe(200);
    expect(committed.body.data.state).toBe('committed'); expect((await http(prefix)).body.data).toEqual(committed.body.data);
    const preview = await http(prefix + '/preview'); expect(preview.body.status, preview.body.msg).toBe(200);
    expect(preview.body.data.url).toBe(committed.body.data.result.url); expect(preview.body.data.src).toContain(preview.body.data.url + '?expires=');
    expect(await assets()).toHaveLength(1);
    await f.db.update(systemRole).set({ rules: '' }).where(eq(systemRole.id, 1));
    expect((await http(prefix)).body.data).toEqual(committed.body.data);
    expect((await http(prefix + '/cancel', 'POST')).body.data).toEqual(committed.body.data);
    expect((await http(prefix + '/preview')).body.status).not.toBe(200);
    expect((await http(prefix + '/complete', 'POST')).body.status).not.toBe(200);
    expect((await http(prefix, 'GET', undefined, {}, 2)).body.status).not.toBe(200);
  });

  it('enforces bounded exact HTTP envelopes, raw part shape and action bodies before any R2 mutation', async () => {
    const id = crypto.randomUUID(), source = videoManifest(videoBytes(12), 12), prefix = 'video_uploads/' + id;
    for (const [path, method, body, mime] of [
      [prefix, 'POST', JSON.stringify({ ...source.manifest, owner: 7 }), 'application/json'],
      [prefix + '?owner=7', 'POST', JSON.stringify(source.manifest), 'application/json'],
      [prefix, 'POST', JSON.stringify(source.manifest).replace('{"filename":', '{"filename":"duplicate.mp4","filename":'), 'application/json'],
      [prefix, 'POST', 'x'.repeat(16385), 'application/json'],
    ]) expect((await http(path, method, body, { 'content-type': mime })).body.status).not.toBe(200);
    expect(await f.rows()).toHaveLength(0);
    expect((await http(prefix, 'POST', JSON.stringify(source.manifest), { 'content-type': 'application/json' })).body.status).toBe(200);
    for (const [path, body, mime, length] of [
      [prefix + '/parts/01', new Blob([source.chunks[0]]), 'application/octet-stream', '12'],
      [prefix + '/parts/1', new Blob([source.chunks[0]]), 'application/json', '12'],
      [prefix + '/parts/1', new Blob([source.chunks[0]]), 'application/octet-stream', '13'],
      [prefix + '/parts/1', new Blob([source.chunks[0]]), 'application/octet-stream', String(5 * 1024 * 1024 + 1)],
    ] as const) expect((await http(path, 'PUT', body, { 'content-type': mime, 'content-length': length })).body.status).not.toBe(200);
    for (const action of ['complete', 'cancel']) expect((await http(prefix + '/' + action, 'POST', '{}', { 'content-type': 'application/json' })).body.status).not.toBe(200);
    expect(f.bucket.put).not.toHaveBeenCalled(); expect(await assets()).toHaveLength(0);
  });

  it('accepts the actual PHP product editor omitted category as the literal undefined multipart field', async () => {
    const bytes = videoBytes(12), form = new FormData();
    for (const [key, value] of Object.entries({ chunkNumber: '1', chunkSize: '12', currentChunkSize: '12', filename: 'php-product.mp4', totalChunks: '1', md5: 'c'.repeat(32), pid: 'undefined' })) form.append(key, value);
    form.append('file', new File([bytes], 'blob', { type: 'application/octet-stream' }));
    const multipart = new Request('https://owned-video.local', { method: 'POST', body: form }), body = await multipart.arrayBuffer();
    for (let replay = 0; replay < 2; replay++) {
      const result = await http('video_upload', 'POST', body, { 'content-type': multipart.headers.get('content-type')!, 'content-length': String(body.byteLength) });
      expect(result.body.status, result.body.msg).toBe(200); expect(result.body.data).toMatchObject({ code: 2, canonical_url: '/api/assets/1' });
    }
    expect(await assets()).toHaveLength(1); expect((await assets())[0].pid).toBe(0);
    const source = videoManifest(bytes, 12);
    expect((await http('video_uploads/' + crypto.randomUUID(), 'POST', JSON.stringify({ ...source.manifest, pid: 'undefined' }), { 'content-type': 'application/json' })).body.status).not.toBe(200);
  });

  it('accepts the legacy multipart HTTP fields and deduplicates external metadata URLs longer than the old name column', async () => {
    const bytes = videoBytes(12), form = new FormData();
    for (const [key, value] of Object.entries({ chunkNumber: '1', chunkSize: '12', currentChunkSize: '12', filename: 'http.mp4', totalChunks: '1', md5: 'b'.repeat(32), pid: '20' })) form.append(key, value);
    form.append('file', new File([bytes], 'blob', { type: 'application/octet-stream' }));
    const multipart = new Request('https://owned-video.local', { method: 'POST', body: form }), body = await multipart.arrayBuffer();
    const result = await http('video_upload', 'POST', body, { 'content-type': multipart.headers.get('content-type')!, 'content-length': String(body.byteLength) });
    expect(result.body.status, result.body.msg).toBe(200); expect(result.body.data).toMatchObject({ code: 2, canonical_url: '/api/assets/1' });
    const urlBase = 'https://cdn.example.test/owned.mp4?token=', external = { path: urlBase + 'a'.repeat(180 - urlBase.length), pid: 20, upload_type: 1 };
    for (let replay = 0; replay < 2; replay++) {
      const registered = await http('video_attachment', 'POST', JSON.stringify(external), { 'content-type': 'application/json' });
      expect(registered.body.status, registered.body.msg).toBe(200); expect(registered.body.data).toBe(true);
    }
    const stored = await assets(); expect(stored).toHaveLength(2); expect(stored[1].attDir).toBe(external.path); expect(stored[1].name.length).toBeLessThanOrEqual(100);
    const type = await http('upload_type'); expect(type.body.data).toMatchObject({ upload_type: '1', storage_type: '8' });
    const duplicate = new FormData(); for (const [key, value] of form) duplicate.append(key, value); duplicate.append('pid', '20');
    const invalid = new Request('https://owned-video.local', { method: 'POST', body: duplicate }), invalidBody = await invalid.arrayBuffer();
    expect((await http('video_upload', 'POST', invalidBody, { 'content-type': invalid.headers.get('content-type')!, 'content-length': String(invalidBody.byteLength) })).body.status).not.toBe(200);
    expect(await assets()).toHaveLength(2);
  });
});
