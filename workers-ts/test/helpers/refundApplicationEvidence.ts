import { userUploadRateFixture } from "./userUploadRateFixture";
import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { createContainerFromDb } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrderRefund, systemAdmin, systemAttachment, systemRole, systemSupplier, user } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { supplierRefundApplicationReviewFixture } from './supplierRefundApplicationReview';
import { refundRuntimeFixture } from './refundRuntimeFixture';
import { ownsFinanceFixtureEndpoint, validateFinanceFixtureUrl } from './financePostgres';
import { ownsSequenceRunnerEndpoint } from './kefuSequenceRunnerDatabase';

export const evidencePng = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

/** Real byte storage for the owned R2 boundary; never external storage. */
export function refundEvidenceR2() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const r2Reads: string[] = [], r2Writes: string[] = [], r2Deletes: string[] = [];
  const object = (key: string, value: { bytes: Uint8Array; contentType: string }) => ({
    key, size: value.bytes.length, etag: 'owned-evidence', httpEtag: '"owned-evidence"',
    httpMetadata: { contentType: value.contentType }, body: value.bytes.slice(),
    writeHttpMetadata: (headers: Headers) => { headers.set('Content-Type', value.contentType); },
  });
  const bucket = {
    put: async (key: string, value: BodyInit, options?: { httpMetadata?: { contentType?: string } }) => {
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      if (bytes.length > 10 * 1024 * 1024) throw Error('Owned evidence R2 byte budget exceeded');
      const entry = { bytes, contentType: options?.httpMetadata?.contentType ?? 'image/png' };
      objects.set(key, entry); r2Writes.push(key); return object(key, entry);
    },
    get: async (key: string) => { r2Reads.push(key); const value = objects.get(key); return value ? object(key, value) : null; },
    head: async (key: string) => { const value = objects.get(key); return value ? object(key, value) : null; },
    delete: async (key: string) => { objects.delete(key); r2Deletes.push(key); },
  } as unknown as R2Bucket;
  return { bucket, objects, r2Reads, r2Writes, r2Deletes, png: evidencePng };
}

export async function refundEvidenceSnapshot(db: DbClient) {
  const result: Record<string, unknown> = {};
  for (const row of await db.execute<{ tablename: string }>(sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)) {
    if (!/^[a-z][a-z0-9_]*$/.test(row.tablename)) throw Error('Unowned evidence table');
    result[row.tablename] = await db.execute(sql.raw(`SELECT to_jsonb(t) AS row FROM public."${row.tablename}" t ORDER BY to_jsonb(t)::text`));
  }
  return result;
}
export async function refundEvidenceSequences(db: DbClient) {
  const result = [];
  for (const row of await db.execute<{ sequencename: string }>(sql`SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`)) {
    if (!/^[a-z][a-z0-9_]*$/.test(row.sequencename)) throw Error('Unowned evidence sequence');
    result.push({ name: row.sequencename, ...((await db.execute(sql.raw(`SELECT last_value,is_called FROM public."${row.sequencename}"`)))[0]) });
  }
  return result;
}
async function requireOwnedEvidenceDatabase(db: DbClient) {
  const target = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  const [identity] = await db.execute<{ database: string; namespace: string; role: string; host: string; port: number; version: number }>(sql`SELECT
    current_database() AS database,current_schema() AS namespace,current_user AS role,
    host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('server_version_num')::integer AS version`);
  if (!identity || identity.namespace !== 'public' || identity.role !== 'finance_test' || Math.floor(identity.version / 10000) !== 16
    || !(ownsFinanceFixtureEndpoint(identity.database, identity.namespace, target.href, identity.host, identity.port)
      || ownsSequenceRunnerEndpoint(identity.database, identity.namespace, target.href, identity.host, identity.port)))
    throw Error('Evidence fixture requires its exact owned public PG16 endpoint');
}

/** Synthetic historical display rows. Actual upload/apply authors are separately
 * exercised through refundApplicationEvidenceWriterFixture and real App/JWT. */
export async function refundApplicationEvidenceFixture() {
  const f = await supplierRefundApplicationReviewFixture();
  try {
    await requireOwnedEvidenceDatabase(f.db);
    const r2 = refundEvidenceR2();
    r2.objects.set(f.images.ownedKey, { bytes: evidencePng, contentType: 'image/png' });
    const returnedKey = 'attachments/owned-application-return.png';
    r2.objects.set(returnedKey, { bytes: evidencePng, contentType: 'image/png' });
    await f.db.insert(systemAttachment).values({ attId: 33, type: 3, moduleType: 3, relationId: 11, fileType: 1, imageType: 8,
      name: returnedKey, attDir: '/api/assets/33', sattDir: '/api/assets/33', attType: 'image/png' });
    for (const id of [100, 201, 111]) await f.db.update(storeOrderRefund).set({ refundImg: '["/api/assets/31"]' }).where(eq(storeOrderRefund.id, id));
    await f.db.update(storeOrderRefund).set({ refundImg: '[broken' }).where(eq(storeOrderRefund.id, 202));
    await f.db.update(storeOrderRefund).set({ refundImg: '[]' }).where(eq(storeOrderRefund.id, 301));
    await f.db.update(storeOrderRefund).set({ refundGoodsImg: '["/api/assets/33"]' }).where(eq(storeOrderRefund.id, 100));
    Object.assign(f.env, { ASSETS_BUCKET: r2.bucket });
    return { ...f, ...r2, env: f.env,
      images: { ...f.images, request: 31, requestPath: '/api/assets/31', returned: 33, returnedPath: '/api/assets/33', returnedKey },
      expectedEvidence: new Map([[100, ['/api/assets/31']], [201, ['/api/assets/31']], [111, ['/api/assets/31']], [301, []]]),
      evidenceUnavailable: [202] };
  } catch (error) { await f.close(); throw error; }
}

/** Registered checkout/allocation with explicitly synthetic payment admission.
 * Customer SQL is owned maintenance. Supplier SQL is independent SELECT-only
 * LOGIN; no production authority or payment-provider acceptance is asserted. */
export async function refundApplicationEvidenceWriterFixture() {
  const f = await refundRuntimeFixture();
  try {
    await requireOwnedEvidenceDatabase(f.db);
    const r2 = refundEvidenceR2(), key = 'owned-refund-application-evidence-key', password = 'owned-refund-evidence-account';
    await f.db.insert(systemRole).values({ id: 990, type: 4, relationId: 7, rules: 'supplier.refund.view' });
    await f.db.insert(systemAdmin).values({ id: 990, account: 'owned-refund-evidence-viewer', pwd: password, adminType: 4, relationId: 7, roles: '990' });
    await f.db.update(systemSupplier).set({ adminId: 990 }).where(eq(systemSupplier.id, 7));
    await f.db.update(user).set({ pwd: password }).where(eq(user.uid, 11));
    const source = await f.withRuntime(writer => writer.createPaid({ key: 'evidence-checkout', orderId: 'evidence_checkout' }));
    // Generated deployment bindings fix NODE_ENV to production. This isolated
    // fixture deliberately uses test mode; assert only that test-only binding.
    const env: Env = { ...f.env, TOKEN_BUCKET: userUploadRateFixture(), APP_KEY: key, NODE_ENV: 'test' as Env['NODE_ENV'], ASSETS_BUCKET: r2.bucket };
    const tokens = { buyer: (await createToken(11, 'api', md5(password), key)).token,
      viewer: (await createToken(990, 'supplier', md5(password), key)).token };
    const withBuyer = async <T>(work: (peer: { db: DbClient; container: ReturnType<typeof createContainerFromDb>; exec: typeof f.exec; sqlBoundary: 'maintenance' }) => Promise<T>) =>
      work({ db: f.db, container: createContainerFromDb(f.db), exec: f.exec, sqlBoundary: 'maintenance' });
    const withReader = async <T>(work: (peer: { db: DbClient; container: ReturnType<typeof createContainerFromDb>; role: string; exec: (query: string) => Promise<unknown> }) => Promise<T>) => {
      await requireOwnedEvidenceDatabase(f.db);
      return f.withRuntimeRole!(async peer => {
        await f.exec(`GRANT SELECT ON public.system_admin,public.system_role,public.system_supplier,public.system_menus,public.system_config,public.system_attachment,public.store_order,public.store_order_cart_info,public.store_order_refund,public.store_order_refund_payment,public.store_order_refund_split TO "${peer.role}"`);
        return work({ ...peer, container: createContainerFromDb(peer.db) });
      });
    };
    return { ...f, ...r2, env, tokens, withBuyer, withReader, ids: { sourceOrder: source.id, publicOrderId: source.orderId, buyer: 11, supplier: 7, viewer: 990 },
      source, snapshot: () => refundEvidenceSnapshot(f.db), sequences: () => refundEvidenceSequences(f.db) };
  } catch (error) { await f.close(); throw error; }
}
