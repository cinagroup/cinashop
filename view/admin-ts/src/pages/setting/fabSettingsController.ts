export interface FabRequestStamp { epoch: number; identity: string; stored: string | null }
export interface FabRequestJob { stamp: FabRequestStamp; controller: AbortController }
/** Every list/write/receipt owns an abortable generation; actor/permission changes invalidate all replies. */
export class FabRequestScope {
  private epoch = 0;
  private alive = true;
  private jobs = new Map<string, FabRequestJob>();
  constructor(private readonly identity: () => string, private readonly stored: () => string | null, private readonly authorized: () => boolean) {}
  stamp(): FabRequestStamp { return { epoch: this.epoch, identity: this.identity(), stored: this.stored() }; }
  current(stamp: FabRequestStamp): boolean { return this.alive && this.authorized() && stamp.epoch === this.epoch && stamp.identity === this.identity() && stamp.stored === this.stored(); }
  begin(channel: string): FabRequestJob { this.jobs.get(channel)?.controller.abort(); const job = { stamp: this.stamp(), controller: new AbortController() }; this.jobs.set(channel, job); return job; }
  valid(channel: string, job: FabRequestJob): boolean { return this.jobs.get(channel) === job && this.current(job.stamp); }
  finish(channel: string, job: FabRequestJob): boolean { if (!this.valid(channel, job)) return false; this.jobs.delete(channel); return true; }
  invalidate(): void { this.epoch++; for (const job of this.jobs.values()) job.controller.abort(); this.jobs.clear(); }
  dispose(): void { this.alive = false; this.invalidate(); }
}
