import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminProductVideoUploadService, PRODUCT_VIDEO_CHUNK_BYTES, productVideoUploadId } from '@/services/admin/AdminProductVideoUploadService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import { boundedMultipartVideoChunk } from './AttachmentController';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('视频上传不接受查询参数');
  return { service: new AdminProductVideoUploadService(c.get('container'), c.env), actor: {
    id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}
async function empty(c: C) { if (await readBoundedUtf8Text(c.req.raw, 1024) !== '') throw new ValidateException('视频操作不接受正文'); }
export async function initialize(c: C) {
  const { service, actor } = context(c), id = productVideoUploadId(c.req.param('uploadId'));
  const manifest = parseLevelActivationJson(await readBoundedUtf8Text(c.req.raw, 16 * 1024));
  return jsonOk(c, await service.initialize(id, manifest, actor));
}
export async function query(c: C) { const { service, actor } = context(c); return jsonOk(c, await service.query(c.req.param('uploadId'), actor)); }
export async function cancel(c: C) { const { service, actor } = context(c); await empty(c); return jsonOk(c, await service.cancel(c.req.param('uploadId'), actor)); }
export async function complete(c: C) { const { service, actor } = context(c); await empty(c); return jsonOk(c, await service.complete(c.req.param('uploadId'), actor)); }
export async function preview(c: C) { const { service, actor } = context(c); return jsonOk(c, await service.preview(c.req.param('uploadId'), actor)); }
export async function part(c: C) {
  const { service, actor } = context(c), id = productVideoUploadId(c.req.param('uploadId')), rawIndex = c.req.param('part') ?? '';
  if (!/^[1-9]\d{0,2}$/.test(rawIndex) || Number(rawIndex) > 100) throw new ValidateException('视频分片序号无效');
  await service.authorizeChunk(id, actor);
  const mime = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!['application/octet-stream', 'video/mp4'].includes(mime)) throw new ValidateException('视频分片须为原始二进制正文');
  const declared = c.req.header('content-length');
  if (declared !== undefined && (!/^[1-9]\d*$/.test(declared) || Number(declared) > PRODUCT_VIDEO_CHUNK_BYTES)) throw new ValidateException('视频分片不能超过5 MiB');
  const reader = c.req.raw.body?.getReader(); if (!reader) throw new ValidateException('视频分片不能为空');
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.byteLength;
    if (length > PRODUCT_VIDEO_CHUNK_BYTES) { await reader.cancel(); throw new ValidateException('视频分片不能超过5 MiB'); } chunks.push(item.value); }
  if (!length || declared !== undefined && length !== Number(declared)) throw new ValidateException('视频分片长度未能确认');
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return jsonOk(c, await service.putPart(id, Number(rawIndex), bytes, actor));
}
export async function legacyUpload(c: C) {
  const { service, actor } = context(c);
  // Middleware checks attachment.manage before multipart buffering; the service
  // repeats the live SQL authority before every reservation/publication.
  return jsonOk(c, await service.legacyUpload(await boundedMultipartVideoChunk(c, true), actor));
}
export async function registerExternal(c: C) {
  const { service, actor } = context(c), body = parseLevelActivationJson(await readBoundedUtf8Text(c.req.raw, 4096));
  return jsonOk(c, await service.registerExternal(body, actor));
}
