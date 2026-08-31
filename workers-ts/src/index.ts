/**
 * Worker 入口
 *
 * 导出 4 个 handler:
 *   - fetch:      HTTP 请求 (主入口)
 *   - queue:      业务消息消费 + DLQ 持久化告警归档
 *   - scheduled:  outbox 补偿 + 自动收货/评价/退款对账
 *   - TokenBucketDO / OrderLockDO: Durable Object 类
 */
import { createApp } from "./app";
import { TokenBucketDO } from "./do/TokenBucketDO";
import { OrderLockDO } from "./do/OrderLockDO";
import { SequenceDO } from "./do/SequenceDO";
import { ChatRoomDO } from "./do/ChatRoomDO";
import type { Env, OrderMessage } from "./env";

const app = createApp();

// ─── HTTP ────────────────────────────────────────────────────
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(req, env, ctx);
  },

  // ─── Queue：业务消息至少一次消费；DLQ 先持久化再确认 ─────────
  async queue(
    batch: MessageBatch<OrderMessage>,
    env: Env,
  ): Promise<void> {
    const { createContainer } = await import("./lib/di");
    const container = createContainer(env);

    if (batch.queue === env.ORDER_DLQ_NAME) {
      const { OrderQueueDeadLetterService } = await import(
        "./services/order/OrderQueueDeadLetterService"
      );
      const { consumeOrderQueueDeadLetterMessage } = await import(
        "./services/order/OrderQueueDeadLetterConsumer"
      );
      const archiver = new OrderQueueDeadLetterService(container, env.ORDER_QUEUE);
      for (const message of batch.messages) {
        await consumeOrderQueueDeadLetterMessage(batch.queue, message, archiver);
      }
      return;
    }

    const {
      OrderOutboxService,
      isOrderNotificationOutboxMessage,
      isOrderPaidOutboxMessage,
    } = await import(
      "./services/order/OrderOutboxService"
    );
    const {
      consumeWorkCallbackQueueMessage,
      EnterpriseWechatCallbackService,
      isWorkCallbackDispatchMessage,
      isWorkCallbackOutboxMessage,
    } = await import("./services/work/EnterpriseWechatCallbackService");
    const {
      consumeWorkContactActionMessage,
      EnterpriseWechatContactActionService,
      isWorkContactActionDispatchMessage,
      isWorkContactActionMessage,
    } = await import("./services/work/EnterpriseWechatContactActionService");
    const {
      consumeOrderNotificationOutboxQueueMessage,
      consumeOrderPaidOutboxQueueMessage,
    } = await import(
      "./services/order/OrderPaidOutboxQueueConsumer"
    );
    const {
      ScheduledMaintenanceService,
      isScheduledMaintenanceMessage,
      isScheduledOrderMessage,
      isPinkTimeoutMessage,
      scheduledRetryDelaySeconds,
    } = await import("./services/order/ScheduledMaintenanceService");
    const { SmsVerificationService, isSmsVerificationMessage } = await import(
      "./services/message/SmsVerificationService"
    );
    const { hasExhaustedOrderQueueRetries } = await import(
      "./services/order/OrderQueuePolicy"
    );
    const { AttachmentService, isAttachmentObjectCleanupMessage } = await import(
      "./services/system/AttachmentService"
    );
    const {
      OfficialAccountQrcodeService,
      isOfficialAccountQrcodeMessage,
    } = await import("./services/wechat/OfficialAccountQrcodeService");
    const {
      OrderNotificationDeliveryService,
      consumeOrderNotificationDeliveryMessage,
      isOrderNotificationDeliveryMessage,
    } = await import("./services/order/OrderNotificationDeliveryService");
    const {
      ReceiptPrintJobService,
      consumeOrderPrintJobMessage,
      isOrderPrintJobMessage,
    } = await import("./services/printing/ReceiptPrintJobService");
    const {
      OrderWaybillJobService,
      consumeOrderWaybillJobMessage,
      isOrderWaybillJobMessage,
    } = await import("./services/waybill/OrderWaybillJobService");
    const outbox = new OrderOutboxService(container, env);
    const workCallbacks = new EnterpriseWechatCallbackService(container, env);
    const workContactActions = new EnterpriseWechatContactActionService(container, env);
    const maintenance = new ScheduledMaintenanceService(container, env);
    const sms = new SmsVerificationService(container, env);
    const attachments = new AttachmentService(container, env);
    const officialQrcodes = new OfficialAccountQrcodeService(container, env);
    const notificationDeliveries = new OrderNotificationDeliveryService(container, env);
    const printJobs = new ReceiptPrintJobService(container, env);
    const waybillJobs = new OrderWaybillJobService(container, env);

    for (const msg of batch.messages) {
      if (isWorkContactActionDispatchMessage(msg.body)) {
        try {
          const [dispatched, redacted] = await Promise.all([
            workContactActions.dispatchPending(50),
            workContactActions.redactCompletedCallbackPayloads(100),
          ]);
          console.log(JSON.stringify({
            event: "work_contact_actions_dispatched",
            ...dispatched,
            redacted,
            scheduledAt: msg.body.scheduledAt,
            queueAttempt: msg.attempts,
          }));
          msg.ack();
        } catch (error) {
          const delaySeconds = Math.min(30 * 2 ** Math.max(msg.attempts - 1, 0), 900);
          console.error(JSON.stringify({
            event: "work_contact_action_dispatch_failed",
            scheduledAt: msg.body.scheduledAt,
            queueAttempt: msg.attempts,
            retryDelaySeconds: delaySeconds,
            error: error instanceof Error && /^[a-z0-9_:-]{1,64}$/i.test(error.message)
              ? error.message
              : "contact_action_dispatch_failed",
          }));
          msg.retry({ delaySeconds });
        }
        continue;
      }

      if (isWorkContactActionMessage(msg.body)) {
        await consumeWorkContactActionMessage({
          body: msg.body,
          attempts: msg.attempts,
          ack: () => msg.ack(),
          retry: (options) => msg.retry(options),
        }, workContactActions);
        continue;
      }

      if (isWorkCallbackDispatchMessage(msg.body)) {
        try {
          const result = await workCallbacks.dispatchPendingPages(20, 5);
          console.log(JSON.stringify({
            event: "work_callback_outbox_dispatched",
            ...result,
            scheduledAt: msg.body.scheduledAt,
            queueAttempt: msg.attempts,
          }));
          msg.ack();
        } catch (error) {
          const delaySeconds = Math.min(30 * 2 ** Math.max(msg.attempts - 1, 0), 900);
          console.error(JSON.stringify({
            event: "work_callback_outbox_dispatch_failed",
            scheduledAt: msg.body.scheduledAt,
            queueAttempt: msg.attempts,
            retryDelaySeconds: delaySeconds,
            error: error instanceof Error && /^[a-z0-9_:-]{1,64}$/i.test(error.message)
              ? error.message
              : "callback_dispatch_failed",
          }));
          msg.retry({ delaySeconds });
        }
        continue;
      }

      if (isWorkCallbackOutboxMessage(msg.body)) {
        await consumeWorkCallbackQueueMessage({
          body: msg.body,
          attempts: msg.attempts,
          ack: () => msg.ack(),
          retry: (options) => msg.retry(options),
        }, workCallbacks);
        continue;
      }

      if (isOrderPaidOutboxMessage(msg.body)) {
        await consumeOrderPaidOutboxQueueMessage(msg, outbox);
        continue;
      }

      if (isOrderNotificationOutboxMessage(msg.body)) {
        await consumeOrderNotificationOutboxQueueMessage(msg, outbox);
        try {
          await notificationDeliveries.dispatchPending(10, msg.body.eventKey);
        } catch (error) {
          console.error(JSON.stringify({
            event: "order_notification_delivery_dispatch_failed",
            outboxId: msg.body.outboxId,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
        continue;
      }

      if (isOrderNotificationDeliveryMessage(msg.body)) {
        await consumeOrderNotificationDeliveryMessage(msg, notificationDeliveries);
        continue;
      }

      if (isOrderPrintJobMessage(msg.body)) {
        await consumeOrderPrintJobMessage(msg, printJobs);
        continue;
      }

      if (isOrderWaybillJobMessage(msg.body)) {
        await consumeOrderWaybillJobMessage(msg, waybillJobs);
        continue;
      }

      if (isScheduledMaintenanceMessage(msg.body) || isScheduledOrderMessage(msg.body)) {
        try {
          const result = isScheduledMaintenanceMessage(msg.body)
            ? await maintenance.processMaintenance(msg.body)
            : await maintenance.processOrder(msg.body);
          console.log(
            JSON.stringify({
              ...result,
              queueAttempt: msg.attempts,
            }),
          );
          msg.ack();
        } catch (error) {
          const delaySeconds = scheduledRetryDelaySeconds(msg.attempts);
          console.error(
            JSON.stringify({
              event: "scheduled_maintenance_failed",
              action: msg.body.action,
              job: msg.body.job,
              runId: msg.body.runId,
              queueAttempt: msg.attempts,
              retryDelaySeconds: delaySeconds,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          msg.retry({ delaySeconds });
        }
        continue;
      }

      if (isPinkTimeoutMessage(msg.body)) {
        try {
          const result = await maintenance.processPinkTimeout(msg.body);
          console.log(JSON.stringify({ ...result, queueAttempt: msg.attempts }));
          msg.ack();
        } catch (error) {
          const delaySeconds = scheduledRetryDelaySeconds(msg.attempts);
          console.error(JSON.stringify({
            event: "scheduled_pink_timeout_failed",
            pinkId: msg.body.pinkId,
            runId: msg.body.runId,
            queueAttempt: msg.attempts,
            retryDelaySeconds: delaySeconds,
            error: error instanceof Error ? error.message : String(error),
          }));
          msg.retry({ delaySeconds });
        }
        continue;
      }

      if (isSmsVerificationMessage(msg.body)) {
        try {
          const result = await sms.processMessage(msg.body);
          console.log(JSON.stringify({
            event: "sms_verification_consumed",
            recordId: msg.body.recordId,
            result,
            queueAttempt: msg.attempts,
          }));
          msg.ack();
        } catch (error) {
          if (hasExhaustedOrderQueueRetries(msg.attempts)) {
            await sms.abandon(msg.body);
            console.error(JSON.stringify({
              event: "sms_verification_abandoned",
              recordId: msg.body.recordId,
              queueAttempt: msg.attempts,
              error: error instanceof Error ? error.message : String(error),
            }));
            msg.ack();
          } else {
            const delaySeconds = Math.min(30 * 2 ** Math.max(msg.attempts - 1, 0), 900);
            console.error(JSON.stringify({
              event: "sms_verification_failed",
              recordId: msg.body.recordId,
              queueAttempt: msg.attempts,
              retryDelaySeconds: delaySeconds,
              error: error instanceof Error ? error.message : String(error),
            }));
            msg.retry({ delaySeconds });
          }
        }
        continue;
      }

      if (isAttachmentObjectCleanupMessage(msg.body)) {
        try {
          const result = await attachments.processObjectCleanup(msg.body);
          console.log(JSON.stringify({
            event: "attachment_objects_deleted",
            objectCount: result.deleted,
            queueAttempt: msg.attempts,
          }));
          msg.ack();
        } catch (error) {
          const delaySeconds = Math.min(30 * 2 ** Math.max(msg.attempts - 1, 0), 900);
          console.error(JSON.stringify({
            event: "attachment_object_cleanup_failed",
            objectCount: msg.body.keys.length,
            queueAttempt: msg.attempts,
            retryDelaySeconds: delaySeconds,
            error: error instanceof Error ? error.message : String(error),
          }));
          msg.retry({ delaySeconds });
        }
        continue;
      }

      if (isOfficialAccountQrcodeMessage(msg.body)) {
        try {
          const result = await officialQrcodes.processProvision(msg.body);
          console.log(JSON.stringify({
            event: "official_qrcode_provisioned",
            thirdType: msg.body.thirdType,
            thirdId: msg.body.thirdId,
            result,
            queueAttempt: msg.attempts,
          }));
          msg.ack();
        } catch (error) {
          const delaySeconds = Math.min(30 * 2 ** Math.max(msg.attempts - 1, 0), 900);
          console.error(JSON.stringify({
            event: "official_qrcode_provision_failed",
            thirdType: msg.body.thirdType,
            thirdId: msg.body.thirdId,
            queueAttempt: msg.attempts,
            retryDelaySeconds: delaySeconds,
            error: error instanceof Error ? error.message : String(error),
          }));
          msg.retry({ delaySeconds });
        }
        continue;
      }

      console.warn(
        JSON.stringify({
          event: "unsupported_order_queue_message",
          action: msg.body.action,
          orderId: msg.body.orderId,
        }),
      );
      msg.ack();
    }
  },

  // ─── 定时任务 (M4 启用: 自动收货 / 自动评价) ────────────
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(handleScheduled(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env, OrderMessage>;

/** Cron stays off the database critical path and only writes replayable root jobs. */
async function handleScheduled(env: Env, scheduledAt: number): Promise<void> {
  const { enqueueScheduledRun } = await import(
    "./services/order/ScheduledMaintenanceService"
  );
  await Promise.all([
    env.ORDER_QUEUE.send({
      action: "dispatchWorkCallbackOutbox",
      scheduledAt,
    }),
    env.ORDER_QUEUE.send({
      action: "dispatchWorkContactActions",
      scheduledAt,
    }),
    enqueueScheduledRun(env, scheduledAt),
  ]);
}

// ─── Durable Object 导出 (wrangler.toml class_name 指向这些) ─
export { TokenBucketDO, OrderLockDO, SequenceDO, ChatRoomDO };
