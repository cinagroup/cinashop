import type { MiddlewareHandler } from "hono";
import type { AppVariables, Env } from "@/env";
import {
  classifyCriticalHttpOperation,
  emitOperationalEvent,
} from "@/utils/observability";

export const HTTP_SLOW_THRESHOLD_MS = 1_000;

/**
 * Critical-flow and anomaly log. Invocation metrics remain Cloudflare's source
 * of truth; this event adds a low-cardinality business domain without logging
 * raw paths, query strings, user identifiers, headers, or request bodies.
 */
export const observabilityMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> = async (c, next) => {
  const startedAt = Date.now();
  await next();

  const durationMs = Math.max(0, Date.now() - startedAt);
  const operation = classifyCriticalHttpOperation(c.req.method, c.req.path);
  const statusCode = c.res.status;
  const failed = statusCode >= 500;
  const rejected = statusCode >= 400;
  const slow = durationMs >= HTTP_SLOW_THRESHOLD_MS;
  if (!operation && !failed && !slow) return;

  emitOperationalEvent(
    failed ? "error" : rejected || slow ? "warn" : "info",
    {
      event: "http_request_completed",
      component: operation ?? "http",
      operation: operation ?? "request",
      outcome: failed ? "failure" : rejected ? "rejected" : "success",
      statusCode,
      durationMs,
      thresholdMs: HTTP_SLOW_THRESHOLD_MS,
      slow,
    },
  );
};
