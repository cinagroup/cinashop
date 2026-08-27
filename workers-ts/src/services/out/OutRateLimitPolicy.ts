export interface RateLimitPolicy {
  key: string;
  limit: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  auditEvent: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export interface RateWindow {
  count: number;
  resetAt: number;
}

export interface RateLimitTransition {
  windows: Record<string, RateWindow>;
  decision: RateLimitDecision;
}

const MAX_RATE_POLICIES = 4;
const MAX_RATE_KEYS = 512;

/** Deterministic transition shared by the Durable Object and Node unit tests. */
export function advanceRateWindows(
  previous: Record<string, RateWindow>,
  policies: RateLimitPolicy[],
  now: number,
  windowSeconds: number,
): RateLimitTransition {
  if (!Array.isArray(policies) || policies.length < 1 || policies.length > MAX_RATE_POLICIES) {
    throw new Error("invalid rate limit policies");
  }
  if (!Number.isFinite(now) || now < 0) throw new Error("invalid rate limit time");
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 3600) {
    throw new Error("invalid rate limit window");
  }
  const normalized = policies.map((policy) => {
    const key = String(policy?.key ?? "");
    const limit = Number(policy?.limit);
    if (!/^[a-z0-9:_{}\/-]{1,160}$/.test(key)) throw new Error("invalid rate limit key");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
      throw new Error("invalid rate limit value");
    }
    return { key, limit };
  });
  if (new Set(normalized.map((policy) => policy.key)).size !== normalized.length) {
    throw new Error("duplicate rate limit policy");
  }

  const resetAt = now + windowSeconds * 1000;
  const policyKeys = new Set(normalized.map((policy) => policy.key));
  const windows = Object.fromEntries(
    Object.entries(previous)
      .filter(([key, value]) => !policyKeys.has(key) && Number.isFinite(value.resetAt) && value.resetAt > now)
      .sort((left, right) => right[1].resetAt - left[1].resetAt)
      .slice(0, MAX_RATE_KEYS - normalized.length),
  ) as Record<string, RateWindow>;
  const decisions = normalized.map((policy) => {
    const current = previous[policy.key];
    const state = current && Number.isSafeInteger(current.count) && current.count >= 0 && current.resetAt > now
      ? { count: current.count + 1, resetAt: current.resetAt }
      : { count: 1, resetAt };
    windows[policy.key] = state;
    return {
      allowed: state.count <= policy.limit,
      auditEvent: state.count === policy.limit + 1,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - state.count),
      resetAt: state.resetAt,
    };
  });
  return {
    windows,
    decision: decisions.reduce((result, decision) => ({
      allowed: result.allowed && decision.allowed,
      auditEvent: result.auditEvent || decision.auditEvent,
      limit: Math.min(result.limit, decision.limit),
      remaining: Math.min(result.remaining, decision.remaining),
      resetAt: Math.max(result.resetAt, decision.resetAt),
    })),
  };
}
