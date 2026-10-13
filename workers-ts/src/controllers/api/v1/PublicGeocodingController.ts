import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { SystemConfigService } from '@/services/system/SystemConfigService';
import { parseGeocodingLocation, PublicGeocodingService } from '@/services/system/PublicGeocodingService';
import { RateLimitException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { jsonFail, jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

async function enforceGeocodingBudget(c: C): Promise<void> {
  const bucket = c.env.TOKEN_BUCKET;
  if (!c.env.APP_KEY || !bucket || typeof bucket.getByName !== 'function') {
    throw new ServiceUnavailableException('地图限流服务暂时不可用');
  }
  // Trust only Cloudflare's source header; a missing header shares one limited bucket.
  const ip = (c.req.header('CF-Connecting-IP') ?? 'unknown').slice(0, 128);
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(c.env.APP_KEY),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`public-geocoding\u0000${ip}`));
    const hash = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
    for (const [name, limit] of [[`public-geocoding:${hash}`, 30], ['public-geocoding:global', 300]] as const) {
      const decision = await bucket.getByName(name).consumeRateLimit([{ key: 'reverse', limit }], 60);
      if (!decision || typeof decision.allowed !== 'boolean' || !Number.isFinite(decision.resetAt)) {
        throw new Error('Invalid geocoding budget decision');
      }
      if (!decision.allowed) {
        throw new RateLimitException('位置查询过于频繁，请稍后重试',
          Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000)), false);
      }
    }
  } catch (error) {
    if (error instanceof RateLimitException) throw error;
    throw new ServiceUnavailableException('地图限流服务暂时不可用');
  }
}

/** GET /api/geoLbscoder. Public, StationOpen; no identity, IP or header goes to Tencent. */
export async function geoLbscoder(c: C) {
  c.header('Cache-Control', 'private, no-store, max-age=0');
  c.header('Referrer-Policy', 'no-referrer');
  try {
    const values = c.req.queries('location');
    if (!values || values.length !== 1) throw new ValidateException('经纬度参数错误');
    const location = parseGeocodingLocation(values[0]);
    await enforceGeocodingBudget(c);
    const service = new PublicGeocodingService(new SystemConfigService(c.get('container'), c.env));
    return jsonOk(c, await service.reverse(location));
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}
