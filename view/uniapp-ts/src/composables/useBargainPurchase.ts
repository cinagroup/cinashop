import { computed, ref, shallowRef, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiBargainSelection, apiBargainFriendView, apiMyBargains, apiBargainStart, apiBargainHelp } from '@/api/bargain';
import { apiCartAdd } from '@/api/order';
import { RequestError } from '@/utils/request';
import { bargainPage, bargainOpen, bargainCartInput, bargainCheckoutQuery,
  type BargainSelection, type MyBargain } from '../../../common/bargainPurchase';
import { parseBargainRoute, bargainInvitationPath, bargainFriendOpen, type BargainFriendView } from '../../../common/bargainInvitation';

export function useBargainPurchase() {
  const auth = useAuthStore(), activityId = ref(0), participantId = ref(0), mine = ref(false), visible = ref(false);
  const helpMode = ref(false), legacyOwner = ref(0), friend = shallowRef<BargainFriendView | null>(null);
  const detail = shallowRef<BargainSelection | null>(null), records = shallowRef<MyBargain[]>([]), page = ref(1);
  const selected = ref(''), quantity = ref<number | string>(1), loading = ref(false), buying = ref(false), navigating = ref(false);
  const error = ref(''), prepared = ref<{ id: number; participantId: number } | null>(null), clock = ref(Date.now());
  let generation = 0, navigationRevision = 0, pageRevision = 0, disposed = false, timer: ReturnType<typeof setInterval> | undefined;
  type Intent = { id: number; participantId: number; unique: string; quantity: number; owner: number };
  let loginSelection: Intent | null = null;
  const loggedIn = computed(() => auth.isLoggedIn);
  const selectedSku = computed(() => detail.value?.skus.find(s => s.unique === selected.value));
  const open = computed(() => !!detail.value && bargainOpen(detail.value, clock.value));
  const sharePath = computed(() => !mine.value && (friend.value || detail.value)
    ? bargainInvitationPath(activityId.value, friend.value?.participant_id || detail.value?.participation?.id || 0) : '');
  const locked = computed(() => buying.value || navigating.value || prepared.value !== null);
  const canBuy = computed(() => visible.value && !mine.value && !helpMode.value && loggedIn.value && !loading.value && !buying.value && !navigating.value &&
    (prepared.value !== null || !!detail.value?.can_select && open.value && !!selectedSku.value &&
      typeof quantity.value === 'number' && Number.isSafeInteger(quantity.value) && quantity.value > 0 && quantity.value <= selectedSku.value.max_quantity));
  const canStart = computed(() => visible.value && !mine.value && !helpMode.value && loggedIn.value && !loading.value && !locked.value && open.value && !detail.value?.participation && !participantId.value);
  const canHelp = computed(() => visible.value && !mine.value && !helpMode.value && loggedIn.value && !loading.value && !locked.value && open.value && detail.value?.participation?.state === 'cutting');
  const canHelpFriend = computed(() => visible.value && helpMode.value && loggedIn.value && !loading.value && !locked.value
    && !!friend.value?.can_help && bargainFriendOpen(friend.value, clock.value));
  function reset() {
    generation++; navigationRevision++; navigating.value = false; loading.value = false;
    detail.value = null; friend.value = null; records.value = []; selected.value = ''; quantity.value = 1; prepared.value = null;
    // A pending mutation keeps its gate until its own finally, including across hide/show.
  }
  function choose(key: string) {
    if (!visible.value || loading.value || locked.value || !detail.value?.skus.some(s => s.unique === key && s.max_quantity > 0)) return;
    selected.value = key; quantity.value = 1; error.value = '';
  }
  async function load(targetPage = page.value) {
    if (!visible.value || disposed || locked.value || (!mine.value && !activityId.value)) return;
    const current = ++generation;
    loading.value = true; error.value = ''; detail.value = null; friend.value = null; records.value = []; selected.value = ''; quantity.value = 1;
    try {
      if (mine.value) {
        page.value = bargainPage(targetPage);
        const result = await apiMyBargains(page.value);
        if (current === generation && visible.value && !disposed) records.value = result;
      } else if (helpMode.value) {
        const result = await apiBargainFriendView(activityId.value, participantId.value, legacyOwner.value);
        if (current !== generation || !visible.value || disposed) return;
        // A legacy owner link resolves only once. Refresh/login return cannot
        // silently move this invitation to the owner's later participation.
        participantId.value = result.participant_id; legacyOwner.value = 0; friend.value = result;
      } else {
        const result = await apiBargainSelection(activityId.value, participantId.value);
        if (current !== generation || !visible.value || disposed) return;
        detail.value = result;
        const resume = loginSelection; loginSelection = null;
        if (resume?.id === result.bargain_id && resume.participantId === participantId.value && (!resume.owner || resume.owner === auth.uid)) {
          const sku = result.skus.find(s => s.unique === resume.unique && s.max_quantity > 0);
          if (sku) { selected.value = sku.unique; quantity.value = resume.quantity;
            if (resume.quantity > sku.max_quantity) error.value = '返回时库存或限购已变化，请重新确认数量';
          } else if (resume.unique) error.value = '原规格已失效，请重新选择';
        }
      }
    } catch (e) { if (current === generation && visible.value) error.value = e instanceof Error ? e.message : '砍价加载失败，请重试'; }
    finally { if (current === generation && visible.value) loading.value = false; }
  }
  function navigate(url: string, onFailure: () => void) {
    const current = generation, revision = ++navigationRevision;
    navigating.value = true;
    const fail = () => { if (current === generation && revision === navigationRevision && visible.value && !disposed) { navigating.value = false; onFailure(); } };
    try { uni.navigateTo({ url, fail }); } catch { fail(); }
  }
  function intent(): Intent {
    return { id: activityId.value, participantId: participantId.value || detail.value?.participation?.id || 0,
      unique: selected.value, quantity: Number(quantity.value), owner: auth.isLoggedIn ? auth.uid : 0 };
  }
  function login() {
    if (!visible.value || locked.value || loading.value || loggedIn.value) return;
    loginSelection = helpMode.value ? null : intent();
    navigate('/pages/auth/login', () => { loginSelection = null; error.value = '登录页面打开失败，请重试'; });
  }
  function goMine() {
    if (!visible.value || locked.value || loading.value) return;
    navigate('/pages/activity/bargainDetail?mine=1', () => { error.value = '我的砍价页面打开失败，请重试'; });
  }
  function goOwn() {
    if (!visible.value || !friend.value || loading.value || locked.value) return;
    const exact = friend.value.is_owner ? `&bargainUserId=${friend.value.participant_id}` : '';
    navigate(`/pages/activity/bargainDetail?id=${activityId.value}${exact}`, () => { error.value = '本人砍价页面打开失败，请重试'; });
  }
  function chooseRecord(id: number) {
    if (!visible.value || !mine.value || loading.value || locked.value || !loggedIn.value) return;
    const row = records.value.find(r => r.id === id); if (!row) return;
    navigate(`/pages/activity/bargainDetail?id=${row.activityId}&bargainUserId=${row.id}`, () => { error.value = '详情页面打开失败，请重试'; });
  }
  function goCheckout() {
    if (!prepared.value) return;
    const query = bargainCheckoutQuery(prepared.value.id, prepared.value.participantId);
    navigate(`/pages/order/confirm?${Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`,
      () => { error.value = '结算页面打开失败，可继续结算，无需重新加购'; });
  }
  async function purchase() {
    if (!canBuy.value) return;
    if (prepared.value) { goCheckout(); return; }
    if (!detail.value) return;
    const current = generation, revision = pageRevision, version = auth.sessionVersion, submitted = intent();
    buying.value = true; error.value = '';
    try {
      const input = bargainCartInput(detail.value, submitted.unique, submitted.quantity);
      const result = await apiCartAdd(input);
      if (current !== generation || !visible.value || disposed) return;
      if (!result || !Number.isSafeInteger(result.id) || result.id < 1 || result.id > 2_147_483_647) throw new Error('购买记录响应无效，请刷新确认');
      prepared.value = { id: result.id, participantId: input.bargainUserId }; goCheckout();
    } catch (e) {
      if (e instanceof RequestError && e.status !== undefined && [410000, 410001, 410002].includes(e.status) &&
        !disposed && revision === pageRevision && !auth.isLoggedIn && auth.sessionVersion === version + 1 && activityId.value === submitted.id) {
        participantId.value = submitted.participantId; loginSelection = submitted;
      }
      if (current === generation && visible.value) { detail.value = null; selected.value = ''; error.value = e instanceof Error ? e.message : '加购结果未知，请刷新确认，勿重复提交'; }
    } finally { buying.value = false; }
  }
  async function mutate(kind: 'start' | 'help') {
    if (kind === 'start' ? !canStart.value : !canHelp.value) return;
    if (!detail.value || !bargainOpen(detail.value)) { error.value = '活动已到期，请刷新确认'; return; }
    const current = generation;
    buying.value = true; error.value = '';
    try {
      if (kind === 'start') {
        const result = await apiBargainStart(activityId.value);
        if (current !== generation || !visible.value || disposed) return;
        if (!result || !Number.isSafeInteger(result.id) || result.id < 1 || result.id > 2_147_483_647) throw new Error('发起结果无效，请到我的砍价确认');
        participantId.value = result.id;
      } else await apiBargainHelp(detail.value.participation!.id);
      if (current !== generation || !visible.value || disposed) return;
      // Persist start identity before reloading; a failed read must not repeat the write.
      buying.value = false; await load();
    } catch (e) {
      if (current === generation && visible.value) { detail.value = null; selected.value = ''; error.value = e instanceof Error ? e.message : '操作结果未知，请到我的砍价刷新确认'; }
    } finally { buying.value = false; }
  }
  async function helpFriend() {
    if (!canHelpFriend.value || !friend.value) return;
    if (!bargainFriendOpen(friend.value)) { friend.value = null; error.value = '活动已到期，请刷新确认'; return; }
    const current = generation, exact = friend.value.participant_id;
    buying.value = true; error.value = '';
    try {
      await apiBargainHelp(exact);
      if (current !== generation || !visible.value || disposed) return;
      buying.value = false; await load();
    } catch (e) {
      if (current === generation && visible.value) {
        friend.value = null; error.value = e instanceof Error ? e.message : '帮砍结果未知，请刷新确认，勿重复提交';
      }
    } finally { buying.value = false; }
  }
  function suspend() { visible.value = false; reset(); if (timer) { clearInterval(timer); timer = undefined; } }
  watch(() => auth.sessionVersion, () => {
    if (visible.value) loginSelection = null;
    reset(); error.value = '登录状态已变化，请刷新砍价';
  }, { flush: 'sync' });
  let routeSignature = '';
  function applyRoute(query: Record<string, unknown> | undefined, fromLocation = false) {
    try {
      const parsed = parseBargainRoute(query), signature = JSON.stringify(parsed);
      if (fromLocation && signature === routeSignature) return;
      reset(); pageRevision++; loginSelection = null; page.value = 1; routeSignature = signature;
      activityId.value = parsed.activityId; participantId.value = parsed.participantId; mine.value = parsed.mine;
      helpMode.value = parsed.help; legacyOwner.value = parsed.ownerUid;
      error.value = '';
      if (fromLocation && visible.value) void load();
    } catch {
      reset(); pageRevision++; loginSelection = null; routeSignature = '';
      activityId.value = 0; participantId.value = 0; legacyOwner.value = 0; helpMode.value = false; mine.value = false;
      error.value = '砍价链接标识无效，请返回活动列表';
    }
  }
  function locationQuery(): Record<string, unknown> | null {
    if (typeof window === 'undefined') return null;
    const raw = window.location.hash.replace(/^#/, ''), at = raw.indexOf('?');
    if ((at < 0 ? raw : raw.slice(0, at)) !== '/pages/activity/bargainDetail') return null;
    const query: Record<string, unknown> = {};
    for (const pair of at < 0 ? [] : raw.slice(at + 1).split('&')) {
      const index = pair.indexOf('='), decode = (value: string) => decodeURIComponent(value.replace(/\+/g, ' '));
      const key = decode(index < 0 ? pair : pair.slice(0, index));
      if (Object.hasOwn(query, key)) throw Error('Duplicate bargain route parameter');
      query[key] = decode(index < 0 ? '' : pair.slice(index + 1));
    }
    return query;
  }
  function routeChanged() {
    if (!visible.value || disposed) return;
    try { const query = locationQuery(); if (query !== null) applyRoute(query, true); }
    catch { applyRoute(undefined); }
  }
  if (typeof window !== 'undefined') window.addEventListener?.('hashchange', routeChanged);
  onLoad(query => {
    try { applyRoute(locationQuery() ?? query); } catch { applyRoute(undefined); }
  });
  onShow(() => {
    if (disposed) return;
    visible.value = true; clock.value = Date.now();
    if (timer) clearInterval(timer);
    timer = setInterval(() => { clock.value = Date.now(); }, 1000); void load();
  });
  onHide(suspend); onUnload(() => {
    disposed = true; pageRevision++; loginSelection = null; suspend();
    if (typeof window !== 'undefined') window.removeEventListener?.('hashchange', routeChanged);
  });
  return { activityId, participantId, mine, records, page, loggedIn, visible, detail, selected, quantity, loading, buying, navigating, error,
    prepared, selectedSku, open, locked, canBuy, canStart, canHelp, choose, load, login, goMine, chooseRecord, purchase,
    helpMode, friend, sharePath, canHelpFriend, helpFriend, goOwn,
    startBargain: () => mutate('start'), helpSelf: () => mutate('help') };
}
