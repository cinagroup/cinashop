import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MERCHANT_SHIPMENT_CALLBACK_PIPELINE_SQL } from "../src/migrations/merchantShipmentCallbackPipeline";
import {
  merchantShipmentCallbackEvent,
  merchantShipmentCallbackOutbox,
  merchantShipmentCallbackWatermark,
} from "../src/models/schema";
import {
  kuaidi100CallbackSignature,
  merchantShipmentState,
  verifyKuaidi100MerchantShipmentCallback,
} from "../src/services/shipping/Kuaidi100MerchantShipmentCallback";
import { merchantShipmentTransition } from "../src/services/shipping/MerchantShipmentCallbackService";

const SALT = "audit-kuaidi100-callback-salt-32";
const OFFICIAL_PARAM = JSON.stringify({
  kuaidicom: "yuantong",
  kuaidinum: "YT1234567890",
  status: "200",
  message: "成功",
  data: {
    orderId: "provider-order-1",
    status: "0",
    courierName: "王大",
    courierMobile: "13800138000",
    feeDetails: [{ feeType: "PACKAGINGFEE", amount: "0.8" }],
    imgBase64: "private-label-image",
  },
});

function form(param = OFFICIAL_PARAM, salt = SALT) {
  return new URLSearchParams({
    taskId: "task-official-sample-1",
    sign: kuaidi100CallbackSignature(param, salt),
    param,
  }).toString();
}

describe("Kuaidi100 merchant-shipment callback contract", () => {
  it("verifies the current official form signature and persists only an allowlist", () => {
    const callback = verifyKuaidi100MerchantShipmentCallback(form(), SALT);
    expect(callback.taskId).toBe("task-official-sample-1");
    expect(callback.providerOrderId).toBe("provider-order-1");
    expect(callback.callbackStatus).toBe("200");
    expect(callback.orderStatus).toBe("0");
    expect(callback.state.state).toBe("ORDER_CREATED");
    const durable = JSON.stringify(callback.payload);
    expect(durable).toBe('{"protocol":"kuaidi100-order-callback-v1"}');
    expect(durable).not.toContain("13800138000");
    expect(durable).not.toContain("王大");
    expect(durable).not.toContain("PACKAGINGFEE");
    expect(durable).not.toContain("private-label-image");
  });

  it("rejects bad signatures, duplicate form fields, blank salts and the old AES envelope", () => {
    const invalid = new URLSearchParams(form());
    invalid.set("sign", "0".repeat(32));
    expect(() => verifyKuaidi100MerchantShipmentCallback(invalid.toString(), SALT))
      .toThrow("kuaidi100_signature_mismatch");
    expect(() => verifyKuaidi100MerchantShipmentCallback(`${form()}&taskId=duplicate`, SALT))
      .toThrow("kuaidi100_callback_form_invalid");
    expect(() => verifyKuaidi100MerchantShipmentCallback(form(), ""))
      .toThrow("kuaidi100_callback_salt_invalid");
    expect(() => verifyKuaidi100MerchantShipmentCallback(
      new URLSearchParams({ type: "order_take", data: "ciphertext" }).toString(),
      SALT,
    )).toThrow("kuaidi100_callback_form_field_invalid");
  });

  it("requires tracking evidence for physical fulfilment and safely ignores unknown statuses", () => {
    const noTracking = JSON.stringify({
      kuaidicom: "yuantong",
      kuaidinum: "",
      status: "200",
      data: { orderId: "provider-order-1", status: "10" },
    });
    expect(() => verifyKuaidi100MerchantShipmentCallback(form(noTracking), SALT))
      .toThrow("kuaidi100_tracking_number_required");
    expect(merchantShipmentState("777")).toMatchObject({ state: "UNKNOWN", projectionType: "ignored" });
  });

  it("rejects failed communication envelopes and normalizes settlement and reassignment", () => {
    const failedEnvelope = JSON.stringify({
      kuaidicom: "yuantong",
      kuaidinum: "YT1234567890",
      status: "500",
      data: { orderId: "provider-order-1", status: "10" },
    });
    expect(() => verifyKuaidi100MerchantShipmentCallback(form(failedEnvelope), SALT))
      .toThrow("kuaidi100_callback_status_failed");
    expect(merchantShipmentState("15")).toMatchObject({
      state: "SETTLED", terminal: true, fulfilsOrder: true,
    });
    const reassignedParam = JSON.stringify({
      kuaidicom: "yuantong",
      kuaidinum: "",
      status: "200",
      data: {
        orderId: "provider-order-new",
        status: "302",
        taskId: "task-reassigned-2",
        kuaidiCom: "jd",
        kuaidiNum: "JD1234567890",
        courierName: "不得持久化",
      },
    });
    const reassigned = verifyKuaidi100MerchantShipmentCallback(form(reassignedParam), SALT);
    expect(reassigned.state.state).toBe("REASSIGNED");
    expect(reassigned.payload).toEqual({
      protocol: "kuaidi100-order-callback-v1",
      reassignment: {
        taskId: "task-reassigned-2",
        carrierCode: "jd",
        trackingNumber: "JD1234567890",
      },
    });
    expect(JSON.stringify(reassigned.payload)).not.toContain("不得持久化");
  });
});

describe("merchant-shipment monotonic transition graph", () => {
  const current = (state: string, rank: number, terminal = 0) => ({ lastState: state, lastRank: rank, terminal });

  it("advances active states but supersedes stale state and late cancellation after pickup", () => {
    expect(merchantShipmentTransition(current("ACCEPTED", 20), merchantShipmentState("10"))).toBe("apply");
    expect(merchantShipmentTransition(current("PICKED_UP", 40), merchantShipmentState("1"))).toBe("superseded");
    expect(merchantShipmentTransition(current("PICKED_UP", 40), merchantShipmentState("99"))).toBe("superseded");
  });

  it("requires explicit resurrection after terminal cancellation", () => {
    expect(merchantShipmentTransition(current("CANCELLED", 90, 1), merchantShipmentState("1"))).toBe("conflict");
    expect(merchantShipmentTransition(current("CANCELLED", 90, 1), merchantShipmentState("166"))).toBe("apply");
    expect(merchantShipmentTransition(current("ACCEPTED", 20), merchantShipmentState("166"))).toBe("superseded");
  });

  it("bridges reassigned tasks without accepting a stale active state", () => {
    expect(merchantShipmentTransition(current("REASSIGNED", 35), merchantShipmentState("1")))
      .toBe("superseded");
    expect(merchantShipmentTransition(current("REASSIGNED", 35), merchantShipmentState("10")))
      .toBe("apply");
    expect(merchantShipmentTransition(current("SETTLED", 75, 1), merchantShipmentState("1")))
      .toBe("conflict");
  });

  it("allows settlement to close an already fulfilled active shipment", () => {
    expect(merchantShipmentTransition(current("PICKED_UP", 40), merchantShipmentState("15")))
      .toBe("apply");
    expect(merchantShipmentTransition(current("SIGNED", 70), merchantShipmentState("15")))
      .toBe("apply");
    expect(merchantShipmentTransition(current("CANCELLED", 90, 1), merchantShipmentState("15")))
      .toBe("superseded");
  });
});

describe("merchant-shipment callback DDL and route wiring", () => {
  it("keeps external and embedded DDL identical with three constrained durable tables", () => {
    const external = readFileSync("migrations/0123_merchant_shipment_callback_pipeline.sql", "utf8");
    expect(external.trim()).toBe(MERCHANT_SHIPMENT_CALLBACK_PIPELINE_SQL.trim());
    expect(merchantShipmentCallbackEvent.provider.getSQLType()).toBe("varchar(24)");
    expect(merchantShipmentCallbackOutbox.replayKey.getSQLType()).toBe("varchar(36)");
    expect(merchantShipmentCallbackWatermark.lastState.getSQLType()).toBe("varchar(32)");
    expect(external).toContain("ON DELETE RESTRICT");
    expect(external).toContain("current_schema()");
    expect(external).toContain("merchant_shipment_callback_state_upgrade");
    expect(external).toContain("'SETTLED', 'REASSIGNED'");
    expect(external).not.toContain("courier_mobile");
    expect(external).not.toContain("raw_body");
    expect(external).not.toContain("signature\"");
  });

  it("registers ANY parity but rejects non-POST at runtime and emits opaque queue messages", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/MerchantShipmentCallbackController.ts", "utf8");
    const service = readFileSync("src/services/shipping/MerchantShipmentCallbackService.ts", "utf8");
    expect(routes).toContain('v1Routes.all("/order_call_back", merchantShipmentCallback)');
    expect(controller).toContain('c.req.method !== "POST"');
    expect(controller).toContain('"application/x-www-form-urlencoded"');
    expect(service).toContain('action: "processMerchantShipmentCallbackOutbox"');
    expect(service).not.toContain("courierMobile");
    expect(service).not.toContain("imgBase64");
  });
});
