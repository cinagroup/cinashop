import { quoteMoney } from './checkoutQuote';

export interface DivisionStaffOwner { uid: number; version: number; token: string }
export interface DivisionStaffItem { uid: number; nickname: string; avatar: string; phone: string; spreadUid: number;
  joinedAt: string; joinedEpoch: number; percent: number; children: number; orders: number; orderAmount: string; payCount: number; revision: string }
export interface DivisionStaffPage { items: DivisionStaffItem[]; count: number; brokerage: string; page: number; limit: number;
  agent: { uid: number; percent: number; endTime: number } }
export interface DivisionStaffFilter { keyword: string; start: number; stop: number; page: number; limit: number }
export interface DivisionStaffInvite { agentId: number; agentCode: number; expectedAgentId: number; autoBind: boolean; kind: 'qrcode' | 'legacy_h5' }
export interface DivisionStaffInviteInfo { agentId: number; name: string; canBind: boolean; alreadyBound: boolean; revision: string; source: 'qrcode' | 'legacy_h5'; codeId: number }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('员工管理响应无效');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min = 0, max = 2147483647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw Error('员工管理数字无效');
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw Error('员工管理文本无效');
  return value;
}
const revision = (value: unknown) => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Error('员工关系版本无效'); return value; };
export function normalizeDivisionStaffPage(value: unknown, owner: number, expectedPage: number): DivisionStaffPage {
  const data = record(value), agent = record(data.agent), seen = new Set<number>();
  if (integer(agent.uid, 1) !== owner || integer(data.page, 1) !== expectedPage || !Array.isArray(data.list) || data.list.length > 100) throw Error('员工列表所属用户或页码已变化');
  const items = data.list.map(value => {
    const row = record(value), uid = integer(row.uid, 1);
    if (seen.has(uid) || uid === owner) throw Error('员工列表身份无效'); seen.add(uid);
    const percent = integer(row.divisionPercent, 0, 100), joinedEpoch = integer(row.spreadTime);
    if (row.division_percent !== percent || row.pay_count !== row.payCount) throw Error('员工兼容字段不一致');
    const joinedAt = text(row.spread_time, 10);
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(joinedAt)) throw Error('员工加入时间无效');
    return { uid, nickname: text(row.nickname, 255), avatar: text(row.avatar, 2048), phone: text(row.phone, 32),
      spreadUid: integer(row.spread_uid), joinedAt, joinedEpoch, percent, children: integer(row.childCount), orders: integer(row.orderCount),
      orderAmount: quoteMoney(row.numberCount), payCount: integer(row.payCount), revision: revision(row.revision) };
  });
  const count = integer(data.count), limit = integer(data.limit, 1, 100);
  if (count < items.length || items.length > limit) throw Error('员工列表数量不一致');
  return { items, count, brokerage: quoteMoney(data.brokerage), page: expectedPage, limit,
    agent: { uid: owner, percent: integer(agent.divisionPercent, 0, 100), endTime: integer(agent.divisionEndTime) } };
}
export function divisionStaffDates(start: string, stop: string): { start: number; stop: number } {
  if (!start && !stop) return { start: 0, stop: 0 };
  function parse(value: string) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw Error('请选择完整的加入日期范围');
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2]) || date.getUTCDate() !== Number(match[3])) throw Error('加入日期无效');
    return date.getTime() / 1000 - 8 * 3600;
  }
  const first = parse(start), last = parse(stop);
  if (last < first || first <= 0 || last + 86399 > 2147483647) throw Error('加入日期范围无效');
  return { start: first, stop: last + 86399 };
}
export function divisionStaffOwnerEqual(a: DivisionStaffOwner, b: DivisionStaffOwner): boolean {
  return a.uid === b.uid && a.version === b.version && a.token === b.token && !!a.uid && !!a.token;
}
/** Immutable owner/scope and request epoch; stale replies cannot render or drive writes. */
export class DivisionStaffSession {
  private epoch = 0;
  state: { result: DivisionStaffPage | null; loading: boolean; error: string } = { result: null, loading: false, error: '' };
  constructor(private readonly loadPage: (filter: DivisionStaffFilter) => Promise<unknown>,
    private readonly notify: (state: DivisionStaffSession['state']) => void) {}
  reset() { ++this.epoch; this.state = { result: null, loading: false, error: '' }; this.notify(this.state); }
  async load(filter: DivisionStaffFilter, owner: DivisionStaffOwner, append = false): Promise<void> {
    const current = ++this.epoch, expectedOwner = { ...owner }, expectedFilter = { ...filter }, previous = append ? this.state.result : null;
    if (!owner.uid || !owner.token || append && (!previous || previous.page + 1 !== filter.page)) return;
    this.state = { result: previous, loading: true, error: '' }; this.notify(this.state);
    try {
      const result = normalizeDivisionStaffPage(await this.loadPage(expectedFilter), expectedOwner.uid, expectedFilter.page);
      if (current !== this.epoch) return;
      if (previous) {
        const all = [...previous.items, ...result.items.filter(row => !previous.items.some(old => old.uid === row.uid))];
        if (all.length > result.count || all.length > 5000) throw Error('员工列表已变化或超过页面上限，请重新搜索');
        result.items = all;
      }
      this.state = { result, loading: false, error: '' };
    } catch (error) { if (current !== this.epoch) return; this.state = { result: null, loading: false, error: error instanceof Error ? error.message : '员工列表读取失败' }; }
    this.notify(this.state);
  }
}
function routeId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) throw Error('员工邀请参数无效');
  return integer(Number(value), 1);
}
/** Legacy numeric / id&spid scenes auto-bind once; a=<QRid> is the modern confirmed flow. */
export function parseDivisionStaffInviteRoute(value: unknown): DivisionStaffInvite {
  const options = record(value), allowed = ['scene', 'a', 'agent_code', 'agent_id', 'id', 'spid'];
  if (Object.keys(options).some(key => !allowed.includes(key))) throw Error('员工邀请包含未知参数');
  let source = options, autoBind = false;
  if (options.scene !== undefined) {
    if (Object.keys(options).length !== 1 || typeof options.scene !== 'string' || options.scene.length > 128) throw Error('员工扫码参数无效');
    let scene: string; try { scene = decodeURIComponent(options.scene); } catch { throw Error('员工扫码编码无效'); }
    if (/^[1-9]\d*$/.test(scene)) return { agentCode: routeId(scene), agentId: 0, expectedAgentId: 0, autoBind: true, kind: 'qrcode' };
    const decoded: Record<string, string> = {};
    for (const term of scene.split('&')) {
      const pair = term.split('=');
      if (pair.length !== 2) throw Error('员工扫码参数无效');
      const [key, item] = pair;
      if (!['a', 'id', 'spid'].includes(key) || Object.prototype.hasOwnProperty.call(decoded, key)) throw Error('员工扫码参数重复或无效');
      decoded[key] = item;
    }
    source = decoded; autoBind = decoded.id !== undefined;
  }
  const keys = Object.keys(source);
  if (source.id !== undefined) {
    if (keys.some(key => !['id', 'spid'].includes(key))) throw Error('旧员工扫码来源混合');
    return { agentCode: routeId(source.id), agentId: 0, expectedAgentId: source.spid === undefined ? 0 : routeId(source.spid), autoBind: true, kind: 'qrcode' };
  }
  if (source.a !== undefined || source.agent_code !== undefined) {
    if (keys.length !== 1) throw Error('员工二维码来源混合');
    return { agentCode: routeId(source.a ?? source.agent_code), agentId: 0, expectedAgentId: 0, autoBind, kind: 'qrcode' };
  }
  if (source.agent_id !== undefined && keys.length === 1) return { agentId: routeId(source.agent_id), agentCode: 0, expectedAgentId: 0, autoBind: true, kind: 'legacy_h5' };
  throw Error('员工邀请参数缺失');
}
export function normalizeDivisionStaffInviteInfo(value: unknown, target: DivisionStaffInvite): DivisionStaffInviteInfo {
  const p = record(value), agent = record(p.agent), agentId = integer(agent.uid, 1), codeId = integer(p.codeId);
  if (p.source !== target.kind || target.agentId && agentId !== target.agentId || target.expectedAgentId && agentId !== target.expectedAgentId
    || codeId !== target.agentCode || typeof p.canBind !== 'boolean' || typeof p.alreadyBound !== 'boolean' || p.canBind && p.alreadyBound) throw Error('员工邀请目标已变化');
  return { agentId, name: text(agent.name, 255), canBind: p.canBind, alreadyBound: p.alreadyBound, revision: revision(p.revision), source: target.kind, codeId };
}
export function divisionStaffInviteReturnPath(target: DivisionStaffInvite): string {
  const query = target.agentCode ? target.autoBind ? `id=${target.agentCode}${target.expectedAgentId ? `&spid=${target.expectedAgentId}` : ''}`
    : `a=${target.agentCode}` : `agent_id=${target.agentId}`;
  return `/pages/users/agent/bind?${query}`;
}
