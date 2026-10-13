import { API_BASE, http } from '@/utils/request';
import { useAuthStore } from '@/stores/auth';
import { normalizeDivisionStaffInviteInfo, type DivisionStaffFilter, type DivisionStaffInvite } from '../../../common/divisionStaff';

export const apiDivisionStaffList = (filter: DivisionStaffFilter) => http.get<unknown>('/division/agent/staff_list', { ...filter });
export const apiDivisionStaffPercent = (uid: number, percent: number, revision: string) =>
  http.post<unknown>('/division/agent/staff_percent', { uid, division_percent: percent, revision });
export const apiDivisionStaffRemove = (uid: number, revision: string) => http.delete<unknown>(`/division/agent/staff/${uid}`, { revision });
const targetInput = (target: DivisionStaffInvite) => target.agentCode ? { agent_code: target.agentCode } : { agent_id: target.agentId };
export async function apiDivisionStaffPreview(target: DivisionStaffInvite) {
  return normalizeDivisionStaffInviteInfo(await http.get<unknown>('/division/agent/bind_info', targetInput(target)), target);
}
export const apiDivisionStaffBind = (target: DivisionStaffInvite, revision: string) =>
  http.post<unknown>('/division/agent/spread', { ...targetInput(target), invite_revision: revision });
export async function apiDivisionStaffInviteImage(): Promise<{ url: string; expires: number }> {
  const auth = useAuthStore(), owner = { uid: auth.uid, token: auth.token, version: auth.sessionVersion };
  const value = await http.get<unknown>('/division/agent/spread/code');
  if (owner.uid !== auth.uid || owner.token !== auth.token || owner.version !== auth.sessionVersion) throw Error('登录状态已变化');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('员工邀请图片响应无效');
  const p = value as Record<string, unknown>;
  if (typeof p.url !== 'string' || p.url.length > 2048 || typeof p.expires !== 'number' || !Number.isSafeInteger(p.expires)
    || p.expires <= Date.now() / 1000 || p.expires > Math.floor(Date.now() / 1000) + 600) throw Error('员工邀请码已过期');
  const base = API_BASE || (typeof location !== 'undefined' ? location.origin : '');
  if (!base) throw Error('员工邀请接口地址未配置');
  const origin = base.replace(/\/+$/, ''), absolute = p.url.startsWith('/') ? `${origin}${p.url}` : p.url;
  if (!absolute.startsWith(`${origin}/`) || absolute.includes('#')) throw Error('员工邀请图片地址无效');
  const relative = absolute.slice(origin.length), pair = relative.split('?');
  if (pair.length !== 2 || !new RegExp(`^/api(?:/v1)?/division/agent/spread/code/image/${owner.uid}$`).test(pair[0])) throw Error('员工邀请图片地址无效');
  const terms: Record<string, string> = {};
  for (const piece of pair[1].split('&')) {
    const [key, val, excess] = piece.split('=');
    if (excess !== undefined || !['expires', 'signature'].includes(key) || Object.prototype.hasOwnProperty.call(terms, key)) throw Error('员工邀请图片参数无效');
    terms[key] = val;
  }
  if (Object.keys(terms).length !== 2 || terms.expires !== String(p.expires) || !/^[a-f0-9]{64}$/.test(terms.signature ?? '')) throw Error('员工邀请图片凭据无效');
  return { url: absolute, expires: p.expires };
}
