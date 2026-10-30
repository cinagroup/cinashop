/** Anonymous reads of the existing public community endpoints, without preview fixtures. */
export interface CommunityAuthorPost {
  id: number;
  type: number;
  relationId: number;
  contentType: 1 | 2;
  title: string;
  content: string;
  image: string;
  sliderImage: string[] | null;
  likeNum: number;
  commentNum: number;
  playNum: number;
  isLike: 0 | 1;
  status: 1;
  is_verify: 1;
  addTime: number;
  shareNum?: number;
  share_num?: number;
  author?: string;
  author_image?: string;
  videoUrl?: string;
  video_url?: string;
  site_url?: string;
  is_follow?: 0 | 1;
  is_self?: 0 | 1;
  [key: string]: unknown;
}

export interface DiyCommunityPreview { open: boolean; rows: CommunityAuthorPost[]; message: string }

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= 2147483647;
const flag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;
function checkedLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('社区预览数量必须为 1 至 100 的整数');
}

/** Validate every received row before deduplication; no invalid row is filtered away. */
export function checkedDiyCommunityPublicRows(raw: unknown, limit: number): CommunityAuthorPost[] {
  checkedLimit(limit);
  if (!Array.isArray(raw) || raw.length > limit) throw Error('社区预览列表格式错误');
  const checked = Array.from(raw, value => {
    const row = record(value);
    if (!row || !integer(row.id, 1) || !Number.isSafeInteger(row.type) || Number(row.type) < 0
      || !integer(row.relationId) || row.contentType !== 1 && row.contentType !== 2
      || !flag(row.isLike) || row.status !== 1 || row.is_verify !== 1
      || [row.likeNum, row.commentNum, row.playNum, row.addTime].some(value => !integer(value))
      || ['title', 'content', 'image'].some(key => typeof row[key] !== 'string')
      || !(row.sliderImage === null || Array.isArray(row.sliderImage) && Array.from(row.sliderImage).every(value => typeof value === 'string'))
      || ['author', 'author_image', 'videoUrl', 'video_url', 'site_url'].some(key => row[key] !== undefined && typeof row[key] !== 'string')
      || ['shareNum', 'share_num'].some(key => row[key] !== undefined && !integer(row[key]))
      || ['is_follow', 'is_self'].some(key => row[key] !== undefined && !flag(row[key]))) throw Error('社区预览包含非公开或格式错误的帖子');
    return structuredClone(row) as unknown as CommunityAuthorPost;
  });
  const ids = new Set<number>();
  return checked.filter(row => !ids.has(row.id) && Boolean(ids.add(row.id)));
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('社区预览读取已取消');
  error.name = 'AbortError';
  throw error;
}

type Receipt = { data: unknown; closed: false } | { message: string; closed: true };

async function anonymousRead(url: string, signal?: AbortSignal): Promise<Receipt> {
  abortIfNeeded(signal);
  const response = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal });
  abortIfNeeded(signal);
  const body = record(await response.json());
  abortIfNeeded(signal);
  if (!body || !Number.isSafeInteger(body.status) || typeof body.msg !== 'string' || !Object.hasOwn(body, 'data')) throw Error('社区预览响应格式错误');
  const knownClosure = ['社区暂未开放', '站点升级中，请稍候访问'].includes(body.msg);
  // A generic 5xx is a retryable read error. The exact known 503 closure receipt
  // remains distinguishable from an unrelated server failure carrying 410010.
  if (body.status === 410010 && (response.status < 500 || response.status === 503 && knownClosure)) return { closed: true, message: body.msg || '社区暂未开放' };
  if (!response.ok || body.status !== 200) throw Error(body.msg || `社区预览读取失败（${response.status}）`);
  return { closed: false, data: body.data };
}

/** Config admission precedes the single page-one public list read; no topic filter. */
export async function apiDiyCommunityPreview(limit: number, signal?: AbortSignal): Promise<DiyCommunityPreview> {
  checkedLimit(limit);
  const configReceipt = await anonymousRead('/api/community/config', signal);
  abortIfNeeded(signal);
  if (configReceipt.closed) return { open: false, rows: [], message: configReceipt.message };
  const config = record(configReceipt.data);
  if (!config || !['community_status', 'community_comment_status', 'community_comment_add'].every(key => flag(config[key]))) throw Error('社区开关格式错误，请刷新');
  if (config.community_status === 0) return { open: false, rows: [], message: '社区暂未开放' };
  abortIfNeeded(signal);
  const listReceipt = await anonymousRead(`/api/community/list?page=1&limit=${limit}&is_follow=0`, signal);
  abortIfNeeded(signal);
  if (listReceipt.closed) return { open: false, rows: [], message: listReceipt.message };
  return { open: true, rows: checkedDiyCommunityPublicRows(listReceipt.data, limit), message: '' };
}

export interface CommunityPreview { closed: boolean; rows: CommunityAuthorPost[] }
export const checkedCommunityAuthorRows = checkedDiyCommunityPublicRows;
export async function readCommunityPreview(limit: number, signal: AbortSignal): Promise<CommunityPreview> {
  const receipt = await apiDiyCommunityPreview(limit, signal);
  return { closed: !receipt.open, rows: receipt.rows };
}
/** Only actual media slots can expire a displayed public receipt. */
export function communityPreviewDeadline(preview: CommunityPreview): number {
  let deadline = Infinity;
  for (const row of preview.rows) for (const image of [row.image, row.author_image, ...(row.sliderImage ?? [])]) {
    if (typeof image !== 'string') continue;
    const query = /^\/api\/assets\/[1-9]\d*\?([^#]*)$/u.exec(image); if (!query) continue;
    const expires = new URLSearchParams(query[1]).get('expires');
    if (expires && /^[1-9]\d{0,10}$/u.test(expires)) deadline = Math.min(deadline, Number(expires) * 1000);
  }
  return deadline;
}
