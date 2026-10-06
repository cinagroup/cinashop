export type {
  MerchantManagementEnvelope, MerchantManagementContext, MerchantCapabilities,
  MerchantOrderActions, MerchantActionAvailability, MerchantOrderAction,
  MerchantOrderStatistics, MerchantOrderPeriod, MerchantOrderChartPoint,
  MerchantOrderDailyRow, MerchantPaged, MerchantOrderCart, MerchantOrderListItem,
  MerchantOrderDetail, MerchantDeliveryDefaults, MerchantDeliveryAgent,
  MerchantCarrier, MerchantOperationReceipt, MerchantOrderSelector,
  MerchantDeliveryGain, MerchantExpressResult, MerchantTrackingPackage,
} from '../../../common/merchantManagement';

export interface MerchantPendingIntent {
  request_key: string; actor_uid: number; store_id: number; scope_key: string;
  action: string; order_id: string; receipt_path: string; receipt_method: 'GET'|'POST';
  created_at: number; funds_pending?: boolean; request_hash?: string; endpoint?: string; method?: 'POST'|'PUT';
  body?: Record<string,unknown>; abandon_path?: string;
}
export interface MerchantOperationPlan {
  action: string; order_id: string; endpoint: string; method?: 'POST'|'PUT';
  body: Record<string, unknown>; receipt_path: string; receipt_method?: 'GET'|'POST';
  abandon_path?: string;
}
