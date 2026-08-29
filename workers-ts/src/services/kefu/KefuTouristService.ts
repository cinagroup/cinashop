import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { KefuProductService } from "@/services/kefu/KefuProductService";
import { CustomerServiceCatalogService } from "@/services/message/CustomerServiceCatalogService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { LegacyContentService } from "@/services/system/LegacyContentService";
import { RateLimitException } from "@/utils/errors";

const FEEDBACK_LIMIT_PER_HOUR = 5;
const FEEDBACK_GLOBAL_LIMIT_PER_HOUR = 300;

async function hmacHex(keyValue: string, value: string): Promise<string> {
  if (!keyValue) throw new Error("Tourist feedback HMAC key unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyValue),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class KefuTouristService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async advertisement() {
    return new LegacyContentService(this.container).kfAdv();
  }

  async feedbackInfo() {
    return new SystemConfigService(this.container, this.env).get("service_feedback");
  }

  async productInfo(id: unknown) {
    return new KefuProductService(this.container).productInfo(id, true);
  }

  async submitFeedback(input: unknown, ip = "") {
    const source = await hmacHex(
      this.env.APP_KEY,
      `kefu-tourist-feedback\u0000${ip.trim().slice(0, 128) || "unknown"}`,
    );
    const decision = await this.env.TOKEN_BUCKET
      .getByName(`kefu-tourist-feedback:${source.slice(0, 32)}`)
      .consumeRateLimit(
        [{ key: "ip", limit: FEEDBACK_LIMIT_PER_HOUR }],
        60 * 60,
      );
    if (!decision.allowed) {
      const retryAfter = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
      throw new RateLimitException("反馈提交过于频繁，请稍后重试", retryAfter, false);
    }
    const globalDecision = await this.env.TOKEN_BUCKET
      .getByName("kefu-tourist-feedback:global")
      .consumeRateLimit(
        [{ key: "global", limit: FEEDBACK_GLOBAL_LIMIT_PER_HOUR }],
        60 * 60,
      );
    if (!globalDecision.allowed) {
      const retryAfter = Math.max(1, Math.ceil((globalDecision.resetAt - Date.now()) / 1000));
      throw new RateLimitException("反馈服务繁忙，请稍后重试", retryAfter, false);
    }
    return new CustomerServiceCatalogService(this.container).submitAnonymousFeedback(input);
  }
}
