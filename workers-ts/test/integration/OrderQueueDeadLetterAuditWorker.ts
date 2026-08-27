import type { OrderMessage } from "../../src/env";
import { createContainerFromDb } from "../../src/lib/di";
import { consumeOrderQueueDeadLetterMessage } from "../../src/services/order/OrderQueueDeadLetterConsumer";
import { OrderQueueDeadLetterService } from "../../src/services/order/OrderQueueDeadLetterService";
import {
  cleanupDeadLetterAudit,
  createDeadLetterAuditContainer,
  deadLetterAuditRowByType,
  enableDeadLetterAuditReplay,
  probeDeadLetterAuditTransactionScope,
  readDeadLetterAuditStatus,
  recordDeadLetterAuditDelivery,
  setupDeadLetterAudit,
  verifyDeadLetterAudit,
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
        const auditKey = typeof message.body.auditKey === "string" ? message.body.auditKey : "";
        try {
          const control = await recordDeadLetterAuditDelivery(container, {
            auditKey,
            messageId: message.id,
            queueAttempt: message.attempts,
          });
          if (control.fail) message.retry({ delaySeconds: 0 });
          else message.ack();
        } catch {
          message.retry({ delaySeconds: 1 });
        }
      }
    });
  },
} satisfies ExportedHandler<AuditEnv, AuditMessage>;
