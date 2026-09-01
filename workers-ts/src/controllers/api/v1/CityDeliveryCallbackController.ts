import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { CityDeliveryCallbackService } from "@/services/delivery/CityDeliveryCallbackService";
import { readBoundedUtf8Text } from "@/utils/request-body";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_CALLBACK_BODY_BYTES = 32 * 1024;

function reply(c: C, status: 200 | 400 | 405 | 500 | 503, success: boolean) {
  c.header("Cache-Control", "no-store, private");
  c.header("Pragma", "no-cache");
  return c.json(success ? { status: "ok" } : { status: "fail" }, status);
}

function callbackRoute(url: string): { provider: "dada"; token: string } {
  const query = new URL(url).searchParams;
  const keys = [...query.keys()];
  if (keys.length !== 2 || keys.filter((key) => key === "provider").length !== 1
    || keys.filter((key) => key === "token").length !== 1) {
    throw new Error("city_delivery_callback_query_invalid");
  }
  const provider = query.get("provider");
  if (provider === "uu") throw new Error("city_delivery_uu_contract_unavailable");
  if (provider !== "dada") throw new Error("city_delivery_provider_invalid");
  return { provider, token: query.get("token") ?? "" };
}

/** ANY route parity; only authenticated Dada POST/JSON is currently executable. */
export async function cityDeliveryCallback(c: C) {
  if (c.req.method !== "POST") {
    c.header("Allow", "POST");
    return reply(c, 405, false);
  }
  const contentType = (c.req.header("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return reply(c, 400, false);

  const service = new CityDeliveryCallbackService(c.get("container"), c.env);
  let route: ReturnType<typeof callbackRoute>;
  let verified: ReturnType<CityDeliveryCallbackService["verifyDada"]>;
  try {
    route = callbackRoute(c.req.url);
    const rawBody = await readBoundedUtf8Text(c.req.raw, MAX_CALLBACK_BODY_BYTES);
    verified = service.verifyDada(rawBody, route.token);
  } catch (error) {
    const unavailable = error instanceof Error && error.message === "city_delivery_uu_contract_unavailable";
    emitOperationalEvent(unavailable ? "error" : "warn", {
      event: "city_delivery_callback_rejected",
      component: "waybill",
      operation: "city_delivery_callback_receive",
      outcome: unavailable ? "failure" : "rejected",
      result: unavailable ? "unavailable" : "rejected",
      errorCode: operationalErrorCode(error, "city_delivery_callback_rejected"),
    });
    return reply(c, unavailable ? 503 : 400, false);
  }

  try {
    const received = await service.receive(verified);
    c.executionCtx.waitUntil(service.dispatchById(received.outboxId).catch((error) => {
      emitOperationalEvent("error", {
        event: "city_delivery_callback_dispatch_failed",
        component: "queue",
        operation: "city_delivery_callback_dispatch",
        outcome: "retry",
        errorCode: operationalErrorCode(error, "city_delivery_callback_dispatch_failed"),
      });
    }));
    emitOperationalEvent("info", {
      event: "city_delivery_callback_persisted",
      component: "waybill",
      operation: "city_delivery_callback_receive",
      outcome: "success",
      result: received.duplicate ? "duplicate" : "accepted",
    });
    return reply(c, 200, true);
  } catch (error) {
    emitOperationalEvent("error", {
      event: "city_delivery_callback_persist_failed",
      component: "waybill",
      operation: "city_delivery_callback_receive",
      outcome: "failure",
      errorCode: operationalErrorCode(error, "city_delivery_callback_persist_failed"),
    });
    return reply(c, 500, false);
  }
}
