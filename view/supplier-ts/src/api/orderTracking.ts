import { apiRequest } from './http';
import { previewMode } from './supplier';

export interface SupplierTrackingTarget {
  id: number;
  order_id: string;
  delivery_type: string;
  delivery_name: string;
  delivery_code: string;
  delivery_id: string;
}
export type SupplierTrackingState = 'pending' | 'in_transit' | 'delivered' | 'exception' | 'not_configured' | 'temporarily_unavailable';
export interface SupplierOrderTracking {
  orderId: string;
  expressName: string;
  expressCode: string;
  expressNo: string;
  deliveryStatus: string;
  trackingState: SupplierTrackingState;
  trackingSource: 'merchant' | 'carrier' | 'cache';
  message: string;
  lastUpdatedAt: number;
  traces: Array<{ time: string; content: string; status: string }>;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('物流响应不完整');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 262144) throw Error('物流响应不完整');
  return value;
}
export function parseSupplierOrderTracking(value: unknown, target: SupplierTrackingTarget): SupplierOrderTracking {
  const row = record(value), order = record(row.order);
  if (!Array.isArray(row.packages) || row.packages.length !== 1) throw Error('物流包裹身份不一致，请重新读取订单');
  const item = record(row.packages[0]);
  const fields = ['orderId', 'expressName', 'expressCode', 'expressNo', 'deliveryStatus', 'trackingState', 'trackingSource', 'message', 'lastUpdatedAt'] as const;
  if (fields.some(key => row[key] !== item[key]) || JSON.stringify(row.traces) !== JSON.stringify(item.traces)
    || row.orderId !== target.order_id || order.order_id !== row.orderId || order.delivery_type !== 'express'
    || row.expressName !== target.delivery_name || row.expressCode !== target.delivery_code || row.expressNo !== target.delivery_id
    || order.delivery_name !== row.expressName || order.delivery_code !== row.expressCode || order.delivery_id !== row.expressNo
    || row.delivery_name !== row.expressName || row.delivery_id !== row.expressNo) throw Error('物流包裹身份不一致，请重新读取订单');
  const state = text(row.trackingState), source = text(row.trackingSource);
  if (!['pending', 'in_transit', 'delivered', 'exception', 'not_configured', 'temporarily_unavailable'].includes(state)
    || !['merchant', 'carrier', 'cache'].includes(source) || !Number.isSafeInteger(row.lastUpdatedAt) || Number(row.lastUpdatedAt) < 0
    || !Array.isArray(row.traces) || row.traces.length > 200) throw Error('物流响应不完整');
  const traces = row.traces.map(raw => { const trace = record(raw); return { time: text(trace.time), content: text(trace.content), status: text(trace.status) }; });
  const legacy = traces.map(trace => ({ time: trace.time, status: trace.content }));
  if (JSON.stringify(row.result) !== JSON.stringify(legacy) || JSON.stringify(row.express) !== JSON.stringify(legacy)
    || source === 'merchant' && traces.length || ['not_configured', 'temporarily_unavailable'].includes(state) && traces.length) throw Error('物流响应不完整');
  return { orderId: text(row.orderId), expressName: text(row.expressName), expressCode: text(row.expressCode), expressNo: text(row.expressNo),
    deliveryStatus: text(row.deliveryStatus), trackingState: state as SupplierTrackingState, trackingSource: source as SupplierOrderTracking['trackingSource'],
    message: text(row.message), lastUpdatedAt: Number(row.lastUpdatedAt), traces };
}
export async function getSupplierOrderTracking(target: SupplierTrackingTarget, signal?: AbortSignal): Promise<SupplierOrderTracking> {
  if (previewMode) throw Error('预览模式无法查询承运商物流，请登录后查看实际运单');
  if (!target || !Number.isSafeInteger(target.id) || target.id <= 0 || target.id > 2147483647 || target.delivery_type !== 'express'
    || [target.order_id, target.delivery_name, target.delivery_code, target.delivery_id].some(value => typeof value !== 'string') || !target.delivery_id.trim())
    throw Error('请选择已填写快递运单的具体包裹');
  return parseSupplierOrderTracking(await apiRequest<unknown>({ method: 'GET', url: `/order/express/${target.id}`, signal }), target);
}
