import type { Env } from "@/env";
import { ValidateException } from "@/utils/errors";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2_048;
const MAX_RESPONSE_BYTES = 16 * 1_024;
const VERIFY_TIMEOUT_MS = 5_000;
const MAX_CHALLENGE_AGE_MS = 5 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 30 * 1_000;

interface TurnstileSiteverifyResponse {
  success?: boolean;
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
  "error-codes"?: unknown;
}

interface TurnstileConfig {
  secretKey: string;
  siteKey: string;
  expectedHostnames: ReadonlySet<string>;
}

export interface TurnstileVerification {
  hostname: string;
  action: string;
  challengeTime: string;
}

function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function loadConfig(env: Env): TurnstileConfig {
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim() ?? "";
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  const expectedHostnames = new Set(
    (env.TURNSTILE_EXPECTED_HOSTNAMES ?? "")
      .split(",")
      .map(normalizedHostname)
      .filter(Boolean),
  );
  if (!secretKey || !siteKey || expectedHostnames.size === 0) {
    throw new ValidateException("人机验证尚未配置");
  }
  return { secretKey, siteKey, expectedHostnames };
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("Turnstile response exceeded 16 KiB");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Turnstile response exceeded 16 KiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function validateResponse(
  value: TurnstileSiteverifyResponse,
  config: TurnstileConfig,
  expectedAction: string,
  expectedCdata: string,
  now: number,
): TurnstileVerification {
  if (value.success !== true) throw new ValidateException("人机验证失败，请重试");
  const hostname = normalizedHostname(String(value.hostname ?? ""));
  if (!hostname || !config.expectedHostnames.has(hostname)) {
    throw new ValidateException("人机验证来源不匹配，请重试");
  }
  const action = String(value.action ?? "");
  if (action !== expectedAction) throw new ValidateException("人机验证用途不匹配，请重试");
  if (String(value.cdata ?? "") !== expectedCdata) {
    throw new ValidateException("人机验证挑战不匹配，请重试");
  }
  const challengeTime = String(value.challenge_ts ?? "");
  const challengeTimestamp = Date.parse(challengeTime);
  if (
    !Number.isFinite(challengeTimestamp) ||
    challengeTimestamp > now + MAX_CLOCK_SKEW_MS ||
    now - challengeTimestamp > MAX_CHALLENGE_AGE_MS + MAX_CLOCK_SKEW_MS
  ) {
    throw new ValidateException("人机验证已过期，请重试");
  }
  return { hostname, action, challengeTime };
}

export class TurnstileService {
  constructor(
    private readonly env: Env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  publicConfig(): { siteKey: string; expectedHostnames: string[] } {
    const config = loadConfig(this.env);
    return { siteKey: config.siteKey, expectedHostnames: [...config.expectedHostnames] };
  }

  async verify(
    tokenValue: unknown,
    remoteIp: string,
    expectedAction: string,
    expectedCdata: string,
    now = Date.now(),
  ): Promise<TurnstileVerification> {
    const token = String(tokenValue ?? "").trim();
    if (!token || token.length > MAX_TOKEN_LENGTH) {
      throw new ValidateException("请完成人机验证");
    }
    const config = loadConfig(this.env);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
      // Cloudflare's global fetch rejects a foreign receiver. Detach injected/global
      // fetch from this service instance before invoking it.
      const fetcher = this.fetcher;
      const response = await fetcher(SITEVERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: config.secretKey,
          response: token,
          remoteip: remoteIp.trim().slice(0, 128),
          idempotency_key: crypto.randomUUID(),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Turnstile Siteverify returned HTTP ${response.status}`);
      const text = await readBoundedText(response);
      let parsed: TurnstileSiteverifyResponse;
      try {
        parsed = JSON.parse(text) as TurnstileSiteverifyResponse;
      } catch {
        throw new Error("Turnstile Siteverify returned invalid JSON");
      }
      return validateResponse(parsed, config, expectedAction, expectedCdata, now);
    } catch (error) {
      if (error instanceof ValidateException) throw error;
      throw new ValidateException("人机验证服务暂时不可用，请重试");
    } finally {
      clearTimeout(timeout);
    }
  }
}
