import { WECHAT_APP_KEYS, isWechatAppConfigKey, parseWechatAppSave, parseWechatAppStoredText,
  wechatAppStoredValue, type WechatAppKey, type WechatAppSave } from '../../../../view/common/wechatApp';

/** Internal plan only. The author must still authorize/lock in its own SQL
 * transaction, compare every row/version and persist its independent receipt.
 */
export interface WechatAppConfigRow {
  id: number; menuName: string; isStore: number; sort: number;
  value: string | null; version: string;
}
export type WechatAppConfigChange<Row extends WechatAppConfigRow> = {
  key: WechatAppKey; winner: Row | null; raw: string;
};

export function wechatAppWinningRows<Row extends WechatAppConfigRow>(rows: readonly Row[]): Map<WechatAppKey, Row> {
  if (rows.length > 64 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1024 * 1024)
    throw Error('原生App配置超过完整读取容量');
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw Error('原生App配置行身份重复');
  const winners = new Map<WechatAppKey, Row>();
  for (const row of [...rows].sort((a, b) => b.sort - a.sort || b.id - a.id)) {
    if (!Number.isSafeInteger(row.id) || row.id <= 0 || !Number.isSafeInteger(row.sort)
      || row.isStore !== 0 || !isWechatAppConfigKey(row.menuName)
      || typeof row.version !== 'string' || !/^\d+$/u.test(row.version)
      || row.value !== null && typeof row.value !== 'string') throw Error('原生App配置完整来源不匹配');
    if (!winners.has(row.menuName)) winners.set(row.menuName, row);
  }
  return winners;
}

export function planWechatAppIntents<Row extends WechatAppConfigRow>(rows: readonly Row[], value: unknown): {
  input: WechatAppSave; winners: Map<WechatAppKey, Row>;
  changes: Array<WechatAppConfigChange<Row>>; appIdValueChanged: boolean;
} {
  const input = parseWechatAppSave(value), winners = wechatAppWinningRows(rows);
  const changes: Array<WechatAppConfigChange<Row>> = [];
  for (const key of WECHAT_APP_KEYS) {
    const intent = input.fields[key];
    if (intent.action === 'keep') continue;
    const raw = wechatAppStoredValue(intent.action === 'clear' ? '' : intent.value);
    const winner = winners.get(key) ?? null;
    if (winner?.value !== raw) changes.push({ key, winner, raw });
  }
  const appId = input.fields.wechat_app_appid;
  return { input, winners, changes, appIdValueChanged: appId.action === 'replace'
    && appId.value !== (parseWechatAppStoredText(winners.get('wechat_app_appid')?.value) ?? '') };
}
