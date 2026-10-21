import { ref } from 'vue';
import { RequestError } from '@/utils/request';
import { apiCouponReceive } from '@/api/activity';
import { commerceInteger, commerceRecord, type CommerceCoupon } from './diyCommerceData';

interface ClaimJournal { version: 1; actor: number; issue: number; attempt: string; state: 'unknown' | 'acknowledged' | 'owned'; couponUserId: number | null }
export const diyCouponClaimRevision = ref(0);
const pending = new Map<string, Promise<void>>();
let serial = 0;
export const diyCouponClaimKey = (actor: number, issue: number) => `cinashop_diy_coupon_claim_v1_${commerceInteger(actor, 1)}_${commerceInteger(issue, 1)}`;
function read(actor: number, issue: number): ClaimJournal | null {
  const raw = uni.getStorageSync(diyCouponClaimKey(actor, issue));
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 1024) throw Error('领券恢复资料无效，请到优惠券中心核对');
  const row = commerceRecord(JSON.parse(raw));
  if (Object.keys(row).sort().join(',') !== 'actor,attempt,couponUserId,issue,state,version' || row.version !== 1 || row.actor !== actor || row.issue !== issue
    || typeof row.attempt !== 'string' || !/^\d{1,16}:\d{1,12}$/u.test(row.attempt) || !['unknown', 'acknowledged', 'owned'].includes(row.state as string)
    || row.state === 'acknowledged' && (!Number.isSafeInteger(row.couponUserId) || Number(row.couponUserId) < 1)
    || row.state !== 'acknowledged' && row.couponUserId !== null) throw Error('领券恢复资料无效，请到优惠券中心核对');
  return row as unknown as ClaimJournal;
}
function save(row: ClaimJournal) { uni.setStorageSync(diyCouponClaimKey(row.actor, row.issue), JSON.stringify(row)); diyCouponClaimRevision.value++; }
export function diyCouponClaimState(actor: number, issue: number): '' | ClaimJournal['state'] | 'pending' | 'invalid' {
  void diyCouponClaimRevision.value;
  if (actor < 1) return '';
  try { const key = diyCouponClaimKey(actor, issue); return pending.has(key) ? 'pending' : read(actor, issue)?.state ?? ''; } catch { return 'invalid'; }
}
/** Persist the uncertain intent before dispatch. A hidden/remounted block cannot replay it. */
export async function claimDiyCoupon(actor: number, issue: number): Promise<void> {
  const key = diyCouponClaimKey(actor, issue);
  if (pending.has(key)) return pending.get(key)!;
  if (read(actor, issue)) throw Error('该优惠券已有领取记录，请只读核对，不要重复提交');
  const journal: ClaimJournal = { version: 1, actor, issue, attempt: `${Date.now()}:${++serial}`, state: 'unknown', couponUserId: null };
  save(journal);
  const task = (async () => {
    try {
      const receipt = commerceRecord(await apiCouponReceive(issue)), id = commerceInteger(receipt.couponUserId, 1);
      const latest = read(actor, issue);
      if (latest?.attempt === journal.attempt) save({ ...journal, state: 'acknowledged', couponUserId: id });
    } catch (error) {
      // This controller emits status400 only for a rejected input/rolled-back
      // ValidateException. Transport, 5xx, malformed and stale-owner replies stay unknown.
      if (error instanceof RequestError && error.status === 400 && error.httpStatus === 200) {
        const latest = read(actor, issue);
        if (latest?.attempt === journal.attempt && latest.state === 'unknown') { uni.removeStorageSync(key); diyCouponClaimRevision.value++; }
      }
      throw error;
    } finally { pending.delete(key); diyCouponClaimRevision.value++; }
  })();
  pending.set(key, task); diyCouponClaimRevision.value++;
  return task;
}
/** Ownership proves current possession, not that the uncertain POST itself succeeded. */
export function reconcileDiyCouponClaims(actor: number, coupons: CommerceCoupon[]) {
  if (actor < 1) return;
  for (const coupon of coupons) {
    if (coupon.is_use !== true) continue;
    try { const journal = read(actor, coupon.id); if (journal?.state === 'unknown') save({ ...journal, state: 'owned', couponUserId: null }); } catch { /* Invalid journals remain locked for explicit wallet inspection. */ }
  }
}
