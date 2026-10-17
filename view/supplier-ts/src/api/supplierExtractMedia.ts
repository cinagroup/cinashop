import { apiRequest } from './http';
import { classifyProductMediaReference } from '../../../common/productMediaReference';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import type { SupplierExtractRecord } from './supplierExtracts';

export type ExtractMediaKind = 'qrcode' | 'voucher';
export interface ExtractMediaIdentity { actor_id: number; supplier_id: number }
export interface ExtractMediaPreview { reference: string; status: 'ready' | 'unavailable'; src: string; expires_at: number | null }
export interface SupplierExtractMedia extends ExtractMediaIdentity {
  version: 'supplier-extract-media-v1'; id: number; revision: string;
  previews: Record<ExtractMediaKind, ExtractMediaPreview>; bounded: true;
}
const failure = () => Error('提现明细图片无法核对，请重新读取');
function fact(value: unknown): asserts value { if (!value) throw failure(); }
function positive(value: unknown): number { fact(typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647); return value; }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  fact(value && typeof value === 'object' && !Array.isArray(value)); const row = value as Record<string, unknown>;
  fact(Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key))); return row;
}
export function extractMediaReference(row: SupplierExtractRecord, kind: ExtractMediaKind): string {
  return kind === 'qrcode' ? row.qrcode_url : row.voucher_image;
}
export function extractMediaEligible(row: SupplierExtractRecord, kind: ExtractMediaKind): boolean {
  return kind === 'qrcode' ? ['alipay', 'weixin'].includes(row.extract_type)
    : row.status === 1 && row.pay_status === 1 && row.admin_id > 0 && !!row.pay_time;
}
/** Only the two actual old root mounts and their exact ticket form can be
 * renewed; encoded, absolute or ambiguous aliases stay unavailable. */
export function extractHistoricalPrivateMediaId(reference: string): number | undefined {
  const value = classifyProductMediaReference(reference);
  if (value.kind !== 'asset') return;
  const match = /^\/(?:api|kefuapi)\/assets\/([1-9]\d*)(?:\?([^#]+))?$/.exec(reference);
  if (!match || Number(match[1]) !== value.id) return;
  if (match[2]) {
    const query = new URLSearchParams(match[2]);
    if ([...query.keys()].length !== 2 || query.getAll('expires').length !== 1 || query.getAll('signature').length !== 1
      || !/^\d{1,16}$/.test(query.get('expires') ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(query.get('signature') ?? '')) return;
  }
  return value.id;
}
export function currentExtractMediaIdentity(): ExtractMediaIdentity {
  try { const user = JSON.parse(localStorage.getItem('supplier-user') ?? 'null'); return Object.freeze({ actor_id: positive(user?.id), supplier_id: positive(user?.supplier_id) }); }
  catch { throw Error('供应商登录资料已失效，请重新登录'); }
}
function preview(value: unknown, source: SupplierExtractRecord, kind: ExtractMediaKind, now: number): ExtractMediaPreview {
  const row = record(value, ['reference', 'status', 'src', 'expires_at']), reference = extractMediaReference(source, kind);
  fact(row.reference === reference && typeof row.src === 'string' && (row.status === 'ready' || row.status === 'unavailable'));
  if (row.status === 'unavailable') { fact(row.src === '' && row.expires_at === null); return Object.freeze({ reference, status: 'unavailable', src: '', expires_at: null }); }
  fact(extractMediaEligible(source, kind)); const media = classifyProductMediaReference(reference); fact(media.kind !== 'invalid');
  if (media.kind === 'asset') {
    fact(extractHistoricalPrivateMediaId(reference) === media.id);
    const match = new RegExp(`^/api/assets/${media.id}\\?expires=([1-9]\\d*)&signature=([A-Za-z0-9_-]{43})$`).exec(row.src);
    fact(match && Number.isSafeInteger(row.expires_at) && row.expires_at === Number(match[1]) && Number(row.expires_at) > now && Number(row.expires_at) <= now + 300);
  } else fact(media.reference === reference && row.src === reference && row.expires_at === null);
  return Object.freeze({ reference, status: 'ready', src: row.src, expires_at: row.expires_at as number | null });
}
export function parseSupplierExtractMedia(value: unknown, identity: ExtractMediaIdentity, source: SupplierExtractRecord,
  now = Math.floor(Date.now() / 1000)): SupplierExtractMedia {
  const row = record(value, ['version', 'actor_id', 'supplier_id', 'id', 'revision', 'previews', 'bounded']);
  fact(row.version === 'supplier-extract-media-v1' && row.bounded === true && positive(row.actor_id) === positive(identity.actor_id));
  fact(positive(row.supplier_id) === positive(identity.supplier_id) && row.supplier_id === source.supplier_id && positive(row.id) === source.id);
  fact(typeof row.revision === 'string' && /^[a-f0-9]{64}$/.test(row.revision) && row.revision === source.revision);
  const previews = record(row.previews, ['qrcode', 'voucher']);
  return Object.freeze({ version: 'supplier-extract-media-v1', ...identity, id: source.id, revision: row.revision,
    previews: Object.freeze({ qrcode: preview(previews.qrcode, source, 'qrcode', now), voucher: preview(previews.voucher, source, 'voucher', now) }), bounded: true });
}
/** A preview may disclose only this historical row and kind. A raw private ID
 * or another kind's projection never authorizes a rendered image. */
export function supplierExtractMediaImage(context: SupplierExtractMedia | undefined, source: SupplierExtractRecord, kind: ExtractMediaKind,
  now = Math.floor(Date.now() / 1000)): string {
  if (!extractMediaEligible(source, kind)) return '';
  const reference = extractMediaReference(source, kind), media = classifyProductMediaReference(reference);
  if (media.kind === 'public' && media.reference === reference) return reference;
  if (!context || context.id !== source.id || context.supplier_id !== source.supplier_id || context.revision !== source.revision) return '';
  try { return preview(context.previews[kind], source, kind, now).src; } catch { return ''; }
}
export async function readSupplierExtractMedia(identity: ExtractMediaIdentity, source: SupplierExtractRecord, signal?: AbortSignal): Promise<SupplierExtractMedia> {
  positive(source.id); fact(source.supplier_id === positive(identity.supplier_id) && /^[a-f0-9]{64}$/.test(source.revision)); positive(identity.actor_id);
  const scope = createSupplierSessionScope(), controller = new AbortController(), cancel = () => controller.abort();
  scope.signal.addEventListener('abort', cancel); signal?.addEventListener('abort', cancel);
  try {
    fact(!signal?.aborted && scope.isCurrent());
    const value = await apiRequest<unknown>({ method: 'GET', url: `/finance/supplier_extract/${source.id}/media`, params: { revision: source.revision }, signal: controller.signal });
    fact(!controller.signal.aborted && scope.isCurrent()); return parseSupplierExtractMedia(value, identity, source);
  } finally { signal?.removeEventListener('abort', cancel); scope.signal.removeEventListener('abort', cancel); scope.dispose(); }
}
