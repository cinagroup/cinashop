import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeCombination, storeProduct, systemAttachment, systemStore, systemSupplier } from '@/models/schema';
import { AttachmentService, supplierAttachmentScope } from '@/services/system/AttachmentService';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { diyCommerceAuthorFixture } from './helpers/diyCommerceAuthorFixture';
import type { DiyStateRow as Row } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('missing owned public media SQL'); return wiring.container; },
}));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Exercise the actual route, middleware, controller, DAO, owner policy, HMAC
// and asset handler. All setup/uploads belong to a newly owned PG16 fixture.
describe.runIf(!!process.env.TEST_FINANCE_POSTGRES_URL)('public Commerce canonical product images on owned PostgreSQL16', () => {
  let f: Awaited<ReturnType<typeof diyCommerceAuthorFixture>>, directory = '';
  let attachment: typeof systemAttachment.$inferSelect;
  let supplierImage = '', foreignImage = '';
  const app = createApp(), evidence: Row[] = [];
  beforeAll(async () => {
    f = await diyCommerceAuthorFixture(); wiring.container = f.container;
    directory = await mkdtemp(join(tmpdir(), 'cinashop-public-product-media-native-'));
    [attachment] = await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, Number(f.platformImage.url.split('/').at(-1))));
    await f.db.insert(systemSupplier).values({ id: 84062, name: '媒体外属供应商', isShow: 1, isDel: 0 });
    await f.db.insert(systemStore).values({ id: 77, name: '商品图片兼容门店', isStore: 1, isShow: 1, isDel: 0 });
    const service = new AttachmentService(f.container, f.env);
    supplierImage = (await service.uploadImage(supplierAttachmentScope(84061), new File([f.png], 'owned-product.png', { type: 'image/png' }), 0)).url;
    foreignImage = (await service.uploadImage(supplierAttachmentScope(84062), new File([f.png], 'foreign-product.png', { type: 'image/png' }), 0)).url;
  }, 90_000);
  afterAll(async () => {
    try { if (f && directory) await writeFile(join(directory, 'execution.json'), JSON.stringify({ tables: f.tables, sequences: f.sequences, evidence }, null, 2) + '\n');
      process.stdout.write('PUBLIC_PRODUCT_MEDIA_NATIVE ' + JSON.stringify({ directory, checks: evidence.length }) + '\n');
    } finally { wiring.container = undefined; await f?.close(); }
  }, 30_000);
  beforeEach(async () => {
    await f.db.update(systemAttachment).set(attachment).where(eq(systemAttachment.attId, attachment.attId));
    await f.db.update(systemSupplier).set({ isShow: 1, isDel: 0 }).where(eq(systemSupplier.id, 84061));
    await f.db.update(storeCombination).set({ type: 0, relationId: 0, image: f.platformImage.url }).where(eq(storeCombination.id, 1801));
    await f.db.update(storeProduct).set({ type: 0, relationId: 0, image: f.platformImage.url, isVipProduct: 0 }).where(eq(storeProduct.id, 605));
  });
  async function get(path: string) {
    const before = await f.snapshot(), resources = f.resources(), waits: Promise<unknown>[] = [];
    const response = await app.fetch(new Request('https://owned-public-media.local' + path), f.env,
      { waitUntil: (value: Promise<unknown>) => waits.push(value), passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(waits);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const payload = response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(new TextDecoder().decode(bytes)) as Row : null;
    const after = await f.snapshot(); expect(after).toEqual(before); expect(f.resources()).toEqual(resources);
    evidence.push({ path, http_status: response.status, status: payload?.status, before: hash(before), after: hash(after), resources_unchanged: true,
      bytes: bytes.length, body_sha256: createHash('sha256').update(bytes).digest('hex') });
    return { response, payload, bytes };
  }
  function signed(value: string, reference: string) {
    const url = new URL(value, 'https://owned-public-media.local'), expires = Number(url.searchParams.get('expires'));
    expect(url.pathname).toBe(reference); expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'signature']);
    expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000)); expect(expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 900);
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256', f.env.APP_KEY).update('GET\n' + reference + '\n' + expires).digest('base64url'));
  }
  for (const family of ['combination', 'presale'] as const) describe(family, () => {
    const path = family === 'combination' ? '/api/combination/list?page=1&limit=50' : '/api/presale/list?time_type=0&page=1&limit=100';
    const id = family === 'combination' ? 1801 : 605;
    async function patch(value: { image?: string; type?: number; relationId?: number }) {
      if (family === 'combination') await f.db.update(storeCombination).set(value).where(eq(storeCombination.id, id));
      else await f.db.update(storeProduct).set(value).where(eq(storeProduct.id, id));
    }
    async function picture() {
      const result = await get(path); expect(result.payload?.status).toBe(200);
      const list: Row[] = family === 'combination' ? result.payload!.data : result.payload!.data.list;
      const row = list.find(item => item.id === id); expect(row).toBeDefined(); return row!.image as string;
    }
    it('turns canonical registered platform IDs into readable response tickets and leaves storage canonical', async () => {
      const image = await picture(); signed(image, f.platformImage.url);
      const result = await get(image); expect(result.response.status).toBe(200); expect(result.response.headers.get('Content-Type')).toContain('image/png');
      expect([...result.bytes]).toEqual([...f.png]);
      const naked = await get(f.platformImage.url); expect(naked.response.status).toBe(404);
    });
    it('refreshes expired entity-encoded tickets without persisting the refreshed signature', async () => {
      const stale = f.platformImage.url + '?expires=1&amp;signature=old'; await patch({ image: stale });
      const before = await f.snapshot(); signed(await picture(), f.platformImage.url); expect(await f.snapshot()).toEqual(before);
    });
    it('uses persisted supplier ownership, permits shared platform assets and rejects foreign or inactive ownership', async () => {
      await patch({ type: 2, relationId: 84061, image: supplierImage }); signed(await picture(), supplierImage);
      await patch({ image: f.platformImage.url }); signed(await picture(), f.platformImage.url);
      await patch({ image: foreignImage }); expect(await picture()).toBe('');
      await patch({ image: supplierImage }); await f.db.update(systemSupplier).set({ isShow: 0 }).where(eq(systemSupplier.id, 84061)); expect(await picture()).toBe('');
      await patch({ type: 0, relationId: 0, image: supplierImage }); expect(await picture()).toBe('');
    });
    it('matches store SKU views by retaining platform and legacy media without granting supplier or user attachments', async () => {
      await patch({ type: 1, relationId: 77, image: f.platformImage.url }); signed(await picture(), f.platformImage.url);
      for (const image of ['/static/logo.png', 'https://example.invalid/store.png']) { await patch({ image }); expect(await picture()).toBe(image); }
      for (const image of [supplierImage, foreignImage, f.image.url]) { await patch({ image }); expect(await picture()).toBe(''); }
      await patch({ relationId: -1, image: f.platformImage.url }); expect(await picture()).toBe('');
    });
    it('never signs user, absent, malformed or executable references', async () => {
      for (const image of [f.image.url, '/api/assets/2147483647', '/api/assets/0', '/api/assets/02', '/api/assets/2147483648',
        '//example.invalid/private.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '/images\\private.png', '/images/white space.png',
        'https://user:secret@example.invalid/image.png']) {
        await patch({ image }); expect(await picture(), image).toBe('');
      }
    });
    it('rejects contradictory attachment namespace, module, object key and raster metadata', async () => {
      for (const value of [{ type: 3, relationId: 11, moduleType: 3 }, { moduleType: 2 }, { fileType: 2 }, { imageType: 0 },
        { attDir: '/api/assets/999' }, { name: 'attachments/admin/0/wrong-owner.png' }, { name: 'attachments/admin/1/../private.png' },
        { name: 'attachments/admin/1/file.svg', attType: 'image/svg+xml' }, { attType: 'application/pdf' }]) {
        await f.db.update(systemAttachment).set({ ...attachment, ...value }).where(eq(systemAttachment.attId, attachment.attId));
        expect(await picture(), JSON.stringify(value)).toBe('');
      }
    });
    it('retains the full256-character persisted image contract', async () => {
      const image = 'https://example.invalid/' + 'x'.repeat(256 - 'https://example.invalid/'.length);
      expect(image).toHaveLength(256); await patch({ image }); expect(await picture()).toBe(image);
    });
    it('retains HTTPS and static legacy images without fetching them on the server', async () => {
      const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('list must not fetch external images'));
      try { for (const image of ['https://example.invalid/image.png', '/static/logo.png']) { await patch({ image }); expect(await picture()).toBe(image); }
        expect(network).not.toHaveBeenCalled();
      } finally { network.mockRestore(); }
    });
  });
  it('atomically rejects a policy input above its complete-reference budget before querying or signing', async () => {
    const select = vi.spyOn(f.db, 'select');
    try { await expect(publicProductPictures(f.db, Array.from({ length: 10001 }, () => ({ image: f.platformImage.url, type: 0, relationId: 0 })))).rejects.toThrow('完整预览容量');
      expect(select).not.toHaveBeenCalled();
      // The schema itself rejects >256 stored characters; exercise the policy
      // boundary directly instead of widening a production column in a test.
      await expect(publicProductPictures(f.db, [{ image: 'https://example.invalid/' + 'x'.repeat(255), type: 0, relationId: 0 }])).resolves.toEqual(['']);
      expect(select).not.toHaveBeenCalled();
    } finally { select.mockRestore(); }
  });
});
