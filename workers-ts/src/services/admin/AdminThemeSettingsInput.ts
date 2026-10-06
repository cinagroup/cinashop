import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import type { ThemeStatus } from '@/services/content/ThemeReadService';
import { parseLevelActivationJson } from './AdminLevelActivationInput';
import { pcBannerRequestId } from './AdminPcBannerInput';

export interface ThemeCanonical { operation: 'update'; revision: string; status: ThemeStatus }
export interface ThemeReceipt { operation: 'update'; id: number; request_id: string; payload_hash: string }
export const themeRequestId = pcBannerRequestId;

export class ThemeSettingsStaleVersion extends ValidateException {
  readonly operation = 'update';
  constructor(public readonly request_id: string, public readonly payload_hash: string) {
    super('主题配置已变化，请重新读取并确认'); this.name = 'ThemeSettingsStaleVersion';
  }
}
export class ThemeSettingsRejected extends ValidateException {
  readonly operation = 'update';
  constructor(message: string, public readonly request_id: string, public readonly payload_hash: string) {
    super(message); this.name = 'ThemeSettingsRejected';
  }
}

export function themeCanonical(input: unknown): { request_id: string; canonical: ThemeCanonical } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidateException('主题请求须为JSON对象');
  const raw = input as Record<string, unknown>, expected = ['request_id', 'revision', 'status'];
  if (Object.keys(raw).length !== expected.length || Object.keys(raw).some(key => !expected.includes(key))) throw new ValidateException('须完整提交主题字段，不能包含未知字段');
  const request_id = themeRequestId(raw.request_id);
  if (typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision)) throw new ValidateException('主题配置版本无效');
  if (typeof raw.status !== 'number' || !Number.isInteger(raw.status) || raw.status < 1 || raw.status > 6) throw new ValidateException('主题方案须为1至6整数');
  return { request_id, canonical: { operation: 'update', revision: raw.revision, status: raw.status as ThemeStatus } };
}

export async function readThemeBody(request: Request): Promise<unknown> {
  return parseLevelActivationJson(await readBoundedUtf8Text(request, 4096));
}
