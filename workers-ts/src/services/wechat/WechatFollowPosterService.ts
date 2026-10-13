import { and, desc, eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container } from '@/lib/di';
import { systemAttachment, systemConfig } from '@/models/schema';
import { themeDeadlines } from '@/services/content/ThemeReadService';
import { parseCanonicalAttachmentId, R2_IMAGE_TYPE } from '@/services/system/AttachmentService';
import { normalizeConfigScalar } from '@/utils/config';
import { NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { FOLLOW_BACKGROUND_BASE64, FOLLOW_BACKGROUND_SHA256 } from './WechatFollowBackground';

const BYTE_LIMIT = 3 * 1024 * 1024, DEADLINE_MS = 8000, IMAGE_TTL = 900;
const encoder = new TextEncoder();
const unavailable = () => new ServiceUnavailableException('关注海报图片服务暂时不可用');
type Source = { identity: string; kind: 'r2'; key: string; mime: string } | { identity: string; kind: 'https'; url: string };
const mimeForExtension = (path: string) => {
  const extension = /\.(jpe?g|png|gif|webp)$/i.exec(path)?.[1]?.toLowerCase();
  return extension ? `image/${extension === 'jpg' ? 'jpeg' : extension}` : '';
};
const rasterMime = (value: string) => value.split(';')[0].trim().toLowerCase().replace(/^image\/jpg$/, 'image/jpeg');
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', bytes));
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });

/** An operator pin authorizes exactly an HTTPS origin, never a redirect target. */
function pinnedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/'
      || url.port && url.port !== '443' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(url.hostname)
      || /^[\d.]+$/.test(url.hostname) || /\.(?:local|internal|localhost|test|invalid)$/i.test(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}

export function followImportedImageUrl(reference: string, env: Pick<Env, 'PUBLIC_H5_ORIGIN' | 'WECHAT_FOLLOW_IMAGE_ORIGINS'>): string {
  const pins = (env.WECHAT_FOLLOW_IMAGE_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (pins.length > 20 || pins.some(value => !pinnedOrigin(value))) throw unavailable();
  const explicit = new Set(pins.map(value => pinnedOrigin(value)!));
  const h5 = env.PUBLIC_H5_ORIGIN ? pinnedOrigin(env.PUBLIC_H5_ORIGIN) : null;
  if (h5) pins.push(h5);
  if (reference.length > 2048 || /[\\\u0000-\u0020\u007f]/u.test(reference) || /%(?:2f|5c|2e|00)/i.test(reference)) throw new ValidateException('关注二维码图片地址无效');
  let url: URL;
  try { url = new URL(reference.startsWith('uploads/') ? `/${reference}` : reference, h5 ?? undefined); }
  catch { throw new ValidateException('关注二维码图片地址无效'); }
  if (url.username || url.password || url.hash || (!explicit.has(url.origin) && url.origin !== h5) || !pinnedOrigin(url.origin)) throw new ValidateException('关注二维码图片域名未配置');
  // The public storefront contributes only its legacy uploads directory. An
  // explicit media-origin pin can also serve a bucket/CDN raster object path.
  const rasterPath = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:jpe?g|png|gif|webp)$/i;
  if (!rasterPath.test(url.pathname) || !explicit.has(url.origin) && !url.pathname.startsWith('/uploads/')
    || url.pathname.split('/').some(part => part === '.' || part === '..') || url.search) throw new ValidateException('关注二维码图片地址无效');
  return url.href;
}

export function followRasterMatches(bytes: Uint8Array, mime: string): boolean {
  if (mime === 'image/png') return bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  if (mime === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/gif') return bytes.length >= 10 && /^GIF8[79]a$/.test(new TextDecoder().decode(bytes.subarray(0, 6)));
  return mime === 'image/webp' && bytes.length >= 16 && new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP';
}

/** One deadline covers provider admission, headers and every streamed byte. */
async function deadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, DEADLINE_MS); });
  try { return await Promise.race([work(controller.signal), timeout]); }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}

async function readBytes(body: ReadableStream<Uint8Array> | null, length: number, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) { if (body) await body.cancel().catch(() => {}); throw unavailable(); }
  if (!body || !Number.isFinite(length) || length < 0 || length > BYTE_LIMIT) {
    if (body) await body.cancel().catch(() => {});
    throw new ValidateException('关注二维码图片超过读取容量');
  }
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw unavailable();
      const next = await reader.read();
      if (signal.aborted) throw unavailable();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > BYTE_LIMIT) { await reader.cancel().catch(() => {}); throw new ValidateException('关注二维码图片超过读取容量'); }
      chunks.push(next.value);
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  if (!size) throw new ValidateException('关注二维码图片为空');
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export class WechatFollowPosterService {
  constructor(private readonly container: Container, private readonly env: Env, private readonly fetcher: typeof fetch = fetch, private readonly now = () => Math.floor(Date.now() / 1000)) {}

  private async source(): Promise<Source> {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await themeDeadlines(tx);
      const rows = await tx.select({ id: systemConfig.id, value: sql<string>`left(${systemConfig.value},2049)` }).from(systemConfig)
        .where(and(eq(systemConfig.isStore, 0), eq(systemConfig.menuName, 'wechat_qrcode')))
        .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(1001);
      if (rows.length > 1000 || (rows[0]?.value.length ?? 0) > 2048) throw new ValidateException('关注二维码配置超过完整读取容量');
      const reference = normalizeConfigScalar(rows[0]?.value);
      if (!reference) throw new ValidateException('请上传二维码');
      const id = parseCanonicalAttachmentId(reference);
      const identity = `${rows[0].id}:${reference}`;
      if (id === null) return { kind: 'https', url: followImportedImageUrl(reference, this.env), identity };
      const [asset] = await tx.select().from(systemAttachment).where(and(eq(systemAttachment.attId, id), eq(systemAttachment.type, 1),
        eq(systemAttachment.relationId, 0), eq(systemAttachment.moduleType, 1), eq(systemAttachment.fileType, 1), eq(systemAttachment.imageType, R2_IMAGE_TYPE))).limit(1);
      const expected = asset ? mimeForExtension(asset.name) : '';
      if (!asset || asset.attDir !== `/api/assets/${id}` || !/^attachments\/admin\/1\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(asset.name)
        || asset.name.split('/').some(part => part === '.' || part === '..') || !expected || asset.attType.trim() && rasterMime(asset.attType) !== expected) throw new ValidateException('关注二维码附件无效');
      return { kind: 'r2', key: asset.name, mime: expected, identity: `${identity}:${asset.name}:${asset.attType.trim()}:${asset.time}` };
    });
  }

  private async load(source: Source): Promise<Uint8Array> {
    const bytes = await deadline(async signal => {
      if (source.kind === 'r2') {
        const object = await this.env.ASSETS_BUCKET.get(source.key);
        if (signal.aborted) { await object?.body.cancel().catch(() => {}); throw unavailable(); }
        if (!object) throw new ValidateException('关注二维码图片不存在');
        const actual = object.httpMetadata?.contentType ? rasterMime(object.httpMetadata.contentType) : source.mime;
        if (actual !== source.mime) { await object.body.cancel().catch(() => {}); throw new ValidateException('关注二维码图片格式无效'); }
        return { bytes: await readBytes(object.body, object.size, signal), mime: actual };
      }
      const response = await this.fetcher(source.url, { signal, redirect: 'error', headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' } });
      if (signal.aborted || !response.ok || response.redirected) { await response.body?.cancel().catch(() => {}); throw unavailable(); }
      const mime = rasterMime(response.headers.get('Content-Type') ?? '');
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) { await response.body?.cancel().catch(() => {}); throw new ValidateException('关注二维码图片格式无效'); }
      return { bytes: await readBytes(response.body, Number(response.headers.get('Content-Length') ?? 0), signal), mime };
    }).catch(error => { if (error instanceof ValidateException || error instanceof ServiceUnavailableException) throw error; throw unavailable(); });
    if (!followRasterMatches(bytes.bytes, bytes.mime)) throw new ValidateException('关注二维码图片格式无效');
    return bytes.bytes;
  }

  private async revision(source: Source, bytes: Uint8Array) {
    return digest(encoder.encode(`wechat-follow-v1\n${FOLLOW_BACKGROUND_SHA256}\n${source.identity}\n${await digest(bytes)}`));
  }

  private async signature(revision: string, expires: number) {
    if (!this.env.APP_KEY) throw unavailable();
    const key = await crypto.subtle.importKey('raw', encoder.encode(this.env.APP_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`wechat-follow-v1\n${revision}\n${expires}`)));
  }

  private async verifySignature(revision: string, expires: number, signature: string): Promise<boolean> {
    if (!this.env.APP_KEY) throw unavailable();
    const key = await crypto.subtle.importKey('raw', encoder.encode(this.env.APP_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const bytes = Uint8Array.from(signature.match(/../g) ?? [], part => Number.parseInt(part, 16));
    return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(`wechat-follow-v1\n${revision}\n${expires}`));
  }

  private async render(source: Source, bytes: Uint8Array, revision: string): Promise<Uint8Array> {
    if (!this.env.IMAGES || !this.env.ASSETS_BUCKET) throw unavailable();
    const result = await deadline(async signal => {
      const key = `generated/wechat-follow/v1/${revision}.jpg`;
      const cached = await this.env.ASSETS_BUCKET.get(key);
      if (cached && cached.customMetadata?.revision === revision && cached.customMetadata?.background === FOLLOW_BACKGROUND_SHA256 && rasterMime(cached.httpMetadata?.contentType ?? '') === 'image/jpeg') {
        const candidate = await readBytes(cached.body, cached.size, signal);
        if (followRasterMatches(candidate, 'image/jpeg')) return candidate;
      } else if (cached) await cached.body.cancel().catch(() => {});
      if (signal.aborted) throw unavailable();
      const info = await this.env.IMAGES.info(stream(bytes));
      if (signal.aborted) throw unavailable();
      if (!('width' in info) || !('height' in info) || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height)
        || info.width < 1 || info.height < 1 || info.width > 8192 || info.height > 8192 || info.width * info.height > 16_000_000) throw new ValidateException('关注二维码图片尺寸无效');
      const background = Uint8Array.from(atob(FOLLOW_BACKGROUND_BASE64), character => character.charCodeAt(0));
      const output = await this.env.IMAGES.input(stream(background))
        .draw(this.env.IMAGES.input(stream(bytes)).transform({ width: 344, height: 344, fit: 'squeeze' }), { left: 76, top: 76 })
        .output({ format: 'image/jpeg', quality: 90 });
      const response = output.response();
      if (!response.ok || rasterMime(response.headers.get('Content-Type') ?? '') !== 'image/jpeg') { await response.body?.cancel().catch(() => {}); throw unavailable(); }
      const image = await readBytes(response.body, Number(response.headers.get('Content-Length') ?? 0), signal);
      if (!followRasterMatches(image, 'image/jpeg')) throw unavailable();
      // Configuration/ownership changes during remote/image I/O invalidate the
      // result. No network or Images call holds a SQL transaction open.
      if ((await this.source()).identity !== source.identity || signal.aborted) throw new NotFoundException('关注二维码已更新，请重新生成');
      await this.env.ASSETS_BUCKET.put(key, image, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { revision, background: FOLLOW_BACKGROUND_SHA256 } });
      return image;
    }).catch(error => { if (error instanceof ValidateException || error instanceof NotFoundException || error instanceof ServiceUnavailableException) throw error; throw unavailable(); });
    // Cached data is subject to the same fresh persisted authority check.
    if ((await this.source()).identity !== source.identity) throw new NotFoundException('关注二维码已更新，请重新生成');
    return result;
  }

  async follow(requestUrl: string): Promise<{ path: string }> {
    if (!this.env.APP_KEY || !this.env.ASSETS_BUCKET || !this.env.IMAGES) throw unavailable();
    const source = await this.source(), bytes = await this.load(source), revision = await this.revision(source, bytes);
    await this.render(source, bytes, revision);
    const expires = this.now() + IMAGE_TTL;
    const url = new URL(`/api/wechat/follow/image/${revision}`, requestUrl);
    url.search = new URLSearchParams({ expires: String(expires), signature: await this.signature(revision, expires) }).toString();
    return { path: url.href };
  }

  async read(revision: string, expiresValue: string, signature: string, beforeRead: () => Promise<void> = async () => {}): Promise<Response> {
    const expires = Number(expiresValue), now = this.now();
    if (!/^[a-f0-9]{64}$/.test(revision) || !/^[1-9]\d{0,10}$/.test(expiresValue) || !Number.isSafeInteger(expires)
      || expires <= now || expires > now + IMAGE_TTL || !/^[a-f0-9]{64}$/.test(signature)
      || !await this.verifySignature(revision, expires, signature)) throw new NotFoundException('关注海报链接无效或已过期');
    await beforeRead();
    const source = await this.source(), bytes = await this.load(source);
    if (await this.revision(source, bytes) !== revision) throw new NotFoundException('关注二维码已更新，请重新生成');
    const image = await this.render(source, bytes, revision);
    return new Response(image, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store, max-age=0',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="follow.jpg"' } });
  }
}
