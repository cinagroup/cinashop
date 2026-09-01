import { apiDiySuspended, type DiySuspendedConfig } from "@/api/diy";

const SUSPENDED_CACHE_TTL_MS = 5 * 60 * 1_000;

let cachedConfig: DiySuspendedConfig | null = null;
let cachedUntil = 0;
let pendingConfig: Promise<DiySuspendedConfig> | null = null;

export async function loadDiySuspendedConfig(now = Date.now()): Promise<DiySuspendedConfig> {
  if (cachedConfig && now < cachedUntil) return cachedConfig;
  if (pendingConfig) return pendingConfig;

  pendingConfig = apiDiySuspended()
    .then((value) => {
      cachedConfig = value;
      cachedUntil = Date.now() + SUSPENDED_CACHE_TTL_MS;
      return value;
    })
    .finally(() => {
      pendingConfig = null;
    });
  return pendingConfig;
}
