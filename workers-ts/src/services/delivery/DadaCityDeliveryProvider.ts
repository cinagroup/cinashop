import { createHash } from "node:crypto";
import type { Env } from "@/env";
import {
  normalizeDadaCityDeliveryQuery,
  type VerifiedDadaCityDeliveryEvent,
} from "./DadaCityDeliveryCallback";

const DADA_ORDER_QUERY_URL = "https://newopen.imdada.cn/api/order/status/query";
const MAX_RESPONSE_BYTES = 32 * 1024;

interface DadaConfig {
  appKey: string;
  appSecret: string;
  sourceId: string;
  clientId: string;
}

function configured(value: string | undefined, label: string, maximum: number): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`dada_${label}_invalid`);
  }
  return normalized;
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
    throw new Error("dada_query_response_too_large");
  }
  if (!response.body) throw new Error("dada_query_response_empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("dada_query_response_too_large");
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
    throw new Error("dada_query_response_invalid_json");
  }
  const body = record(decoded);
  if (!body) throw new Error("dada_query_response_invalid_shape");
  return body;
}

/** Dada outbound request signature: uppercase MD5(secret + sorted key/value pairs + secret). */
export function dadaApiSignature(fields: Record<string, string | number>, secret: string): string {
  const joined = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${value}`)
    .join("");
  return createHash("md5").update(`${secret}${joined}${secret}`, "utf8").digest("hex").toUpperCase();
}

export class DadaCityDeliveryProvider {
  constructor(private readonly env: Env) {}

  async query(providerOrderId: string, observedAt = Math.floor(Date.now() / 1_000))
    : Promise<VerifiedDadaCityDeliveryEvent> {
    if (!/^[A-Za-z0-9._:-]{1,32}$/.test(providerOrderId)) {
      throw new Error("dada_order_id_invalid");
    }
    const config = this.config();
    const fields: Record<string, string | number> = {
      app_key: config.appKey,
      body: JSON.stringify({ order_id: providerOrderId }),
      format: "json",
      source_id: config.sourceId,
      timestamp: observedAt,
      v: "1.0",
    };
    const requestBody = JSON.stringify({
      ...fields,
      signature: dadaApiSignature(fields, config.appSecret),
    });
    let response: Response;
    try {
      response = await fetch(DADA_ORDER_QUERY_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: requestBody,
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new Error(`dada_query_network_${errorMessage(error).slice(0, 80)}`);
    }
    if (!response.ok) throw new Error(`dada_query_http_${response.status}`);
    const envelope = await readBoundedJson(response);
    const code = String(envelope.code ?? "");
    if (code !== "0" || envelope.status !== "success") {
      const providerCode = String(envelope.errorCode ?? envelope.code ?? "unknown")
        .replace(/[^A-Za-z0-9_-]/g, "_")
        .slice(0, 40);
      throw new Error(`dada_query_provider_${providerCode || "unknown"}`);
    }
    const result = record(envelope.result);
    if (!result) throw new Error("dada_query_result_invalid");
    const returnedOrderId = String(result.order_id ?? result.origin_id ?? providerOrderId).trim();
    if (returnedOrderId !== providerOrderId) throw new Error("dada_query_order_mismatch");
    return normalizeDadaCityDeliveryQuery(result, {
      expectedClientId: config.clientId,
      providerOrderId,
      observedAt,
    });
  }

  private config(): DadaConfig {
    return {
      appKey: configured(this.env.DADA_APP_KEY, "app_key", 128),
      appSecret: configured(this.env.DADA_APP_SECRET, "app_secret", 256),
      sourceId: configured(this.env.DADA_SOURCE_ID, "source_id", 128),
      clientId: configured(this.env.DADA_CLIENT_ID, "client_id", 64),
    };
  }
}
