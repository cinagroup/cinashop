/**
 * TokenBucket Durable Object
 *
 * 用于鉴权 token 的强一致存储。
 *
 * 为什么需要 DO 而不是只用 Upstash:
 *   - 单设备登录强制下线场景: 同一 uid 新 token 踢掉旧 token,
 *     需要"原子比较+替换", Upstash REST 跨网络做不到无竞态。
 *   - DO 单线程执行, blockConcurrencyWhile 天然互斥。
 *
 * sharding: 每个 uid 一个 DO 实例 (id = uid 字符串)。
 *
 * 注: M1 阶段 token bucket 主存 Upstash (与 PHP 兼容),
 *     DO 作为可选的"单设备登录"增强, 默认不启用。
 *     通过 SINGLE_DEVICE_LOGIN 配置开关。
 */
import { DurableObject } from "cloudflare:workers";
import {
  advanceRateWindows,
  type RateLimitDecision,
  type RateLimitPolicy,
  type RateWindow,
} from "@/services/out/OutRateLimitPolicy";

interface BucketState {
  token: string; // 当前有效 token
  tokenKey: string; // md5(token)
  exp: number; // 过期时间戳(秒)
}

export type ScanLoginAudience = "pc_user" | "kefu_agent";
export type ScanLoginStage = "pending" | "scanned" | "approved";

export interface ScanLoginChallengeState {
  version: 1;
  audience: ScanLoginAudience;
  stage: ScanLoginStage;
  pollTokenHash: string;
  issuedAt: number;
  expiresAt: number;
  scannedUid?: number;
  approvedUid?: number;
  approvedKefuId?: number;
}

export interface ScanLoginChallengeView {
  audience: ScanLoginAudience;
  stage: ScanLoginStage;
  issuedAt: number;
  expiresAt: number;
  scannedUid?: number;
}

export type ScanLoginPollResult =
  | { status: 0 }
  | { status: 1 | 2; audience: ScanLoginAudience; expiresAt: number }
  | {
    status: 3;
    audience: ScanLoginAudience;
    uid: number;
    kefuId?: number;
  };

const RATE_WINDOWS_KEY = "out-rate-windows";
const SCAN_LOGIN_KEY = "scan-login";

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

export class TokenBucketDO extends DurableObject {
  private async liveScanLoginState(now: number): Promise<ScanLoginChallengeState | null> {
    const state = await this.ctx.storage.get<ScanLoginChallengeState>(SCAN_LOGIN_KEY) ?? null;
    if (state && state.expiresAt <= now) {
      await this.ctx.storage.delete(SCAN_LOGIN_KEY);
      return null;
    }
    return state;
  }

  /** Initialize one browser-held QR login challenge in this challenge shard. */
  async createScanLoginChallenge(state: ScanLoginChallengeState): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Math.floor(Date.now() / 1000);
      const current = await this.liveScanLoginState(now);
      if (current) return false;
      if (
        state.version !== 1
        || !["pc_user", "kefu_agent"].includes(state.audience)
        || state.stage !== "pending"
        || !/^[a-f0-9]{64}$/.test(state.pollTokenHash)
        || state.issuedAt > now + 60
        || state.expiresAt <= now
      ) return false;
      await this.ctx.storage.put(SCAN_LOGIN_KEY, state);
      const alarm = await this.ctx.storage.getAlarm();
      const expiresAtMs = state.expiresAt * 1000;
      if (alarm === null || alarm > expiresAtMs) await this.ctx.storage.setAlarm(expiresAtMs);
      return true;
    });
  }

  /** Return only non-secret challenge metadata to the Worker service layer. */
  async getScanLoginChallenge(): Promise<ScanLoginChallengeView | null> {
    const state = await this.liveScanLoginState(Math.floor(Date.now() / 1000));
    if (!state) return null;
    return {
      audience: state.audience,
      stage: state.stage,
      issuedAt: state.issuedAt,
      expiresAt: state.expiresAt,
      scannedUid: state.scannedUid,
    };
  }

  /** Bind the displayed QR challenge to the first authenticated mobile user. */
  async markScanLoginChallengeScanned(uid: number): Promise<ScanLoginChallengeView | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.liveScanLoginState(Math.floor(Date.now() / 1000));
      if (!state || !Number.isSafeInteger(uid) || uid <= 0) return null;
      if (state.stage === "pending") {
        state.stage = "scanned";
        state.scannedUid = uid;
        await this.ctx.storage.put(SCAN_LOGIN_KEY, state);
      } else if (state.scannedUid !== uid) {
        return null;
      }
      return {
        audience: state.audience,
        stage: state.stage,
        issuedAt: state.issuedAt,
        expiresAt: state.expiresAt,
        scannedUid: state.scannedUid,
      };
    });
  }

  /** Approve only the same authenticated user that inspected the challenge. */
  async approveScanLoginChallenge(
    uid: number,
    kefuId?: number,
  ): Promise<ScanLoginChallengeView | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.liveScanLoginState(Math.floor(Date.now() / 1000));
      if (!state || state.scannedUid !== uid) return null;
      if (state.stage === "scanned") {
        if (state.audience === "kefu_agent" && (!Number.isSafeInteger(kefuId) || Number(kefuId) <= 0)) {
          return null;
        }
        state.stage = "approved";
        state.approvedUid = uid;
        if (state.audience === "kefu_agent") state.approvedKefuId = Number(kefuId);
        await this.ctx.storage.put(SCAN_LOGIN_KEY, state);
      } else if (state.stage !== "approved" || state.approvedUid !== uid) {
        return null;
      }
      return {
        audience: state.audience,
        stage: state.stage,
        issuedAt: state.issuedAt,
        expiresAt: state.expiresAt,
        scannedUid: state.scannedUid,
      };
    });
  }

  /** Poll with the browser-only secret; approval is atomically consumed once. */
  async pollScanLoginChallenge(
    pollTokenHash: string,
    expectedAudience: ScanLoginAudience,
  ): Promise<ScanLoginPollResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.liveScanLoginState(Math.floor(Date.now() / 1000));
      if (
        !state
        || state.audience !== expectedAudience
        || !(await constantTimeEqual(state.pollTokenHash, pollTokenHash))
      ) return { status: 0 };
      if (state.stage === "pending") {
        return { status: 2, audience: state.audience, expiresAt: state.expiresAt };
      }
      if (state.stage === "scanned") {
        return { status: 1, audience: state.audience, expiresAt: state.expiresAt };
      }
      if (!state.approvedUid) return { status: 0 };
      await this.ctx.storage.delete(SCAN_LOGIN_KEY);
      return {
        status: 3,
        audience: state.audience,
        uid: state.approvedUid,
        ...(state.approvedKefuId ? { kefuId: state.approvedKefuId } : {}),
      };
    });
  }

  /**
   * 注册 token。如果启用单设备登录且已有旧 token, 返回旧 tokenKey 让上层清除。
   *
   * @returns 被踢下线的旧 tokenKey (若有), 否则 null
   */
  async register(state: BucketState, forceKick: boolean): Promise<string | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const old = (await this.ctx.storage.get<BucketState>("current")) ?? null;
      await this.ctx.storage.put("current", state);
      // 设置过期 alarm (DO 不支持 TTL, 用 alarm 清理)
      await this.ctx.storage.setAlarm(state.exp * 1000);
      if (forceKick && old && old.tokenKey !== state.tokenKey) {
        return old.tokenKey;
      }
      return null;
    });
  }

  /** 校验当前 token 是否仍是有效的 (用于 auth 中间件二次确认) */
  async verify(tokenKey: string): Promise<boolean> {
    const cur = await this.ctx.storage.get<BucketState>("current");
    return cur?.tokenKey === tokenKey;
  }

  /** 主动注销 (用户登出 / 改密) */
  async revoke(): Promise<void> {
    await this.ctx.storage.delete("current");
  }

  /**
   * Atomically consume several fixed-window policies for one coordination
   * subject (for example an Out account or one unauthenticated source IP).
   * All counters live in one persisted object so a request can never consume
   * only part of its account/IP policies.
   */
  async consumeRateLimit(
    policies: RateLimitPolicy[],
    windowSeconds: number,
  ): Promise<RateLimitDecision> {
    const now = Date.now();
    const previous = await this.ctx.storage.get<Record<string, RateWindow>>(RATE_WINDOWS_KEY) ?? {};
    const { windows, decision } = advanceRateWindows(previous, policies, now, windowSeconds);
    await this.ctx.storage.put(RATE_WINDOWS_KEY, windows);
    const alarm = await this.ctx.storage.getAlarm();
    const nextReset = Math.min(...Object.values(windows).map((window) => window.resetAt));
    if (alarm === null || alarm > nextReset) await this.ctx.storage.setAlarm(nextReset);
    return decision;
  }

  /** alarm 触发时清理过期状态 */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const current = await this.ctx.storage.get<BucketState>("current");
    const scanLogin = await this.ctx.storage.get<ScanLoginChallengeState>(SCAN_LOGIN_KEY);
    const previous = await this.ctx.storage.get<Record<string, RateWindow>>(RATE_WINDOWS_KEY) ?? {};
    const windows = Object.fromEntries(
      Object.entries(previous).filter(([, window]) => window.resetAt > now),
    ) as Record<string, RateWindow>;

    if (current && current.exp * 1000 <= now) await this.ctx.storage.delete("current");
    if (scanLogin && scanLogin.expiresAt * 1000 <= now) await this.ctx.storage.delete(SCAN_LOGIN_KEY);
    if (Object.keys(windows).length) await this.ctx.storage.put(RATE_WINDOWS_KEY, windows);
    else if (Object.keys(previous).length) await this.ctx.storage.delete(RATE_WINDOWS_KEY);

    const nextTimes = [
      current && current.exp * 1000 > now ? current.exp * 1000 : null,
      scanLogin && scanLogin.expiresAt * 1000 > now ? scanLogin.expiresAt * 1000 : null,
      ...Object.values(windows).map((window) => window.resetAt),
    ].filter((value): value is number => value !== null);
    if (nextTimes.length) await this.ctx.storage.setAlarm(Math.min(...nextTimes));
  }
}
