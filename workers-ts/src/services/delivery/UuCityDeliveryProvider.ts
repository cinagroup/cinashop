import { createHash } from "node:crypto";
import type { Env } from "@/env";
import {
  normalizeUuCityDeliveryQuery,
  type VerifiedUuCityDeliveryEvent,
} from "./UuCityDeliveryCallback";

const UU_ORDER_QUERY_URL = "https://api-open.uupt.com/openapi/v3/order/orderDetail";
const MAX_RESPONSE_BYTES = 32 * 1024;

interface UuConfig {
  appId: string;
  appKey: string;
  openId: string;
  timestampUnit: "seconds" | "milliseconds";
}

function configured(value: string | undefined, label: string, maximum: number): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`uu_${label}_invalid`);
  }
  return normalized;
}

function timestampUnit(value: string | undefined): "seconds" | "milliseconds" {
  if (value === "seconds" || value === "milliseconds") return value;
  // The current official prose says seconds while its executable examples use
  // 13-digit milliseconds. Require an integration-tested deployment choice.
  throw new Error("uu_timestamp_unit_unverified");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("uu_query_response_too_large");
  }
  if (!response.body) throw new Error("uu_query_response_empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("uu_query_response_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new Error("uu_query_response_invalid_json");
  }
  const body = record(decoded);
  if (!body) throw new Error("uu_query_response_invalid_shape");
  return body;
}

/** Current public V3 request signature: uppercase MD5(biz + appKey + timestamp). */
export function uuApiSignature(biz: string, appKey: string, timestamp: number): string {
  return createHash("md5")
    .update(`${biz}${appKey}${timestamp}`, "utf8")
    .digest("hex")
    .toUpperCase();
}

export class UuCityDeliveryProvider {
  constructor(private readonly env: Env) {}

  async query(originId: string, observedAt = Math.floor(Date.now() / 1_000))
    : Promise<VerifiedUuCityDeliveryEvent> {
    if (!/^[A-Za-z0-9._:-]{1,32}$/.test(originId)) throw new Error("uu_origin_id_invalid");
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0 || observedAt > 4_102_444_800) {
      throw new Error("uu_observed_at_invalid");
    }
    const config = this.config();
    const timestamp = config.timestampUnit === "milliseconds" ? observedAt * 1_000 : observedAt;
    const biz = JSON.stringify({ originId });
    const requestBody = JSON.stringify({
      openId: config.openId,
      timestamp,
      biz,
      sign: uuApiSignature(biz, config.appKey, timestamp),
    });
    let response: Response;
    try {
      response = await fetch(UU_ORDER_QUERY_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-App-Id": config.appId,
        },
        body: requestBody,
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new Error(`uu_query_network_${errorMessage(error).slice(0, 80)}`);
    }
    if (!response.ok) throw new Error(`uu_query_http_${response.status}`);
    const envelope = await readBoundedJson(response);
    if (String(envelope.code ?? "") !== "1" || String(envelope.state ?? "") !== "1") {
      const providerCode = String(envelope.code ?? envelope.state ?? "unknown")
        .replace(/[^A-Za-z0-9_-]/g, "_")
        .slice(0, 40);
      throw new Error(`uu_query_provider_${providerCode || "unknown"}`);
    }
    const result = record(envelope.body);
    if (!result) throw new Error("uu_query_result_invalid");
    return normalizeUuCityDeliveryQuery(result, {
      expectedOpenId: config.openId,
      originId,
      observedAt,
    });
  }

  private config(): UuConfig {
    return {
      appId: configured(this.env.UU_APP_ID, "app_id", 128),
      appKey: configured(this.env.UU_APP_KEY, "app_key", 256),
      openId: configured(this.env.UU_OPEN_ID, "open_id", 64),
      timestampUnit: timestampUnit(this.env.UU_API_TIMESTAMP_UNIT),
    };
  }
}
