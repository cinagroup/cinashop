import type { OrderMessage } from '@/env';
import { capturePurchasedProductLabelDispatch, isPurchasedProductLabelDispatch } from './PurchasedProductLabelQueue';
import type { PurchasedProductLabelTaskService } from './PurchasedProductLabelTaskService';
import { emitOperationalEvent, operationalErrorCode } from '@/utils/observability';
export async function consumePurchasedProductLabelQueueMessage(message: Pick<Message<OrderMessage>, 'body'|'attempts'|'ack'|'retry'>,
  service: Pick<PurchasedProductLabelTaskService, 'process'|'dispatchPending'>) {
  try {
    if (isPurchasedProductLabelDispatch(message.body)) {
      capturePurchasedProductLabelDispatch(message.body); await service.dispatchPending(); message.ack(); return;
    }
    const result = await service.process(message.body);
    if (result === 'busy') { message.retry({ delaySeconds: Math.min(30 * 2 ** Math.max(message.attempts-1,0),900) }); return; }
    message.ack();
  } catch (error) {
    emitOperationalEvent('error', { event: 'purchased_product_labels_consume_failed', component: 'queue', operation: 'outbox_consume',
      outcome: 'retry', errorCode: operationalErrorCode(error), queueAttempt: message.attempts });
    message.retry({ delaySeconds: Math.min(30 * 2 ** Math.max(message.attempts-1,0),900) });
  }
}
