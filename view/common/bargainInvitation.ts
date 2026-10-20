import { bargainId } from './bargainPurchase';
import { seckillImage } from './seckillPurchase';

export interface BargainHelpProgress {
  id: number; status: number; state: 'cutting' | 'ready' | 'closed' | 'used';
  original_price: string; minimum_price: string; cut_price: string; current_price: string;
  remaining_cut: string; progress_percent: number;
}
export interface BargainFriendView {
  help_only: true; type: 2; bargain_id: number; participant_id: number; product_id: number; title: string; image: string;
  owner: { nickname: string; avatar: string }; is_owner: boolean; participation: BargainHelpProgress;
  start_time: string | null; stop_time: string | null; date_window: 'future' | 'active' | 'ended';
  people: number; help_count: number; already_helped: boolean; remaining_helper_uses: number; in_stock: boolean;
  can_help: boolean; help_state: string;
}
const invalid = (): never => { throw Error('砍价邀请数据无效，请刷新或重新打开邀请'); };
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function integer(value: unknown, min = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 2147483647 ? value : invalid();
}
function text(value: unknown, max = 255): string {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : invalid();
}
function flag(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid(); }
function money(value: unknown): string { const raw = text(value); return /^\d{1,10}\.\d{2}$/.test(raw) ? raw : invalid(); }
function cents(value: string): number { const [whole, fraction] = value.split('.'); return Number(whole) * 100 + Number(fraction); }
function decimal(value: number): string { return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`; }
function date(value: unknown): string | null {
  if (value === null) return null;
  const raw = text(value); return /^\d{4}-\d{2}-\d{2}T.*Z$/.test(raw) && Number.isFinite(Date.parse(raw)) ? raw : invalid();
}

export function bargainInvitationPath(activityId: number, participantId = 0): string {
  integer(activityId, 1); integer(participantId);
  return `/pages/activity/bargainDetail?id=${activityId}${participantId ? `&bargainUserId=${participantId}&help=1` : ''}`;
}
/** Native runtimes do not need browser URL globals for a fixed invitation. */
export function bargainShareTarget(path: string): { id: number; bargainUserId?: number } | null {
  const match = /^\/pages\/activity\/bargainDetail\?id=([1-9]\d{0,9})(?:&bargainUserId=([1-9]\d{0,9})&help=1)?$/.exec(path);
  if (!match) return null;
  try { return { id: bargainId(match[1]), ...(match[2] ? { bargainUserId: bargainId(match[2]) } : {}) }; }
  catch { return null; }
}
export function parseBargainRoute(query: Record<string, unknown> = {}) {
  if (Object.keys(query).some(key => !['id', 'bargain_id', 'bargainUserId', 'help', 'spid', 'mine'].includes(key))) return invalid();
  if (query.mine !== undefined) {
    if (query.mine !== '1' || ['id', 'bargain_id', 'bargainUserId', 'help', 'spid'].some(key => query[key] !== undefined)) return invalid();
    return { activityId: 0, participantId: 0, ownerUid: 0, help: false, mine: true };
  }
  const activityId = bargainId(query.id ?? query.bargain_id);
  if (query.id !== undefined && query.bargain_id !== undefined && bargainId(query.bargain_id) !== activityId) return invalid();
  const participantId = query.bargainUserId === undefined ? 0 : bargainId(query.bargainUserId);
  if (query.help !== undefined && (query.help !== '1' || !participantId)) return invalid();
  const referrer = query.spid === undefined ? 0 : bargainId(query.spid);
  // PHP owner links used bargain_id + spid. Once resolved, callers retain the
  // exact returned participation; canonical id links keep spid as referral only.
  const ownerUid = query.id === undefined && query.bargain_id !== undefined && !participantId ? referrer : 0;
  return { activityId, participantId, ownerUid, help: query.help === '1' || ownerUid > 0, mine: false };
}
export function parseBargainFriendView(value: unknown, activityId: number, participantId = 0): BargainFriendView {
  integer(activityId, 1); integer(participantId);
  const row = object(value), exact = integer(row.participant_id, 1);
  if (row.help_only !== true || row.type !== 2 || row.bargain_id !== activityId || participantId && exact !== participantId
    || row.selection_only !== undefined || row.skus !== undefined || row.can_select !== undefined) return invalid();
  const p = object(row.participation), status = integer(p.status, 1);
  if (status > 4 || p.id !== exact) return invalid();
  const original = money(p.original_price), minimum = money(p.minimum_price), cut = money(p.cut_price);
  const capacity = cents(original) - cents(minimum), remaining = capacity - cents(cut);
  if (capacity < 0 || remaining < 0 || status === 3 && remaining !== 0) return invalid();
  const state = status === 4 ? 'used' : status === 2 ? 'closed' : remaining === 0 ? 'ready' : 'cutting';
  const percent = capacity === 0 ? 100 : Math.floor(cents(cut) * 100 / capacity);
  if (p.state !== state || p.current_price !== decimal(cents(original) - cents(cut))
    || p.remaining_cut !== decimal(remaining) || p.progress_percent !== percent) return invalid();
  const start = date(row.start_time), stop = date(row.stop_time), window = text(row.date_window);
  if (!['future', 'active', 'ended'].includes(window) || start && stop && Date.parse(start) > Date.parse(stop)) return invalid();
  const owner = object(row.owner), isOwner = flag(row.is_owner), helped = flag(row.already_helped), stock = flag(row.in_stock);
  const people = integer(row.people, 1), count = integer(row.help_count), uses = integer(row.remaining_helper_uses);
  const helpState = window !== 'active' ? window : state !== 'cutting' ? state : isOwner ? 'owner' : !stock ? 'sold_out'
    : helped ? 'already_helped' : uses === 0 ? 'limit_reached' : count >= people ? 'people_full' : 'available';
  if (row.help_state !== helpState || row.can_help !== (helpState === 'available')) return invalid();
  return { help_only: true, type: 2, bargain_id: activityId, participant_id: exact, product_id: integer(row.product_id, 1),
    title: text(row.title), image: seckillImage(row.image), owner: { nickname: text(owner.nickname, 128), avatar: seckillImage(owner.avatar) },
    is_owner: isOwner, participation: { id: exact, status, state, original_price: original, minimum_price: minimum,
      cut_price: cut, current_price: money(p.current_price), remaining_cut: money(p.remaining_cut), progress_percent: percent },
    start_time: start, stop_time: stop, date_window: window as BargainFriendView['date_window'],
    people, help_count: count, already_helped: helped, remaining_helper_uses: uses, in_stock: stock,
    can_help: flag(row.can_help), help_state: helpState };
}
export function bargainFriendOpen(view: BargainFriendView, now = Date.now()): boolean {
  return view.date_window === 'active' && (!view.start_time || Date.parse(view.start_time) <= now)
    && (!view.stop_time || Date.parse(view.stop_time) >= now);
}
