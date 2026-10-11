import policy from "../audit/observability-policy.json";

type Window = { start: string; end: string };

const graphQlSources = [
  { dataset: "hyperdriveQueriesAdaptiveGroups", signals: ["hyperdrive_query_errors", "hyperdrive_query_latency"] },
  { dataset: "hyperdrivePoolSizesAdaptiveGroups", signals: ["hyperdrive_pool_waiters"] },
  { dataset: "queueMessageOperationsAdaptiveGroups", signals: ["queue_dlq_transition"] },
  { dataset: "durableObjectsInvocationsAdaptiveGroups", signals: ["durable_object_errors"] },
  { dataset: "durableObjectsPeriodicGroups", signals: ["durable_object_memory"] },
  { dataset: "r2OperationsAdaptiveGroups", signals: ["r2_internal_errors"] },
] as const;
const realtimeSources = [
  { resource: "cinashop-order", signal: "queue_backlog" },
  { resource: "cinashop-order-dlq", signal: null },
  { resource: "cinashop-order-dlq-unarchived", signal: "queue_unarchived_dead_letters" },
] as const;

/** Offline plan only. The operator supplies the verified account and API permissions. */
export function buildProductionObservabilitySamplePlan(asOf: Date) {
  const time = asOf.getTime();
  if (!Number.isSafeInteger(time) || time < Date.UTC(2020, 0, 1)) {
    throw new Error("Invalid UTC observability sample anchor");
  }
  const ids = policy.signals.map((signal) => signal.id);
  const platformIds: string[] = [
    ...graphQlSources.flatMap((source) => [...source.signals]),
    ...realtimeSources.flatMap((source) => source.signal ? [source.signal] : []),
  ];
  if (new Set(ids).size !== 17 || ids.length !== 17 || platformIds.length !== 9
    || platformIds.some((id) => !ids.includes(id)) || new Set(platformIds).size !== 9) {
    throw new Error("Observability policy signal inventory drifted");
  }
  const window = (durationMs: number): Window => ({
    start: new Date(time - durationMs).toISOString(), end: asOf.toISOString(),
  });
  const windows = { fifteenMinutes: window(15 * 60_000), day: window(24 * 60 * 60_000) };
  return {
    asOf: asOf.toISOString(),
    policySignalCount: ids.length,
    platformSignalCount: platformIds.length,
    requiresCurrentFormalBindingPreflight: true,
    windows,
    graphQl: graphQlSources.map((source) => ({ ...source, windows })),
    queuesRealtime: realtimeSources.map((source) => ({ ...source, sampledAt: asOf.toISOString() })),
    outsidePlatformSample: ids.filter((id) => !platformIds.includes(id)),
    resultRule: "A missing or denied dataset is unavailable; an empty observed window is no_traffic, never zero_errors.",
  };
}

/** Preserve the distinction between a valid empty window and an API failure. */
export function classifyPlatformRows(input: {
  success: boolean; rows?: readonly unknown[]; errors?: readonly unknown[];
}): "observed" | "no_traffic" | "unavailable" {
  if (!input.success || input.errors?.length || !Array.isArray(input.rows)) return "unavailable";
  return input.rows.length ? "observed" : "no_traffic";
}
