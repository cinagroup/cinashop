/** The authored DIY customerService contract, shared by its editor and client.
 * Imported strings remain strings: the PHP client used JavaScript truthiness
 * for both switches and for the zero/default position. Reading never rewrites. */
export type CustomerServiceRecord = Record<string, unknown>;
export const customerServiceRecord = (value: unknown): CustomerServiceRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as CustomerServiceRecord : null;

export function customerServiceSwitch(value: unknown, fallback: 0 | 1): 0 | 1 {
  if (value === undefined) return fallback;
  if (![0, 1, '0', '1'].includes(value as never)) throw Error('悬浮客服选项无效');
  return value ? 1 : 0;
}

export function customerServiceTop(value: unknown): number {
  if (value === undefined || value === 0) return 30;
  const number = typeof value === 'number' || typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) throw Error('悬浮客服偏移无效');
  return Math.min(number, 80);
}

export function readDiyCustomerService(value: unknown) {
  const block = customerServiceRecord(value);
  if (block?.name !== 'customerService') throw Error('悬浮客服组件无效');
  const child = (key: string) => customerServiceRecord(block[key]);
  const logo = child('logoConfig');
  const text = (value: unknown, maximum: number) => {
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > maximum) throw Error('悬浮客服地址无效');
    return value;
  };
  const routine = block.routine_contact_type;
  const contactType = routine === undefined ? 0 : typeof routine === 'number' || typeof routine === 'string' && /^(?:0|[1-9]\d*)$/u.test(routine) ? Number(routine) : NaN;
  if (!Number.isSafeInteger(contactType) || contactType < 0 || contactType > 2147483647) throw Error('小程序客服配置无效');
  return {
    enabled: ![true, 1, '1'].includes(block.isHide as never),
    service: customerServiceSwitch(child('buttonConfig')?.tabVal, 0) === 1,
    right: customerServiceSwitch(child('locationConfig')?.tabVal, 1) === 1,
    topPercent: customerServiceTop(child('topConfig')?.val),
    logo: text(logo?.url, 8192),
    link: text(logo?.link, 2048),
    contactType,
  };
}

export function newDiyCustomerService(timestamp: number): CustomerServiceRecord {
  return { name: 'customerService', cname: '悬浮按钮', timestamp, isHide: false,
    setUp: { tabVal: 0 }, titleLeft: '按钮设置', titleRight: '位置设置',
    buttonConfig: { title: '按钮跳转', tabVal: 0, tabList: [{name: '页面链接'}, {name: '客服入口'}] },
    locationConfig: { title: '展示位置', tabVal: 1, tabList: [{name: '左'}, {name: '右'}] },
    logoConfig: { title: '建议：展示上传100*100px；', url: '', link: '' },
    topConfig: { title: '上下偏移', val: 0, min: 0 } };
}
