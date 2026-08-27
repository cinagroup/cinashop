/**
 * This must stay aligned with the cinashop-order consumer in wrangler.toml.
 * Cloudflare delivers once initially and then up to max_retries additional times.
 */
export const ORDER_QUEUE_MAX_RETRIES = 3;
export const ORDER_QUEUE_MAX_DELIVERY_ATTEMPTS = ORDER_QUEUE_MAX_RETRIES + 1;

export function hasExhaustedOrderQueueRetries(attempts: number): boolean {
  return attempts >= ORDER_QUEUE_MAX_DELIVERY_ATTEMPTS;
}
