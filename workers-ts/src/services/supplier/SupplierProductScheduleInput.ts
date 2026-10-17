import { ValidateException } from '@/utils/errors';

export interface SupplierProductScheduleInput { autoOnTime?: number; autoOffTime?: number }
const maximum = 2_147_483_647;
const shanghai = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function invalid(): never { throw new ValidateException('定时上下架时间须为合法北京时间、UTC时间或0至2147483647的整数秒'); }
function epoch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalid();
  return value;
}
function calendar(parts: number[]): number {
  const [year, month, day, hour, minute, second] = parts;
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) invalid();
  const utc = Date.UTC(year, month - 1, day, hour, minute, second), date = new Date(utc);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) invalid();
  return utc;
}
/** PHP's datetime widget submits Shanghai wall time. Explicit empty strings
 * cancel, as strtotime('') did; omission is deliberately a different operation.
 * Past/equal/reversed plans remain representable for the mature live consumer. */
export function supplierProductScheduleTime(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (value === '') return 0;
  if (typeof value === 'number') return epoch(value);
  if (typeof value !== 'string' || value.length > 24) invalid();
  const local = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (local) {
    const parts = local.slice(1).map(part => Number(part ?? 0)), wall = calendar(parts);
    let utc = wall - 8 * 3_600_000;
    // Honour the actual Asia/Shanghai zone, including historical DST, rather
    // than inheriting the Worker host's timezone or accepting rollover dates.
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = Object.fromEntries(shanghai.formatToParts(new Date(utc)).map(part => [part.type, part.value]));
      const seen = [p.year, p.month, p.day, p.hour, p.minute, p.second].map(Number);
      if (seen.every((part, index) => part === parts[index])) return epoch(utc / 1000);
      utc += wall - Date.UTC(seen[0], seen[1] - 1, seen[2], seen[3], seen[4], seen[5]);
    }
    invalid();
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!iso) invalid();
  return epoch(calendar(iso.slice(1, 7).map(Number)) / 1000);
}
export function supplierProductScheduleInput(input: Record<string, unknown>): SupplierProductScheduleInput {
  const result: SupplierProductScheduleInput = {};
  for (const [wire, key] of [['auto_on_time', 'autoOnTime'], ['auto_off_time', 'autoOffTime']] as const) {
    if (Object.hasOwn(input, wire)) {
      const value = supplierProductScheduleTime(input[wire]);
      if (value !== undefined) result[key] = value;
    }
  }
  return result;
}
