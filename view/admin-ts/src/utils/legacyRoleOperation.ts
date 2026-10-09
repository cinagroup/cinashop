import { parseRolePending, parseRoleReceipt, type LegacyRolePending, type LegacyRoleReceipt } from '@/api/legacyRole';

export const rolePendingKey = (actor: number) => `admin_legacy_role_pending_v1:${actor}`;
export type RoleStamp = { generation: number; identity: string; session: string | null; actor: number };
export type RoleJob = { stamp: RoleStamp; controller: AbortController };
/** Captures token + actor + live permission identity; old requests never mutate a replacement session. */
export class RoleRequestScope {
  private generation = 0;
  private alive = true;
  private jobs = new Map<string, RoleJob>();
  constructor(private identity: () => string, private session: () => string | null, private actor: () => number) {}
  stamp(): RoleStamp { return { generation: this.generation, identity: this.identity(), session: this.session(), actor: this.actor() }; }
  current(stamp: RoleStamp): boolean {
    return this.alive && stamp.actor > 0 && stamp.actor === this.actor() && stamp.generation === this.generation && stamp.identity === this.identity() && stamp.session === this.session();
  }
  begin(channel: string): RoleJob {
    this.jobs.get(channel)?.controller.abort();
    const job = { stamp: this.stamp(), controller: new AbortController() }; this.jobs.set(channel, job); return job;
  }
  valid(channel: string, job: RoleJob): boolean { return this.jobs.get(channel) === job && this.current(job.stamp); }
  finish(channel: string, job: RoleJob): boolean { if (this.jobs.get(channel) !== job) return false; this.jobs.delete(channel); return true; }
  invalidate() { this.generation++; for (const job of this.jobs.values()) job.controller.abort(); this.jobs.clear(); }
  dispose() { this.invalidate(); this.alive = false; }
}
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Lock = <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
export const roleBrowserLock: Lock = async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
  if (!globalThis.navigator?.locks) return Promise.reject(Error('浏览器无法提供可靠的多窗口提交锁，请更换支持安全存储的浏览器'));
  return await navigator.locks.request(name, { mode: 'exclusive' }, async () => await run());
};
/** Only the seven recovery fields reach storage. Passwords, draft fields, revision and bearer never do. */
export class RolePendingStore {
  constructor(private storage: Storage, private lock: Lock = roleBrowserLock) {}
  read(actor: number): LegacyRolePending | null {
    const raw = this.storage.getItem(rolePendingKey(actor)); return raw === null ? null : parseRolePending(JSON.parse(raw), actor);
  }
  async reserve(value: LegacyRolePending, current: () => boolean): Promise<void> {
    parseRolePending(value, value.actor_id);
    await this.lock(rolePendingKey(value.actor_id), () => {
      if (!current()) throw Error('登录身份已变化，请重新预览');
      const key = rolePendingKey(value.actor_id), raw = JSON.stringify(value);
      if (this.storage.getItem(key) !== null) throw Error('已有待确认操作，请先查询原回执');
      this.storage.setItem(key, raw);
      if (this.storage.getItem(key) !== raw) throw Error('无法可靠保存待确认记录，未提交');
    });
  }
  async finish(receipt: LegacyRoleReceipt, expected: LegacyRolePending, current: () => boolean): Promise<boolean> {
    parseRoleReceipt(receipt, expected);
    if (receipt.state === 'unknown') return false;
    // The transport parser has validated the full receipt; this guard also refuses accidental foreign calls.
    if (receipt.operation_id !== expected.operation_id || receipt.actor_id !== expected.actor_id || receipt.operation !== expected.operation
      || receipt.state === 'committed' && receipt.request_hash !== expected.request_hash) throw Error('原回执不匹配，不能解除待确认记录');
    return this.lock(rolePendingKey(expected.actor_id), () => {
      if (!current()) return false;
      const saved = this.read(expected.actor_id);
      if (!saved || JSON.stringify(saved) !== JSON.stringify(expected)) throw Error('恢复记录已变化，请保留记录并核对');
      this.storage.removeItem(rolePendingKey(expected.actor_id));
      if (this.storage.getItem(rolePendingKey(expected.actor_id)) !== null) throw Error('恢复记录未能安全清除');
      return true;
    });
  }
}
