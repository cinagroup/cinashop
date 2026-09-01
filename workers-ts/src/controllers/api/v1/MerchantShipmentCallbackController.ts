import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { MerchantShipmentCallbackService } from "@/services/shipping/MerchantShipmentCallbackService";
import { readBoundedUtf8Text } from "@/utils/request-body";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_CALLBACK_BODY_BYTES = 32 * 1024;

function response(c: C, result: boolean, returnCode: "200" | "400" | "500", message: string, status: 200 | 400 | 500) {
  c.header("Cache-Control", "no-store, private");
  c.header("Pragma", "no-cache");
  return c.json({ result, returnCode, message }, status);
}

/** ANY /api/order_call_back for route parity; only current signed POST is executable. */
export async function merchantShipmentCallback(c: C) {
  if (c.req.method !== "POST") {
    c.header("Allow", "POST");
    return response(c, false, "400", "失败", 400);
  }
  const contentType = (c.req.header("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return response(c, false, "400", "失败", 400);
  }

  const service = new MerchantShipmentCallbackService(c.get("container"), c.env);
  let verified: ReturnType<MerchantShipmentCallbackService["verify"]>;
  try {
    const rawBody = await readBoundedUtf8Text(c.req.raw, MAX_CALLBACK_BODY_BYTES);
    verified = service.verify(rawBody);
  } catch (error) {
    emitOperationalEvent("warn", {
      event: "merchant_shipment_callback_rejected",
      component: "waybill",
      operation: "merchant_shipment_callback_receive",
      outcome: "rejected",
      errorCode: operationalErrorCode(error, "merchant_shipment_callback_rejected"),
    });
    return response(c, false, "400", "失败", 400);
  }

  try {
    const received = await service.receive(verified);
    c.executionCtx.waitUntil(service.dispatchById(received.outboxId).catch((error) => {
      emitOperationalEvent("error", {
        event: "merchant_shipment_callback_dispatch_failed",
        component: "queue",
        operation: "merchant_shipment_callback_dispatch",
        outcome: "retry",
        errorCode: operationalErrorCode(error, "merchant_shipment_callback_dispatch_failed"),
      });
    }));
    return response(c, true, "200", "成功", 200);
  } catch (error) {
    emitOperationalEvent("error", {
      event: "merchant_shipment_callback_persist_failed",
      component: "waybill",
      operation: "merchant_shipment_callback_receive",
      outcome: "failure",
      errorCode: operationalErrorCode(error, "merchant_shipment_callback_persist_failed"),
    });
    return response(c, false, "500", "失败", 500);
  }
}
