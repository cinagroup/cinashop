# CinaShop production observability gate

This document defines the release evidence for migration checklist `TEST-003`.
The machine-readable thresholds live in `audit/observability-policy.json`; CI
must run `npm run audit:observability` so prose cannot silently drift away from
the bindings, critical events, or deployment state.

## Current boundary

- Workers Logs and invocation logs are enabled at a `1.0` head sampling rate in
  the release configuration. Critical events are logged as objects, not JSON
  strings, so Cloudflare can index `schema`, `event`, `component`, `operation`,
  `outcome`, `durationMs`, `statusCode`, and `errorCode` independently.
- Raw paths, query strings, SQL, headers, tokens, request/response bodies,
  provider messages, phone numbers, email addresses, credentials and any
  `id`/`*Id`/`*Uid` identifier are not operational-log fields. The logger also
  prevents callers from overriding `schema`; unknown exceptions expose a bounded
  error class only. CI parses every call site and rejects identifier fields or
  object spreads before runtime.
- Fetch traces remain disabled because Enterprise WeChat credentials currently
  occur in provider query strings. Enabling traces requires an explicit redaction
  acceptance test on a deployed candidate.
- Cloudflare's native GraphQL/REST datasets remain the source of truth for
  Hyperdrive, Queues, Durable Objects and R2. Application events add business
  domains; they do not replace native metrics.
- No notification destination or production alert policy has been verified.
  Consequently TEST-003 remains open even when the code audit passes.

## Signals and first-response rules

| Domain | Native/application signal | Warning | Critical | First response |
|---|---|---|---|---|
| Hyperdrive | query errors, average query latency, pool waiters | >=1% errors with 100 queries/5m; avg >=250 ms/15m; any waiter/5m | >=5% errors with 20 queries/5m; avg >=1 s/5m; 5 waiters/5m | Correlate the low-cardinality HTTP domain, SQLSTATE and pool metrics; inspect PostgreSQL without logging SQL or parameters. |
| Queue | real-time backlog and oldest message | 100 messages or 60 s old for 5m | 1,000 messages or 300 s old for 5m | Check consumer errors, provider latency, concurrency and retry amplification. |
| DLQ | `outcome=dlq`, persistent archive, unarchived queue | none | any DLQ transition or any unarchived backlog | Open the PostgreSQL dead-letter record; never replay an unarchived body blindly. |
| Durable Objects | invocation errors and p99 memory | >=1% errors; p99 >=96 MiB | >=5% errors; p99 >=120 MiB | Split by namespace/object and inspect per-principal socket fan-out. |
| R2 | operation status plus `r2_object_*` | slow GET >=500 ms is diagnostic | any native `internalError`; any application write/read failure | Preserve object/metadata compensation ordering and check object existence before repair. |
| Login | critical-flow HTTP objects | 10 rejects/5m | 3 server errors/5m | Separate abuse/rate limiting from Redis, database or identity-provider outage. |
| Payment | callback events and durable outbox | 5 rejects/5m | any processing failure or 3 HTTP 5xx/5m | Verify signature/configuration and inspect the payment outbox; never synthesize success. |
| Refund | callback/reconciliation events and payment status | 5 rejects or 3 reconciliation failures/15m | `UNKNOWN` older than 15m or any `DEAD` | Query the provider using the immutable refund identity; never issue a blind second refund. |
| Print | queue duration and job status | 3 retries or p95 >=5 s/15m | any `UNKNOWN` or `DEAD` | Confirm the provider result manually before retrying. |
| Waybill | queue duration and job status | 3 retries or p95 >=5 s/15m | any `UNKNOWN` or `DEAD` | Confirm allocation before retrying; prevent a second tracking number. |

## Production acceptance checklist

1. Deploy the exact release candidate and confirm Workers Logs contain object
   fields for a controlled success, rejection and failure without sensitive data.
2. Configure a real notification destination and materialize every policy in
   `audit/observability-policy.json` using Cloudflare notifications or an
   approved external metrics/Logs destination. Record policy IDs and owners.
3. Exercise one safe synthetic event per domain and prove warning/critical
   delivery, acknowledgement and escalation. Do not create fake payment,
   refund, print or waybill provider side effects.
4. Observe the candidate for the release window, record baseline traffic and
   tune thresholds only with evidence. Keep low-traffic absolute-count guards.
5. Enable fetch traces only after query-string redaction has been demonstrated;
   otherwise keep the current fail-closed setting.

Official platform references used for this contract:

- https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- https://developers.cloudflare.com/hyperdrive/observability/metrics/
- https://developers.cloudflare.com/queues/observability/metrics/
- https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/
- https://developers.cloudflare.com/r2/platform/metrics-analytics/
