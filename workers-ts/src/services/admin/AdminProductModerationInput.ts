import { ValidateException } from '@/utils/errors';

const MAX_INTEGER = 2_147_483_647;
export interface AdminProductModerationInput {
  isVerify: -2 | -1 | 1;
  refusal: string;
  isShow: 0 | 1 | 2;
  autoOnTime: number;
}

export function adminProductModerationId(value: unknown): number {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9]\d{0,9}$/.test(text) || Number(text) > MAX_INTEGER) throw new ValidateException('缺少商品ID');
  return Number(text);
}

function choice(value: unknown, name: string, values: readonly number[], fallback: number): number {
  const parsed = value === undefined ? fallback : typeof value === 'string' && /^(?:-?[1-9]\d*|0)$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || !values.includes(parsed)) throw new ValidateException(`${name}格式错误`);
  return parsed;
}

/** Live DatePicker serializes Date to ISO UTC; historical local strings use
 * Asia/Shanghai. These explicit forms replace PHP strtotime's ambiguity. */
export function adminProductModerationTime(value: unknown): number {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') return 0;
  if (typeof value !== 'string') throw new ValidateException('自动上架时间格式错误');
  const utc = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  const local = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  const parts = utc ?? local;
  if (!parts) throw new ValidateException('自动上架时间须为UTC或北京时间');
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map((item, index) => item === undefined && index === 5 ? 0 : Number(item));
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) throw new ValidateException('自动上架时间格式错误');
  const calendar = Date.UTC(year, month - 1, day, hour, minute, second), date = new Date(calendar);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) throw new ValidateException('自动上架时间格式错误');
  const timestamp = Math.floor(calendar / 1000) - (utc ? 0 : 8 * 3600);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > MAX_INTEGER) throw new ValidateException('自动上架时间超出存储范围');
  return timestamp;
}

export function normalizeAdminProductModerationInput(body: unknown): AdminProductModerationInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidateException('商品审核参数错误');
  const row = body as Record<string, unknown>;
  // Old auditForm includes id; PHP getMore discards it. The path always wins.
  if (Object.keys(row).some(key => !['id', 'is_verify', 'refusal', 'is_show', 'auto_on_time'].includes(key))) throw new ValidateException('商品审核存在未知参数');
  const isVerify = choice(row.is_verify, '审核状态', [-2, -1, 1], 1) as AdminProductModerationInput['isVerify'];
  const refusal = row.refusal === undefined ? '' : row.refusal;
  if (typeof refusal !== 'string' || [...refusal].length > 255 || /[\u0000\ud800-\udfff]/u.test(refusal)) throw new ValidateException('审核原因长度或字符错误');
  if (isVerify !== 1 && !refusal.trim()) throw new ValidateException('请输入原因');
  const autoOnTime = adminProductModerationTime(row.auto_on_time);
  const requestedShow = choice(row.is_show, '上架时机', [0, 1, 2], 0) as AdminProductModerationInput['isShow'];
  // Without a parsed time even source is_show=2 stays 2. Rejection itself
  // does not force hide; a supplied nonzero timestamp does.
  return { isVerify, refusal, isShow: autoOnTime ? 0 : requestedShow, autoOnTime };
}
