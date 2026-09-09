import { ApiException } from '@/utils/errors';
import type { SystemConfigEnv } from '@/services/system/SystemConfigService';

const TTL = 30 * 60;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
type QuoteStore = Pick<SystemConfigEnv['CONFIG_KV'], 'get' | 'put'>;
export interface CheckoutConfirmationScope { uid: number; key: string; adminId?: number; touristUid?: string }
export interface CheckoutConfirmation { fingerprint: string; expiresAt: number }

/** Only a definite pre-commit rejection. Infrastructure/unknown outcomes keep their original errors. */
export class OrderQuoteReconfirmRequired extends ApiException {
  constructor(key: string) {
    super('订单报价或结算信息已变化，请重新确认', 400, { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: key });
  }
}

function scopeKey(scope: CheckoutConfirmationScope, token: string): string {
  if (!Number.isSafeInteger(scope.uid) || scope.uid < 0 || !KEY.test(scope.key)
    || !Number.isSafeInteger(scope.adminId ?? 0) || (scope.adminId ?? 0) < 0
    || (scope.uid === 0 && !scope.adminId)) throw new OrderQuoteReconfirmRequired(scope.key);
  return `order:quote:v1:${scope.uid}:${scope.adminId ?? 0}:${scope.key}:${token}`;
}

/** Hash only explicitly constructed, serializable checkout facts, never arbitrary request bodies. */
export async function checkoutFingerprint(facts: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(facts));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Immutable random receipt. A computed response never overwrites another response's quote. */
export async function issueCheckoutConfirmation(store: QuoteStore, scope: CheckoutConfirmationScope, fingerprint: string): Promise<string> {
  if (!DIGEST.test(fingerprint)) throw new Error('Invalid server checkout fingerprint');
  const token = crypto.randomUUID().replaceAll('-', '');
  const createdAt = Math.floor(Date.now() / 1000);
  await store.put(scopeKey(scope, token), JSON.stringify({ version: 1, uid: scope.uid, key: scope.key,
    adminId: scope.adminId ?? 0, touristUid: scope.touristUid ?? '', fingerprint, createdAt, expiresAt: createdAt + TTL }), { expirationTtl: TTL });
  return token;
}

export async function readCheckoutConfirmation(store: QuoteStore, scope: CheckoutConfirmationScope, token: unknown): Promise<CheckoutConfirmation> {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw new OrderQuoteReconfirmRequired(scope.key);
  // KV visibility failures are fail-closed, never a fallback to client amounts or the latest cached quote.
  const text = await store.get(scopeKey(scope, token));
  if (!text || text.length > 4096) throw new OrderQuoteReconfirmRequired(scope.key);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new OrderQuoteReconfirmRequired(scope.key); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OrderQuoteReconfirmRequired(scope.key);
  const row = value as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  if (row.version !== 1 || row.uid !== scope.uid || row.key !== scope.key || row.adminId !== (scope.adminId ?? 0)
    || row.touristUid !== (scope.touristUid ?? '') || typeof row.fingerprint !== 'string' || !DIGEST.test(row.fingerprint)
    || typeof row.createdAt !== 'number' || !Number.isSafeInteger(row.createdAt) || row.createdAt > now
    || typeof row.expiresAt !== 'number' || row.expiresAt !== row.createdAt + TTL || row.expiresAt <= now) {
    throw new OrderQuoteReconfirmRequired(scope.key);
  }
  return { fingerprint: row.fingerprint, expiresAt: row.expiresAt };
}

export function assertCheckoutConfirmation(confirmation: CheckoutConfirmation, fingerprint: string, key: string): void {
  // Fingerprints are public content hashes, not secrets/authenticator comparisons.
  if (confirmation.expiresAt <= Math.floor(Date.now() / 1000) || confirmation.fingerprint !== fingerprint) {
    throw new OrderQuoteReconfirmRequired(key);
  }
}
