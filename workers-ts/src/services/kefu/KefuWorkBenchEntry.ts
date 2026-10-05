import type { Env } from '@/env';

type EntryEnv = Pick<Env, 'PUBLIC_KEFU_ORIGIN' | 'KEFU_AUTH_ALLOWED_ORIGINS' | 'ALLOWED_ORIGINS'>;
const mobilePaths = new Set(['/kefu/mobile_list', '/kefu/mobile_chat']);
const appPaths = new Set(['/mobile_list', '/mobile_chat', '/kefu/mobile_list', '/kefu/mobile_chat', '/workbench']);

/** A CORS allowlist is not a destination. Operators must choose the canonical
 * independent Kefu app explicitly; no API origin or first allowlist fallback. */
export function kefuWorkBenchOrigin(env: EntryEnv): string {
  const configured = env.PUBLIC_KEFU_ORIGIN;
  if (!configured || configured !== configured.trim() || configured.length > 256) return '';
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || configured !== url.origin || !url.hostname.includes('.')) return '';
    const permitted = (list?: string) => (list ?? '').split(',').map(value => value.trim()).includes(url.origin);
    return permitted(env.KEFU_AUTH_ALLOWED_ORIGINS) && permitted(env.ALLOWED_ORIGINS) ? url.origin : '';
  } catch { return ''; }
}

export function isLegacyKefuWorkBenchTarget(value: string): boolean {
  return mobilePaths.has(value.split('?', 1)[0]!);
}

/** Query parameters only select a peer within the dedicated Kefu session.
 * User/Admin credentials and callback destinations never cross this entry. */
export function legacyKefuWorkBenchTarget(value: string, origin: string): string {
  if (!origin || value.length > 2048 || value !== value.trim() || /[\\#\u0000-\u0020\u007f]/u.test(value)) return '';
  const at = value.indexOf('?'), path = at < 0 ? value : value.slice(0, at);
  if (!mobilePaths.has(path)) return '';
  if (at < 0) return path === '/kefu/mobile_list' ? `${origin}/mobile_list` : '';
  if (path !== '/kefu/mobile_chat') return '';
  const query = new URLSearchParams(value.slice(at + 1)), fields = [...query.keys()];
  if (fields.length !== 2 || new Set(fields).size !== 2 || fields.some(key => !['uid', 'toUid', 'is_tourist'].includes(key))) return '';
  const uid = query.get('uid') ?? query.get('toUid'), domain = query.get('is_tourist');
  if (!uid || !/^[1-9]\d{0,9}$/u.test(uid) || Number(uid) > 2147483647 || !['0', '1'].includes(domain ?? '')) return '';
  return `${origin}/mobile_chat?uid=${uid}&is_tourist=${domain}`;
}

export function isConfiguredKefuWorkBenchTarget(value: string, origin: string): boolean {
  if (!origin) return false;
  // Recognition is intentionally broader than activation: an invalid canonical
  // configuration must still hide an equivalent stored absolute staff entry.
  // This origin is never used to construct a destination or as a fallback.
  try { const url = new URL(value), declared = new URL(origin); return url.origin === declared.origin && appPaths.has(url.pathname); }
  catch { return false; }
}
