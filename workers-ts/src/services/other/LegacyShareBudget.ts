import type { Env } from '@/env';
import { RateLimitException, ServiceUnavailableException } from '@/utils/errors';
import { legacyShareHmac } from './LegacyShareCodeProtocol';

/** Cloudflare's source address is HMAC'd; neither raw IP nor forwarded headers
 * become persistent keys. Missing or malformed Durable Object replies fail closed. */
export async function enforceLegacyShareBudget(env: Env, cloudflareIp: string | undefined): Promise<void> {
  if (!env.APP_KEY || !env.TOKEN_BUCKET || typeof env.TOKEN_BUCKET.getByName !== 'function') throw new ServiceUnavailableException('分享限流服务暂不可用');
  const hash = legacyShareHmac(env.APP_KEY,'budget',(cloudflareIp ?? 'unknown').slice(0,128));
  try {
    for (const [name,limit] of [[`legacy-share:${hash}`,30],['legacy-share:global',300]] as const) {
      const decision = await env.TOKEN_BUCKET.getByName(name).consumeRateLimit([{key:'request',limit}],60);
      if (!decision || typeof decision.allowed !== 'boolean' || !Number.isFinite(decision.resetAt)) throw Error('Invalid share budget response');
      if (!decision.allowed) throw new RateLimitException('分享请求过于频繁，请稍后重试',Math.max(1,Math.ceil((decision.resetAt-Date.now())/1000)),false);
    }
  } catch (error) { if (error instanceof RateLimitException) throw error; throw new ServiceUnavailableException('分享限流服务暂不可用'); }
}
