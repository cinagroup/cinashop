import { parseStaffPending, parseStaffReceipt, type LegacyStaffPending, type LegacyStaffReceipt } from '@/api/legacyAdmin';

export const staffPendingKey = (actor: number) => `admin_legacy_staff_pending_v1:${actor}`;
export type StaffStamp = { generation: number; identity: string; session: string | null; actor: number };
export type StaffJob = { stamp: StaffStamp; controller: AbortController };
/** Captures token + actor + live permission identity; old requests never mutate a replacement session. */
export class StaffRequestScope {
  private generation = 0;
  private alive = true;
  private jobs = new Map<string, StaffJob>();
  constructor(private identity: () => string, private session: () => string | null, private actor: () => number) {}
  stamp(): StaffStamp { return { generation: this.generation, identity: this.identity(), session: this.session(), actor: this.actor() }; }
  current(stamp: StaffStamp): boolean {
    return this.alive && stamp.actor > 0 && stamp.actor === this.actor() && stamp.generation === this.generation && stamp.identity === this.identity() && stamp.session === this.session();
  }
  begin(channel: string): StaffJob {
    this.jobs.get(channel)?.controller.abort();
    const job = { stamp: this.stamp(), controller: new AbortController() }; this.jobs.set(channel, job); return job;
  }
  valid(channel: string, job: StaffJob): boolean { return this.jobs.get(channel) === job && this.current(job.stamp); }
  finish(channel: string, job: StaffJob): boolean { if (this.jobs.get(channel) !== job) return false; this.jobs.delete(channel); return true; }
  invalidate() { this.generation++; for (const job of this.jobs.values()) job.controller.abort(); this.jobs.clear(); }
  dispose() { this.invalidate(); this.alive = false; }
}
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Lock = <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
export const staffBrowserLock: Lock = async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
  if (!globalThis.navigator?.locks) return Promise.reject(Error('浏览器无法提供可靠的多窗口提交锁，请更换支持安全存储的浏览器'));
  return await navigator.locks.request(name, { mode: 'exclusive' }, async () => await run());
};
/** Only the seven recovery fields reach storage. Passwords, draft fields, revision and bearer never do. */
export class StaffPendingStore {
  constructor(private storage: Storage, private lock: Lock = staffBrowserLock) {}
  read(actor: number): LegacyStaffPending | null {
    const raw = this.storage.getItem(staffPendingKey(actor)); return raw === null ? null : parseStaffPending(JSON.parse(raw), actor);
  }
  async reserve(value: LegacyStaffPending, current: () => boolean): Promise<void> {
    parseStaffPending(value, value.actor_id);
    await this.lock(staffPendingKey(value.actor_id), () => {
      if (!current()) throw Error('登录身份已变化，请重新预览');
      const key = staffPendingKey(value.actor_id), raw = JSON.stringify(value);
      if (this.storage.getItem(key) !== null) throw Error('已有待确认操作，请先查询原回执');
      this.storage.setItem(key, raw);
      if (this.storage.getItem(key) !== raw) throw Error('无法可靠保存待确认记录，未提交');
    });
  }
  async finish(receipt: LegacyStaffReceipt, expected: LegacyStaffPending, current: () => boolean): Promise<boolean> {
    parseStaffReceipt(receipt, expected);
    if (receipt.state === 'unknown') return false;
    // The transport parser has validated the full receipt; this guard also refuses accidental foreign calls.
    if (receipt.operation_id !== expected.operation_id || receipt.actor_id !== expected.actor_id || receipt.operation !== expected.operation
      || receipt.state === 'committed' && receipt.request_hash !== expected.request_hash) throw Error('原回执不匹配，不能解除待确认记录');
    return this.lock(staffPendingKey(expected.actor_id), () => {
      if (!current()) return false;
      const saved = this.read(expected.actor_id);
      if (!saved || JSON.stringify(saved) !== JSON.stringify(expected)) throw Error('恢复记录已变化，请保留记录并核对');
      this.storage.removeItem(staffPendingKey(expected.actor_id));
      if (this.storage.getItem(staffPendingKey(expected.actor_id)) !== null) throw Error('恢复记录未能安全清除');
      return true;
    });
  }
}
