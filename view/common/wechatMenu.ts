/** Authoring contract for the three actions supported by the fixed PHP editor.
 * Inactive fields are preserved locally; provider payloads contain active fields only. */
export interface WechatMenuButton {
  name: string;
  type?: 'click' | 'view' | 'miniprogram';
  key?: string;
  url?: string;
  appid?: string;
  pagepath?: string;
  sub_button?: WechatMenuButton[];
}
const encoder = new TextEncoder();
const fields = new Set(['name', 'type', 'key', 'url', 'appid', 'pagepath', 'sub_button', 'id']);
export function wechatMenuBytes(value: string): number { return encoder.encode(value).length; }
function text(value: unknown, label: string, maximum: number, required = true): string {
  if (typeof value !== 'string' || required && !value.trim() || wechatMenuBytes(value) > maximum
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value)) {
    throw Error(`${label}为空、超出${maximum}字节或含无效字符`);
  }
  return value;
}
function link(value: unknown): string {
  const result = text(value, '网页链接', 1024);
  try {
    const url = new URL(result);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\\\s]/u.test(result)) throw Error();
  } catch { throw Error('网页链接须为不含账号密码的完整 HTTP 或 HTTPS 地址'); }
  return result;
}
/** Empty drafts are representable, but publishing an empty menu is never deletion. */
export function normalizeWechatMenu(value: unknown, allowEmpty = false): WechatMenuButton[] {
  if (!Array.isArray(value) || value.length > 3 || !allowEmpty && value.length === 0) throw Error('请设置1至3个一级菜单；空菜单不能发布');
  function button(value: unknown, child: boolean): WechatMenuButton {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('菜单须为完整对象');
    const raw = value as Record<string, unknown>;
    if (Object.keys(raw).some(k => !fields.has(k)) || raw.id !== undefined && raw.id !== 0) throw Error('菜单包含当前编辑器不支持的历史字段，请先核对原始内容');
    const result: WechatMenuButton = { name: text(raw.name, child ? '子菜单名称' : '一级菜单名称', child ? 60 : 16) };
    if (raw.type !== undefined) {
      if (!['click', 'view', 'miniprogram'].includes(raw.type as string)) throw Error('历史菜单类型不受支持，请先核对原始内容');
      result.type = raw.type as WechatMenuButton['type'];
    }
    for (const key of ['key', 'url', 'appid', 'pagepath'] as const) {
      if (raw[key] !== undefined) result[key] = text(raw[key], key, key === 'appid' ? 64 : 2048, false);
    }
    if (raw.sub_button !== undefined) {
      if (!Array.isArray(raw.sub_button) || raw.sub_button.length > (child ? 0 : 5)) throw Error('仅支持两层菜单，每个一级菜单最多5个子菜单');
      result.sub_button = raw.sub_button.map(item => button(item, true));
    }
    if (result.sub_button?.length) return result;
    if (result.type === 'click') {
      result.key = text(result.key, '点击关键词', 128);
      // The mature callback and reply-key consumer use 64 UTF-16 code units.
      if (result.key.length > 64) throw Error('点击关键词最多64个字符单位，且不超过128字节');
    } else if (result.type === 'view' || result.type === 'miniprogram') {
      result.url = link(result.url);
      if (result.type === 'miniprogram') {
        if (typeof result.appid !== 'string' || !/^wx[a-zA-Z0-9]{16}$/u.test(result.appid)) throw Error('请填写有效的小程序 AppID');
        result.pagepath = text(result.pagepath, '小程序页面路径', 2048);
        if (result.pagepath.startsWith('/') || result.pagepath.includes('://') || /[\\\s]/u.test(result.pagepath)) throw Error('小程序页面路径须为 pages/… 形式的相对页面路径');
      }
    } else throw Error('请选择菜单响应类型');
    return result;
  }
  return value.map(item => button(item, false));
}
export function wechatMenuProviderButtons(value: readonly WechatMenuButton[]): Record<string, unknown>[] {
  return value.map(button => button.sub_button?.length
    ? { name: button.name, sub_button: wechatMenuProviderButtons(button.sub_button) }
    : button.type === 'click' ? { name: button.name, type: button.type, key: button.key }
    : button.type === 'miniprogram' ? { name: button.name, type: button.type, url: button.url, appid: button.appid, pagepath: button.pagepath }
    : { name: button.name, type: button.type, url: button.url });
}
export function wechatMenuCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(wechatMenuCanonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + wechatMenuCanonical((value as Record<string, unknown>)[key])).join(',') + '}';
}
