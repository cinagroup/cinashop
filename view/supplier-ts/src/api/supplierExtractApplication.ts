import { apiRequest } from './http';
import { supplierExtractImage } from './supplierExtracts';

export type ExtractApplicationType = 'bank' | 'alipay' | 'weixin';
export interface ExtractApplicationSeed {
  version: 'supplier-extract-application-seed-v1'; actor_id: number; supplier_id: number; revision: string;
  available: string; min_price: string; max_price: string; can_apply: boolean;
  accounts: { bank: { bank_code: string; bank_address: string; ready: boolean };
    alipay: { account: string; qrcode_url: string; ready: boolean }; weixin: { account: string; qrcode_url: string; ready: boolean } };
}
export interface ExtractApplicationIntent {
  version: 'supplier-extract-application-intent-v1'; operation_id: string; actor_id: number; supplier_id: number;
  revision: string; extract_type: ExtractApplicationType; money: string; mark: string;
}
export interface PendingExtractApplication {
  version: 'supplier-extract-application-pending-v1'; operation_id: string; actor_id: number; supplier_id: number;
  request_hash: string; money: string; extract_type: ExtractApplicationType;
}
export interface ExtractApplicationResult {
  id: number; extract_type: ExtractApplicationType; extract_price: string; balance: string; bank_code: string; bank_address: string;
  alipay_account: string; wechat: string; qrcode_url: string; supplier_mark: string; status: 0; pay_status: 0; add_time: number;
}
export interface ExtractApplicationReceipt {
  version: 'supplier-extract-application-receipt-v1'; operation_id: string; actor_id: number; supplier_id: number;
  state: 'unknown' | 'committed' | 'not_applied'; request_hash: string; result: ExtractApplicationResult | null;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/, decimal = /^(?:0|[1-9]\d{0,17})\.\d{2}$/, storedMoney = /^(?:0|[1-9]\d{0,9})\.\d{2}$/;
const id = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
const own = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const fail = (): never => { throw Error('提现申请资料、原操作身份或结果不完整，请重新核对'); };
const type = (v: unknown): v is ExtractApplicationType => ['bank', 'alipay', 'weixin'].includes(String(v));
const scalar = (v: unknown, max: number, multiline = false): v is string => typeof v === 'string' && v.length <= max * 2 && [...v].length <= max
  && !(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(v)
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
const amount = (v: unknown, positive = false, stored = false): v is string => typeof v === 'string'
  && (stored ? storedMoney : decimal).test(v) && (!positive || v !== '0.00');
export const extractApplicationCents = (v: string) => { if (!amount(v)) return fail(); return BigInt(v.replace('.', '')); };
export function canonicalExtractApplication(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalExtractApplication).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalExtractApplication((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function extractApplicationRequestHash(intent: ExtractApplicationIntent) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalExtractApplication(intent)))))
    .map(n => n.toString(16).padStart(2, '0')).join('');
}
export const extractApplicationStorageKey = (actor: number, supplier: number) => `supplier_extract_application_pending_v1:${supplier}:${actor}`;
export function parseExtractApplicationSeed(value: unknown, actor: number, supplier: number): ExtractApplicationSeed {
  if (!id(actor) || !id(supplier) || !own(value, ['version', 'actor_id', 'supplier_id', 'revision', 'available', 'min_price', 'max_price', 'accounts', 'can_apply'])
    || value.version !== 'supplier-extract-application-seed-v1' || value.actor_id !== actor || value.supplier_id !== supplier
    || typeof value.revision !== 'string' || !hash.test(value.revision) || !amount(value.available) || !amount(value.min_price)
    || !amount(value.max_price) || typeof value.can_apply !== 'boolean' || !own(value.accounts, ['bank', 'alipay', 'weixin'])) return fail();
  const bank = value.accounts.bank;
  if (!own(bank, ['bank_code', 'bank_address', 'ready']) || !scalar(bank.bank_code, 32) || !scalar(bank.bank_address, 256)
    || bank.ready !== (!!bank.bank_code && bank.bank_code !== '0' && !!bank.bank_address)) return fail();
  for (const key of ['alipay', 'weixin'] as const) {
    const row = value.accounts[key];
    if (!own(row, ['account', 'qrcode_url', 'ready']) || !scalar(row.account, key === 'alipay' ? 64 : 15)
      || !scalar(row.qrcode_url, 255) || row.ready !== (!!row.account && !!row.qrcode_url)) return fail();
  }
  const min = extractApplicationCents(value.min_price), max = extractApplicationCents(value.max_price), available = extractApplicationCents(value.available);
  if (value.can_apply !== (max > 0n && max >= (min > 0n ? min : 1n) && available >= (min > 0n ? min : 1n))) return fail();
  return value as unknown as ExtractApplicationSeed;
}
export function normalizeExtractApplicationMoney(input: string): string {
  const value = input.trim(); if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) throw Error('请输入正确的提现金额，最多两位小数');
  const [whole, fraction = ''] = value.split('.'); const normalized = `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
  if (!amount(normalized, true, true)) throw Error('提现金额须为正数且不超过9999999999.99'); return normalized;
}
export function makeExtractApplicationIntent(seed: ExtractApplicationSeed, operation: string, extractType: ExtractApplicationType, money: string, mark: string): ExtractApplicationIntent {
  if (!uuid.test(operation) || !type(extractType) || !amount(money, true, true) || !scalar(mark, 255, true) || mark !== mark.trim()
    || !seed.can_apply || !seed.accounts[extractType].ready) throw Error('请核对提现金额、备注和完整收款资料');
  const cents = extractApplicationCents(money), min = extractApplicationCents(seed.min_price);
  if (cents < (min > 0n ? min : 1n) || cents > extractApplicationCents(seed.max_price) || cents > extractApplicationCents(seed.available))
    throw Error('提现金额超出当前可用余额或平台限额，请重新核对');
  return { version: 'supplier-extract-application-intent-v1', operation_id: operation, actor_id: seed.actor_id, supplier_id: seed.supplier_id,
    revision: seed.revision, extract_type: extractType, money, mark };
}
export function parsePendingExtractApplication(value: unknown, actor: number, supplier: number): PendingExtractApplication {
  if (!id(actor) || !id(supplier) || !own(value, ['version', 'operation_id', 'actor_id', 'supplier_id', 'request_hash', 'money', 'extract_type'])
    || value.version !== 'supplier-extract-application-pending-v1' || value.actor_id !== actor || value.supplier_id !== supplier
    || typeof value.operation_id !== 'string' || !uuid.test(value.operation_id) || typeof value.request_hash !== 'string' || !hash.test(value.request_hash)
    || !amount(value.money, true, true) || !type(value.extract_type)) return fail();
  return value as unknown as PendingExtractApplication;
}
export function parseExtractApplicationReceipt(value: unknown, pending: PendingExtractApplication): ExtractApplicationReceipt {
  if (!own(value, ['version', 'operation_id', 'actor_id', 'supplier_id', 'state', 'request_hash', 'result'])
    || value.version !== 'supplier-extract-application-receipt-v1' || value.operation_id !== pending.operation_id || value.actor_id !== pending.actor_id
    || value.supplier_id !== pending.supplier_id || !['unknown', 'committed', 'not_applied'].includes(String(value.state))) return fail();
  if (value.state !== 'committed') { if (value.request_hash !== '' || value.result !== null) return fail(); }
  else {
    const row = value.result;
    if (value.request_hash !== pending.request_hash || !own(row, ['id', 'extract_type', 'extract_price', 'balance', 'bank_code', 'bank_address',
      'alipay_account', 'wechat', 'qrcode_url', 'supplier_mark', 'status', 'pay_status', 'add_time']) || !id(row.id) || !id(row.add_time)
      || row.extract_type !== pending.extract_type || row.extract_price !== pending.money || !amount(row.balance, false, true)
      || row.status !== 0 || row.pay_status !== 0 || !scalar(row.bank_code, 32) || !scalar(row.bank_address, 256)
      || !scalar(row.alipay_account, 64) || !scalar(row.wechat, 15) || !scalar(row.qrcode_url, 255) || !scalar(row.supplier_mark, 255, true)) return fail();
    if (row.extract_type === 'bank' ? !row.bank_code || row.bank_code === '0' || !row.bank_address || !!row.alipay_account || !!row.wechat || !!row.qrcode_url
      : row.extract_type === 'alipay' ? !!row.bank_code || !!row.bank_address || !row.alipay_account || !!row.wechat || !row.qrcode_url
        : !!row.bank_code || !!row.bank_address || !!row.alipay_account || !row.wechat || !row.qrcode_url) return fail();
  }
  return value as unknown as ExtractApplicationReceipt;
}
/** Cross-tab reservation is atomic. No request is sent without a readable,
 * durable own-actor journal; no original account, note or token is persisted. */
async function journalLock<T>(actor: number, supplier: number, work: () => Promise<T> | T): Promise<T> {
  if (!id(actor) || !id(supplier) || typeof navigator === 'undefined' || !navigator.locks?.request)
    throw Error('浏览器无法保护原申请记录，请使用支持安全存储的现代浏览器');
  return navigator.locks.request(extractApplicationStorageKey(actor, supplier), { mode: 'exclusive' }, work);
}
export async function reserveExtractApplication(pending: PendingExtractApplication, current: () => boolean) {
  parsePendingExtractApplication(pending, pending.actor_id, pending.supplier_id);
  return journalLock(pending.actor_id, pending.supplier_id, () => {
    if (!current()) throw Error('会话或申请资料已变化，请重新打开');
    const key = extractApplicationStorageKey(pending.actor_id, pending.supplier_id);
    if (localStorage.getItem(key)) throw Error('已有原提现申请待核对，请先查询原结果');
    const text = JSON.stringify(pending); localStorage.setItem(key, text);
    if (localStorage.getItem(key) !== text) throw Error('原提现申请未能可靠保存，不能提交');
  });
}
export async function clearExtractApplication(pending: PendingExtractApplication, current: () => boolean) {
  return journalLock(pending.actor_id, pending.supplier_id, () => {
    if (!current()) throw Error('会话已变化，请重新打开原申请结果');
    const key = extractApplicationStorageKey(pending.actor_id, pending.supplier_id), raw = localStorage.getItem(key);
    if (!raw || canonicalExtractApplication(parsePendingExtractApplication(JSON.parse(raw), pending.actor_id, pending.supplier_id)) !== canonicalExtractApplication(pending))
      throw Error('本机原申请已变化，请重新打开核对');
    localStorage.removeItem(key); if (localStorage.getItem(key) !== null) throw Error('本机原申请仍未清除，请保留并重新核对');
  });
}
const path = '/finance/supplier_extract';
export async function getExtractApplicationSeed(actor: number, supplier: number, signal?: AbortSignal) {
  return parseExtractApplicationSeed(await apiRequest({ method: 'GET', url: path + '/cash', signal }), actor, supplier);
}
export async function submitExtractApplication(intent: ExtractApplicationIntent, pending: PendingExtractApplication, current: () => boolean, signal?: AbortSignal) {
  if (pending.operation_id !== intent.operation_id || pending.actor_id !== intent.actor_id || pending.supplier_id !== intent.supplier_id
    || pending.request_hash !== await extractApplicationRequestHash(intent)) return fail();
  if (signal?.aborted || !current()) throw Error('会话或原申请已变化，请重新打开原申请结果');
  return parseExtractApplicationReceipt(await apiRequest({ method: 'POST', url: path + '/cash', signal,
    data: { operation_id: intent.operation_id, revision: intent.revision, extract_type: intent.extract_type, money: intent.money, mark: intent.mark } }), pending);
}
export async function recoverExtractApplication(pending: PendingExtractApplication, close = false, signal?: AbortSignal) {
  parsePendingExtractApplication(pending, pending.actor_id, pending.supplier_id);
  return parseExtractApplicationReceipt(await apiRequest({ method: close ? 'POST' : 'GET',
    url: path + '/application_operations/' + pending.operation_id + (close ? '/resolve' : ''), ...(close ? { data: {} } : {}), signal }), pending);
}
export const extractApplicationImage = supplierExtractImage;
