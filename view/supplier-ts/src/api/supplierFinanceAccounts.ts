import { apiRequest } from './http';
import { classifyProductMediaReference } from '../../../common/productMediaReference';

export const financeAccountLimits = { bank_code: 32, bank_address: 256, alipay_account: 64,
  alipay_qrcode_url: 255, wechat: 15, wechat_qrcode_url: 255 } as const;
export type FinanceAccountField = keyof typeof financeAccountLimits;
export type FinanceAccounts = Record<FinanceAccountField, string>;
export type FinanceQrChannel = 'alipay' | 'weixin';
export interface FinanceAccountsIdentity { actor_id: number; supplier_id: number }
export interface FinanceQrPreview { reference: string; status: 'ready' | 'unavailable'; src: string; expires_at: number | null }
export interface FinanceAccountsContext extends FinanceAccountsIdentity {
  version: 'supplier-finance-accounts-v1'; revision: string; accounts: FinanceAccounts;
  ready: Record<'bank' | FinanceQrChannel, boolean>; previews: Record<FinanceQrChannel, FinanceQrPreview>; bounded: true;
}
export type FinanceAccountsSave = FinanceAccounts & { revision: string };
const fields = Object.keys(financeAccountLimits) as FinanceAccountField[];
const fail = () => new Error('收款资料无法核对，请重新读取');
function fact(value: unknown): asserts value { if (!value) throw fail(); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  fact(value && typeof value === 'object' && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  fact(Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)));
  return row;
}
function positive(value: unknown): number {
  fact(typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647); return value;
}
export function financeAccountText(value: unknown, limit: number): string {
  fact(typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value));
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++i); fact(next >= 0xdc00 && next <= 0xdfff); }
    else fact(unit < 0xdc00 || unit > 0xdfff);
  }
  const text = value.trim(); fact([...text].length <= limit); return text;
}
export function emptyFinanceAccounts(): FinanceAccounts {
  return { bank_code: '', bank_address: '', alipay_account: '', alipay_qrcode_url: '', wechat: '', wechat_qrcode_url: '' };
}
export function normalizeFinanceAccounts(value: unknown): FinanceAccounts {
  const row = record(value, fields), result = emptyFinanceAccounts();
  for (const field of fields) result[field] = financeAccountText(row[field], financeAccountLimits[field]);
  if (result.bank_code === '0') result.bank_code = '';
  return result;
}
export function sameFinanceAccounts(left: FinanceAccounts, right: FinanceAccounts): boolean {
  return fields.every(field => left[field] === right[field]);
}
export function financeAccountsIdentity(): FinanceAccountsIdentity {
  try {
    const user = JSON.parse(localStorage.getItem('supplier-user') ?? 'null');
    return Object.freeze({ actor_id: positive(user?.id), supplier_id: positive(user?.supplier_id) });
  } catch { throw new Error('供应商登录资料已失效，请重新登录'); }
}
export function financeAccountCanonicalReference(reference: string): string {
  const value = classifyProductMediaReference(reference);
  fact(value.kind !== 'invalid' && value.reference === reference);
  if (value.kind === 'public') {
    const url = new URL(reference, 'https://supplier-media.invalid');
    for (const key of url.searchParams.keys()) fact(!/^(expires|signature)$/i.test(key));
  }
  return reference;
}
function parsePreview(value: unknown, reference: string, now: number): FinanceQrPreview {
  const row = record(value, ['reference', 'status', 'src', 'expires_at']);
  fact(row.reference === reference && (row.status === 'ready' || row.status === 'unavailable') && typeof row.src === 'string');
  if (row.status === 'unavailable') { fact(row.src === '' && row.expires_at === null); return Object.freeze({ reference, status: 'unavailable', src: '', expires_at: null }); }
  const media = classifyProductMediaReference(reference); fact(media.kind !== 'invalid' && media.reference === reference);
  if (media.kind === 'asset') {
    fact(Number.isSafeInteger(row.expires_at) && Number(row.expires_at) > now && Number(row.expires_at) <= now + 3600);
    const match = new RegExp(`^/api/assets/${media.id}\\?expires=([1-9]\\d*)&signature=([A-Za-z0-9_-]{43})$`).exec(row.src);
    fact(match && Number(match[1]) === row.expires_at);
  } else fact(row.src === reference && row.expires_at === null);
  return Object.freeze({ reference, status: 'ready', src: row.src, expires_at: row.expires_at as number | null });
}
export function parseFinanceAccounts(value: unknown, identity: FinanceAccountsIdentity, now = Math.floor(Date.now() / 1000)): FinanceAccountsContext {
  const row = record(value, ['version', 'actor_id', 'supplier_id', 'revision', 'accounts', 'ready', 'previews', 'bounded']);
  fact(row.version === 'supplier-finance-accounts-v1' && row.bounded === true);
  fact(positive(row.actor_id) === identity.actor_id && positive(row.supplier_id) === identity.supplier_id);
  fact(typeof row.revision === 'string' && /^[a-f0-9]{64}$/.test(row.revision));
  const accounts = normalizeFinanceAccounts(row.accounts);
  fact(sameFinanceAccounts(accounts, row.accounts as FinanceAccounts));
  const readiness = record(row.ready, ['bank', 'alipay', 'weixin']);
  const ready = { bank: !!accounts.bank_code && !!accounts.bank_address,
    alipay: !!accounts.alipay_account && !!accounts.alipay_qrcode_url, weixin: !!accounts.wechat && !!accounts.wechat_qrcode_url };
  fact(Object.entries(ready).every(([key, value]) => readiness[key] === value));
  const previews = record(row.previews, ['alipay', 'weixin']);
  return Object.freeze({ version: 'supplier-finance-accounts-v1', actor_id: identity.actor_id, supplier_id: identity.supplier_id, revision: row.revision,
    accounts: Object.freeze(accounts), ready: Object.freeze(ready), previews: Object.freeze({
      alipay: parsePreview(previews.alipay, accounts.alipay_qrcode_url, now),
      weixin: parsePreview(previews.weixin, accounts.wechat_qrcode_url, now),
    }), bounded: true });
}
export function makeFinanceAccountsSave(context: FinanceAccountsContext, value: unknown): FinanceAccountsSave {
  const accounts = normalizeFinanceAccounts(value);
  for (const field of ['alipay_qrcode_url', 'wechat_qrcode_url'] as const) {
    if (accounts[field] && accounts[field] !== context.accounts[field]) financeAccountCanonicalReference(accounts[field]);
  }
  return Object.freeze({ ...accounts, revision: context.revision });
}
export function financeAccountPreview(preview: FinanceQrPreview | undefined, reference: string, now = Math.floor(Date.now() / 1000)): string {
  try { return parsePreview(preview, reference, now).src; } catch { return ''; }
}
export async function readFinanceAccounts(identity: FinanceAccountsIdentity, signal?: AbortSignal): Promise<FinanceAccountsContext> {
  return parseFinanceAccounts(await apiRequest<unknown>({ method: 'GET', url: '/finance/info', params: { selection: 'accounts' }, signal }), identity);
}
export async function saveFinanceAccounts(context: FinanceAccountsContext, input: FinanceAccountsSave,
  current: () => boolean, signal?: AbortSignal): Promise<FinanceAccountsContext> {
  const row = record(input, [...fields, 'revision']); fact(row.revision === context.revision);
  const scalar = emptyFinanceAccounts(); for (const field of fields) scalar[field] = row[field] as string;
  const data = makeFinanceAccountsSave(context, scalar);
  fact(!signal?.aborted && current());
  const result = parseFinanceAccounts(await apiRequest<unknown>({ method: 'POST', url: '/finance/info', params: { selection: 'accounts' }, data, signal }), context);
  fact(result.revision !== context.revision && sameFinanceAccounts(result.accounts, data)); return result;
}
