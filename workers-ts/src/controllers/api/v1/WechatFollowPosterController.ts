import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { WechatFollowPosterService } from '@/services/wechat/WechatFollowPosterService';
import { RateLimitException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function headers(c: C) { c.header('Cache-Control', 'private, no-store, max-age=0'); c.header('Referrer-Policy', 'no-referrer'); }
async function budget(c: C) {
  if (!c.env.APP_KEY || !c.env.TOKEN_BUCKET || typeof c.env.TOKEN_BUCKET.getByName !== 'function') throw new ServiceUnavailableException('关注海报限流服务暂时不可用');
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(c.env.APP_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`wechat-follow\u0000${(c.req.header('CF-Connecting-IP') ?? 'unknown').slice(0, 128)}`));
    const hash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    for (const [name, limit] of [[`wechat-follow:${hash}`, 30], ['wechat-follow:global', 300]] as const) {
      const decision = await c.env.TOKEN_BUCKET.getByName(name).consumeRateLimit([{ key: 'poster', limit }], 60);
      if (!decision || typeof decision.allowed !== 'boolean' || !Number.isFinite(decision.resetAt)) throw Error('Invalid budget decision');
      if (!decision.allowed) throw new RateLimitException('关注海报生成过于频繁，请稍后重试', Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000)), false);
    }
  } catch (error) { if (error instanceof RateLimitException) throw error; throw new ServiceUnavailableException('关注海报限流服务暂时不可用'); }
}

/** Legacy optional-auth GET /wechat/follow, under StationOpen. */
export async function follow(c: C) {
  headers(c);
  if (Object.keys(c.req.query()).length) throw new ValidateException('关注海报参数无效');
  await budget(c);
  return jsonOk(c, await new WechatFollowPosterService(c.get('container'), c.env).follow(c.req.url));
}

/** Signature is checked before public resource budget and storage/provider I/O. */
export async function image(c: C) {
  headers(c);
  const values = c.req.queries();
  if (Object.keys(values).some(name => !['expires', 'signature'].includes(name)) || values.expires?.length !== 1 || values.signature?.length !== 1) throw new ValidateException('关注海报参数无效');
  return new WechatFollowPosterService(c.get('container'), c.env).read(c.req.param('revision') ?? '', values.expires[0], values.signature[0], () => budget(c));
}
