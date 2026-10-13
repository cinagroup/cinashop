import { ValidateException } from '@/utils/errors';

export interface DivisionStaffActor { uid: number; passwordVersion: string; expiresAt: number }
export interface DivisionStaffListInput { keyword: string; page: number; limit: number; start: number; stop: number }
export interface DivisionStaffInviteInput { agentId: number; agentCode: number; revision?: string }

export function staffInteger(value: unknown, label: string, min = 1, max = 2147483647): number {
  if (!(typeof value === 'number' && Number.isSafeInteger(value)
    || typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value))) throw new ValidateException(`${label}格式错误`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new ValidateException(`${label}超出范围`);
  return parsed;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('员工管理参数格式错误');
  if (Object.keys(value).some(key => !keys.includes(key))) throw new ValidateException('员工管理包含未知参数');
  return value as Record<string, unknown>;
}
export function parseDivisionStaffList(value: unknown): DivisionStaffListInput {
  const p = object(value, ['keyword', 'page', 'limit', 'start', 'stop']);
  const keyword = p.keyword ?? '';
  if (typeof keyword !== 'string' || keyword.length > 50 || /[\u0000-\u001f\u007f]/.test(keyword)) throw new ValidateException('员工搜索内容无效');
  const start = staffInteger(p.start ?? 0, '开始时间', 0), stop = staffInteger(p.stop ?? 0, '结束时间', 0);
  if (start ? stop < start : stop !== 0) throw new ValidateException('员工加入时间范围无效');
  return { keyword: keyword.trim(), start, stop, page: staffInteger(p.page ?? 1, '页码', 1, 1000000), limit: staffInteger(p.limit ?? 20, '每页数量', 1, 100) };
}
export function staffRevision(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ValidateException('员工关系版本无效，请刷新');
  return value;
}
export function parseDivisionStaffPercent(value: unknown): { uid: number; percent: number; revision?: string } {
  const p = object(value, ['uid', 'division_percent', 'revision']);
  return { uid: staffInteger(p.uid, '员工UID'), percent: staffInteger(p.division_percent, '员工比例', 0, 100), revision: staffRevision(p.revision) };
}
export function parseDivisionStaffRemove(value: unknown): { revision?: string } {
  const p = object(value, ['revision']);
  return { revision: staffRevision(p.revision) };
}
export function parseDivisionStaffInvite(value: unknown): DivisionStaffInviteInput {
  const p = object(value, ['agent_id', 'agent_code', 'invite_revision']);
  const agentId = staffInteger(p.agent_id ?? 0, '代理商UID', 0), agentCode = staffInteger(p.agent_code ?? 0, '邀请码', 0);
  if (!agentId && !agentCode) throw new ValidateException('上级代理商不存在');
  if (agentId && agentCode) throw new ValidateException('请只提供代理商UID或二维码邀请码');
  return { agentId, agentCode, revision: staffRevision(p.invite_revision) };
}
/** Duplicate query keys are inspected before Hono's query object can collapse them. */
export function divisionStaffQuery(url: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of new URL(url).searchParams) {
    if (Object.prototype.hasOwnProperty.call(result, key)) throw new ValidateException('员工管理查询参数重复');
    Object.defineProperty(result, key, { value, enumerable: true, configurable: true });
  }
  return result;
}
/** These small write contracts accept scalar JSON only; reject duplicate decoded keys. */
export function divisionStaffJson(text: string): unknown {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { throw new ValidateException('员工管理JSON格式错误'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('员工管理参数格式错误');
  const scalar = /\s*("(?:[^"\\]|\\.)*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*/y;
  let i = text.indexOf('{') + 1;
  const keys = new Set<string>();
  while (true) {
    while (/\s/.test(text[i] ?? '') && i < text.length) i++;
    if (text[i] === '}') break;
    scalar.lastIndex = i; const key = scalar.exec(text);
    if (!key || key[1][0] !== '"') throw new ValidateException('员工管理JSON字段无效');
    const name = JSON.parse(key[1]) as string;
    if (keys.has(name)) throw new ValidateException('员工管理JSON字段重复');
    keys.add(name); i = scalar.lastIndex;
    if (text[i++] !== ':') throw new ValidateException('员工管理JSON字段无效');
    scalar.lastIndex = i; const entry = scalar.exec(text);
    if (!entry) throw new ValidateException('员工管理JSON仅接受标量字段');
    i = scalar.lastIndex;
    if (text[i] === '}') break;
    if (text[i++] !== ',') throw new ValidateException('员工管理JSON字段无效');
  }
  return value;
}
