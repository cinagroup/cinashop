import { parsePublicReviewPage, parsePublicReviewDetail, parsePublicReviewComments, parsePublicReviewCommentAck, parsePublicReviewPraiseAck,
  publicReviewId, publicReviewFilter, publicReviewCommentContent,
  type ReviewFilter, type PublicReviewCard, type PublicReviewPage, type PublicReviewComment, type PublicReviewDetailPage } from './publicProductReviews';

export interface PublicReviewSession { uid: number; token: string; current(): boolean }
const errorText = (error: unknown) => error instanceof Error ? error.message : '评价请求失败，请重新读取';
const allowed = (s: PublicReviewSession) => s.current() && Number.isInteger(s.uid) && s.uid >= 0 && s.uid <= 2147483647 && (s.uid === 0 ? !s.token : !!s.token);
const signedIn = (s: PublicReviewSession) => allowed(s) && s.uid > 0;
const sameIds = (old: readonly { id: number }[], incoming: readonly { id: number }[]) => incoming.some(row => old.some(previous => previous.id === row.id));

export interface PublicReviewListState { page: PublicReviewPage | null; items: PublicReviewCard[]; filter: ReviewFilter; loading: boolean; loadingMore: boolean; error: string }
export const initialPublicReviewList = (): PublicReviewListState => ({ page: null, items: [], filter: 0, loading: false, loadingMore: false, error: '' });
export function createPublicReviewListFlow(state: PublicReviewListState, dep: {
  capture(): PublicReviewSession; read(productId: number, type: ReviewFilter, page: number, limit: number): Promise<unknown>;
}) {
  let productId = 0, epoch = 0;
  const limit = 10;
  function clear() { epoch++; state.page = null; state.items = []; state.loading = false; state.loadingMore = false; state.error = ''; }
  function setProduct(value: unknown) { clear(); productId = 0; state.filter = 0; try { productId = publicReviewId(value); } catch { state.error = '商品评价链接无效，请重新进入商品'; } }
  function capture() { const s = dep.capture(), generation = epoch, id = productId, type = state.filter; return { ...s, current: () => s.current() && generation === epoch && productId === id && state.filter === type }; }
  async function read(more: boolean) {
    if (!productId || !allowed(dep.capture())) return;
    if (more && (state.loading || state.loadingMore || !state.page || state.items.length >= state.page.total)) return;
    if (!more) { clear(); state.loading = true; } else state.loadingMore = true;
    const s = capture(), id = productId, type = state.filter, page = more ? state.page!.page + 1 : 1;
    state.error = '';
    try {
      const result = parsePublicReviewPage(await dep.read(id, type, page, limit), id, type, page, limit, s.uid);
      if (!s.current()) return;
      if (more && result.total !== state.page!.total) throw Error('评价数量已变化，请刷新后继续查看');
      if (more && sameIds(state.items, result.items)) throw Error('评价排序已变化，请刷新后继续查看');
      state.page = result; state.items = more ? [...state.items, ...result.items] : result.items;
    } catch (e) { if (s.current()) state.error = errorText(e); }
    finally { if (s.current()) { state.loading = false; state.loadingMore = false; } }
  }
  async function selectFilter(value: unknown) { const next = publicReviewFilter(value); if (next === state.filter && state.page) return; state.filter = next; await read(false); }
  return { clear, suspend: clear, setProduct, load: () => read(false), loadMore: () => read(true), selectFilter,
    hasMore: () => !!state.page && state.items.length < state.page.total };
}

interface PendingReviewAction { inFlight: boolean; kind: 'comment' | 'praise'; commentId: number | null }
// Only operation identity is kept for this JS session; no reply text or media.
// Reconstruction, hide/show and identical-token re-login cannot replay a write.
const pending = new Map<string, PendingReviewAction>();
const identity = (s: PublicReviewSession, id: number) => JSON.stringify([s.uid, s.token, id]);
export interface PublicReviewDetailState {
  page: PublicReviewDetailPage | null; comments: PublicReviewComment[]; commentsPage: number; commentsTotal: number;
  loading: boolean; loadingMore: boolean; busy: boolean; uncertain: boolean; checked: boolean; content: string; error: string; message: string;
}
export const initialPublicReviewDetail = (): PublicReviewDetailState => ({ page: null, comments: [], commentsPage: 0, commentsTotal: 0,
  loading: false, loadingMore: false, busy: false, uncertain: false, checked: false, content: '', error: '', message: '' });
export function createPublicReviewDetailFlow(state: PublicReviewDetailState, dep: {
  capture(): PublicReviewSession; read(id: number): Promise<unknown>; visit(id: number): Promise<unknown>;
  comments(id: number, page: number, limit: number): Promise<unknown>;
  comment(id: number, content: string): Promise<unknown>;
  praise(id: number, commentId: number | null, praised: boolean): Promise<unknown>;
}) {
  let replyId = 0, epoch = 0, attemptedVisit = false, ownerKey = '';
  const limit = 20;
  function clear() { epoch++; state.page = null; state.comments = []; state.commentsPage = 0; state.commentsTotal = 0; state.loading = false;
    state.loadingMore = false; state.busy = false; state.uncertain = false; state.checked = false; state.content = ''; state.error = ''; state.message = ''; ownerKey = ''; }
  function setReview(value: unknown) { clear(); replyId = 0; attemptedVisit = false; try { replyId = publicReviewId(value); } catch { state.error = '评价链接无效，请重新进入商品'; } }
  function capture() { const s = dep.capture(), generation = epoch, id = replyId; return { ...s, current: () => s.current() && generation === epoch && replyId === id }; }
  function status(s: PublicReviewSession) {
    const mark = pending.get(identity(s, replyId)); state.uncertain = !!mark;
    if (mark) state.message = mark.inFlight ? '上次操作仍在处理中，请稍后刷新核对' : state.checked ? '已读取当前资料。请核对回复和点赞，再结束本次操作。' : '上次操作结果未确认，请刷新核对；不会自动再次提交';
    return mark;
  }
  async function load() {
    if (!replyId) return;
    const raw = dep.capture(), key = identity(raw, replyId), draft = ownerKey === key ? state.content : '';
    clear(); state.content = draft; ownerKey = key; state.loading = true;
    const s = capture(), id = replyId;
    if (!signedIn(s)) { state.loading = false; state.content = ''; state.error = '请登录后查看评价详情'; return; }
    const mark = status(s), mayCheck = !!mark && !mark.inFlight;
    try {
      // A retry, refresh or return from hiding must be a read, never a visit.
      const visit = !attemptedVisit; attemptedVisit = true;
      const rawPage = await (visit ? dep.visit(id) : dep.read(id));
      const page = parsePublicReviewDetail(rawPage, id, s.uid);
      if (!s.current()) return;
      const comments = parsePublicReviewComments(await dep.comments(id, 1, limit), id, 1, limit, s.uid);
      if (!s.current()) return;
      state.page = page; state.comments = comments.items; state.commentsPage = 1; state.commentsTotal = comments.total;
      // The separately read thread count is authoritative for its own snapshot.
      state.page.detail.reply.comment_sum = comments.total;
      state.checked = mayCheck && pending.get(key) === mark && !mark!.inFlight;
      status(s);
    } catch (e) { if (s.current()) { state.error = errorText(e); status(s); } }
    finally { if (s.current()) state.loading = false; }
  }
  async function loadMore() {
    const s = capture(); if (!signedIn(s) || !state.page || state.loading || state.loadingMore || state.busy || state.comments.length >= state.commentsTotal) return;
    const id = replyId, page = state.commentsPage + 1; state.loadingMore = true; state.error = '';
    try {
      const result = parsePublicReviewComments(await dep.comments(id, page, limit), id, page, limit, s.uid);
      if (!s.current()) return;
      if (result.total !== state.commentsTotal) throw Error('回复数量已变化，请刷新后继续查看');
      if (sameIds(state.comments, result.items)) throw Error('回复排序已变化，请刷新后继续查看');
      state.comments = [...state.comments, ...result.items]; state.commentsPage = page; state.commentsTotal = result.total;
      state.page!.detail.reply.comment_sum = result.total;
    } catch (e) { if (s.current()) state.error = errorText(e); }
    finally { if (s.current()) state.loadingMore = false; }
  }
  function canWrite() { const s = capture(); return signedIn(s) && !!state.page && state.page.uid === s.uid && !state.loading && !state.loadingMore && !state.busy && !state.uncertain && !pending.has(identity(s, replyId)); }
  async function mutate(kind: 'comment' | 'praise', commentId: number | null, praised = false) {
    if (!canWrite()) return;
    const s = capture(), id = replyId, key = identity(s, id);
    if (commentId !== null && !state.comments.some(c => c.id === commentId || c.children?.id === commentId)) return;
    let content = ''; if (kind === 'comment') { try { content = publicReviewCommentContent(state.content); } catch { state.error = '请填写1至1000字回复'; return; } }
    if (pending.size >= 256) { state.error = '待核对操作过多，请先核对之前的评价'; return; }
    const mark: PendingReviewAction = { inFlight: true, kind, commentId }; pending.set(key, mark); state.busy = true; state.error = ''; state.message = ''; state.checked = false;
    let confirmed = false;
    try {
      if (kind === 'comment') parsePublicReviewCommentAck(await dep.comment(id, content), id, s.uid);
      else parsePublicReviewPraiseAck(await dep.praise(id, commentId, praised), id, commentId, praised, s.uid);
      confirmed = true;
    } catch (e) { if (s.current()) { state.error = errorText(e); state.uncertain = true; state.message = '操作结果未确认，请刷新核对；不会自动再次提交'; } }
    finally { mark.inFlight = false; if (s.current()) { state.busy = false; if (confirmed && pending.get(key) === mark) pending.delete(key); } }
    if (!confirmed || !s.current()) return;
    if (kind === 'comment') state.content = '';
    const owner = dep.capture(); await load();
    if (owner.current() && replyId === id && state.page?.uid === s.uid && state.page.replyId === id) state.message = kind === 'comment' ? '回复已发布' : praised ? '已点赞' : '已取消点赞';
  }
  function finishUncertain() {
    const s = capture(), key = identity(s, replyId), mark = pending.get(key);
    if (!signedIn(s) || !state.page || state.loading || state.loadingMore || state.busy || !state.checked || !mark || mark.inFlight) return;
    pending.delete(key); state.uncertain = false; state.checked = false; state.content = ''; state.error = ''; state.message = '本次操作已结束；如需发表新回复，请重新填写';
  }
  return { clear, suspend: clear, setReview, load, loadMore, canWrite, finishUncertain,
    canFinishUncertain: () => state.checked && state.uncertain && !state.loading && !state.loadingMore && !state.busy && !pending.get(identity(dep.capture(), replyId))?.inFlight,
    submit: () => mutate('comment', null),
    toggleReviewPraise: () => state.page ? mutate('praise', null, !state.page.detail.is_praise) : Promise.resolve(),
    toggleCommentPraise: (id: number) => { const node = state.comments.flatMap(c => c.children ? [c, c.children] : [c]).find(c => c.id === id); return node ? mutate('praise', id, !node.is_praise) : Promise.resolve(); },
    hasMore: () => !!state.page && state.comments.length < state.commentsTotal };
}
