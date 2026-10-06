import { apiDiySuspended } from "@/api/diy";
import { parseFabConfig, type FabConfig } from "@/utils/fab";

const SUSPENDED_CACHE_TTL_MS = 5 * 60 * 1_000;

let cachedConfig: FabConfig | null = null;
let cachedUntil = 0;
let hasCached = false;
let pendingConfig: Promise<FabConfig | null> | null = null;
let generation = 0;

export async function loadDiySuspendedConfig(now = Date.now()): Promise<FabConfig | null> {
  if (hasCached && now < cachedUntil) return cachedConfig;
  if (pendingConfig) return pendingConfig;

  const epoch = generation;
  const pending = apiDiySuspended()
    .then((value) => {
      const parsed = parseFabConfig(value);
      if (epoch !== generation) return null;
      cachedConfig = parsed;
      hasCached = true;
      cachedUntil = Date.now() + SUSPENDED_CACHE_TTL_MS;
      return parsed;
    })
    .finally(() => {
      if (pendingConfig === pending) pendingConfig = null;
    });
  pendingConfig = pending;
  return pendingConfig;
}

/** Invalidating cannot allow an older response to repopulate the cache. */
export function invalidateDiySuspendedConfig(): void { generation++; cachedConfig = null; hasCached = false; cachedUntil = 0; pendingConfig = null; }
