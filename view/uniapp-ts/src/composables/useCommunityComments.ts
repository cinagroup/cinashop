import { useCommunityAvailability, isCommunityRejected } from '@/utils/communityAvailability';
import { computed, onScopeDispose, reactive, ref, shallowRef, watch, type ShallowRef } from 'vue';
import { onHide, onShow, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiCommunityCommentConfig, apiCommunityCommentPage, apiCommunityCommentCreate,
  apiCommunityCommentLike, apiCommunityCommentDelete, type CommunityThreadComment, type CommunityCommentConfig } from '@/api/community';

type Comment = CommunityThreadComment;
type Fence = { nonce: number; state: 'pending' | 'unknown'; inflight: boolean };
type Registry = { owner: string; fences: ShallowRef<Map<number, Fence>> };
// Only unresolved operation markers survive a component's destruction. No text,
// comments or account data are cached; an explicit reread reconciles a marker.
const registries = new WeakMap<object, Registry>();
let nextNonce = 0;
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= 2147483647;
const makePage = () => ({ rows: [] as Comment[], page: 0, count: 0, loading: false, error: '', finished: false, epoch: 0 });
type Pager = ReturnType<typeof makePage>;
type Replies = Pager & { expanded: boolean };

export function useCommunityComments() {
  const availability = useCommunityAvailability();
  const auth = useAuthStore(), postId = ref(0), publicPost = ref(false);
  const identity = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  let registry = registries.get(auth);
  if (!registry) { registry = { owner: identity(), fences: shallowRef(new Map<number, Fence>()) }; registries.set(auth, registry); }
  const shared = registry;
  if (shared.owner !== identity()) { shared.owner = identity(); shared.fences.value = new Map(); }
  const roots = reactive(makePage()), replies = reactive(new Map<number, Replies>());
  const config = ref<CommunityCommentConfig | null>(null), configLoading = ref(false), error = ref(''), message = ref('');
  const text = ref(''), target = ref<Comment | null>(null), deleteId = ref<number | null>(null);
  const countUpdate = ref<{ postId: number; count: number } | null>(null);
  let generation = 0, countSerial = 0, appliedCountSerial = 0, visible = true, disposed = false;
  let intent: { id: number; owner: string; post: number; generation: number; until: number } | undefined;
  const ownFences = () => shared.owner === identity() ? shared.fences.value : new Map<number, Fence>();
  const busy = computed(() => [...ownFences().values()].some(row => row.inflight));
  const unknown = computed(() => ownFences().get(postId.value)?.state === 'unknown');
  const enabled = computed(() => availability.allowed.value && config.value?.community_status === 1 && config.value.community_comment_status === 1);
  const loading = computed(() => configLoading.value || roots.loading || [...replies.values()].some(row => row.loading));
  const loggedIn = computed(() => auth.isLoggedIn && integer(auth.uid, 1));
  const canInteract = computed(() => visible && !disposed && postId.value > 0 && enabled.value && loggedIn.value && !busy.value && !unknown.value && !loading.value);
  const canAdd = computed(() => canInteract.value && publicPost.value && config.value?.community_comment_add === 1);
  const current = (revision: number, owner: string, id: number) => !disposed && visible && !availability.closed.value && revision === generation && owner === identity() && postId.value === id;
  function fence(id: number, value: Fence | null) {
    if (shared.owner !== identity()) return;
    const next = new Map(shared.fences.value); if (value) next.set(id, value); else next.delete(id); shared.fences.value = next;
  }
  function cancelDelete() { intent = undefined; deleteId.value = null; }
  function clearComposer() { text.value = ''; target.value = null; cancelDelete(); }
  function clearView() {
    generation++; Object.assign(roots, makePage()); replies.clear(); config.value = null; configLoading.value = false;
    error.value = ''; countUpdate.value = null; clearComposer();
  }
  function uncertainPending() {
    const pending = ownFences().get(postId.value);
    if (pending?.inflight) fence(postId.value, { ...pending, state: 'unknown' });
  }
  function reportCount(id: number, count: number, ticket = ++countSerial) {
    // Separate pagers may resolve out of order. A later issued read or an
    // accepted mutation must not be overwritten by an earlier read receipt.
    if (ticket < appliedCountSerial) return;
    appliedCountSerial = ticket; countUpdate.value = { postId: id, count };
  }
  function visibleRows(rows: Comment[]) {
    if (rows.some(row => row.isShow === 0 && !(loggedIn.value && row.type === 2 && row.uid === auth.uid))) throw Error('评论列表包含不可见内容，请刷新');
    return rows;
  }
  async function readPage(pager: Pager, replyId: number, next: number) {
    if (!visible || disposed || pager.loading || busy.value || !enabled.value || !integer(next, 1)) return false;
    const revision = generation, owner = identity(), id = postId.value, epoch = pager.epoch, ticket = ++countSerial;
    pager.loading = true; pager.error = '';
    try {
      const result = await apiCommunityCommentPage(id, next, replyId);
      if (!current(revision, owner, id) || pager.epoch !== epoch) return false;
      const rows = visibleRows(result.list), seen = new Set(pager.rows.map(row => row.id));
      // Validate all rows before committing any portion of a page.
      if (rows.some(row => row.isShow === 0 && row.type !== 2)) throw Error('评论身份无效');
      for (const row of rows) if (!seen.has(row.id)) { pager.rows.push(row); seen.add(row.id); }
      pager.page = next; pager.count = result.count;
      pager.finished = rows.length < 10 || next >= 2147483647 || next * 10 >= result.count;
      if (replyId) { const root = roots.rows.find(row => row.id === replyId); if (root) root.reply_count = result.count; }
      reportCount(id, result.post_comment_num, ticket);
      return true;
    } catch (cause) {
      if (current(revision, owner, id) && pager.epoch === epoch) pager.error = cause instanceof Error ? cause.message : '评论加载失败，请重试';
      return false;
    } finally { if (current(revision, owner, id) && pager.epoch === epoch) pager.loading = false; }
  }
  async function refresh(manual = true) {
    if (!availability.allowed.value || !visible || disposed || !integer(postId.value, 1) || busy.value || unknown.value && !manual) return false;
    clearView(); const revision = generation, owner = identity(), id = postId.value;
    configLoading.value = true;
    try {
      const settings = await apiCommunityCommentConfig();
      if (!current(revision, owner, id)) return false;
      config.value = settings; configLoading.value = false;
      if (!enabled.value) return false;
      const ok = await readPage(roots, 0, 1);
      if (ok && current(revision, owner, id) && manual && unknown.value) {
        fence(id, null); message.value = '已刷新，请核对评论结果。';
      }
      return ok;
    } catch (cause) {
      if (current(revision, owner, id)) error.value = cause instanceof Error ? cause.message : '评论开关加载失败，请刷新';
      return false;
    } finally { if (current(revision, owner, id)) configLoading.value = false; }
  }
  async function setContext(id: number, writable = true) {
    uncertainPending(); clearView(); message.value = '';
    postId.value = integer(id, 1) ? id : 0; publicPost.value = writable;
    if (postId.value && !unknown.value) await refresh(false);
  }
  async function loadMore() { if (!unknown.value && !roots.finished) await readPage(roots, 0, roots.page + 1); }
  function findRow(row: Comment) {
    const live = [...roots.rows, ...[...replies.values()].flatMap(page => page.rows)].find(item => item.id === row.id);
    return live?.communityId === postId.value ? live : undefined;
  }
  function own(row: Comment) { return row.type === 2 && loggedIn.value && row.uid === auth.uid; }
  function shown(row: Comment) { return row.isShow === 1 && row.isVerify === 1; }
  async function toggleReplies(row: Comment) {
    const root = roots.rows.find(item => item.id === row.id);
    if (!root || unknown.value || busy.value || !visible || disposed) return;
    let page = replies.get(root.id);
    if (page?.expanded) { page.epoch++; Object.assign(page, makePage(), { epoch: page.epoch, expanded: false }); return; }
    page = { ...makePage(), expanded: true }; replies.set(root.id, page);
    await readPage(replies.get(root.id)!, root.id, 1);
  }
  async function moreReplies(id: number) {
    const page = replies.get(id); if (!page?.expanded || unknown.value || page.finished) return;
    await readPage(page, id, page.page + 1);
  }
  function replyTo(row: Comment) {
    const live = findRow(row);
    if (!canAdd.value || !live || !shown(live)) return;
    if (live.isReply === 0 && !roots.rows.some(root => root.id === live.replyId && shown(root))) return;
    cancelDelete(); target.value = live;
  }
  function cancelReply() { target.value = null; }
  async function mutate<T>(work: () => Promise<T>, accept: (value: T) => boolean) {
    if (!canInteract.value) return;
    if (ownFences().size >= 64 && !ownFences().has(postId.value)) { error.value = '请先刷新此前未确认的评论操作'; return; }
    const revision = generation, owner = identity(), id = postId.value, nonce = ++nextNonce;
    fence(id, { nonce, state: 'pending', inflight: true }); cancelDelete(); error.value = ''; message.value = '';
    const unresolved = () => {
      if (owner !== identity() || shared.owner !== owner || ownFences().get(id)?.nonce !== nonce) return;
      fence(id, { nonce, state: 'unknown', inflight: false });
      if (postId.value === id && !disposed) { clearView(); message.value = ''; }
    };
    try {
      const result = await work();
      if (!current(revision, owner, id)) { unresolved(); return; }
      const reread = accept(result);
      if (ownFences().get(id)?.nonce === nonce) fence(id, null);
      if (reread) await refresh(false);
    } catch (cause) {
      if (owner !== identity() || shared.owner !== owner) return;
      const rejected = isCommunityRejected(cause);
      if (rejected) { if (ownFences().get(id)?.nonce === nonce) fence(id, null); if (current(revision, owner, id)) error.value = (cause as Error).message; }
      else unresolved();
    }
  }
  async function submit() {
    if (!canAdd.value) return;
    const content = text.value.trim(), selected = target.value && findRow(target.value);
    if (!content || content.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) {
      error.value = !content ? '请输入评论内容' : content.length > 1000 ? '评论内容不能超过1000个字符' : '评论包含不支持的控制字符'; return;
    }
    if (target.value && (!selected || !shown(selected) || selected.isReply === 0 && !roots.rows.some(root => root.id === selected.replyId && shown(root)))) {
      error.value = '回复目标已变化，请重新选择'; target.value = null; return;
    }
    const id = postId.value, targetId = selected?.id ?? 0;
    await mutate(() => apiCommunityCommentCreate(id, content, targetId), result => {
      if (!result || !integer(result.id, 1) || ![0, 1].includes(result.is_verify) || !integer(result.post_comment_num)) throw Error('评论回执格式错误');
      clearComposer(); reportCount(id, result.post_comment_num);
      message.value = result.is_verify === 1 ? '评论成功' : '评论已提交，等待审核'; return true;
    });
  }
  async function toggleLike(row: Comment) {
    const live = findRow(row);
    if (!canInteract.value || !publicPost.value || !live || !shown(live)
      || live.isReply === 0 && !roots.rows.some(root => root.id === live.replyId && shown(root))) return;
    const desired: 0 | 1 = live.isLike === 1 ? 0 : 1;
    await mutate(() => apiCommunityCommentLike(live.id, desired), result => {
      if (!result || !integer(result.likeNum) || result.status !== desired) throw Error('点赞回执格式错误');
      live.isLike = desired; live.likeNum = result.likeNum; return false;
    });
  }
  function requestDelete(row: Comment) {
    const live = findRow(row); if (!canInteract.value || !live || !own(live)) return;
    target.value = null; intent = { id: live.id, owner: identity(), post: postId.value, generation, until: Date.now() + 60000 }; deleteId.value = live.id;
  }
  async function confirmDelete() {
    const snapshot = intent, live = snapshot && [...roots.rows, ...[...replies.values()].flatMap(page => page.rows)].find(row => row.id === snapshot.id);
    if (!canInteract.value || !snapshot || snapshot.owner !== identity() || snapshot.generation !== generation || snapshot.post !== postId.value
      || snapshot.until < Date.now() || !live || !own(live)) { cancelDelete(); return; }
    await mutate(() => apiCommunityCommentDelete(snapshot.id), result => {
      if (result !== null) throw Error('删除回执格式错误');
      clearComposer(); message.value = '评论已删除'; return true;
    });
  }
  function openAuthor(row: Comment, replyTarget = false) {
    const live = findRow(row); if (!visible || disposed || !live || busy.value) return;
    const type = replyTarget ? live.comment_author_type : live.type, uid = replyTarget ? live.comment_author_uid : live.uid;
    if (type === 0 && uid === 0 || type === 2 && integer(uid, 1)) uni.navigateTo({ url: `/pages/discover/workspace?author_id=${uid}` });
  }
  function login() { if (visible && !disposed) uni.navigateTo({ url: '/pages/auth/login' }); }
  watch(availability.closed, closed => { if (closed) { uncertainPending(); clearView(); message.value = ''; } }, { flush: 'sync' });
  function leave() { uncertainPending(); visible = false; clearView(); message.value = ''; }
  function dispose() { leave(); disposed = true; }
  onHide(leave); onUnload(dispose); onScopeDispose(dispose);
  onShow(() => { const returning = !visible; visible = true; if (returning && !disposed && postId.value && !unknown.value) void refresh(false); });
  watch(identity, () => {
    shared.owner = identity(); shared.fences.value = new Map(); clearView(); message.value = '';
    error.value = '登录状态已变化，请刷新评论';
  }, { flush: 'sync' });
  return { availability, postId, roots, replies, config, configLoading, enabled, loading, busy, unknown, canInteract, canAdd, loggedIn,
    publicPost, error, message, text, target, deleteId, countUpdate, setContext, refresh, loadMore, toggleReplies, moreReplies,
    replyTo, cancelReply, submit, toggleLike, own, shown, requestDelete, cancelDelete, confirmDelete, openAuthor, login, dispose };
}
