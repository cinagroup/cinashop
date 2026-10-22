import { API_BASE } from './request';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** These are published media slots, never links or arbitrary editor strings. */
function mediaValues(page: unknown): unknown[] {
  const value = record(page).value;
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).flatMap(raw => {
    const block = record(raw), field = (key: string) => record(block[key]).url;
    if (block.name === 'news') return [field('imgConfig')];
    if (block.name === 'hotspot') return [field('picStyle')];
    if (block.name === 'follow') return [field('imgConfig'), field('codeConfig')];
    if (block.name === 'activeParty') { const items = record(block.menuConfig).list; return Array.isArray(items) ? items.slice(0, 4).map(item => record(item).img) : []; }
    return [];
  });
}
function assetQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let path = value;
  if (API_BASE && path.startsWith(API_BASE + '/api/assets/')) path = path.slice(API_BASE.length);
  else if (typeof window !== 'undefined' && path.startsWith(window.location.origin + '/api/assets/')) path = path.slice(window.location.origin.length);
  if (!/^\/api\/assets\/[1-9]\d*(?:\?|#|$)/u.test(path)) return null;
  return path.split('?', 2)[1]?.split('#', 1)[0] ?? '';
}
/** Server signatures last 900s. Public cache may reuse them for at most 840s
 * and must leave a full minute before the earliest ticket expiry. Static and
 * external images retain their existing offline schema contract. */
export function diyEditorialMediaDeadline(page: unknown, cachedAt: number, now = Date.now()): number {
  let earliest=Infinity;
  for (const value of mediaValues(page)) {
    const query = assetQuery(value); if (query === null) continue;
    if (!Number.isFinite(cachedAt) || cachedAt <= 0 || cachedAt > now) return 0;
    let params: [string, string][];
    try { params = query.split('&').map(part => { const at = part.indexOf('='); return [decodeURIComponent(at < 0 ? part : part.slice(0, at)), decodeURIComponent(at < 0 ? '' : part.slice(at + 1))]; }); }
    catch { return 0; }
    const expires = params.filter(([key]) => key === 'expires'), signatures = params.filter(([key]) => key === 'signature');
    if (expires.length !== 1 || signatures.length !== 1 || !/^[1-9]\d{0,10}$/u.test(expires[0]![1]) || !/^[A-Za-z0-9_-]{16,256}$/u.test(signatures[0]![1])) return 0;
    const deadline = Number(expires[0]![1]) * 1000;
    if (!Number.isSafeInteger(deadline)) return 0;
    earliest=Math.min(earliest,cachedAt+840000,deadline-60000);
  }
  return earliest;
}
export const diyEditorialMediaCacheUsable=(page:unknown,cachedAt:number,now=Date.now())=>diyEditorialMediaDeadline(page,cachedAt,now)>now;
