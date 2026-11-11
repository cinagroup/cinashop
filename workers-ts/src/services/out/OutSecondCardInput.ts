import { normalizeProductSkuEditorPayload, type SecondCardSkuConfiguration } from '@/services/product/ProductSkuEditorService';
import { supplierProductScheduleTime } from '@/services/supplier/SupplierProductScheduleInput';
import { ValidateException } from '@/utils/errors';

type Row = Record<string, unknown>;

function alias(row: Row, keys: string[]): unknown {
  const values = keys.filter(key => row[key] !== undefined && row[key] !== null && row[key] !== '').map(key => row[key]);
  if (values.length > 1 && values.some(value => String(value) !== String(values[0]))) {
    throw new ValidateException('次卡核销规则字段冲突');
  }
  return values[0];
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) value += ' 00:00:00';
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  return supplierProductScheduleTime(value);
}

/** Translate PHP's editor fields, then reuse the administrator's SKU rules. */
export function outSecondCardConfiguration(input: Row): SecondCardSkuConfiguration {
  const rows = Array.isArray(input.attrs) ? input.attrs : input.attrs && typeof input.attrs === 'object'
    ? Object.values(input.attrs as Row) : [];
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object' || Array.isArray(rows[0])) {
    throw new ValidateException('次卡商品只支持单规格单SKU');
  }
  const row = rows[0] as Row;
  const mode = alias(row, ['write_valid', 'writeValid']);
  const prepared: Row = { ...row, write_times: alias(row, ['write_times', 'writeTimes']), write_valid: mode };
  if (Number(mode) === 2) prepared.write_days = alias(row, ['days', 'write_days', 'writeDays']);
  if (Number(mode) === 3) {
    const section = row.section_time;
    if (section !== undefined && (!Array.isArray(section) || section.length !== 2)) {
      throw new ValidateException('次卡固定有效期格式错误');
    }
    const bounds = Array.isArray(section) ? section.map(timestamp) : [];
    const start = timestamp(alias(row, ['write_start', 'writeStart']));
    const end = timestamp(alias(row, ['write_end', 'writeEnd']));
    if ((start !== undefined && bounds[0] !== undefined && start !== bounds[0]) ||
      (end !== undefined && bounds[1] !== undefined && end !== bounds[1])) throw new ValidateException('次卡有效期字段冲突');
    prepared.write_start = start ?? bounds[0]; prepared.write_end = end ?? bounds[1];
  }
  const payload = normalizeProductSkuEditorPayload({ ...input, spec_type: input.spec_type ?? input.specType, attrs: [prepared] }, 4);
  const { writeTimes, writeValid, writeDays, writeStart, writeEnd } = payload.skus[0];
  return { writeTimes, writeValid, writeDays, writeStart, writeEnd };
}
