import { ValidateException } from '@/utils/errors';

export type RefundGenerationMarker = { refundId: number; role: 'remaining' | 'selected' } | { branchId: string; role: 'remaining' };
export function readRefundGenerationMarker(value: unknown): RefundGenerationMarker {
  const invalid = () => new ValidateException('退款拆分代次证据不一致，请先核对订单');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const marker = value as Record<string, unknown>;
  if (Object.keys(marker).length !== 2) throw invalid();
  if (typeof marker.refundId === 'number' && Number.isSafeInteger(marker.refundId) && marker.refundId > 0
    && marker.refundId <= 2147483647 && (marker.role === 'selected' || marker.role === 'remaining')) {
    return { refundId: marker.refundId, role: marker.role };
  }
  if (typeof marker.branchId === 'string' && /^[0-9a-f]{32}$/.test(marker.branchId) && marker.role === 'remaining') {
    return { branchId: marker.branchId, role: marker.role };
  }
  throw invalid();
}
