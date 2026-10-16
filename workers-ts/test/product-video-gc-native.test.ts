import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import type { OrderMessage, ProductVideoGcMessage } from '@/env';
import { installProductVideoUpload } from '@/migrations/adminProductVideoUpload';
import { installProductVideoGc } from '@/migrations/productVideoGc';
import { installProductVideoGcAttachmentIndex } from '@/migrations/productVideoGcAttachmentIndex';
import { systemAdmin, systemAttachment, systemAttachmentCategory, systemRole } from '@/models/schema';
import { AdminProductVideoUploadService, isProductVideoCleanupMessage } from '@/services/admin/AdminProductVideoUploadService';
import { isSupplierVideoCleanupMessage } from '@/services/supplier/SupplierProductVideoUploadService';
import { ProductVideoGcService, isProductVideoGcMessage, productVideoGcRoot, productVideoGcWindow } from '@/services/system/ProductVideoGcService';
import { createToken, md5, verifyToken } from '@/utils/jwt';
import { productVideoFixture, videoBytes, videoManifest, OwnedFixedLengthStream } from './helpers/supplierProductVideoUpload';
import { withFinancePeers, outcome } from './helpers/financePeers';
import { ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './helpers/financePostgres';

type Scope = ProductVideoGcMessage['scope'];
const scopes: Scope[] = ['admin', 'supplier'];
const sourceTable = (scope: Scope) => sql.raw(scope === 'admin' ? 'public.admin_product_video_upload_v1' : 'public.supplier_product_video_upload_v1');
const cleanup = (scope: Scope, uploadId: string) => ({ action: scope === 'admin' ? 'cleanupProductVideoUpload' as const : 'cleanupSupplierVideoUpload' as const, uploadId });
const idAt = (n: number) => n.toString(16).padStart(8, '0') + '-0000-4000-8000-000000000001';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Owned GC barrier timed out')), 4000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('durable video GC dispatch on actual PG16 with explicit R2 and Queue stand-ins', () => {
  let f: Awaited<ReturnType<typeof productVideoFixture>>;
  let admin: { id: number; authVersion: string; expiresAt: number };
  let sent: OrderMessage[];
  let sendBatch: ReturnType<typeof vi.fn>;
  beforeAll(() => vi.stubGlobal('FixedLengthStream', OwnedFixedLengthStream));
  beforeEach(async () => {
    f = await productVideoFixture();
    await f.db.transaction(async tx => { await installProductVideoUpload(tx); await installProductVideoGc(tx); await installProductVideoGcAttachmentIndex(tx); });
    await f.db.insert(systemRole).values({ id: 11, roleName: 'Owned GC Admin', rules: 'attachment.manage', level: 1 });
    await f.db.insert(systemAdmin).values({ id: 11, account: 'owned-gc-admin', pwd: 'owned-gc-password', roles: '11', adminType: 1, relationId: 0, level: 1, status: 1 });
    await f.db.insert(systemAttachmentCategory).values({ id: 23, type: 1, relationId: 0, fileType: 2, name: 'Admin GC video' });
    const claims = await verifyToken((await createToken(11, 'admin', md5('owned-gc-password'), f.env.APP_KEY)).token, f.env.APP_KEY);
    if (!claims.auth) throw Error('Missing owned GC actual JWT'); admin = { id: 11, authVersion: claims.auth, expiresAt: claims.exp };
    sent = [];
    sendBatch = vi.fn(async (batch: Array<{ body: OrderMessage }>) => { sent.push(...batch.map(row => row.body)); });
    Object.assign(f.queue, { sendBatch });
    f.queue.send.mockImplementation(async body => { sent.push(body as OrderMessage); });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider network in owned GC tests'));
  }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  afterAll(() => vi.unstubAllGlobals());
  const gc = (db = f.db) => new ProductVideoGcService(createContainerFromDb(db), f.env);
  const state = async (scope: Scope) => (await f.db.execute(sql`SELECT scope,cursor::text,maximum::text,cycle,lease_token::text,lease_until,last_completed_at,updated_at
    FROM public.product_video_gc_state_v1 WHERE scope=${scope}`))[0];
  const prepare = async (scope: Scope) => {
    const bytes = videoBytes(12), id = crypto.randomUUID(), manifest = videoManifest(bytes, 12, scope === 'admin' ? 23 : 20).manifest;
    if (scope === 'admin') { const service = new AdminProductVideoUploadService(f.container, f.env); await service.initialize(id, manifest, admin); await service.putPart(id, 1, bytes, admin); }
    else { await f.serviceFor().initialize(id, manifest, f.actors[1]); await f.serviceFor().putPart(id, 1, bytes, f.actors[1]); }
    return { bytes, id };
  };
  const complete = (scope: Scope, id: string, db = f.db) => scope === 'admin'
    ? new AdminProductVideoUploadService(createContainerFromDb(db), f.env).complete(id, admin)
    : f.serviceFor(db).complete(id, f.actors[1]);
  const consume = async () => {
    const work = sent.splice(0);
    for (const message of work) {
      if (isProductVideoCleanupMessage(message)) await new AdminProductVideoUploadService(f.container, f.env).cleanup(message);
      else if (isSupplierVideoCleanupMessage(message)) await f.serviceFor().cleanup(message);
      else throw Error('Unexpected owned GC work');
    }
  };
  const seed = async (scope: Scope, id: string, mode: 'active' | 'expired' | 'cancelled' | 'tombstone' = 'expired') => {
    const [clock] = await f.db.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
    const created = Number(clock.now) - (mode === 'active' ? 1 : 43260), date = new Date(created * 1000);
    const key = `attachments/${scope}/${scope === 'admin' ? 1 : 7}/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${id}.mp4`;
    const intent = { version: 1, mode: 'manifest', filename: 'owned.mp4', total_size: 12, chunk_size: 12, total_chunks: 1,
      sha256: videoManifest(videoBytes(12), 12).manifest.sha256, pid: scope === 'admin' ? 23 : 20, client_md5: null };
    const fields = scope === 'supplier' ? sql`actor_id,supplier_id` : sql`actor_id`;
    const actor = scope === 'supplier' ? sql`1,7` : sql`11`;
    await f.db.execute(sql`INSERT INTO ${sourceTable(scope)} (upload_id,${fields},request_hash,intent,object_key,state,parts,confirmed,attachment_id,created_at,updated_at,expires_at)
      VALUES(${id}::uuid,${actor},${mode === 'tombstone' ? '' : 'a'.repeat(64)},${mode === 'tombstone' ? null : JSON.stringify(intent)}::jsonb,
        ${mode === 'tombstone' ? null : key},${mode === 'cancelled' || mode === 'tombstone' ? 'cancelled' : 'active'},'{}','[]',NULL,${created},${created},${created + 43200})`);
    return { key, part: `attachments/tmp/${scope}/${scope === 'admin' ? '11' : '7/1'}/${id}/1.part` };
  };

  it.each(scopes)('rebuilds %s cleanup solely from durable roots after every original and DLQ message is discarded', async scope => {
    const { id, bytes } = await prepare(scope); await complete(scope, id);
    const [asset] = await f.db.select().from(systemAttachment); expect(f.objects.get(asset.name)?.bytes).toEqual(bytes);
    await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, asset.attId));
    sent.length = 0; f.queue.send.mockClear(); // all pre/post/old DLQ messages are gone
    expect(await gc().dispatch(productVideoGcRoot(scope))).toEqual({ status: 'completed', examined: 1, enqueued: 1 });
    expect(sent).toEqual([cleanup(scope, id)]); await consume(); expect(f.objects.size).toBe(0);
    expect(await state(scope)).toMatchObject({ cursor: null, maximum: null, cycle: 1, lease_token: null, lease_until: 0 });
    expect(await gc().dispatch(productVideoGcRoot(scope))).toEqual({ status: 'throttled', examined: 0, enqueued: 0 });
  });

  it.each(scopes)('preserves the %s final key after unknown publication COMMIT and while any library owner still references it', async scope => {
    const source = await prepare(scope), lost = Error('Owned actual video COMMIT acknowledgement lost'); let discarded = false;
    const db = new Proxy(f.db, { get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return async (callback: Parameters<DbClient['transaction']>[0], options: Parameters<DbClient['transaction']>[1]) => {
        const result = await target.transaction(callback, options);
        if (!discarded && result && typeof result === 'object' && 'state' in result && result.state === 'committed') { discarded = true; throw lost; }
        return result;
      };
    } });
    await expect(complete(scope, source.id, db)).rejects.toBe(lost); expect(discarded).toBe(true);
    const [asset] = await f.db.select().from(systemAttachment);
    // Deliberately a different owner and MIME. All name references protect the key.
    await f.db.insert(systemAttachment).values({ name: asset.name, type: 4, relationId: 99, fileType: 1, attType: 'image/png' });
    await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, asset.attId)); sent.length = 0;
    await gc().dispatch(productVideoGcRoot(scope)); await consume();
    expect(f.objects.get(asset.name)?.bytes).toEqual(source.bytes);
    expect(f.bucket.delete.mock.calls.flatMap(([keys]) => typeof keys === 'string' ? [keys] : keys)).not.toContain(asset.name);
  });

  it.each(scopes)('cancels an actually expired %s root and collects only its durable owner-derived keys', async scope => {
    const id = idAt(1), keys = await seed(scope, id, 'expired');
    f.objects.set(keys.key, { bytes: videoBytes(12) }); f.objects.set(keys.part, { bytes: videoBytes(12) });
    const unrelated = `attachments/tmp/${scope}/unrelated/1.part`; f.objects.set(unrelated, { bytes: videoBytes(12) });
    await gc().dispatch(productVideoGcRoot(scope)); expect(sent).toEqual([cleanup(scope, id)]); await consume();
    expect((await f.db.execute(sql`SELECT state FROM ${sourceTable(scope)} WHERE upload_id=${id}::uuid`))[0].state).toBe('cancelled');
    expect([...f.objects.keys()]).toEqual([unrelated]);
  });

  it.each(scopes)('collects a very late %s provider composition when every pre-write/post-write/old cleanup message is lost', async scope => {
    const source = await prepare(scope), reached = deferred(), release = deferred();
    f.bucket.put.mockImplementationOnce(async (key, body, options) => {
      const bytes = body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(await new Response(body).arrayBuffer());
      reached.resolve(); await release.promise; return f.write(key, bytes, options);
    });
    await withFinancePeers(f.db, async ([latePeer, firstPeer]) => {
      const late = outcome(complete(scope, source.id, latePeer.db));
      try {
        await bounded(reached.promise); await complete(scope, source.id, firstPeer.db);
        const [asset] = await f.db.select().from(systemAttachment); await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, asset.attId));
        f.objects.clear(); sent.length = 0;
        f.queue.send.mockRejectedValue(Error('Owned post-write Queue outage'));
        release.resolve(); const result = await late; expect(result.ok).toBe(false);
        expect(f.objects.get(asset.name)?.bytes).toEqual(source.bytes); expect(await f.db.select().from(systemAttachment)).toHaveLength(0);
        sent.length = 0; f.queue.send.mockImplementation(async body => { sent.push(body as OrderMessage); });
        await gc().dispatch(productVideoGcRoot(scope)); expect(sent).toEqual([cleanup(scope, source.id)]);
        await consume(); expect(f.objects.size).toBe(0);
      } finally { release.resolve(); await late; }
    });
  }, 30000);

  it.each(scopes)('advances a bounded %s active prefix, resumes after losing its continuation, and freezes the high-water UUID', async scope => {
    for (let n = 1; n <= 165; n++) await seed(scope, idAt(n), n <= 80 ? 'active' : n % 3 === 0 ? 'tombstone' : n % 3 === 1 ? 'cancelled' : 'expired');
    expect(await gc().dispatch(productVideoGcRoot(scope))).toEqual({ status: 'advanced', examined: 80, enqueued: 0 });
    expect(sent).toEqual([productVideoGcRoot(scope)]); sent.length = 0; // continuation lost
    expect(await state(scope)).toMatchObject({ cursor: idAt(80), maximum: idAt(165), lease_token: null });
    await seed(scope, idAt(200), 'expired'); // new writes cannot extend this cycle
    expect(await gc().dispatch(productVideoGcRoot(scope))).toEqual({ status: 'advanced', examined: 80, enqueued: 80 });
    expect(sent.filter(row => !isProductVideoGcMessage(row))).toEqual(Array.from({ length: 80 }, (_, i) => cleanup(scope, idAt(i + 81))));
    sent.length = 0;
    expect(await gc().dispatch(productVideoGcRoot(scope))).toEqual({ status: 'completed', examined: 5, enqueued: 5 });
    expect(sent).toEqual(Array.from({ length: 5 }, (_, i) => cleanup(scope, idAt(i + 161))));
    expect(await state(scope)).toMatchObject({ cycle: 1, cursor: null, maximum: null });
  }, 30000);

  it.each(scopes)('collects a late %s part after cancellation even when every post-write cleanup send fails', async scope => {
    const bytes = videoBytes(12), id = crypto.randomUUID(), manifest = videoManifest(bytes, 12, scope === 'admin' ? 23 : 20).manifest;
    const adminService = new AdminProductVideoUploadService(f.container, f.env), supplierService = f.serviceFor();
    if (scope === 'admin') await adminService.initialize(id, manifest, admin); else await supplierService.initialize(id, manifest, f.actors[1]);
    const reached = deferred(), release = deferred();
    f.bucket.put.mockImplementationOnce(async (key, body, options) => { reached.resolve(); await release.promise; return f.write(key, body, options); });
    const late = outcome(scope === 'admin' ? adminService.putPart(id, 1, bytes, admin) : supplierService.putPart(id, 1, bytes, f.actors[1]));
    try {
      await bounded(reached.promise);
      if (scope === 'admin') await adminService.cancel(id, admin); else await supplierService.cancel(id, f.actors[1]);
      sent.length = 0; f.queue.send.mockRejectedValue(Error('Owned post-part Queue outage'));
    } finally { release.resolve(); }
    expect((await late).ok).toBe(false); expect(f.objects.size).toBe(1);
    f.queue.send.mockImplementation(async body => { sent.push(body as OrderMessage); }); sent.length = 0;
    await gc().dispatch(productVideoGcRoot(scope)); expect(sent).toEqual([cleanup(scope, id)]); await consume(); expect(f.objects.size).toBe(0);
  });

  it('restarts an old completed cycle from the beginning, including lower UUIDs and long-terminal rows', async () => {
    const scope = 'supplier'; await seed(scope, idAt(1), 'cancelled'); await seed(scope, idAt(100), 'expired');
    await f.exec("UPDATE public.product_video_gc_state_v1 SET lease_token='11111111-1111-4111-8111-111111111111',lease_until=floor(extract(epoch FROM clock_timestamp()))::int+120 WHERE scope='supplier'");
    await f.exec("UPDATE public.product_video_gc_state_v1 SET cycle=1,last_completed_at=floor(extract(epoch FROM clock_timestamp()))::int-301,lease_token=NULL,lease_until=0 WHERE scope='supplier'");
    expect(await gc().dispatch(productVideoGcRoot(scope))).toEqual({ status: 'completed', examined: 2, enqueued: 2 });
    expect(sent).toEqual([cleanup(scope, idAt(1)), cleanup(scope, idAt(100))]); expect((await state(scope)).cycle).toBe(2);
  });

  it('keeps the cursor after accepted-but-unconfirmed Queue delivery and repeats the same bounded page safely', async () => {
    const id = idAt(1); await seed('supplier', id); const lost = Error('Owned Queue accepted but acknowledgement lost');
    sendBatch.mockImplementationOnce(async (batch: Array<{ body: OrderMessage }>) => { sent.push(...batch.map(row => row.body)); throw lost; });
    await expect(gc().dispatch(productVideoGcRoot('supplier'))).rejects.toBe(lost);
    expect(await state('supplier')).toMatchObject({ cursor: null, maximum: id, cycle: 0, lease_token: null });
    expect(sent).toEqual([cleanup('supplier', id)]);
    await gc().dispatch(productVideoGcRoot('supplier')); expect(sent).toEqual([cleanup('supplier', id), cleanup('supplier', id)]);
  });

  it.each(['claim','bind','ack'] as const)('handles real %s COMMIT acknowledgement loss without advancing unaccepted work or rewinding accepted work', async phase => {
    await seed('supplier', idAt(1)); const lost = Error('Owned GC actual COMMIT acknowledgement lost');
    let count = 0, discarded = false; const ordinal = { claim: 1, bind: 3, ack: 4 }[phase];
    const db = new Proxy(f.db, { get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return async (callback: Parameters<DbClient['transaction']>[0], options: Parameters<DbClient['transaction']>[1]) => {
        const result = await target.transaction(callback, options); count++;
        if (count === ordinal) { discarded = true; throw lost; } return result;
      };
    } });
    await expect(gc(db).dispatch(productVideoGcRoot('supplier'))).rejects.toBe(lost); expect(discarded).toBe(true);
    if (phase === 'ack') {
      expect(await state('supplier')).toMatchObject({ cycle: 1, cursor: null, maximum: null, lease_token: null });
      expect(sent).toEqual([cleanup('supplier', idAt(1))]);
      expect((await gc().dispatch(productVideoGcRoot('supplier'))).status).toBe('throttled');
    } else {
      expect(sent).toEqual([]); expect(await state('supplier')).toMatchObject({ cursor: null, cycle: 0 });
      expect((await state('supplier')).lease_token).toMatch(/^[a-f0-9-]{36}$/);
      expect((await gc().dispatch(productVideoGcRoot('supplier'))).status).toBe('busy');
    }
  });

  it('lets only one independent database session hold a scope lease and holds no SQL lock over Queue I/O', async () => {
    await seed('supplier', idAt(1)); const reached = deferred(), release = deferred();
    sendBatch.mockImplementationOnce(async (batch: Array<{ body: OrderMessage }>) => { reached.resolve(); await release.promise; sent.push(...batch.map(row => row.body)); });
    await withFinancePeers(f.db, async ([first, second]) => {
      const pending = gc(first.db).dispatch(productVideoGcRoot('supplier'));
      try {
        await bounded(reached.promise);
        expect((await gc(second.db).dispatch(productVideoGcRoot('supplier'))).status).toBe('busy');
        await second.db.transaction(async tx => {
          await tx.execute(sql`LOCK TABLE ONLY public.product_video_gc_state_v1 IN ACCESS EXCLUSIVE MODE NOWAIT`);
          await tx.execute(sql`LOCK TABLE ONLY public.supplier_product_video_upload_v1 IN ACCESS EXCLUSIVE MODE NOWAIT`);
          await tx.execute(sql`LOCK TABLE ONLY public.system_attachment IN ACCESS EXCLUSIVE MODE NOWAIT`);
        });
      } finally { release.resolve(); await pending; }
      expect(sent).toEqual([cleanup('supplier', idAt(1))]);
    });
  });

  it('reclaims a genuinely expired lease using the database wall clock', async () => {
    await seed('supplier', idAt(1));
    await f.exec("UPDATE public.product_video_gc_state_v1 SET lease_token='11111111-1111-4111-8111-111111111111',lease_until=floor(extract(epoch FROM clock_timestamp()))::int+1 WHERE scope='supplier'");
    await f.exec('SELECT pg_sleep(1.1)');
    expect((await gc().dispatch(productVideoGcRoot('supplier'))).status).toBe('completed'); expect(sent).toEqual([cleanup('supplier', idAt(1))]);
  });

  it('refuses stale ACK after a replacement token and never releases the new lease', async () => {
    await seed('supplier', idAt(1)); const reached = deferred(), release = deferred();
    sendBatch.mockImplementationOnce(async (batch: Array<{ body: OrderMessage }>) => { reached.resolve(); await release.promise; sent.push(...batch.map(row => row.body)); });
    const pending = outcome(gc().dispatch(productVideoGcRoot('supplier')));
    try {
      await bounded(reached.promise);
      // Simulate a different authorized worker releasing its token, then claiming.
      await f.exec("UPDATE public.product_video_gc_state_v1 SET lease_token=NULL,lease_until=0 WHERE scope='supplier'");
      await f.exec("UPDATE public.product_video_gc_state_v1 SET lease_token='22222222-2222-4222-8222-222222222222',lease_until=floor(extract(epoch FROM clock_timestamp()))::int+120 WHERE scope='supplier'");
    } finally { release.resolve(); }
    expect((await pending).ok).toBe(false);
    expect(await state('supplier')).toMatchObject({ cursor: null, cycle: 0, lease_token: '22222222-2222-4222-8222-222222222222' });
  });

  it('fails closed on absent or drifted addons/indexes with zero Queue and R2 work, while keeping scopes independent', async () => {
    await seed('admin', idAt(1)); const original = Error('rollback owned GC drift');
    for (const change of ['DROP INDEX public.system_attachment_video_gc_name_idx',
      'ALTER INDEX public.system_attachment_video_gc_name_idx SET (fillfactor=70)',
      'ALTER TABLE public.product_video_gc_state_v1 DISABLE TRIGGER pvgc_rows',
      'GRANT SELECT ON public.product_video_gc_state_v1 TO PUBLIC',
      'ALTER TABLE public.admin_product_video_upload_v1 ADD COLUMN unreviewed integer']) {
      await expect(f.db.transaction(async tx => {
        await tx.execute(sql.raw(change));
        const db = { transaction: async (run: (t: DbClient) => Promise<unknown>) => run(tx as unknown as DbClient) } as unknown as DbClient;
        await expect(gc(db).dispatch(productVideoGcRoot('admin'))).rejects.toThrow();
        expect(sent).toEqual([]); expect(f.bucket.delete).not.toHaveBeenCalled(); throw original;
      })).rejects.toBe(original);
    }
    await f.exec('DROP TABLE public.supplier_product_video_upload_v1'); await f.exec('DROP FUNCTION public.supplier_product_video_upload_guard_v1()');
    expect((await gc().dispatch(productVideoGcRoot('admin'))).enqueued).toBe(1);
    sent.length = 0; await expect(gc().dispatch(productVideoGcRoot('supplier'))).rejects.toThrow(); expect(sent).toEqual([]);
  });

  it('uses the existing UUID primary key and nonunique attachment-name index with the genuine default planner', async () => {
    for (let n = 1; n <= 200; n++) await seed('supplier', idAt(n), 'active');
    // Moderate metadata fixture, no forced enable_seqscan setting or stress load.
    await f.exec("INSERT INTO public.system_attachment(name) SELECT 'owned-explain-'||n FROM generate_series(1,5000) n; ANALYZE public.system_attachment; ANALYZE public.supplier_product_video_upload_v1");
    const references = await f.db.execute(sql`EXPLAIN (FORMAT JSON) SELECT att_id FROM public.system_attachment WHERE name='owned-explain-4999' LIMIT 1`);
    const window = await f.db.execute(sql`EXPLAIN (FORMAT JSON) ${productVideoGcWindow('supplier', idAt(100), idAt(200))}`);
    expect(JSON.stringify(references)).toContain('system_attachment_video_gc_name_idx');
    expect(JSON.stringify(window)).toContain('spvu_pk'); expect(JSON.stringify(window)).not.toContain('Seq Scan'); expect(JSON.stringify(window)).not.toContain('Sort');
    console.log('PRODUCT_VIDEO_GC_NATIVE_EXPLAIN', JSON.stringify({ references, window }));
  });

  it('uses a repeatable-read read-only bounded discovery snapshot and preserves stricter caller deadlines', async () => {
    await seed('supplier', idAt(1)); const observations: Array<Record<string, unknown>> = [];
    const db = new Proxy(f.db, { get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return async (callback: Parameters<DbClient['transaction']>[0], options: Parameters<DbClient['transaction']>[1]) => target.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout='1700ms'; SET LOCAL lock_timeout='150ms'; SET LOCAL idle_in_transaction_session_timeout='2500ms'`);
        const result = await callback(tx);
        observations.push((await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS statement,
          current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`))[0]);
        return result;
      }, options);
    } });
    await gc(db).dispatch(productVideoGcRoot('supplier'));
    expect(observations).toHaveLength(4);
    expect(observations.map(row => row.isolation)).toEqual(['read committed','repeatable read','read committed','read committed']);
    expect(observations.map(row => row.readonly)).toEqual(['off','on','off','off']);
    expect(observations.every(row => row.statement === '1700ms' && row.lock === '150ms' && row.idle === '2500ms')).toBe(true);
    expect((await f.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly`))[0].readonly).toBe('off');
  });

  it('rejects a real competing GC table lock instead of acknowledging an empty successful page', async () => {
    await seed('supplier', idAt(1));
    await withFinancePeers(f.db, async ([blocker, worker]) => {
      await blocker.exec('BEGIN');
      try {
        await blocker.exec('LOCK TABLE ONLY public.product_video_gc_state_v1 IN ACCESS EXCLUSIVE MODE NOWAIT');
        await expect(gc(worker.db).dispatch(productVideoGcRoot('supplier'))).rejects.toMatchObject({ cause: { code: '55P03' } });
        expect(sent).toEqual([]); expect(f.bucket.delete).not.toHaveBeenCalled();
      } finally { await blocker.exec('ROLLBACK'); }
    });
    expect((await gc().dispatch(productVideoGcRoot('supplier'))).status).toBe('completed');
  });

  it('dispatches using a separate restricted LOGIN with only SELECT UPDATE on GC state and no schema ownership', async () => {
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
    const [origin] = await f.db.execute(sql`SELECT current_database() AS database,current_schema() AS schema`);
    if (!ownsFinanceFixtureTarget(String(origin.database), String(origin.schema), base.href)) throw Error('Unowned GC LOGIN target');
    const role = 'video_gc_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12), password = crypto.randomUUID();
    await f.exec(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    let client: ReturnType<typeof postgres> | undefined;
    try {
      await f.exec(`GRANT CONNECT ON DATABASE "${origin.database}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}";
        GRANT SELECT,UPDATE ON public.product_video_gc_state_v1 TO "${role}";
        GRANT SELECT,INSERT,UPDATE ON public.admin_product_video_upload_v1,public.supplier_product_video_upload_v1 TO "${role}";
        GRANT SELECT ON public.system_attachment TO "${role}"`);
      await seed('supplier', idAt(1)); const url = new URL(base); url.pathname = '/' + origin.database; url.username = role; url.password = password;
      client = postgres(url.href, { max: 1, prepare: false, connect_timeout: 5 });
      const db = drizzle(client) as unknown as DbClient;
      expect((await gc(db).dispatch(productVideoGcRoot('supplier'))).status).toBe('completed');
      expect(sent).toEqual([cleanup('supplier', idAt(1))]);
      await expect(db.execute(sql`DELETE FROM public.product_video_gc_state_v1`)).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(db.execute(sql`INSERT INTO public.product_video_gc_state_v1(scope,cycle,lease_until,last_completed_at,updated_at) VALUES('other',0,0,0,0)`)).rejects.toMatchObject({ cause: { code: '42501' } });
    } finally { await client?.end({ timeout: 1 }); await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`); }
  });
});
