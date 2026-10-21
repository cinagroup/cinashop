export interface ShareReferralSession { uid: number; token: string; version: number }
interface Pending { version: 1; source: string; spid: number; owner: number; sent: boolean; created: number }
const sourcePattern = /^(?:[a-f0-9]{24}|legacy:pages\/(?:index\/index|activity\/(?:seckillDetail|bargainDetail|detail|presaleDetail|newcomerDetail)):[1-9]\d{0,9}|community:[12]:[1-9]\d{0,9}:[1-9]\d{0,9})$/u;
const validSource = (source: string) => sourcePattern.test(source) && (!source.startsWith('community:')
  || source.split(':').slice(2).every(value => Number(value) <= 2147483647));
export interface ReferralStorage { get(): unknown; set(value: Pending): void }
/** One signed scene belongs to the first coherent login, including across page navigation/reload. */
export class ShareReferralIntent {
  private pending: Pending | null = null;
  private session: ShareReferralSession = { uid: 0, token: '', version: 0 };
  private generation = 0;
  notice = '';
  constructor(private storage: ReferralStorage, private bind: (uid: number) => Promise<unknown>, private now = () => Date.now()) {
    const raw = storage.get(); if (raw === undefined || raw === null || raw === '') return;
    const value = raw as Partial<Pending>;
    if (!value || value.version !== 1 || typeof value.source !== 'string' || !validSource(value.source) || !Number.isSafeInteger(value.spid) || !value.spid || value.spid < 0 || value.spid > 2147483647 || !Number.isSafeInteger(value.owner) || value.owner! < 0 || typeof value.sent !== 'boolean' || typeof value.created !== 'number' || !Number.isFinite(value.created)) throw Error('原推荐关系记录损坏，请保留记录核对');
    if (this.now() - value.created <= 30 * 86400000 && value.created <= this.now()) this.pending = { ...value } as Pending;
  }
  private save() { if (this.pending) { this.storage.set({ ...this.pending }); const result = this.storage.get(); if (JSON.stringify(result) !== JSON.stringify(this.pending)) throw Error('推荐关系保存未确认'); } }
  capture(source: string, spid: number) {
    if (!validSource(source) || !Number.isSafeInteger(spid) || spid < 1 || spid > 2147483647) throw Error('推荐关系无效');
    if (this.pending?.source === source) return;
    this.generation++; this.notice = '';
    this.pending = { version: 1, source, spid, owner: this.session.token && this.session.uid > 0 ? this.session.uid : 0, sent: false, created: this.now() }; this.save();
  }
  update(session: ShareReferralSession) {
    const changed = session.uid !== this.session.uid || session.token !== this.session.token || session.version !== this.session.version;
    this.session = { ...session }; if (changed) { this.generation++; this.notice = ''; }
    if (this.pending?.owner && this.pending.owner !== session.uid) { this.pending.sent = true; this.save(); return; }
    if (this.pending && !this.pending.owner && session.token && session.uid > 0) { this.pending.owner = session.uid; this.save(); }
  }
  async consume() {
    const pending = this.pending, actor = { ...this.session }, generation = this.generation;
    if (!pending || pending.sent || !actor.token || actor.uid < 1 || pending.owner !== actor.uid) return;
    pending.sent = true; this.save();
    if (actor.uid === pending.spid) { this.notice = '当前分享来自本人，无需关联推荐关系'; return; }
    try { await this.bind(pending.spid); if (this.current(generation, actor)) this.notice = '推荐关系已由系统按账户规则处理'; }
    catch { if (this.current(generation, actor)) this.notice = '推荐关系未能确认，仍可正常浏览；不会转交给其他账号'; }
  }
  private current(generation: number, actor: ShareReferralSession) { return generation === this.generation && actor.uid === this.session.uid && actor.token === this.session.token && actor.version === this.session.version; }
}
