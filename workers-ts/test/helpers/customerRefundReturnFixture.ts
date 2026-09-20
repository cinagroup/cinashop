import { customerRefundReadFixture } from './customerRefundReadFixture';
import { systemAttachment, expressCompany } from '../../src/models/schema';
import { refundExpress } from '../../src/controllers/api/v1/PayController';
import { logistics } from '../../src/controllers/api/v1/PublicController';
import { asset, userUploadImage } from '../../src/controllers/system/AttachmentController';
import type { PgTable } from 'drizzle-orm/pg-core';

/** Actual upload/signature/SQL controllers; only object storage is process-local and synthetic. */
export async function customerRefundReturnFixture(extraTables: PgTable[] = []) {
  const fixture = await customerRefundReadFixture([systemAttachment, expressCompany, ...extraTables]);
  const objects = new Map<string, { bytes: ArrayBuffer; mime: string }>();
  Object.assign(fixture.env, { APP_KEY: 'synthetic-local-refund-return-key-not-production', ASSETS_BUCKET: {
    async put(key: string, stream: ReadableStream<Uint8Array>, options: R2PutOptions) {
      const bytes = await new Response(stream).arrayBuffer();
      objects.set(key, { bytes, mime: (options.httpMetadata as R2HTTPMetadata)?.contentType ?? 'application/octet-stream' });
      return { size: bytes.byteLength };
    },
    async delete(key: string) { objects.delete(key); },
    async get(key: string) {
      const object = objects.get(key); if (!object) return null;
      return { body: new Response(object.bytes).body, size: object.bytes.byteLength, httpEtag: '"local-evidence"',
        writeHttpMetadata(headers: Headers) { headers.set('Content-Type', object.mime); } };
    },
  } });
  try {
    await fixture.db.insert(expressCompany).values([
      { id: 1, name: '本地快递甲', code: 'local-a', status: 1, sort: 2 },
      { id: 2, name: '本地快递乙', code: 'local-b', status: 1 },
      { id: 3, name: '停用快递', code: 'disabled', status: 0 },
      { id: 4, name: '隐藏快递', code: 'hidden', isShow: 0 },
    ]);
    fixture.app.post('/api/order/refund/express', refundExpress);
    fixture.app.get('/api/logistics', logistics);
    fixture.app.post('/api/upload/image', userUploadImage);
    fixture.app.get('/api/assets/:id', asset);
    return { ...fixture, objects };
  } catch (error) { await fixture.close(); throw error; }
}
