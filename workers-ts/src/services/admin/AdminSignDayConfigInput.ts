import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from './AdminLevelActivationInput';

export type SignDayOperation = 'create' | 'update' | 'status' | 'delete';
export type SignDayCanonicalMutation =
  | { operation: 'create' | 'update'; id: number; revision: string; day: string; sign_num: number; sort: number; status: 0 | 1 }
  | { operation: 'status'; id: number; revision: string; status: 0 | 1 }
  | { operation: 'delete'; id: number; revision: string };

const MAX_INT = 2_147_483_647;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REVISION = /^[a-f0-9]{64}$/;

export function signDayId(value: unknown): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d{0,9}$/.test(String(value))) {
    throw new ValidateException('签到天数条目ID无效');
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id > MAX_INT) throw new ValidateException('签到天数条目ID无效');
  return id;
}

export function signDayRequestId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidateException('请求标识必须是UUID');
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ValidateException(`${label}必须是范围内的整数`);
  }
  return value;
}

/** The original day text is part of the saved value and the receipt hash. */
export function signDayText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > 64 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ValidateException('签到天数文案须为1至64个非控制字符');
  }
  return value;
}

export function signDayMutationCanonical(
  operation: SignDayOperation, id: number, raw: Record<string, unknown>,
): { request_id: string; canonical: SignDayCanonicalMutation } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidateException('签到天数请求格式无效');
  if (operation === 'create' && id !== 0) throw new ValidateException('创建请求不能指定条目ID');
  if (operation !== 'create') signDayId(id);
  const allowed = new Set(['request_id', 'revision',
    ...(operation === 'create' || operation === 'update' ? ['day', 'sign_num', 'sort', 'status'] : operation === 'status' ? ['status'] : [])]);
  if (Object.keys(raw).some(key => !allowed.has(key))) throw new ValidateException('不支持的签到天数写入字段');
  const request_id = signDayRequestId(raw.request_id);
  if (typeof raw.revision !== 'string' || !REVISION.test(raw.revision)) {
    throw new ValidateException('签到天数版本无效，请刷新后重试');
  }
  const revision = raw.revision;
  if (operation === 'delete') return { request_id, canonical: { operation, id, revision } };
  const status = integer(raw.status, 0, 1, '显示状态') as 0 | 1;
  if (operation === 'status') return { request_id, canonical: { operation, id, revision, status } };
  return { request_id, canonical: { operation, id, revision,
    day: signDayText(raw.day), sign_num: integer(raw.sign_num, 1, MAX_INT, '签到积分'),
    sort: integer(raw.sort, 0, MAX_INT, '排序'), status } };
}

export async function signDaySha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256(JSON.stringify(canonical)). The canonical object's key order is the wire contract. */
export const signDayPayloadHash = signDaySha256;

export async function readSignDayBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readBoundedUtf8Text(request, 4096);
  let parsed: unknown;
  try { parsed = parseLevelActivationJson(text); }
  catch (error) {
    if (error instanceof ValidateException) throw new ValidateException(error.message.replaceAll('会员激活配置', '签到天数配置'));
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ValidateException('签到天数请求须为JSON对象');
  return parsed as Record<string, unknown>;
}
