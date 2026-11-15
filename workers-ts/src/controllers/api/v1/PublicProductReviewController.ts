import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { authMiddleware } from '@/middleware/auth';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { PublicProductReviewService, type PublicReviewQuery } from '@/services/product/PublicProductReviewService';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { ValidateException } from '@/utils/errors';
import { jsonFail, jsonOk } from '@/utils/json';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const invalid = () => new ValidateException('评价参数无效，请重新读取');
export function publicReviewId(value: string | undefined): number {
  if (!value || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) throw invalid();
  return Number(value);
}
export function publicReviewQuery(url: string, directory = false): PublicReviewQuery {
  const values = new URL(url).searchParams, keys = directory ? ['page', 'limit', 'type'] : ['page', 'limit'];
  if ([...values.keys()].some(key => !keys.includes(key) || values.getAll(key).length !== 1)) throw invalid();
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = values.get(key); if (raw === null) return fallback;
    if (!/^(0|[1-9]\d*)$/.test(raw) || Number(raw) < min || Number(raw) > max) throw invalid();
    return Number(raw);
  };
  const page = integer('page', 1, 1, 1000000), limit = integer('limit', 10, 1, 50), type = integer('type', 0, 0, 3);
  if ((page - 1) * limit > 2147483647) throw invalid(); return { page, limit, type };
}
export function publicReviewBody(text: string, kind: 'visit' | 'comment' | 'praise'): Record<string, unknown> {
  let raw: unknown; try { raw = parseLevelActivationJson(text); } catch { throw invalid(); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  const value = raw as Record<string, unknown>, keys = kind === 'visit' ? ['version'] : ['version', kind === 'comment' ? 'content' : 'praised'];
  if (value.version !== 1 || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw invalid();
  if (kind === 'comment' && typeof value.content !== 'string' || kind === 'praise' && typeof value.praised !== 'boolean') throw invalid();
  return value;
}
function service(c: C) {
  const uid = c.get('uid') ?? 0, actor = uid ? { uid, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } : undefined;
  const authorize = async (db?: DbClient) => {
    if (!actor) return;
    const original = c.get('container');
    // Keep JWT and token-bucket checks intact while binding the middleware's
    // user lookup to the write transaction; always restore request wiring.
    if (db) c.set('container', createContainerFromDb(db));
    try {
      await authMiddleware({ force: true })(c, async () => {});
      if (c.get('uid') !== actor.uid || c.get('socketAuthVersion') !== actor.authVersion || c.get('socketTokenExp') !== actor.expiresAt) throw invalid();
    } finally { c.set('container', original); }
  };
  return new PublicProductReviewService(c.get('container'), c.env.APP_KEY, actor, authorize);
}
async function response(c: C, work: () => Promise<unknown>) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache'); c.header('Referrer-Policy', 'no-referrer');
  try { if (new URL(c.req.url).pathname.includes('%')) throw invalid(); return jsonOk(c, await work()); }
  catch (e) { if (e instanceof ValidateException) return jsonFail(c, e.message); throw e; }
}
function noQuery(c: C) { if ([...new URL(c.req.url).searchParams.keys()].length) throw invalid(); }
const replyId = (c: C) => publicReviewId(c.req.param('replyId'));
export const directory = (c: C) => response(c, () => service(c).directory(publicReviewId(c.req.param('productId')), publicReviewQuery(c.req.url, true)));
/** Actual PHP V2 rich card array; V1 list remains unchanged. */
export const legacyV2List = (c: C) => response(c, async () => (await service(c).directory(publicReviewId(c.req.param('id')), publicReviewQuery(c.req.url, true))).items);
export const state = (c: C) => response(c, () => { noQuery(c); return service(c).state(replyId(c)); });
export const comments = (c: C) => response(c, () => { const q = publicReviewQuery(c.req.url); return service(c).comments(replyId(c), q.page, q.limit); });
export const visit = (c: C) => response(c, async () => { noQuery(c); publicReviewBody(await readBoundedUtf8Text(c.req.raw, 4096), 'visit'); return service(c).visit(replyId(c)); });
export const comment = (c: C) => response(c, async () => { noQuery(c); const body = publicReviewBody(await readBoundedUtf8Text(c.req.raw, 8192), 'comment'); return service(c).comment(replyId(c), body.content); });
export const praise = (c: C) => response(c, async () => { noQuery(c); const body = publicReviewBody(await readBoundedUtf8Text(c.req.raw, 4096), 'praise'); return service(c).praise(replyId(c), null, body.praised as boolean); });
export const commentPraise = (c: C) => response(c, async () => { noQuery(c); const body = publicReviewBody(await readBoundedUtf8Text(c.req.raw, 4096), 'praise'); return service(c).praise(replyId(c), publicReviewId(c.req.param('commentId')), body.praised as boolean); });
