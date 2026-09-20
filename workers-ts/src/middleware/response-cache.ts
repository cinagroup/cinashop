import type { MiddlewareHandler } from 'hono';

/**
 * Workers Cache can cache an unmarked HTTP 200 for two hours, including our
 * PHP-compatible error envelopes and optional-auth product responses. Cache
 * only when a successful handler explicitly declares a policy. Apply after
 * dispatch so raw/streamed Responses and early middleware exits are covered,
 * without reading, cloning or buffering their bodies. WebSocket upgrades are
 * not cacheable HTTP representations and must retain their upgrade response.
 */
export const responseCacheMiddleware: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res.status === 101) return;
  const declared = c.res.headers.get('Cache-Control')?.trim();
  const failed = c.error || c.res.status >= 400;
  const alreadyNoStore = declared && /(?:^|,)\s*no-store\s*(?:,|$)/i.test(declared);
  if (!declared || (failed && !alreadyNoStore)) {
    c.header('Cache-Control', 'private, no-store, max-age=0');
  }
};
