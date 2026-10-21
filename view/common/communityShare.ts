export interface CommunityShareIdentity { id: number; contentType: 1 | 2; spid: number }
export const communityIdentityId = (value: unknown, zero = false): number => {
  if (typeof value !== 'string' || !(zero ? /^(0|[1-9]\d{0,9})$/u : /^[1-9]\d{0,9}$/u).test(value)
    || Number(value) > 2147483647) throw Error('社区分享地址无效');
  return Number(value);
};
export function communitySharePath(id: number, contentType: number, uid = 0): string {
  if (![id, uid].every(Number.isSafeInteger) || id < 1 || id > 2147483647 || uid < 0 || uid > 2147483647
    || ![1, 2].includes(contentType)) return '';
  const path = contentType === 2 ? '/pages/discover/discoverVideo/index' : '/pages/discover/workspace';
  return `${path}?id=${id}${uid ? `&spid=${uid}` : ''}`;
}
export function communityTimelineQuery(id: number, contentType: number, uid = 0): string {
  if (!communitySharePath(id, contentType, uid)) return '';
  return `post_id=${id}&post_type=${contentType}${uid ? `&spid=${uid}` : ''}`;
}
export function isCommunitySharePath(path: string): boolean {
  const match = /^\/pages\/discover\/(workspace|discoverVideo\/index)\?id=([1-9]\d{0,9})(?:&spid=([1-9]\d{0,9}))?$/u.exec(path);
  return !!match && !!communitySharePath(Number(match[2]), match[1] === 'workspace' ? 1 : 2, Number(match[3] ?? 0));
}
export function communityShareUrl(path: string, siteUrl: string): string {
  if (!isCommunitySharePath(path)) return '';
  // Native JS engines need not provide the browser URL constructor. Keep the
  // same strict HTTPS origin contract without relying on browser globals.
  const origin = /^https:\/\/[a-z0-9.-]+$/u.test(siteUrl) && siteUrl.length <= 255 ? siteUrl : '';
  const hostname = origin.slice(8), labels = hostname.split('.');
  const valid = origin && hostname.length <= 253 && labels.length >= 2 && /^[a-z]{2,63}$/u.test(labels.at(-1)!)
    && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
  return valid ? `${origin}/#${path}` : '';
}
/** Parse actual raw query pairs before a router can collapse duplicate identities. */
export function communityQuery(raw: string): Record<string, string> {
  if (raw.length > 2048) throw Error('社区链接过长');
  const query: Record<string, string> = {};
  for (const part of raw ? raw.split('&') : []) {
    const at = part.indexOf('='), decode = (s: string) => decodeURIComponent(s.replace(/\+/gu, ' '));
    const key = decode(at < 0 ? part : part.slice(0, at));
    if (Object.hasOwn(query, key)) throw Error('社区链接包含重复参数');
    Object.defineProperty(query, key, { value: decode(at < 0 ? '' : part.slice(at + 1)), enumerable: true });
  }
  return query;
}
/** Extract known state from the old web-view link; never navigate to its origin or import credentials. */
export function communityEmbeddedVideo(raw: string): Record<string, string | undefined> | null {
  if (!raw || raw.length > 2048) return null;
  try {
    let value = raw.includes('/pages/discover/discoverVideo/index') ? raw : decodeURIComponent(raw);
    if (/^https?:\/\//iu.test(value)) value = value.replace(/^https?:\/\/[^/]+/iu, '');
    const [path, search] = value.split('#', 1)[0].split('?');
    if (path !== '/pages/discover/discoverVideo/index' || search === undefined) return null;
    const query = communityQuery(search);
    for (const key of ['id', 'relation_id', 'spid']) if (query[key] !== undefined) communityIdentityId(query[key], key === 'spid');
    if (query.content_type !== undefined && !['0', '2'].includes(query.content_type)) return null;
    return { id: query.id, relation_id: query.relation_id, content_type: query.content_type, spid: query.spid };
  } catch { return null; }
}
/** Only a valid, bounded post identity can provide a community referral. */
export function communityInbound(path: string, input: Readonly<Record<string, unknown>>): CommunityShareIdentity | null {
  path = '/' + path.replace(/^\//u, '');
  if (!/^\/pages\/discover\/(?:index|workspace|discoverDetails\/index|discoverTopic\/index|discoverSearch\/index|discoverVideo\/(?:index|app))$/u.test(path)) return null;
  const marker = input.post_id !== undefined || input.post_type !== undefined;
  const video = /\/discoverVideo\//u.test(path), detail = /\/discoverDetails\//u.test(path);
  let query = input;
  if (video && input.url !== undefined) {
    if (typeof input.url !== 'string') throw Error('旧版视频地址无效');
    const embedded = communityEmbeddedVideo(input.url); if (!embedded) throw Error('旧版视频地址无效');
    for (const key of ['id', 'relation_id', 'content_type', 'spid']) {
      if (embedded[key] !== undefined && input[key] !== undefined && embedded[key] !== input[key]) throw Error('社区链接参数冲突');
    }
    query = { ...input, ...Object.fromEntries(Object.entries(embedded).filter(([, v]) => v !== undefined)) };
  }
  if (!marker && !detail && !video && (!['/pages/discover/index', '/pages/discover/workspace'].includes(path)
    || query.id === undefined)) return null;
  const rawId = marker ? query.post_id : query.id;
  if (rawId === undefined && !marker && !detail) return null;
  const id = communityIdentityId(rawId);
  if (marker && query.id !== undefined && communityIdentityId(query.id) !== id) throw Error('社区帖子参数冲突');
  if (query.author_id !== undefined || query.publish !== undefined || query.edit_id !== undefined) throw Error('社区帖子与作者参数冲突');
  const contentType = marker ? communityIdentityId(query.post_type) : video ? 2 : 1;
  if (![1, 2].includes(contentType) || video && contentType !== 2) throw Error('社区分享类型无效');
  const spid = query.spid === undefined ? 0 : communityIdentityId(query.spid, true);
  return { id, contentType: contentType as 1 | 2, spid };
}
