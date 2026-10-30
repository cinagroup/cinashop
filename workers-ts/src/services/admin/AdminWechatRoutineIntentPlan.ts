import { WECHAT_ROUTINE_KEYS, isWechatRoutineConfigKey, parseWechatRoutineSave, parseWechatRoutineStoredText,
  wechatRoutineStoredValue, wechatRoutineStoredRadioValue, type WechatRoutineKey, type WechatRoutineSave } from '../../../../view/common/wechatRoutine';

/** The SQL reader and author must reject an incomplete history, not return a
 * prefix. These bounds include all source-row metadata, not only values. */
export const WECHAT_ROUTINE_MAX_CONFIG_ROWS = 64;
export const WECHAT_ROUTINE_MAX_CONFIG_BYTES = 1024 * 1024;
export interface WechatRoutineConfigRow {
  id: number; menuName: string; isStore: number; sort: number;
  value: string | null; version: string;
}
export type WechatRoutineConfigChange<Row extends WechatRoutineConfigRow> = {
  key: WechatRoutineKey; winner: Row | null; raw: string;
};

export function wechatRoutineWinningRows<Row extends WechatRoutineConfigRow>(rows: readonly Row[]): Map<WechatRoutineKey, Row> {
  if (rows.length > WECHAT_ROUTINE_MAX_CONFIG_ROWS
    || new TextEncoder().encode(JSON.stringify(rows)).byteLength > WECHAT_ROUTINE_MAX_CONFIG_BYTES)
    throw Error('小程序配置超过完整读取容量');
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw Error('小程序配置行身份重复');
  const winners = new Map<WechatRoutineKey, Row>();
  for (const row of [...rows].sort((a, b) => b.sort - a.sort || b.id - a.id)) {
    if (!Number.isSafeInteger(row.id) || row.id <= 0 || !Number.isSafeInteger(row.sort)
      || row.isStore !== 0 || !isWechatRoutineConfigKey(row.menuName)
      || typeof row.version !== 'string' || !/^\d+$/u.test(row.version)
      || row.value !== null && typeof row.value !== 'string') throw Error('小程序配置完整来源不匹配');
    if (!winners.has(row.menuName)) winners.set(row.menuName, row);
  }
  return winners;
}

/** Compare material rather than raw JSON formatting. Missing is unconfigured;
 * an existing unreadable value cannot be assumed equal to a replacement.
 * These flags are observations, not permission to adopt or switch an account.
 */
function materialChanged<Row extends WechatRoutineConfigRow>(winner: Row | undefined, next: string): boolean {
  const before = winner ? parseWechatRoutineStoredText(winner.value) : '';
  return before === null || before !== next;
}

/** Pure internal plan: preserve every original row/metadata/shadow. The caller
 * still owns SQL locks, full revision comparison, account-switch maintenance,
 * missing-row metadata and the independent immutable operation receipt. */
export function planWechatRoutineIntents<Row extends WechatRoutineConfigRow>(rows: readonly Row[], value: unknown): {
  input: WechatRoutineSave; winners: Map<WechatRoutineKey, Row>;
  changes: Array<WechatRoutineConfigChange<Row>>;
  appIdValueChanged: boolean; credentialMaterialChanged: boolean;
} {
  const input = parseWechatRoutineSave(value), winners = wechatRoutineWinningRows(rows);
  const changes: Array<WechatRoutineConfigChange<Row>> = [];
  for (const key of WECHAT_ROUTINE_KEYS) {
    const intent = input.fields[key];
    if (intent.action === 'keep') continue;
    const raw = key === 'routine_contact_type' || key === 'store_user_avatar'
      ? wechatRoutineStoredRadioValue(intent.action === 'replace' ? intent.value : undefined)
      : wechatRoutineStoredValue(intent.action === 'clear' ? '' : intent.value);
    const winner = winners.get(key) ?? null;
    if (winner?.value !== raw) changes.push({ key, winner, raw });
  }
  const appId = input.fields.routine_appId, secret = input.fields.routine_appsecret;
  const appIdValueChanged = appId.action === 'replace'
    && materialChanged(winners.get('routine_appId'), appId.value);
  const secretValueChanged = secret.action !== 'keep'
    && materialChanged(winners.get('routine_appsecret'), secret.action === 'clear' ? '' : secret.value);
  // A raw-only canonicalization remains in changes and must still change the
  // caller's full source stamp, even when credential material stays the same.
  return { input, winners, changes, appIdValueChanged,
    credentialMaterialChanged: appIdValueChanged || secretValueChanged };
}
