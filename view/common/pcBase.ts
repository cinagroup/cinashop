/** PREPARATION ONLY: not applied or verified. Fixed PHP pcBaseFormBuild's
 * thirteen non-Open fields. Website OAuth credentials remain Open-owned.
 *
 * Parsing preserves exact authored strings, array order and sort values.
 * It neither fetches media nor authorizes writes nor projects database rows.
 */
export const PC_BASE_KEYS = [
  'pc_logo', 'bast_number', 'first_number', 'product_phone_buy_url',
  'contact_number', 'company_address', 'copyright', 'seo_title',
  'site_keywords', 'site_description', 'links_open', 'links_list', 'filing_list',
] as const;
export const PC_BASE_OPEN_RESERVED_KEYS = [
  'wechat_open_app_id', 'wechat_open_app_secret', 'wechat_open_credentials_authority',
] as const;
export const PC_BASE_CONFIG_VALUE_CHARACTERS = 5000;
// Thirteen varchar(5000) JSON values at four UTF-8 bytes per character,
// plus the fixed envelope, fit this transport limit. Never truncate values.
export const PC_BASE_MAX_BODY_BYTES = 256 * 1024;
export type PcBaseKey = typeof PC_BASE_KEYS[number];
export type PcBaseLink = { name: string; url: string; sort: number };
export type PcBaseFiling = { icon: string; name: string; url: string; sort: number };
export type PcBaseValues = {
  pc_logo: string;
  bast_number: number;
  first_number: number;
  product_phone_buy_url: 1 | 2;
  contact_number: string;
  company_address: string;
  copyright: string;
  seo_title: string;
  site_keywords: string;
  site_description: string;
  links_open: 0 | 1;
  links_list: PcBaseLink[];
  filing_list: PcBaseFiling[];
};
/** Pure all-value validation fixture/helper only, never an HTTP save contract.
 * The modern HTTP writer accepts PcBaseIntentSave from pcBaseIntent instead;
 * these helpers supply the shared per-field replacement rules only. */
export type PcBaseSave = {
  request_id: string;
  revision: string;
  settings: PcBaseValues;
  confirmed: true;
};
export type PcBaseIssue = {
  key: PcBaseKey;
  code: 'missing' | 'invalid' | 'duplicate' | 'capacity' | 'metadata';
  message: string;
};
/** Presence and JSON parseability do not grant replacement or rendering
 * authority. Redaction must also cover unsafe decoded values, not only raw
 * JSON text. A kept historical value may remain an issue after other edits. */
export type PcBaseFieldState = {
  present: boolean;
  parseable: boolean;
  redacted: boolean;
};
/** A future fresh-SQL reader must supply only independently safe projections.
 * Exact stored raw bytes remain in the server snapshot for zero-write keep;
 * no unreviewed original URL, raw JSON or client preservation proof is sent
 * to the browser. A safe projection may retain the same stable HTTP value.
 * This type implements no projector, authorization or SQL reader. */
export type PcBaseSnapshot = {
  /** Safe projected author values only; null for missing, invalid or redacted
   * values. The UI defaults to keep without needing their original bytes. */
  settings: { [K in PcBaseKey]: PcBaseValues[K] | null };
  fields: Record<PcBaseKey, PcBaseFieldState>;
  revision: string;
  /** Operation storage readiness, not validation of every retained value. */
  runtime_ready: boolean;
  issues: PcBaseIssue[];
  /** Independently authorized safe previews only, separate from canonical
   * author values. Stored/private tickets are never copied into this map. */
  asset_previews: Record<string, string>;
};
export type PcBaseReceipt = {
  request_id: string;
  actor_id: number;
  state: 'committed' | 'not_applied';
  revision: string;
  created_at: number;
  replayed: boolean;
  cache_status: 'cleared' | 'pending' | 'not_required';
};
export const isPcBaseConfigKey = (value: unknown): value is PcBaseKey =>
  typeof value === 'string' && (PC_BASE_KEYS as readonly string[]).includes(value);
export const pcBaseRequestId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
export const pcBaseRevision = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{64}$/u.test(value);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw Error('PC配置须为JSON对象');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.values(descriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) {
    throw Error('PC配置须只包含JSON数据字段');
  }
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[]) {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
    throw Error('PC配置字段不完整或包含未知字段');
  }
}
function text(value: unknown, label: string, multiline = false): string {
  if (typeof value !== 'string' || [...value].length > PC_BASE_CONFIG_VALUE_CHARACTERS
    || [...value].some(character => {
      const point = character.codePointAt(0)!;
      return point >= 0xd800 && point <= 0xdfff;
    }) || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
      : /[\u0000-\u001f\u007f]/u).test(value)) throw Error(label + '文本无效或过长');
  return value;
}
function positiveInteger(value: unknown, label: string): number {
  // PHP's server rule is number|gt:0. Do not copy the form's min(0), and
  // do not clamp the saved value to an existing reader's 100-item budget.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw Error(label + '须为正整数');
  }
  return value;
}
function sort(value: unknown): number {
  // The fixed diyTable InputNumber has min=0, without integer precision.
  // Preserve fractional sort values instead of silently rounding them.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
    || value > Number.MAX_SAFE_INTEGER || Object.is(value, -0)) throw Error('PC表格排序号无效');
  return value;
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > PC_BASE_CONFIG_VALUE_CHARACTERS
    || Reflect.ownKeys(value).length !== value.length + 1
    || Object.keys(value).some((key, index) => key !== String(index))) throw Error('PC表格须为连续JSON列表');
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw Error('PC表格须只包含JSON数据项');
  }
  return value;
}

/** Compatibility with fixed PHP SystemConfigValidate's literal tel regex.
 * Empty strings are optional in think\Validate. The 400/landline branches
 * intentionally lack a terminal anchor in PHP: this candidate records that
 * quirk, rather than silently tightening existing author values. */
export function validPcBaseContact(value: string): boolean {
  return value === '' || /^400[0-9]{7}|^1[345789]\d{9}$|^0[0-9]{2,3}-[0-9]{8}/u.test(value);
}

function addressLayers(value: string, image: boolean): URL[] {
  let current = value;
  const result: URL[] = [];
  for (let depth = 0; depth <= 3; depth++) {
    if (depth === 0 && current !== current.trim() || /[\\\u0000-\u001f\u007f]/u.test(current)
      || depth === 0 && /\s/u.test(current)) throw Error('PC地址包含危险字符');
    const relative = /^\/(?!\/)/u.test(current);
    if (!relative && !/^https?:\/\//iu.test(current)) throw Error('PC地址方案无效');
    let url: URL;
    try { url = new URL(current, 'https://pc-base.invalid'); } catch { throw Error('PC地址无效'); }
    // Fixed PHP selected att_dir directly and did not impose HTTPS-only.
    // Stable safe HTTP is an author value too; presentation is separate.
    if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)
      || relative && url.pathname.startsWith('//')) throw Error('PC地址方案或路径无效');
    if (image && [...url.searchParams.keys()].some(key => /^(?:signature|expires|x-amz-signature|x-goog-signature)$/iu.test(key))) {
      throw Error('PC地址不能保存临时签名');
    }
    result.push(url);
    if (!/%[a-f0-9]{2}/iu.test(current)) break;
    if (depth === 3) throw Error('PC地址编码层数过深');
    try { current = decodeURIComponent(current); } catch { throw Error('PC地址编码无效'); }
  }
  return result;
}
const privateAssetPath = /^\/(?:api|kefuapi)\/assets(?:\/|$)/u;
/** Canonical platform image or stable public HTTP/HTTPS/relative image; empty
 * images remain allowed for optional pc_logo and optional filing icons.
 * Ticket signing and actual selected-attachment authority are service work. */
export function pcBaseImage(value: unknown): string {
  const source = text(value, 'PC图片');
  if (source === '') return source;
  const layers = addressLayers(source, true);
  if (layers.some(url => privateAssetPath.test(url.pathname))) {
    const match = /^\/api\/assets\/([1-9]\d{0,9})$/u.exec(source);
    if (!match || Number(match[1]) > 2147483647) throw Error('PC图片须为未签名且未编码的稳定素材引用');
  }
  return source;
}
/** Legacy footer links allow HTTP/HTTPS and root-relative destinations.
 * Unsafe schemes, browser credential prefixes, private bearer asset routes
 * and encoded aliases are never link destinations. No redirect is followed. */
export function pcBaseLink(value: unknown, empty = false): string {
  const source = text(value, 'PC链接');
  if (source === '' && empty) return source;
  if (!source) throw Error('友情链接地址不能为空');
  const layers = addressLayers(source, false);
  if (layers.some(url => privateAssetPath.test(url.pathname))) throw Error('PC链接不能指向私有素材地址');
  return source;
}
function linkRows(value: unknown): PcBaseLink[] {
  return rows(value).map(value => {
    const row = record(value); exact(row, ['name', 'url', 'sort']);
    const name = text(row.name, '友情链接名称');
    // PHP rejects exactly empty cells; whitespace is not rewritten to empty.
    if (name === '') throw Error('友情链接名称不能为空');
    return { name, url: pcBaseLink(row.url), sort: sort(row.sort) };
  });
}
function filingRows(value: unknown): PcBaseFiling[] {
  return rows(value).map(value => {
    const row = record(value); exact(row, ['icon', 'name', 'url', 'sort']);
    // The PHP filing-list nonempty loop is commented out. These three
    // optional fields must not inherit the stricter friendship-link rule.
    return { icon: pcBaseImage(row.icon), name: text(row.name, '备案名称'),
      url: pcBaseLink(row.url, true), sort: sort(row.sort) };
  });
}
function serialized(value: unknown, key: PcBaseKey): string {
  const result = JSON.stringify(value);
  if ([...result].length > PC_BASE_CONFIG_VALUE_CHARACTERS) {
    throw Error('PC配置' + key + '的序列化值超过数据库5000字符限制，不可截断');
  }
  return result;
}
function replacementValue(key: PcBaseKey, value: unknown): PcBaseValues[PcBaseKey] {
  switch (key) {
    case 'pc_logo': return pcBaseImage(value);
    case 'bast_number': return positiveInteger(value, '精品推荐个数');
    case 'first_number': return positiveInteger(value, '首发新品个数');
    case 'product_phone_buy_url':
      if (value !== 1 && value !== 2) throw Error('请选择公众号或小程序手机购买入口');
      return value;
    case 'links_open':
      if (value !== 0 && value !== 1) throw Error('请明确选择友情链接开关');
      return value;
    case 'contact_number': {
      const contact = text(value, '联系电话');
      if (!validPcBaseContact(contact)) throw Error('请填写有效的联系电话');
      return contact;
    }
    case 'company_address': return text(value, '公司地址');
    case 'copyright': return text(value, '版权信息');
    case 'seo_title': {
      // Seed id=5 required:true still applies despite status=0.
      const seo = text(value, '历史SEO标题');
      if (seo === '') throw Error('历史SEO标题不能为空');
      return seo;
    }
    case 'site_keywords': return text(value, '关键词');
    case 'site_description': return text(value, '网站描述', true);
    case 'links_list': return linkRows(value);
    case 'filing_list': return filingRows(value);
  }
}
/** One validation source for full-value proposals and field replacement
 * intents. A keep intent must never call this on historical stored bytes. */
export function normalizePcBaseReplacement<K extends PcBaseKey>(key: K, value: unknown): PcBaseValues[K] {
  if (!isPcBaseConfigKey(key)) throw Error('PC配置字段无效');
  const checked = replacementValue(key, value);
  serialized(checked, key);
  return checked as PcBaseValues[K];
}
export function serializePcBaseReplacement<K extends PcBaseKey>(key: K, value: unknown): string {
  return serialized(normalizePcBaseReplacement(key, value), key);
}
export function normalizePcBaseValues(value: unknown): PcBaseValues {
  const source = record(value); exact(source, PC_BASE_KEYS);
  const result = {} as PcBaseValues;
  for (const key of PC_BASE_KEYS) Object.assign(result, { [key]: normalizePcBaseReplacement(key, source[key]) });
  return result;
}
/** Pure full-value rule fixture only. Do not wire this parser to an HTTP route. */
export function parsePcBaseSave(value: unknown): PcBaseSave {
  const source = record(value); exact(source, ['request_id', 'revision', 'settings', 'confirmed']);
  if (!pcBaseRequestId(source.request_id) || !pcBaseRevision(source.revision) || source.confirmed !== true) {
    throw Error('请保留PC配置版本和请求标识，并明确确认保存');
  }
  const result: PcBaseSave = { request_id: source.request_id, revision: source.revision,
    settings: normalizePcBaseValues(source.settings), confirmed: true };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > PC_BASE_MAX_BODY_BYTES) {
    throw Error('PC配置请求超过256KiB，不可截断');
  }
  return result;
}
/** Pure full-value serialization helper. A service must apply per-field
 * intents instead; never serialize a merged historical keep snapshot here. */
export function serializePcBaseValues(value: unknown): Record<PcBaseKey, string> {
  const checked = normalizePcBaseValues(value);
  return Object.fromEntries(PC_BASE_KEYS.map(key => [key, serialized(checked[key], key)])) as Record<PcBaseKey, string>;
}
/** Pure full-value fixture helper, not the modern HTTP journal contract.
 * The intent journal is pcBaseIntentPending with its explicit PC domain. */
export function pcBasePending(input: PcBaseSave, actor: number) {
  if (!pcBaseRequestId(input.request_id) || !Number.isSafeInteger(actor) || actor <= 0) throw Error('PC保存记录归属无效');
  return { version: 1 as const, actor_id: actor, request_id: input.request_id };
}
