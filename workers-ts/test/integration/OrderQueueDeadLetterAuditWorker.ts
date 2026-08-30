import type { OrderMessage } from "../../src/env";
import { createContainerFromDb } from "../../src/lib/di";
import { consumeOrderQueueDeadLetterMessage } from "../../src/services/order/OrderQueueDeadLetterConsumer";
import { OrderQueueDeadLetterService } from "../../src/services/order/OrderQueueDeadLetterService";
import {
  consumeWorkCallbackQueueMessage,
  EnterpriseWechatCallbackService,
  isWorkCallbackOutboxMessage,
} from "../../src/services/work/EnterpriseWechatCallbackService";
import {
  auditMessageBodySha256,
  cleanupDeadLetterAudit,
  createDeadLetterAuditContainer,
  deadLetterAuditShouldFail,
  deadLetterAuditRowByType,
  enableDeadLetterAuditReplay,
  probeDeadLetterAuditTransactionScope,
  readDeadLetterAuditStatus,
  recordDeadLetterAuditDelivery,
  setupDeadLetterAudit,
  verifyDeadLetterAudit,
  verifyWorkCallbackDeadLetterAudit,
  WORK_C2_CALLBACK_DISPATCH_MESSAGE,
  WORK_C2_CALLBACK_OUTBOX_MESSAGE,
} from "./OrderQueueDeadLetterPostgresScenario";

type AuditMessage = OrderMessage & { auditKey?: string };

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  ORDER_QUEUE: Queue<OrderMessage>;
  DLQ_PRODUCER: Queue<OrderMessage>;
  AUDIT_SCHEMA: string;
  AUDIT_KEY: string;
  AUDIT_TOKEN_SHA256: string;
  SOURCE_QUEUE_NAME: string;
  ORDER_DLQ_NAME: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function authorize(request: Request, verifier: string): Promise<boolean> {
  const token = request.headers.get("X-Audit-Token") ?? "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

async function withContainer<T>(env: AuditEnv, fn: (container: ReturnType<typeof createContainerFromDb>) => Promise<T>) {
  const container = createDeadLetterAuditContainer(env.HYPERDRIVE.connectionString, env.AUDIT_SCHEMA);
  try {
    return await fn(container);
  } finally {
    await container.db.$client.end();
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) return json({ error: "forbidden" }, 403);
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "POST" && path === "/setup") {
        return json(await setupDeadLetterAudit(
          env.HYPERDRIVE.connectionString,
          env.AUDIT_SCHEMA,
          env.AUDIT_KEY,
        ));
      }
      if (request.method === "POST" && path === "/send/failing") {
        await env.ORDER_QUEUE.send({
          action: "processOrderPaidOutbox",
          outboxId: 2_000_000_001,
          eventKey: "order.paid:2000000001",
          auditKey: env.AUDIT_KEY,
        } as AuditMessage);
        return json({ sent: true });
      }
      if (request.method === "POST" && path === "/send/sensitive") {
        await env.DLQ_PRODUCER.send({
          action: "sendSmsVerification",
          recordId: 2_000_000_002,
          uid: 2_000_000_003,
          phone: "13800138000",
          code: "654321",
          expiresIn: 300,
          purpose: "supplier_application",
          templateCode: "SMS_AUDIT_SECRET",
        });
        return json({ sent: true });
      }
      if (request.method === "POST" && path === "/send/work-failing") {
        await env.ORDER_QUEUE.send(WORK_C2_CALLBACK_OUTBOX_MESSAGE);
        return json({ sent: true, contract: "work-callback-four-key" });
      }
      if (request.method === "POST" && path === "/send/work-dispatch") {
        await env.DLQ_PRODUCER.send(WORK_C2_CALLBACK_DISPATCH_MESSAGE);
        return json({ sent: true, contract: "work-dispatch-two-key" });
      }
      if (request.method === "POST" && path === "/duplicate") {
        return json(await withContainer(env, async (container) => {
          const row = await deadLetterAuditRowByType(container, "processOrderPaidOutbox");
          return new OrderQueueDeadLetterService(container, env.ORDER_QUEUE).archive(
            env.ORDER_DLQ_NAME,
            {
              id: row.messageId,
              timestamp: new Date(row.messageTimestampMs),
              body: row.body,
              attempts: row.dlqAttempts,
            },
          );
        }));
      }
      if (request.method === "POST" && path === "/replay") {
        return json(await withContainer(env, async (container) => {
          await enableDeadLetterAuditReplay(container, env.AUDIT_KEY);
          const row = await deadLetterAuditRowByType(container, "processOrderPaidOutbox");
          return new OrderQueueDeadLetterService(container, env.ORDER_QUEUE).replay(
            row.id,
            1,
            "production Hyperdrive isolated controlled replay audit",
          );
        }));
      }
      if (request.method === "POST" && path === "/duplicate/work") {
        return json(await withContainer(env, async (container) => {
          const row = await deadLetterAuditRowByType(container, "processWorkCallbackOutbox");
          return new OrderQueueDeadLetterService(container, env.ORDER_QUEUE).archive(
            env.ORDER_DLQ_NAME,
            {
              id: row.messageId,
              timestamp: new Date(row.messageTimestampMs),
              body: row.body,
              attempts: row.dlqAttempts,
            },
          );
        }));
      }
      if (request.method === "POST" && path === "/replay/work") {
        return json(await withContainer(env, async (container) => {
          await enableDeadLetterAuditReplay(container, env.AUDIT_KEY);
          const row = await deadLetterAuditRowByType(container, "processWorkCallbackOutbox");
          return new OrderQueueDeadLetterService(container, env.ORDER_QUEUE).replay(
            row.id,
            1,
            "WORK-C2 production Hyperdrive isolated manual replay audit",
          );
        }));
      }
      if (request.method === "POST" && path === "/resolve/work") {
        return json(await withContainer(env, async (container) => {
          const row = await deadLetterAuditRowByType(container, "dispatchWorkCallbackOutbox");
          return new OrderQueueDeadLetterService(container, env.ORDER_QUEUE).resolve(
            row.id,
            1,
            "WORK-C2 dispatch replay was verified by strict archive and resolved for cleanup",
          );
        }));
      }
      if (request.method === "POST" && path === "/resolve") {
        return json(await withContainer(env, async (container) => {
          const row = await deadLetterAuditRowByType(container, "sendSmsVerification");
          return new OrderQueueDeadLetterService(container, env.ORDER_QUEUE).resolve(
            row.id,
            1,
            "sensitive verification messages must be regenerated, not replayed",
          );
        }));
      }
      if (request.method === "GET" && path === "/status") {
        return json(await readDeadLetterAuditStatus(env.HYPERDRIVE.connectionString, env.AUDIT_SCHEMA));
      }
      if (request.method === "GET" && path === "/probe") {
        return json(await probeDeadLetterAuditTransactionScope(
          env.HYPERDRIVE.connectionString,
          env.AUDIT_SCHEMA,
        ));
      }
      if (request.method === "GET" && path === "/verify") {
        return json(await verifyDeadLetterAudit(
          env.HYPERDRIVE.connectionString,
          env.AUDIT_SCHEMA,
          env.AUDIT_KEY,
        ));
      }
      if (request.method === "GET" && path === "/verify/work") {
        return json(await verifyWorkCallbackDeadLetterAudit(
          env.HYPERDRIVE.connectionString,
          env.AUDIT_SCHEMA,
          env.AUDIT_KEY,
          env.SOURCE_QUEUE_NAME,
          env.ORDER_DLQ_NAME,
        ));
      }
      if (request.method === "POST" && path === "/cleanup") {
        return json(await cleanupDeadLetterAudit(env.HYPERDRIVE.connectionString, env.AUDIT_SCHEMA));
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },

  async queue(batch: MessageBatch<AuditMessage>, env: AuditEnv): Promise<void> {
    if (batch.queue === env.ORDER_DLQ_NAME) {
      await withContainer(env, async (container) => {
        const archiver = new OrderQueueDeadLetterService(container, env.ORDER_QUEUE);
        for (const message of batch.messages) {
          await consumeOrderQueueDeadLetterMessage(batch.queue, message, archiver);
        }
      });
      return;
    }
    if (batch.queue !== env.SOURCE_QUEUE_NAME) {
      for (const message of batch.messages) message.ack();
      return;
    }
    await withContainer(env, async (container) => {
      for (const message of batch.messages) {
        const auditKey = message.body.action === "processWorkCallbackOutbox"
          ? env.AUDIT_KEY
          : typeof message.body.auditKey === "string" ? message.body.auditKey : "";
        try {
          const bodySha256 = await auditMessageBodySha256(message.body);
          const commonDelivery = {
            auditKey,
            queueName: batch.queue,
            messageId: message.id,
            messageType: message.body.action,
            bodySha256,
            queueAttempt: message.attempts,
          } as const;
          if (await deadLetterAuditShouldFail(container, auditKey)) {
            await recordDeadLetterAuditDelivery(container, {
              ...commonDelivery,
              outcome: "failed",
            });
            message.retry({ delaySeconds: 0 });
            continue;
          }
          if (isWorkCallbackOutboxMessage(message.body)) {
            let acknowledged = false;
            let retryOptions: { delaySeconds: number } | undefined;
            await consumeWorkCallbackQueueMessage({
              body: message.body,
              attempts: message.attempts,
              ack: () => { acknowledged = true; },
              retry: (options) => { retryOptions = options; },
            }, new EnterpriseWechatCallbackService(container, { ORDER_QUEUE: env.ORDER_QUEUE }));
            await recordDeadLetterAuditDelivery(container, {
              ...commonDelivery,
              outcome: acknowledged ? "processed" : "consumer_retry",
            });
            if (acknowledged) message.ack();
            else message.retry(retryOptions ?? { delaySeconds: 1 });
            continue;
          }
          await recordDeadLetterAuditDelivery(container, {
            ...commonDelivery,
            outcome: "processed",
          });
          message.ack();
        } catch {
          message.retry({ delaySeconds: 1 });
        }
      }
    });
  },
} satisfies ExportedHandler<AuditEnv, AuditMessage>;
