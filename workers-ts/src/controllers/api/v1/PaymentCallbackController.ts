import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import type { WechatPayProfile } from "@/services/wechat/WechatPayService";
import { emitOperationalEvent } from "@/utils/observability";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

export type PaymentCallbackTarget = "alipay" | WechatPayProfile;

export type PaymentCallbackDispatch =
  | { outcome: "dispatch"; target: PaymentCallbackTarget }
  | { outcome: "method-not-allowed" }
  | { outcome: "unsupported-type" };

export interface PaymentCallbackHandlers {
  alipayNotify(c: C): Promise<Response>;
  wechatPayNotify(c: C, profile: WechatPayProfile): Promise<Response>;
}

const CALLBACK_TARGETS = new Set<PaymentCallbackTarget>([
  "alipay",
  "wechat",
  "routine",
  "app",
]);

/** The legacy ANY route remains address-compatible, but providers must use POST. */
export function resolvePaymentCallbackDispatch(
  method: string,
  rawType: string,
): PaymentCallbackDispatch {
  if (method.toUpperCase() !== "POST") return { outcome: "method-not-allowed" };
  let type: string;
  try {
    type = decodeURIComponent(rawType);
  } catch {
    return { outcome: "unsupported-type" };
  }
  return CALLBACK_TARGETS.has(type as PaymentCallbackTarget)
    ? { outcome: "dispatch", target: type as PaymentCallbackTarget }
    : { outcome: "unsupported-type" };
}

/** ANY /api/pay/notify/:type — legacy path with strict method/type dispatch. */
export async function paymentNotify(c: C, handlers: PaymentCallbackHandlers) {
  const dispatch = resolvePaymentCallbackDispatch(c.req.method, c.req.param("type") ?? "");
  if (dispatch.outcome === "method-not-allowed") {
    c.header("Allow", "POST");
    c.header("Cache-Control", "no-store");
    return c.body("method not allowed", 405);
  }
  if (dispatch.outcome === "unsupported-type") {
    emitOperationalEvent("warn", {
      event: "payment_callback_rejected",
      component: "payment",
      operation: "payment_callback_dispatch",
      outcome: "rejected",
      errorCode: "unsupported_callback_type",
    });
    c.header("Cache-Control", "no-store");
    return c.body("not found", 404);
  }
  if (dispatch.target === "alipay") return handlers.alipayNotify(c);
  return handlers.wechatPayNotify(c, dispatch.target);
}
