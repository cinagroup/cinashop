import { createHash } from 'node:crypto';
import { detectMp4Type } from './AttachmentService';
import { HttpApiException, ValidateException } from '@/utils/errors';

export interface ProductVideoComposition {
  destination: string;
  parts: Array<{ key: string; size: number; sha256: string }>;
}
const conflict = (message: string) => new HttpApiException(message, 409, 409);
/** Storage-only stage of the durable upload. The caller owns SQL admission;
 * each bounded source is verified again before entering the native fixed stream. */
export async function composeProductVideo(bucket: R2Bucket, plan: ProductVideoComposition): Promise<R2Object> {
  const match = /^attachments\/admin\/1\/\d{4}\/\d{2}\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.mp4$/.exec(plan.destination);
  if (!match || !Array.isArray(plan.parts) || plan.parts.length < 1 || plan.parts.length > 100) throw new ValidateException('视频合并上下文无效');
  let owner = '', total = 0;
  for (const [index, part] of plan.parts.entries()) {
    const source = /^attachments\/tmp\/admin\/([1-9]\d*)\/([a-f0-9-]{36})\/([1-9]\d*)\.part$/.exec(part.key);
    if (!source || Number(source[1]) > 2147483647 || source[2] !== match[1] || Number(source[3]) !== index + 1
      || owner && source[1] !== owner || !Number.isSafeInteger(part.size) || part.size < (index === 0 ? 12 : 1)
      || part.size > 5 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(part.sha256)) throw new ValidateException('视频分片合并上下文无效');
    owner = source[1]; total += part.size;
  }
  if (total > 100 * 1024 * 1024) throw new ValidateException('视频不能超过100 MiB');
  const fixed = new FixedLengthStream(total), writer = fixed.writable.getWriter();
  const putting = bucket.put(plan.destination, fixed.readable, { httpMetadata: {
    contentType: 'video/mp4', contentDisposition: 'inline', cacheControl: 'private, no-store' }, customMetadata: { uploadId: match[1] } });
  void putting.catch(() => undefined);
  try {
    for (const [index, part] of plan.parts.entries()) {
      const source = await bucket.get(part.key);
      if (!source || source.size !== part.size) throw conflict('视频分片缺失，请重传原分片');
      const reader = source.body.getReader(), bytes = new Uint8Array(part.size); let offset = 0;
      try {
        for (;;) { const item = await reader.read(); if (item.done) break;
          if (offset + item.value.byteLength > bytes.length) { await reader.cancel(); throw conflict('视频分片大小已变化'); }
          bytes.set(item.value, offset); offset += item.value.byteLength;
        }
      } finally { reader.releaseLock(); }
      if (offset !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== part.sha256
        || index === 0 && !detectMp4Type(bytes)) throw conflict('视频分片内容已变化，请重新选择原文件');
      await Promise.race([writer.write(bytes), putting.then(() => { throw conflict('视频合并流提前结束'); })]);
    }
    await writer.close(); const stored = await putting;
    if (!stored || stored.size !== total) throw conflict('视频合并结果未确认，请查询原结果');
    return stored;
  } catch (error) {
    // An early provider rejection can leave an unconsumed write. Neither
    // cancellation is awaited, so it cannot hold HTTP recovery indefinitely.
    void fixed.readable.cancel(error).catch(() => undefined);
    void writer.abort(error).catch(() => undefined);
    throw error;
  }
}
