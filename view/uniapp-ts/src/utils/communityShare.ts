export * from '../../../common/communityShare';
import { communityQuery, communityShareUrl as configuredCommunityShareUrl, isCommunitySharePath } from '../../../common/communityShare';

export function communityShareUrl(path: string, siteUrl: string): string {
  if (!isCommunitySharePath(path)) return '';
  // #ifdef H5
  if (typeof window !== 'undefined') {
    try {
      const url = new URL(window.location.href);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
        url.search = ''; url.hash = path; return url.href;
      }
    } catch { return ''; }
  }
  // #endif
  return configuredCommunityShareUrl(path, siteUrl);
}

export function communityPageQuery(input: unknown): Record<string, string | undefined> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('社区页面参数无效');
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 2048)) throw Error('社区页面参数无效');
    Object.defineProperty(result, key, { value, enumerable: true });
  }
  // #ifdef H5
  if (typeof window !== 'undefined') {
    const hash = window.location.hash;
    if (/^#\/?pages\/discover\//u.test(hash) && hash.includes('?')) communityQuery(hash.slice(hash.indexOf('?') + 1));
  }
  // #endif
  return result;
}
