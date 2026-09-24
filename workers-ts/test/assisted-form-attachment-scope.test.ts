import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../src/env';
import { boundedMultipartImage } from '../src/controllers/system/AttachmentController';
import { isAttachmentObjectCleanupMessage, isDefiniteImageMetadataRejection } from '../src/services/system/AttachmentService';
import { assistedFormAttachmentScope, assistedFormAttachmentKey, belongsToAssistedFormScope,
  isAssistedFormAttachmentKey } from '../src/services/system/AssistedFormAttachmentScope';

const owner = { adminId: 17, uid: 11, touristUid: '', key: 'a'.repeat(32), systemFormId: 77 };

describe('assisted form image scope', () => {
  it.each(['42501','23505','22001','40001','40P01'])('allows compensation after definite SQL rejection %s',code=>{
    expect(isDefiniteImageMetadataRejection({cause:{code}})).toBe(true);
  });
  it.each(['40003','08006','57P01','57014','ECONNRESET','',undefined])('retains objects after uncertain completion %s',code=>{
    expect(isDefiniteImageMetadataRejection({cause:{code}})).toBe(false);
    expect(isDefiniteImageMetadataRejection({code:'08006',cause:{code:'42501'}})).toBe(false);
  });
  it('keeps deterministic full-length scope evidence without exposing buyer/guest identifiers in object keys', async () => {
    const scope = await assistedFormAttachmentScope(owner);
    expect(await assistedFormAttachmentScope({ ...owner })).toEqual(scope);
    expect(scope).toMatchObject({ type: 1, relationId: 17, moduleType: 5 });
    expect(scope.digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const first = assistedFormAttachmentKey(scope, 'webp'), second = assistedFormAttachmentKey(scope, 'webp');
    expect(first).not.toBe(second); expect(first.length).toBeLessThanOrEqual(100);
    expect(belongsToAssistedFormScope(first, scope)).toBe(true);
    expect(isAttachmentObjectCleanupMessage({ action: 'deleteAttachmentObjects', keys: [first] })).toBe(true);
  });

  it.each([
    { adminId: 18 }, { uid: 12 }, { key: 'b'.repeat(32) }, { systemFormId: 78 },
    { uid: 0, touristUid: 'guest_a' }, { uid: 0, touristUid: 'guest_b' },
  ])('rejects reuse when any ownership dimension changes: %j', async patch => {
    const scope = await assistedFormAttachmentScope(owner), other = await assistedFormAttachmentScope({ ...owner, ...patch });
    expect(other.digest).not.toBe(scope.digest);
    expect(belongsToAssistedFormScope(assistedFormAttachmentKey(other, 'png'), scope)).toBe(false);
  });

  it.each([
    { adminId: 0 }, { adminId: 2_147_483_648 }, { uid: -1 }, { uid: 0 }, { uid: 1.1 },
    { touristUid: 'guest' }, { uid: 0, touristUid: '../guest' }, { uid: 0, touristUid: 'x'.repeat(51) },
    { systemFormId: 0 }, { key: 'A'.repeat(32) }, { key: 'a'.repeat(33) },
  ])('fails closed on malformed scope: %j', async patch => {
    await expect(assistedFormAttachmentScope({ ...owner, ...patch })).rejects.toThrow('归属无效');
  });

  it('separates two guests and rejects malformed paths or namespaces', async () => {
    const a = await assistedFormAttachmentScope({ ...owner, uid: 0, touristUid: 'guest_a' });
    const b = await assistedFormAttachmentScope({ ...owner, uid: 0, touristUid: 'guest_b' });
    const key = assistedFormAttachmentKey(a, 'png');
    expect(belongsToAssistedFormScope(key, b)).toBe(false);
    for (const candidate of [key + '/extra', key.replace('.png', '.svg'), key.replace('/ao/', '/admin/'),
      key.replace(a.digest, '../'), key.replace(a.digest, 'a'.repeat(42))]) expect(isAssistedFormAttachmentKey(candidate)).toBe(false);
    expect(() => assistedFormAttachmentKey(a, '../png')).toThrow();
    expect(() => assistedFormAttachmentKey({ ...a, relationId: 0 }, 'png')).toThrow();
  });
});

describe('bounded single-image multipart parser', () => {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.onError((e, c) => c.json({ error: e.message }, 400));
  app.post('/upload', async c => { const { file } = await boundedMultipartImage(c); return c.json({ size: file.size }); });
  const file = () => new File([new Uint8Array([137,80,78,71,13,10,26,10])], 'local.png', { type: 'image/png' });
  async function upload(form: FormData) {
    const encoded = new Response(form), bytes = await encoded.arrayBuffer();
    return app.request('/upload', { method: 'POST', headers: { 'content-type': encoded.headers.get('content-type')!,
      'content-length': String(bytes.byteLength) }, body: bytes });
  }
  it('accepts the established file and filename aliases individually', async () => {
    for (const field of ['file', 'filename']) { const form = new FormData(); form.append(field, file());
      expect((await upload(form)).status).toBe(200); }
  });
  it.each([['file','file'], ['filename','filename'], ['file','filename']])('rejects hidden duplicate files %j', async (a,b) => {
    const form = new FormData(); form.append(a, file()); form.append(b, file());
    expect((await upload(form)).status).toBe(400);
  });
});
