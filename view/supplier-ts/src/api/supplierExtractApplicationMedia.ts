import { apiRequest } from './http';
import { classifyProductMediaReference } from '../../../common/productMediaReference';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { extractHistoricalPrivateMediaId } from './supplierExtractMedia';
import { financeAccountsIdentity, financeAccountPreview, normalizeFinanceAccounts, readFinanceAccounts, sameFinanceAccounts,
  type FinanceAccounts, type FinanceQrPreview, type FinanceQrChannel } from './supplierFinanceAccounts';
import { extractApplicationImage, type ExtractApplicationReceipt, type ExtractApplicationSeed } from './supplierExtractApplication';

export class ExtractSeedMediaChanged extends Error { constructor() { super('收款资料已变化，请重新核对申请资料'); } }
export interface ExtractSeedMedia {
  actor_id: number; supplier_id: number; seed_revision: string; accounts: FinanceAccounts;
  previews: Record<FinanceQrChannel, FinanceQrPreview>;
}
export interface ExtractReceiptMedia {
  version: 'supplier-extract-application-media-v1'; operation_id: string; actor_id: number; supplier_id: number;
  request_hash: string; extract_id: number; preview: FinanceQrPreview; bounded: true;
}
const failure = () => Error('提现申请二维码无法核对，请重新读取');
function fact(value: unknown): asserts value { if (!value) throw failure(); }
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  fact(value && typeof value === 'object' && !Array.isArray(value)); const row = value as Record<string, unknown>;
  fact(Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key))); return row;
}
function seedAccounts(seed: ExtractApplicationSeed): FinanceAccounts {
  return normalizeFinanceAccounts({ bank_code: seed.accounts.bank.bank_code, bank_address: seed.accounts.bank.bank_address,
    alipay_account: seed.accounts.alipay.account, alipay_qrcode_url: seed.accounts.alipay.qrcode_url,
    wechat: seed.accounts.weixin.account, wechat_qrcode_url: seed.accounts.weixin.qrcode_url });
}
function committed(receipt: ExtractApplicationReceipt) {
  fact(receipt.state === 'committed' && receipt.result && /^[a-f0-9]{64}$/.test(receipt.request_hash)
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(receipt.operation_id));
  return receipt.result;
}
async function scoped<T>(identity: { actor_id: number; supplier_id: number }, signal: AbortSignal | undefined,
  read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const scope = createSupplierSessionScope(), controller = new AbortController(), cancel = () => controller.abort();
  scope.signal.addEventListener('abort', cancel); signal?.addEventListener('abort', cancel);
  try {
    const actual = financeAccountsIdentity();
    fact(!signal?.aborted && scope.isCurrent() && actual.actor_id === identity.actor_id && actual.supplier_id === identity.supplier_id);
    const value = await read(controller.signal); fact(!controller.signal.aborted && scope.isCurrent()); return value;
  } finally { signal?.removeEventListener('abort', cancel); scope.signal.removeEventListener('abort', cancel); scope.dispose(); }
}
/** The existing settings projection delegates previews only when all six
 * values equal the displayed seed. Its settings revision is not a seed token. */
export async function readExtractSeedMedia(seed: ExtractApplicationSeed, signal?: AbortSignal): Promise<ExtractSeedMedia> {
  return scoped(seed, signal, async scopedSignal => {
    const context = await readFinanceAccounts(seed, scopedSignal);
    if (!sameFinanceAccounts(context.accounts, seedAccounts(seed))) throw new ExtractSeedMediaChanged();
    return Object.freeze({ actor_id: seed.actor_id, supplier_id: seed.supplier_id, seed_revision: seed.revision,
      accounts: context.accounts, previews: context.previews });
  });
}
export function extractSeedQrImage(context: ExtractSeedMedia | undefined, seed: ExtractApplicationSeed,
  channel: FinanceQrChannel, now = Math.floor(Date.now() / 1000)): string {
  const reference = seed.accounts[channel].qrcode_url, literal = extractApplicationImage(reference);
  if (literal) return literal;
  if (!context || context.actor_id !== seed.actor_id || context.supplier_id !== seed.supplier_id || context.seed_revision !== seed.revision
    || !sameFinanceAccounts(context.accounts, seedAccounts(seed))) return '';
  return financeAccountPreview(context.previews[channel], reference, now);
}
export function parseExtractReceiptMedia(value: unknown, receipt: ExtractApplicationReceipt, now = Math.floor(Date.now() / 1000)): ExtractReceiptMedia {
  const result = committed(receipt), row = closed(value, ['version', 'operation_id', 'actor_id', 'supplier_id', 'request_hash', 'extract_id', 'preview', 'bounded']);
  fact(row.version === 'supplier-extract-application-media-v1' && row.bounded === true && row.operation_id === receipt.operation_id
    && row.actor_id === receipt.actor_id && row.supplier_id === receipt.supplier_id && row.request_hash === receipt.request_hash && row.extract_id === result.id);
  const preview = closed(row.preview, ['reference', 'status', 'src', 'expires_at']);
  fact(preview.reference === result.qrcode_url && typeof preview.src === 'string' && (preview.status === 'ready' || preview.status === 'unavailable'));
  if (preview.status === 'unavailable') fact(preview.src === '' && preview.expires_at === null);
  else {
    fact(result.extract_type === 'alipay' || result.extract_type === 'weixin');
    const reference = classifyProductMediaReference(result.qrcode_url); fact(reference.kind !== 'invalid');
    if (reference.kind === 'asset') {
      fact(extractHistoricalPrivateMediaId(result.qrcode_url) === reference.id);
      const match = new RegExp(`^/api/assets/${reference.id}\\?expires=([1-9]\\d*)&signature=([A-Za-z0-9_-]{43})$`).exec(preview.src);
      fact(match && Number.isSafeInteger(preview.expires_at) && preview.expires_at === Number(match[1])
        && Number(preview.expires_at) > now && Number(preview.expires_at) <= now + 300);
    } else fact(reference.reference === result.qrcode_url && preview.src === result.qrcode_url && preview.expires_at === null);
  }
  return Object.freeze({ version: 'supplier-extract-application-media-v1', operation_id: receipt.operation_id, actor_id: receipt.actor_id,
    supplier_id: receipt.supplier_id, request_hash: receipt.request_hash, extract_id: result.id,
    preview: Object.freeze({ reference: result.qrcode_url, status: preview.status, src: preview.src, expires_at: preview.expires_at as number | null }), bounded: true });
}
export async function readExtractReceiptMedia(receipt: ExtractApplicationReceipt, signal?: AbortSignal): Promise<ExtractReceiptMedia> {
  committed(receipt);
  return scoped(receipt, signal, async scopedSignal => parseExtractReceiptMedia(await apiRequest({ method: 'GET',
    url: `/finance/supplier_extract/application_operations/${receipt.operation_id}/media`, params: { request_hash: receipt.request_hash }, signal: scopedSignal }), receipt));
}
export function extractReceiptQrImage(context: ExtractReceiptMedia | undefined, receipt: ExtractApplicationReceipt,
  now = Math.floor(Date.now() / 1000)): string {
  if (receipt.state !== 'committed' || !receipt.result || receipt.result.extract_type === 'bank') return '';
  const literal = extractApplicationImage(receipt.result.qrcode_url); if (literal) return literal;
  try { return context ? parseExtractReceiptMedia(context, receipt, now).preview.src : ''; } catch { return ''; }
}
