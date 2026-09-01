import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CITY_DELIVERY_CALLBACK_PIPELINE_SQL } from "../src/migrations/cityDeliveryCallbackPipeline";
import {
  cityDeliveryCallbackEvent,
  cityDeliveryCallbackOutbox,
  cityDeliveryCallbackWatermark,
  cityDeliveryReconciliationCase,
} from "../src/models/schema";
import {
  cityDeliveryTransition,
  dadaCallbackChecksum,
  dadaCityDeliveryState,
  normalizeDadaCityDeliveryQuery,
  verifyDadaCityDeliveryCallback,
} from "../src/services/delivery/DadaCityDeliveryCallback";
import { dadaApiSignature } from "../src/services/delivery/DadaCityDeliveryProvider";

const TOKEN = "audit-dada-callback-token-32-bytes";
const CLIENT_ID = "dada-client-production";

function callbackBody(overrides: Record<string, unknown> = {}) {
  const body = {
    client_id: CLIENT_ID,
    order_id: "dd202609010001",
    order_status: 2,
    cancel_reason: "",
    cancel_from: 0,
    update_time: 1_788_255_000,
    repeat_reason_type: 0,
    finish_code: "1234",
    dm_name: "骑手姓名",
    dm_mobile: "13800138000",
    ...overrides,
  };
  return JSON.stringify({
    ...body,
    signature: dadaCallbackChecksum(
      String(body.client_id),
      String(body.order_id),
      String(body.update_time),
    ),
  });
}

describe("Dada same-city callback boundary", () => {
  it("requires both the official checksum and a separate strong URL token", () => {
    const verified = verifyDadaCityDeliveryCallback(callbackBody(), {
      requestToken: TOKEN,
      callbackToken: TOKEN,
      expectedClientId: CLIENT_ID,
    });
    expect(verified).toMatchObject({
      provider: "dada",
      source: "callback",
      providerOrderId: "dd202609010001",
      providerStatus: "2",
      providerUpdateTime: 1_788_255_000,
      state: { state: "WAITING_PICKUP", legacyStatus: 2 },
    });
    expect(verified.eventKey).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(verified.payload)).not.toContain("骑手姓名");
    expect(JSON.stringify(verified.payload)).not.toContain("13800138000");
    expect(() => verifyDadaCityDeliveryCallback(callbackBody(), {
      requestToken: `${TOKEN}-wrong`,
      callbackToken: TOKEN,
      expectedClientId: CLIENT_ID,
    })).toThrow("dada_callback_token_mismatch");
  });

  it("rejects a bad checksum/client and normalizes the millisecond failure timestamp", () => {
    const bad = JSON.parse(callbackBody()) as Record<string, unknown>;
    bad.signature = "0".repeat(32);
    expect(() => verifyDadaCityDeliveryCallback(JSON.stringify(bad), {
      requestToken: TOKEN,
      callbackToken: TOKEN,
      expectedClientId: CLIENT_ID,
    })).toThrow("dada_signature_mismatch");
    expect(() => verifyDadaCityDeliveryCallback(callbackBody(), {
      requestToken: TOKEN,
      callbackToken: TOKEN,
      expectedClientId: "another-client",
    })).toThrow("dada_client_id_mismatch");
    const failed = verifyDadaCityDeliveryCallback(callbackBody({
      order_status: 1000,
      update_time: 1_788_255_000_123,
    }), {
      requestToken: TOKEN,
      callbackToken: TOKEN,
      expectedClientId: CLIENT_ID,
    });
    expect(failed.providerUpdateTime).toBe(1_788_255_000);
    expect(failed.state).toMatchObject({ state: "ORDER_FAILED", cancelsDelivery: true });
  });

  it("normalizes authenticated query evidence without inventing callback authentication", () => {
    const queried = normalizeDadaCityDeliveryQuery({
      order_status: 3,
      update_time: 1_788_255_100,
      dm_name: "配送员",
      dm_mobile: "13900139000",
    }, {
      expectedClientId: CLIENT_ID,
      providerOrderId: "dd202609010001",
      observedAt: 1_788_255_200,
    });
    expect(queried).toMatchObject({
      source: "query",
      providerStatus: "3",
      state: { state: "DELIVERING" },
    });
    expect(dadaApiSignature({ app_key: "a", body: "{}", timestamp: 1 }, "secret"))
      .toMatch(/^[0-9A-F]{32}$/);
  });
});

describe("same-city monotonic transition graph", () => {
  const current = (state: string, rank: number, time: number, terminal = 0, eventKey = "a".repeat(64)) => ({
    lastEventKey: eventKey,
    lastState: state,
    lastRank: rank,
    providerUpdateTime: time,
    terminal,
  });
  const next = (status: string, time: number, source: "callback" | "query" = "callback") => ({
    eventKey: "b".repeat(64),
    source,
    providerUpdateTime: time,
    repeatReasonType: 0,
    state: dadaCityDeliveryState(status),
  });

  it("advances current callbacks and supersedes an older callback", () => {
    expect(cityDeliveryTransition(current("WAITING_PICKUP", 20, 100), next("3", 101))).toBe("apply");
    expect(cityDeliveryTransition(current("DELIVERING", 40, 101), next("2", 100))).toBe("superseded");
  });

  it("fails closed on equal-time divergence and cancellation after pickup", () => {
    expect(cityDeliveryTransition(current("WAITING_PICKUP", 20, 100), next("3", 100))).toBe("conflict");
    expect(cityDeliveryTransition(current("DELIVERING", 40, 100), next("5", 101))).toBe("conflict");
  });

  it("allows the documented abnormal-return completion after pickup", () => {
    expect(cityDeliveryTransition(current("DELIVERING", 40, 100), next("10", 101))).toBe("apply");
    expect(cityDeliveryTransition(current("RETURNING", 50, 101), next("10", 102))).toBe("apply");
  });

  it("does not let an active query silently regress or rewrite a terminal state", () => {
    expect(cityDeliveryTransition(current("DELIVERING", 40, 100), next("2", 101, "query")))
      .toBe("conflict");
    expect(cityDeliveryTransition(current("DELIVERED", 60, 100, 1), next("5", 101, "query")))
      .toBe("conflict");
  });
});

describe("same-city callback DDL and wiring", () => {
  it("keeps external and embedded DDL identical with four constrained durable tables", () => {
    const external = readFileSync("migrations/0124_city_delivery_callback_pipeline.sql", "utf8");
    expect(external.trim()).toBe(CITY_DELIVERY_CALLBACK_PIPELINE_SQL.trim());
    expect(cityDeliveryCallbackEvent.providerOrderId.getSQLType()).toBe("varchar(32)");
    expect(cityDeliveryCallbackOutbox.replayKey.getSQLType()).toBe("varchar(36)");
    expect(cityDeliveryCallbackWatermark.lastState.getSQLType()).toBe("varchar(32)");
    expect(cityDeliveryReconciliationCase.deliveryOrderId.getSQLType()).toBe("integer");
    expect(external).toContain("ON DELETE RESTRICT");
    expect(external).toContain('"sdo_dada_reconcile_scan"');
    expect(external).not.toContain("raw_body");
    expect(external).not.toContain("callback_token");
    expect(external).not.toContain('"signature"');
  });

  it("registers route parity while keeping UU fail-closed until its contract is known", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/CityDeliveryCallbackController.ts", "utf8");
    const service = readFileSync("src/services/delivery/CityDeliveryCallbackService.ts", "utf8");
    expect(routes).toContain('v1Routes.all("/city_delivery/notify", cityDeliveryCallback)');
    expect(controller).toContain('c.req.method !== "POST"');
    expect(controller).toContain('contentType !== "application/json"');
    expect(controller).toContain('provider === "uu"');
    expect(controller).toContain("city_delivery_uu_contract_unavailable");
    expect(service).toContain('action: "processCityDeliveryCallbackOutbox"');
    expect(service).toContain('riderName: ""');
  });
});
