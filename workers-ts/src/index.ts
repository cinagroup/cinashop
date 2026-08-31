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
import {
  emitOperationalEvent,
  operationalErrorCode,
  type OperationalComponent,
} from "./utils/observability";

const app = createApp();

function scheduledComponent(job: string): OperationalComponent {
  if (job === "refund_reconciliation") return "refund";
  if (job === "print_job_dispatch") return "print";
  if (job === "waybill_job_dispatch") return "waybill";
  return "queue";
}

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
    const {
      consumeSignReminderQueueMessage,
      isSignReminderMessage,
      SignReminderService,
    } = await import("./services/message/SignReminderService");
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
    const signReminders = new SignReminderService(container, env);
    const sms = new SmsVerificationService(container, env);
    const attachments = new AttachmentService(container, env);
    const officialQrcodes = new OfficialAccountQrcodeService(container, env);
    const notificationDeliveries = new OrderNotificationDeliveryService(container, env);
    const printJobs = new ReceiptPrintJobService(container, env);
    const waybillJobs = new OrderWaybillJobService(container, env);

    for (const msg of batch.messages) {
      const messageStartedAt = Date.now();
      if (isWorkContactActionDispatchMessage(msg.body)) {
        try {
          const [dispatched, redacted] = await Promise.all([
            workContactActions.dispatchPending(50),
            workContactActions.redactCompletedCallbackPayloads(100),
          ]);
          emitOperationalEvent("info", {
            event: "work_contact_actions_dispatched",
            component: "queue",
            operation: "work_contact_actions",
            outcome: "success",
            resourceCount: Number(dispatched.claimed ?? 0) + Number(redacted ?? 0),
            durationMs: Date.now() - messageStartedAt,
            queueAttempt: msg.attempts,
          });
          msg.ack();
        } catch (error) {
          const delaySeconds = Math.min(30 * 2 ** Math.max(msg.attempts - 1, 0), 900);
          emitOperationalEvent("error", {
            event: "work_contact_action_dispatch_failed",
            component: "queue",
            operation: "work_contact_actions",
            outcome: "retry",
            durationMs: Date.now() - messageStartedAt,
            queueAttempt: msg.attempts,
            retryDelaySeconds: delaySeconds,
            errorCode: operationalErrorCode(error, "contact_action_dispatch_failed"),
          });
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
          emitOperationalEvent("info", {
            event: "work_callback_outbox_dispatched",
            component: "queue",
            operation: "work_callback_outbox",
            outcome: "success",
            resourceCount: Number(result.enqueued ?? 0),
            durationMs: Date.now() - messageStartedAt,
            queueAttempt: msg.attempts,
          });
          msg.ack();
        } catch (error) {
          const delaySeconds = Math.min(30 * 2 ** Math.max(msg.attempts - 1, 0), 900);
          emitOperationalEvent("error", {
            event: "work_callback_outbox_dispatch_failed",
            component: "queue",
            operation: "work_callback_outbox",
            outcome: "retry",
            durationMs: Date.now() - messageStartedAt,
            queueAttempt: msg.attempts,
            retryDelaySeconds: delaySeconds,
            errorCode: operationalErrorCode(error, "callback_dispatch_failed"),
          });
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
          emitOperationalEvent("error", {
            event: "order_notification_delivery_dispatch_failed",
            component: "queue",
            operation: "notification_delivery",
            outcome: "failure",
            durationMs: Date.now() - messageStartedAt,
            errorCode: operationalErrorCode(error),
          });
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
          const event = typeof result.event === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(result.event)
            ? result.event
            : "scheduled_maintenance_completed";
          emitOperationalEvent("info", {
            event,
            component: scheduledComponent(msg.body.job),
            operation: "scheduled_maintenance",
            outcome: "success",
            durationMs: Date.now() - messageStartedAt,
            queueAttempt: msg.attempts,
          });
          msg.ack();
        } catch (error) {
          const delaySeconds = scheduledRetryDelaySeconds(msg.attempts);
          emitOperationalEvent("error", {
            event: "scheduled_maintenance_failed",
            component: scheduledComponent(msg.body.job),
            operation: "scheduled_maintenance",
            outcome: "retry",
            durationMs: Date.now() - messageStartedAt,
            queueAttempt: msg.attempts,
            retryDelaySeconds: delaySeconds,
            errorCode: operationalErrorCode(error),
          });
          msg.retry({ delaySeconds });
        }
        continue;
      }

      if (isPinkTimeoutMessage(msg.body)) {
        try {
          const result = await maintenance.processPinkTimeout(msg.body);
          emitOperationalEvent("info", {
            event: "scheduled_pink_timeout_processed",
            component: "queue",
            operation: "pink_timeout",
            outcome: "success",
            result: String(result.result ?? "completed"),
            durationMs: Date.now() - messageStartedAt,
            queueAttempt: msg.attempts,
          });
          msg.ack();
        } catch (error) {
          const delaySeconds = scheduledRetryDelaySeconds(msg.attempts);
          emitOperationalEvent("error", {
            event: "scheduled_pink_timeout_failed",
            component: "queue",
            operation: "pink_timeout",
            outcome: "retry",
            durationMs: Date.now() - messageStartedAt,
            queueAttempt: msg.attempts,
            retryDelaySeconds: delaySeconds,
            errorCode: operationalErrorCode(error),
          });
          msg.retry({ delaySeconds });
        }
        continue;
      }

      if (isSignReminderMessage(msg.body)) {
        await consumeSignReminderQueueMessage(msg, signReminders);
        continue;
      }

      if (isSmsVerificationMessage(msg.body)) {
        try {
          const result = await sms.processMessage(msg.body);
          emitOperationalEvent("info", {
            event: "sms_verification_consumed",
            component: "queue",
            operation: "sms_verification",
            outcome: "success",
            result,
            durationMs: Date.now() - messageStartedAt,
            queueAttempt: msg.attempts,
          });
          msg.ack();
        } catch (error) {
          if (hasExhaustedOrderQueueRetries(msg.attempts)) {
            await sms.abandon(msg.body);
            emitOperationalEvent("error", {
              event: "sms_verification_abandoned",
              component: "queue",
              operation: "sms_verification",
              outcome: "failure",
              durationMs: Date.now() - messageStartedAt,
              queueAttempt: msg.attempts,
              errorCode: operationalErrorCode(error),
            });
            msg.ack();
          } else {
            const delaySeconds = Math.min(30 * 2 ** Math.max(msg.attempts - 1, 0), 900);
            emitOperationalEvent("error", {
              event: "sms_verification_failed",
              component: "queue",
              operation: "sms_verification",
              outcome: "retry",
              durationMs: Date.now() - messageStartedAt,
              queueAttempt: msg.attempts,
              retryDelaySeconds: delaySeconds,
              errorCode: operationalErrorCode(error),
            });
            msg.retry({ delaySeconds });
          }
        }
        continue;
      }

      if (isAttachmentObjectCleanupMessage(msg.body)) {
        try {
          const result = await attachments.processObjectCleanup(msg.body);
          emitOperationalEvent("info", {
            event: "attachment_objects_deleted",
            component: "r2",
            operation: "delete",
            outcome: "success",
            resourceCount: result.deleted,
            durationMs: Date.now() - messageStartedAt,
            queueAttempt: msg.attempts,
          });
          msg.ack();
        } catch (error) {
          const delaySeconds = Math.min(30 * 2 ** Math.max(msg.attempts - 1, 0), 900);
          emitOperationalEvent("error", {
            event: "attachment_object_cleanup_failed",
            component: "r2",
            operation: "delete",
            outcome: "retry",
            resourceCount: msg.body.keys.length,
            durationMs: Date.now() - messageStartedAt,
            queueAttempt: msg.attempts,
            retryDelaySeconds: delaySeconds,
            errorCode: operationalErrorCode(error),
          });
          msg.retry({ delaySeconds });
        }
        continue;
      }

      if (isOfficialAccountQrcodeMessage(msg.body)) {
        try {
          await officialQrcodes.processProvision(msg.body);
          emitOperationalEvent("info", {
            event: "official_qrcode_provisioned",
            component: "queue",
            operation: "official_qrcode",
            outcome: "success",
            thirdType: msg.body.thirdType,
            resourceCount: 1,
            durationMs: Date.now() - messageStartedAt,
            queueAttempt: msg.attempts,
          });
          msg.ack();
        } catch (error) {
          const delaySeconds = Math.min(30 * 2 ** Math.max(msg.attempts - 1, 0), 900);
          emitOperationalEvent("error", {
            event: "official_qrcode_provision_failed",
            component: "queue",
            operation: "official_qrcode",
            outcome: "retry",
            thirdType: msg.body.thirdType,
            durationMs: Date.now() - messageStartedAt,
            queueAttempt: msg.attempts,
            retryDelaySeconds: delaySeconds,
            errorCode: operationalErrorCode(error),
          });
          msg.retry({ delaySeconds });
        }
        continue;
      }

      emitOperationalEvent("warn", {
        event: "unsupported_order_queue_message",
        component: "queue",
        operation: "unsupported_message",
        outcome: "rejected",
        action: msg.body.action,
      });
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
