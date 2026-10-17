export interface ProductScheduleEditor {
  onEnabled: boolean;
  offEnabled: boolean;
  onTime: string;
  offTime: string;
  changed: boolean;
  onChanged: boolean;
  offChanged: boolean;
}
const maximum = 2_147_483_647;
const clock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
export function productScheduleText(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > maximum) throw Error('商品上下架计划无效，请重新读取资料');
  if (!seconds) return '';
  const p = Object.fromEntries(clock.formatToParts(new Date(seconds * 1000)).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
/** Interpret the literal editor value in Shanghai, independently of the
 * browser timezone. A historical ambiguous local hour must be reselected. */
export function productScheduleSeconds(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) throw Error('请填写完整的北京时间');
  const [year, month, day, hour, minute, second] = m.slice(1).map((part, index) => part === undefined && index === 5 ? 0 : Number(part));
  const utc = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  const normalized = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}`;
  const matches = [8, 9].map(offset => utc / 1000 - offset * 3600)
    .filter(seconds => Number.isSafeInteger(seconds) && seconds > 0 && seconds <= maximum && productScheduleText(seconds) === normalized);
  if (matches.length !== 1) throw Error('计划时间不存在、含义不唯一或超出2038年存储范围，请重新选择');
  return matches[0]!;
}
export function productScheduleEditor(detail: { auto_on_time?: unknown; auto_off_time?: unknown } = {}): ProductScheduleEditor {
  const on = detail.auto_on_time, off = detail.auto_off_time;
  if (on === undefined && off === undefined) return { onEnabled: false, offEnabled: false, onTime: '', offTime: '', changed: false, onChanged: false, offChanged: false };
  if (typeof on !== 'number' || typeof off !== 'number') throw Error('商品上下架计划不完整，请重新读取资料');
  return { onEnabled: on > 0, offEnabled: off > 0, onTime: productScheduleText(on), offTime: productScheduleText(off), changed: false, onChanged: false, offChanged: false };
}
export function productSchedulePayload(editor: ProductScheduleEditor): { auto_on_time?: number; auto_off_time?: number } {
  if (!editor.changed) return {};
  return { ...(editor.onChanged ? { auto_on_time: editor.onEnabled ? productScheduleSeconds(editor.onTime) : 0 } : {}),
    ...(editor.offChanged ? { auto_off_time: editor.offEnabled ? productScheduleSeconds(editor.offTime) : 0 } : {}) };
}
