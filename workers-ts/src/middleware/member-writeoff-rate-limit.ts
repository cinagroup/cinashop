import type { MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { RateLimitException, ServiceUnavailableException, ValidateException } from '@/utils/errors';

type Role = 'staff' | 'delivery';
type Action = 'lookup' | 'info' | 'execute';
const WINDOW_SECONDS = 60;
const TOTAL_READS_PER_MINUTE = 30;
const LOOKUPS_PER_MINUTE = 20;
const INFOS_PER_MINUTE = 20;
const EXECUTIONS_PER_MINUTE = 6;

async function operatorBucketName(keyValue: string, uid: number): Promise<string> {
  if (!keyValue) throw new Error('Member-writeoff HMAC key unavailable');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(keyValue),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  // One bucket follows this authenticated UID across both roles and all three routes.
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`member-writeoff\u0000${uid}`));
  const digest = Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `member-writeoff:${digest.slice(0, 32)}`;
}

/** One strongly consistent DO per authenticated UID; invalid and valid codes spend the same budget. */
export function memberWriteoffRateLimit(role: Role, action: Action): MiddlewareHandler<{
  Bindings: Env; Variables: AppVariables;
}> {
  return async (c, next) => {
    c.header('Cache-Control', 'private, no-store, max-age=0');
    c.header('Referrer-Policy', 'no-referrer');
    const uid = Number(c.get('uid') ?? 0);
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException('核销员身份无效');
    const bucket = c.env.TOKEN_BUCKET;
    if (!c.env.APP_KEY || !bucket || typeof bucket.getByName !== 'function') {
      throw new ServiceUnavailableException('会员码扫码限流服务不可用');
    }
    const policies = action === 'execute'
      ? [{ key: 'execute', limit: EXECUTIONS_PER_MINUTE }]
      : [{ key: 'all-reads', limit: TOTAL_READS_PER_MINUTE },
        { key: `${role}:${action}`, limit: action === 'lookup' ? LOOKUPS_PER_MINUTE : INFOS_PER_MINUTE }];
    let decision: Awaited<ReturnType<ReturnType<typeof bucket.getByName>['consumeRateLimit']>>;
    try {
      decision = await bucket.getByName(await operatorBucketName(c.env.APP_KEY, uid))
        .consumeRateLimit(policies, WINDOW_SECONDS);
    } catch {
      throw new ServiceUnavailableException('会员码扫码限流服务不可用');
    }
    if (!decision || typeof decision.allowed !== 'boolean' || !Number.isFinite(decision.resetAt)) {
      throw new ServiceUnavailableException('会员码扫码限流服务不可用');
    }
    if (!decision.allowed) {
      throw new RateLimitException('会员码扫码请求过于频繁，请稍后重试',
        Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1_000)), false);
    }
    await next();
  };
}
