export type {
  DeliveryWorkbenchEnvelope,DeliveryWorkbenchContext,DeliveryContextSelection,DeliveryContextIdentity,
  DeliveryWorkbenchStatistics,DeliveryDailyRow,DeliveryPaged,DeliveryOrderCart,DeliveryAvailability,
  DeliveryOrderActions,DeliveryOrderStore,DeliveryOrderStatus,DeliveryOrderItem,DeliveryOrderDetail,DeliveryOrdersPage,
} from '../../../common/deliveryWorkbench';
export type {DeliveryOperationInput,DeliveryOperationReceipt,DeliveryOperationResult,DeliveryWriteoffPayload,DeliveryWriteoffCart,DeliveryWriteoffPreview,DeliveryWriteoffPreviews,DeliveryWriteoffRecord} from '../../../common/deliveryWriteoff';
import type {DeliveryOperationInput} from '../../../common/deliveryWriteoff';
export interface DeliveryPendingIntent {
  request_key:string;request_hash:string;actor_uid:number;created_at:number;
  body:DeliveryOperationInput;
}
