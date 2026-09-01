import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

interface PolicySignal {
  id: string;
  component: string;
  source: string;
  warning: string;
  critical: string;
  response: string;
}

interface Policy {
  version: number;
  worker: string;
  hyperdriveConfigId: string;
  r2Bucket: string;
  queues: string[];
  queueIds: Record<string, string>;
  alertProvisioning: { state: string; reason: string };
  signals: PolicySignal[];
}

const root = process.cwd();
const text = (path: string) => readFileSync(resolve(root, path), "utf8");
function sourceFiles(path: string): string[] {
  return readdirSync(resolve(root, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(child);
    return entry.isFile() && entry.name.endsWith(".ts") ? [child] : [];
  });
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const policy = JSON.parse(text("audit/observability-policy.json")) as Policy;
const productionBaseline = JSON.parse(text("audit/production-observability-baseline.json")) as {
  hyperdrive: { id: string };
  queues: Record<string, { id: string; consumers: number }>;
  deployment: {
    version: string;
    trafficPercent: number;
    hasAssetsBucketBinding: boolean;
    hasOrderDlqNameVariable: boolean;
  };
  productionDatabaseProbe: { state: string; workerExistsAfterRejectedAttempt: boolean };
  releaseBlockers: string[];
};
const wrangler = text("wrangler.toml");
const logger = text("src/utils/observability.ts");
const criticalSources = [
  "src/index.ts",
  "src/middleware/observability.ts",
  "src/middleware/error.ts",
  "src/controllers/api/v1/PayController.ts",
  "src/controllers/api/v1/WechatController.ts",
  "src/services/order/StoreOrderRefundService.ts",
  "src/services/order/OrderQueueDeadLetterConsumer.ts",
  "src/services/order/OrderQueueDeadLetterService.ts",
  "src/services/order/OrderPaidOutboxQueueConsumer.ts",
  "src/services/order/OrderNotificationDeliveryService.ts",
  "src/services/message/SignReminderService.ts",
  "src/services/payment/PaymentCallbackEventService.ts",
  "src/services/work/EnterpriseWechatCallbackService.ts",
  "src/services/work/EnterpriseWechatContactActionService.ts",
  "src/services/printing/ReceiptPrintJobService.ts",
  "src/services/waybill/OrderWaybillJobService.ts",
  "src/services/system/AttachmentService.ts",
  "src/do/ChatRoomDO.ts",
].map((path) => ({ path, source: text(path) }));
const combined = criticalSources.map(({ source }) => source).join("\n");

assert(policy.version === 1, "observability policy version must be 1");
assert(policy.worker === "cinashop-api", "observability policy worker drifted");
assert(
  policy.hyperdriveConfigId === "9748c294e21c49a99579c9cef70102e0",
  "observability policy Hyperdrive binding drifted",
);
assert(policy.r2Bucket === "cinashop-assets", "observability policy R2 bucket drifted");
assert(
  JSON.stringify(policy.queues) === JSON.stringify([
    "cinashop-order",
    "cinashop-order-dlq",
    "cinashop-order-dlq-unarchived",
  ]),
  "observability policy queue set drifted",
);
for (const queue of policy.queues) {
  assert(/^[a-f0-9]{32}$/.test(policy.queueIds[queue] ?? ""), `queue id is missing: ${queue}`);
  assert(
    productionBaseline.queues[queue]?.id === policy.queueIds[queue],
    `production queue id drifted from policy: ${queue}`,
  );
}
assert(
  productionBaseline.hyperdrive.id === policy.hyperdriveConfigId,
  "production Hyperdrive id drifted from policy",
);
assert(
  productionBaseline.deployment.version === "9f1fd655-e60f-41c1-8280-738bc85d73ef" &&
  productionBaseline.deployment.trafficPercent === 100,
  "production deployment baseline must identify the observed 100% version",
);
assert(
  productionBaseline.queues["cinashop-order-dlq"]?.consumers === 0,
  "observed production DLQ consumer gap changed; refresh the baseline and checklist",
);
assert(
  !productionBaseline.deployment.hasAssetsBucketBinding &&
  !productionBaseline.deployment.hasOrderDlqNameVariable,
  "observed deployed binding gaps changed; refresh the baseline and checklist",
);
assert(
  productionBaseline.productionDatabaseProbe.state === "not_run" &&
  productionBaseline.productionDatabaseProbe.workerExistsAfterRejectedAttempt === false,
  "production database probe boundary is not recorded accurately",
);
assert(
  policy.alertProvisioning.state === "pending",
  "production alerts must remain pending until their destination and deployed policies are verified",
);

assert(/\[observability\][\s\S]*?enabled\s*=\s*true/.test(wrangler), "Workers observability is disabled");
assert(/\[observability\][\s\S]*?head_sampling_rate\s*=\s*1/.test(wrangler), "Workers logs are not sampled at 100% for release acceptance");
assert(/\[observability\.logs\][\s\S]*?enabled\s*=\s*true/.test(wrangler), "Workers Logs are disabled");
assert(/\[observability\.traces\][\s\S]*?enabled\s*=\s*false/.test(wrangler), "fetch traces must stay disabled until query-string redaction is accepted");
assert(logger.includes("console.error(event)"), "error events are not emitted as indexable objects");
assert(logger.includes("console.warn(event)"), "warning events are not emitted as indexable objects");
assert(logger.includes("console.log(event)"), "info events are not emitted as indexable objects");
assert(logger.includes("FORBIDDEN_FIELD"), "operational log field denylist is missing");
const directConsoleSources = sourceFiles("src").filter((path) =>
  path !== "src/utils/observability.ts" && /console\.(?:log|warn|error)\s*\(/.test(text(path))
);
assert(
  directConsoleSources.length === 0,
  `all production logs must pass the redacting object logger: ${directConsoleSources.join(", ")}`,
);

const forbiddenOperationalFields: string[] = [];
for (const path of sourceFiles("src")) {
  const source = text(path);
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) && node.expression.getText(sourceFile) === "emitOperationalEvent" &&
      node.arguments[1]
    ) {
      const eventObject = node.arguments[1];
      assert(ts.isObjectLiteralExpression(eventObject), `${path} operational event must be an object literal`);
      for (const property of eventObject.properties) {
        assert(
          ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property),
          `${path} operational event cannot use spread/computed fields`,
        );
        const key = property.name.getText(sourceFile).replace(/^["']|["']$/g, "");
        if (
          key === "schema" || key === "id" || key.endsWith("Id") || key.endsWith("Uid") ||
          key.endsWith("_id") || key.endsWith("_uid")
        ) {
          forbiddenOperationalFields.push(`${path}:${key}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}
assert(
  forbiddenOperationalFields.length === 0,
  `operational logs must not contain identifiers or override schema: ${forbiddenOperationalFields.join(", ")}`,
);

for (const { path, source } of criticalSources) {
  assert(
    !/console\.(?:log|warn|error)\(\s*JSON\.stringify/.test(source),
    `${path} still emits a JSON string instead of an indexable object`,
  );
}

const requiredEvents = [
  "http_request_completed",
  "http_unhandled_exception",
  "payment_callback_completed",
  "payment_callback_rejected",
  "payment_callback_failed",
  "refund_callback_completed",
  "refund_callback_rejected",
  "refund_reconciliation_failed",
  "order_queue_dead_letter_archived",
  "order_queue_dead_letter_archive_failed",
  "payment_outbox_consumed",
  "payment_outbox_consume_failed",
  "order_notification_delivery_consumed",
  "order_notification_delivery_failed",
  "sign_reminder_consumed",
  "sign_reminder_failed",
  "work_callback_pipeline_consumed",
  "work_callback_pipeline_failed",
  "order_print_job_consumed",
  "order_print_job_retried",
  "order_print_job_failed",
  "order_waybill_job_consumed",
  "order_waybill_job_retried",
  "order_waybill_job_failed",
  "r2_object_written",
  "r2_object_write_failed",
  "r2_object_read_failed",
];
for (const event of requiredEvents) {
  assert(combined.includes(`event: "${event}"`), `required operational event is missing: ${event}`);
}

const requiredComponents = [
  "hyperdrive",
  "queue",
  "dlq",
  "durable_object",
  "r2",
  "login",
  "payment",
  "refund",
  "print",
  "waybill",
];
const components = new Set(policy.signals.map((signal) => signal.component));
for (const component of requiredComponents) {
  assert(components.has(component), `observability policy component is missing: ${component}`);
}
const ids = new Set<string>();
for (const signal of policy.signals) {
  assert(/^[a-z][a-z0-9_]{2,63}$/.test(signal.id), `invalid signal id: ${signal.id}`);
  assert(!ids.has(signal.id), `duplicate signal id: ${signal.id}`);
  ids.add(signal.id);
  assert(signal.source.length >= 8, `signal source is incomplete: ${signal.id}`);
  assert(signal.warning.length >= 8, `signal warning threshold is incomplete: ${signal.id}`);
  assert(signal.critical.length >= 8, `signal critical threshold is incomplete: ${signal.id}`);
  assert(signal.response.length >= 16, `signal response is incomplete: ${signal.id}`);
}

process.stdout.write(`${JSON.stringify({
  policyVersion: policy.version,
  signals: policy.signals.length,
  components: requiredComponents.length,
  requiredEvents: requiredEvents.length,
  logSamplingRate: 1,
  productionAlerts: policy.alertProvisioning.state,
  observedReleaseBlockers: productionBaseline.releaseBlockers.length,
  productionSourceFiles: sourceFiles("src").length,
})}\n`);
