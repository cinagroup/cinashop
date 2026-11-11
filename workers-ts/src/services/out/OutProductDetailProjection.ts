import type { storeProduct, storeProductAttr, storeProductAttrValue, storeProductCategory } from '@/models/schema';
import { ServiceUnavailableException } from '@/utils/errors';
import { legacyPhpJsonDecodeWire } from '@/utils/legacy-php-json';

type Product = typeof storeProduct.$inferSelect;
type Sku = typeof storeProductAttrValue.$inferSelect;
type Dimension = { value: string; detail: string[] };
type Row = Record<string, unknown>;
const activityNames: Record<string, string> = { '0': '默认', '1': '秒杀', '2': '砍价', '3': '拼团' };
const zone = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function outDetailTime(value: number, dayOnly = false): string {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 2147483648) throw new ServiceUnavailableException('商品历史时间超出范围');
  const parts = Object.fromEntries(zone.formatToParts(new Date(value * 1000)).map(part => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return dayOnly ? day : `${day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
export function outDetailIds(value: string | null): number[] {
  if (!value || value === '0') return [];
  const tokens = value.split(',').filter(token => token !== '' && token !== '0');
  if (tokens.length > 10000 || tokens.some(token => !/^[1-9]\d*$/.test(token) || Number(token) > 2147483647))
    throw new ServiceUnavailableException('商品历史选集格式或容量错误');
  return tokens.map(Number);
}
export function outDetailJson(value: string | null): unknown {
  if (!value || value === '0') return [];
  const decoded = legacyPhpJsonDecodeWire(value, 512 * 1024);
  let nodes = 0;
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > 30000 || depth > 24 || Array.isArray(entry) && entry.length > 1000)
      throw new ServiceUnavailableException('商品详情历史JSON结构超过编辑容量');
    if (entry && typeof entry === 'object') for (const child of Object.values(entry)) visit(child, depth + 1);
  };
  visit(decoded, 0); return decoded;
}
export function outDetailTree(rows: Array<typeof storeProductCategory.$inferSelect>) {
  type Node = { value: number; label: string; pid: number; children?: Node[] };
  const byId = new Map(rows.map(row => [row.id, row]));
  if (byId.size !== rows.length) throw new ServiceUnavailableException('商品分类编号重复');
  const children = new Map<number, Node[]>();
  for (const row of rows) {
    const visited = new Set([row.id]); let pid = row.pid;
    while (pid && byId.has(pid)) {
      if (visited.has(pid) || visited.size >= 16) throw new ServiceUnavailableException('商品分类循环或层级超出容量');
      visited.add(pid); pid = byId.get(pid)!.pid;
    }
    const siblings = children.get(row.pid) ?? [];
    siblings.push({ value: row.id, label: row.cateName, pid: row.pid }); children.set(row.pid, siblings);
  }
  const walk = (pid: number): Node[] => (children.get(pid) ?? []).map(node => {
    const descendants = walk(node.value); return descendants.length ? { ...node, children: descendants } : node;
  });
  // A hidden/missing parent is not reparented into the visible root directory.
  return walk(0);
}
export function outDetailFormInfo(value: unknown): Row[] {
  const names: Record<string, string> = { checkboxs: '多选框', citys: '城市', dates: '日期', dateranges: '日期范围',
    radios: '单选框', selects: '下拉框', texts: '文本框', times: '时间', timeranges: '时间范围', uploadPicture: '图片' };
  if (!value || typeof value !== 'object') return [];
  if (Object.keys(value).length > 100) throw new ServiceUnavailableException('商品详情系统表单超过100项编辑容量');
  return Object.values(value).map(item => {
    const row = item && typeof item === 'object' && !Array.isArray(item) ? item as Row : {};
    const nested = (key: string, field: string, fallback: unknown) => row[key] && typeof row[key] === 'object'
      ? (row[key] as Row)[field] ?? fallback : fallback;
    const type = typeof row.name === 'string' ? row.name : '';
    return { id: row.id ?? '', type, name: names[type] ?? '', title: nested('titleConfig', 'value', ''),
      tip: nested('tipConfig', 'value', ''), list: ['checkboxs', 'radios', 'selects'].includes(type) ? nested('wordsConfig', 'list', []) : [],
      require: nested('titleShow', 'val', false), value: row.value ?? '' };
  });
}
const numeric = (value: string | number | null) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ServiceUnavailableException('商品历史金额无效');
  return number;
};
export function outDetailSku(row: Sku, dimensions: Dimension[], counts: Map<string, { available: number; total: number }>): Row {
  const parts = row.suk.split(',');
  const result: Row = { id: row.id, unique: row.unique, suk: row.suk, pic: row.image,
    detail: Object.fromEntries(dimensions.map((dim, index) => [dim.value, parts[index] ?? ''])),
    stock: row.stock, sales: row.sales, sum_stock: row.sumStock, bar_code: row.barCode, code: row.code,
    disk_info: row.diskInfo ?? [], virtual_list: [], virtual_available: counts.get(row.unique)?.available ?? 0,
    virtual_total: counts.get(row.unique)?.total ?? 0, write_times: row.writeTimes, write_valid: row.writeValid,
    days: row.writeDays, section_time: [row.writeStart ? outDetailTime(row.writeStart, true) : '', row.writeEnd ? outDetailTime(row.writeEnd, true) : ''],
    is_retired: row.isRetired };
  for (const [field, value] of Object.entries({ price: row.price, settle_price: row.settlePrice, vip_price: row.vipPrice, cost: row.cost,
    ot_price: row.otPrice, weight: row.weight, volume: row.volume, brokerage: row.brokerage, brokerage_two: row.brokerageTwo })) result[field] = numeric(value);
  dimensions.forEach((_dim, index) => { result[`value${index + 1}`] = parts[index] ?? ''; });
  return result;
}
export function outDetailSpecs(product: Product, attrs: Array<typeof storeProductAttr.$inferSelect>, skus: Sku[], counts: Map<string, { available: number; total: number }>) {
  const items = attrs.map(row => ({ value: row.attrName, detail: row.attrValues.split(',').filter(Boolean) }));
  const active = skus.filter(row => row.isRetired === 0);
  const complete = product.specType === 0 ? active.length === 1 && active[0].suk === '默认'
    : product.specType === 1 && items.length > 0 && items.length <= 3 && active.length <= 200
      && new Set(items.map(row => row.value)).size === items.length
      && items.every(row => row.value && row.detail.length && new Set(row.detail).size === row.detail.length)
      && items.reduce((size, row) => size * row.detail.length, 1) === active.length
      && new Set(active.map(row => row.suk)).size === active.length
      && active.every(row => { const parts = row.suk.split(','); return parts.length === items.length && items.every((dim, index) => dim.detail.includes(parts[index])); });
  const skuRows = active.map(row => outDetailSku(row, items, counts));
  const defaults: Row = { pic: '', price: 0, vip_price: 0, settle_price: 0, cost: 0, ot_price: 0, stock: 0,
    bar_code: '', code: '', weight: 0, volume: 0, brokerage: 0, brokerage_two: 0,
    write_times: 1, write_valid: 1, days: 0, section_time: [] };
  const fallback: Row = { ...defaults, pic: product.image, price: numeric(product.price), vip_price: numeric(product.vipPrice),
    settle_price: numeric(product.settlePrice), cost: numeric(product.cost), ot_price: numeric(product.otPrice), stock: product.stock,
    virtual_list: [], virtual_available: 0, virtual_total: 0, disk_info: [] };
  return { items: product.specType === 1 ? items : [], attrs: product.specType === 1 ? skuRows : [],
    attr: product.specType === 1 ? defaults : skuRows.length === 1 ? skuRows[0] : fallback,
    sku_repair_required: !complete || new Set(skus.map(row => row.unique)).size !== skus.length
      || skus.some(row => ![0, 1].includes(row.isRetired)),
    retired: skus.filter(row => row.isRetired === 1).map(row => outDetailSku(row, items, counts)), flatItems: items };
}
export function outDetailProduct(product: Product): Row {
  const info: Row = Object.fromEntries(Object.entries(product).map(([key, value]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value]));
  delete info.is_polices;
  Object.assign(info, { is_police: product.isPolices, cate_id: product.cateId.split(','), slider_image: legacyPhpJsonDecodeWire(product.sliderImage),
    delivery_type: product.deliveryType && product.deliveryType !== '0' ? product.deliveryType.split(',') : [], specs: outDetailJson(product.specs),
    is_sub: [...(product.isSub === 1 ? [1] : []), ...(product.isVip === 1 ? [0] : [])], recommend: [],
    video_open: Boolean(product.videoOpen), is_limit: Boolean(product.isLimit),
    presale_time: product.presaleStartTime ? [outDetailTime(product.presaleStartTime), outDetailTime(product.presaleEndTime)] : [],
    auto_on_time: product.isShow ? '' : product.autoOnTime ? outDetailTime(product.autoOnTime) : '',
    auto_off_time: !product.isShow ? '' : product.autoOffTime ? outDetailTime(product.autoOffTime) : '',
    activity: product.activity && product.activity !== '0' ? product.activity.split(',').map(value => activityNames[value] ?? value) : ['默认', '秒杀', '砍价', '拼团'] });
  for (const key of ['price', 'postage', 'ot_price', 'vip_price', 'cost', 'give_integral']) info[key] = numeric(info[key] as string);
  return info;
}
