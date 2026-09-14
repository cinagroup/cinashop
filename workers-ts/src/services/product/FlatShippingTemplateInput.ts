import type { shippingTemplates, shippingTemplatesRegion } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

/** Legacy flat input contract shared by edits and the keyed creation engine. */
type Fields = Pick<typeof shippingTemplates.$inferInsert, 'name' | 'type' | 'sort' | 'status'>;
type Region = Pick<typeof shippingTemplatesRegion.$inferInsert,
  'regionId' | 'regionName' | 'first' | 'firstPrice' | 'continue' | 'continuePrice'>;

export function shippingInputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('运费模板数据格式错误');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) {
    throw new ValidateException('运费模板整数参数无效');
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new ValidateException('运费模板整数参数越界');
  return result;
}
function decimal(value: unknown): string {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d{1,10}(?:\.\d{1,2})?$/.test(String(value))) {
    throw new ValidateException('运费模板计量或金额格式无效');
  }
  const [whole, fraction = ''] = String(value).split('.');
  return `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
}
export function parseFlatAdminShippingInput(raw: unknown) {
  const input = shippingInputRecord(raw), id = input.id === undefined ? 0 : integer(input.id, 0, 2_147_483_647);
  const fields: Fields = {};
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 255) throw new ValidateException('请输入有效模板名称');
    fields.name = input.name.trim();
  }
  if (!id && !fields.name) throw new ValidateException('请输入模板名称');
  if (input.type !== undefined) fields.type = integer(input.type, 1, 3);
  if (input.sort !== undefined) fields.sort = integer(input.sort, 0, 2_147_483_647);
  if (input.status !== undefined) fields.status = integer(input.status, 0, 1);
  let regions: Region[] | undefined;
  if (input.regions !== undefined) {
    if (!Array.isArray(input.regions) || input.regions.length > 1000) throw new ValidateException('运费模板区域必须是最多1000项的数组');
    regions = input.regions.map(value => {
      const row = shippingInputRecord(value);
      if (typeof row.region_name !== 'string' || row.region_name.length > 255) throw new ValidateException('运费模板区域名称无效');
      return { regionId: integer(row.region_id, 0, 2_147_483_647), regionName: row.region_name,
        first: decimal(row.first ?? '1'), firstPrice: decimal(row.first_price ?? '0'),
        continue: decimal(row.continue ?? '1'), continuePrice: decimal(row.continue_price ?? '0') };
    });
  }
  return { id, fields, regions };
}
