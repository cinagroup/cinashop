# Admin refund operation HTTP candidate

2026-09-15. Local implementation and isolated tests only; **not deployed**.
The v3 Admin client now consumes this protocol locally (follow-up below). This follows the durable receipt service and
guarded migration in [the migration evidence](sku-membership-price.md#guarded-admin-refund-receipt-migration-candidate-2026-09-15).
It closes the missing HTTP adapter, not the entire refund migration or rollout.

## Routes and authority

Both prefixes mount exactly the same router before legacy catch-alls:
`/adminapi/refund/operations` and `/api/admin/refund/operations`.

| Method and suffix | Request JSON | Effect |
| --- | --- | --- |
| POST `/execute/:id` | Original versioned decision | Execute or replay that same operation; explicit retries may resume the existing provider state machine |
| POST `/receipt` | `{"version":"admin-refund-operation-v1"}` | Read the currently authorized owner's receipt, or null; never dispatch a provider or create a fence |
| POST `/abandon/:id` | Original versioned decision | Persist an abandonment fence only if the operation was not already accepted; otherwise return the accepted receipt unchanged |

All three require the real Admin authentication middleware and `refund.manage`,
including receipt lookup. Lookup is deliberately POST so operation keys stay
out of URLs and the existing manage-permission mapping remains explicit. No
GET/HEAD/PUT route performs an operation. The later local
[legacy-retirement candidate](admin-refund-legacy-retirement.md) now rejects
seven old Admin POSTs with HTTP410; it never fabricates durable keys for callers.

Required headers:

- Existing `Authori-zation: Bearer <token>` or supported `Authorization` header.
- `Idempotency-Key: <original UUIDv4>`, normalized by the existing shared key
  parser. Missing, malformed or comma-joined duplicate keys are rejected.
- `X-Refund-Operation-Scope: v1:admin:<administrator ID>`, exactly matching the
  authenticated principal. This is a **precondition, never an authority source**.
  Missing, stale or noncanonical values return HTTP412. The actual owner comes
  only from mutually consistent `adminId`, `adminInfo.id` and `socketAuthId`.
- `Content-Type: application/json`, optionally `; charset=utf-8`.

The existing CORS origin allowlist is unchanged; only the new scope header is
added to permitted request headers. No wildcard origin or credential rule was
added. There are no new environment bindings or dependency/configuration changes.

JWT/token-bucket authentication and ordinary route authorization occur before
body parsing. Account state, password version, strict expiry and current SQL
role/menu authority are checked again by the existing operation service during
execution, replay, lookup and abandonment. This protects against authority
changes while the request body is delivered, but does **not** make Redis logout
and SQL decision admission one atomic operation.

## Request and response contract

Example **synthetic** return approval, with the refund ID in `:id`:

```json
{
  "version": "admin-refund-operation-v1",
  "action": "return",
  "review": {
    "uid": 11,
    "storeOrderId": 28,
    "storeId": 0,
    "supplierId": 0,
    "orderId": "history_refund_28",
    "refundPrice": "5.00"
  },
  "decision": { "applyType": 2, "refundType": 0, "received": false }
}
```

The only actions are exact strings `return`, `refuse` and `refund`. Refusal
additionally requires `reason`; other actions reject that field. Top-level,
review and decision fields must exactly match the protocol. The service retains
the existing strict numeric identity, amount, state and receipt-acknowledgment
checks, normalizes the refusal reason, copies the decision and hashes it before
external I/O. The request hash does not include the session token; an authorized
renewed session for the same administrator can recover the original key.

Requests are limited to4096 actual UTF-8 bytes, not just a declared length.
Malformed lengths, oversized streams, invalid UTF-8, invalid JSON, unsupported
content encoding, query parameters and extra owner/key fields are rejected.
The byte-limit reader cancels an overflowing stream even with a false small
Content-Length. Legacy browser v2 nonces do not satisfy this protocol.

Responses retain the existing `{status,msg,data}` envelope. On success:

- Execute data is `{version,receipt,replayed,execution}`. Execution is explicitly
  null when not applicable, otherwise the core's `{completed,status}` result.
- Lookup and abandonment data are `{version,receipt}`. Only lookup can return
  a null receipt. Null is **not proof that a delayed sender cannot arrive**.
- Receipt is `{version,adminId,requestKey,requestHash,refundId,action,outcome}`.
  It contains no token, password version, raw refusal reason or business-row
  contents. `provider-admitted` means admission, **not settled money**.
- An abandonment response can contain an already accepted outcome. It must not
  be presented as cancellation. An `abandoned` replay must not be rendered as
  a successfully executed business decision.
- Internal `balance-settled` follows the existing balance/zero-cash finalization
  branch and is not a promise that a nonzero balance credit occurred.

Success, validation, auth, conflict and failure responses are no-store; the
route also sets Pragma:no-cache before auth. Existing compatibility errors may
carry HTTP200 with a non-200 **body.status**. Key conflicts use HTTP409, actor
preconditions HTTP412 and service-unavailable/corrupt-evidence errors HTTP503.
Unexpected SQL errors are sanitized by the existing global handler; they are
not returned with raw SQL parameters or driver messages. Clients must check the
envelope and validate receipt identity, not infer success from HTTP200 alone.

No HTTP operation creates or repairs the receipt table. Its absence fails
closed without business writes or provider dispatch. Only the guarded explicit
maintenance migration may install it.

## Executed evidence

The test app is the actual `createApp()` with its middleware, both real route
prefixes, JWT validation, permission service, controllers and SQL services.
Only the database binding is redirected to a disposable fixture. Provider
adapters are synthetic, all unexpected fetch calls fail, and production data
and credentials are never used. The main fixtures deliberately use the test
environment without Redis; production-without-token-storage is separately
verified to fail503. This is not a live Redis/Hyperdrive/workerd/browser test.

The31 HTTP cases include:

- Both aliases, cross-alias replay, owner isolation, stale actor412, exact
  field/header/UTF-8/size checks, unauthorized and view-only rejection.
- Twelve cases changing account status, password, roles or time after real
  middleware authentication while streaming each of the three request bodies.
  Each rejects without changing the preexisting receipt or decision.
- Renewed-token replay and strict expiration within JWT verification's clock
  tolerance; a missing lookup stays absent until explicit abandonment.
- An actual delayed HTTP execution blocked by its abandonment fence; accepted
  decisions survive attempted abandonment and deletion of mutable business rows.
- Actual balance, bill, inventory and refund writes once; receipt-insert failure
  rolls all of them back and keeps private SQL error content out of responses/logs.
- Provider admission is visible through another HTTP lookup before the mocked
  gateway returns. A duplicate HTTP execution retains the existing lease and
  never dispatches a second request. A lost response remains admitted; lookup
  and abandonment never query the provider. Explicit same-key retry queries
  the stable refund number and invokes the real SQL finalizer on synthetic SUCCESS.
- Missing table refuses all three operations without installing it; unsupported
  HTTP methods do not execute, and allowed-origin preflight admits the new header.

Final result per suite, without adding repeated smoke runs:

| Scope | Files | Passed | Skipped |
| --- | ---: | ---: | ---: |
| Native PG16.15 HTTP31, executor24, ledger15, SQL authorization locks8; non-superuser fixture owner | 4 | 78 | 0 |
| Existing HTTP cache, Admin permissions, frontend/intent/decision/evidence compatibility tests | 6 | 127 | 0 |
| Real restricted-LOGIN shipping receipt ACL regression | 1 | 18 | 0 |
| Portable-runner pre-start CLI restrictions | 1 | 11 | 0 |
| Total, latest result of each suite once | 12 | 234 | 0 |

The first14 HTTP cases passed on PGlite before expansion. Initial unit types
failed because response.json() was unknown and Node's duplex test option was
not part of Workers RequestInit. Tests now validate object/envelope shapes and
use an explicit Node-only structural extension; no any/double-cast was added.
The first native batch passed69 cases before the in-flight HTTP case was added;
it is included in the final78, not added again. The first compatibility batch
reported18 skips due to a missing native test URL; those same18 were then run
successfully in an owned local maintenance cluster with separate restricted
LOGIN roles. Business HTTP tests are explicitly refused in maintenance mode.

Final Worker unit and runtime typechecks, runner syntax and normal git diff
whitespace checks passed. Each native run reported no remaining fixture
databases or extra roles. Independent checks of the three owned clusters
(`3vvPIG`, `nqEVJW`, `I2plVk`) confirmed pg_ctl status3, no postmaster PID or
bootstrap-password files and zero processes from the downloaded runtime.
Stopped diagnostic directories and control databases remain in ignored `.cache`;
no system service or persistent environment setting was installed.

Workers/PostgreSQL skills guided the bounded UTF-8 reader, pre-auth no-store
responses, typed validation and preservation of short SQL phases without an
HTTP-wide transaction. Current [Workers guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
was retrieved. Latest npm types metadata was denied by socket EACCES, so the
installed5.20260828.1 definitions and local Wrangler schema were inspected as
the fallback; no dependency/configuration upgrade was attempted.

## Still required before release

1. Versioned Admin API/intent and the joined local rendered Admin -> real
   authenticated HTTP -> native PostgreSQL acceptance now pass (follow-ups
   below). Production roles, platform runtime and deployment acceptance are
   separate, still-open requirements.
2. The [old-client rollout policy](admin-refund-legacy-retirement.md) and local
   seven-route retirement guard now exist, but cutover/in-flight legacy review
   and the proactive/split replacement are still open. Old v2 nonces never
   reached this ledger; a new receipt lookup/abandonment cannot prove or fence
   an old unkeyed request. Do not clear old unknown guards on that basis.
3. Rendered browser acceptance for current-candidate flows, actual deployment
   roles/Hyperdrive, Redis revocation semantics, real provider verification,
   Linux/workerd/CI and coordinated migration/API/Admin release.

No production DB/R2/cache/image writes, stage, commit, push or deployment.
Original nine staged files remain preserved. Checklist remains
**240 checked /164 open /404**; the full migration goal remains active.

## Admin v3 client follow-up (2026-09-15, local only)

`view/admin-ts/src/utils/refundOperation.ts` persists original decision fields,
administrator ID, refund ID and UUIDv4 key in `admin-refund-intent-v3:<actor>:<refund>`.
The exact request body is reconstructed from those copied fields, never the
newly loaded business row. Canonical SHA256 matches the server, including empty
reason and integer-cent normalization; reads verify that hash before accepting
stored evidence. No session token/password is stored in the operation.

The actual RefundList/API now use execute/receipt/abandon. Credentials and actor
scope are captured before asynchronous verification; A->B->A invalidations are
sticky. The original entity Web Lock, storage compare-and-swap, readback and
retained tombstones remain in use. Returned receipts must match actor, original
key/hash, refund ID, action and allowed outcome. Execution must agree with that
outcome. Null lookup never releases the guard; provider admission stays pending
until an explicit same-key execution returns valid SUCCESS. Abandonment which
returns existing admission is not cancellation. A bound terminal receipt can
resolve even when mutable business detail is unavailable, but a new decision
still requires freshly readable/actionable detail.

The page exposes query, explicit original-key retry, explicit abandonment with
confirmation, and an ID entry for recovery when a row no longer appears in the
list. Page reload only reads data; no automatic execution/fallback legacy POST.
Old v1 and all v2 markers, including historical v2 "resolved" markers, remain
unchanged and block new decisions. Those old markers used mutable business
readback, not durable admission proof; no automatic upgrade/fence/cleanup is
safe. The developer preview is explicitly read-only to avoid fabricating
durable receipts in a real storage namespace.

Executed final local evidence:

- Three suites,89 passed/0 skipped: actual compiled SFC/API lifecycle49,
  v3 client/hash/receipt contract25, legacy v2 parser/lock regression15.
  Initial A->B->A test timed out after the new async storage boundary because
  its intended old request had not dispatched; the fixture now waits for that
  boundary before switching, preserving the stale-response assertion.
- Worker unit typecheck and Admin `vue-tsc -b && vite build` passed. Build still
  emits two pre-existing VueUse PURE-annotation warnings. No dependencies changed.
- Playwright1.62.1 with installed Edge153.0.4234.32, real Vite Admin page at
  `http://127.0.0.1:5175/refund`,1440x1000 and390x844. The named legacy Browser
  plugin/`browser` skill was not listed (`Browser plugin not available` under
  the frontend skill's routing definition); unified-browser inventory was
  readable, but this run used existing regular Playwright. No browser install.
- Synthetic HTTP responses only: same-key execute -> lost response -> reload ->
  receipt -> attempted abandonment returns admission -> explicit retry SUCCESS;
  separate execute -> unaccepted/unknown -> null lookup stays blocked -> permanent
  abandonment -> freshly confirmed new key. Eight operation requests total,
  exact original keys and body hashes asserted; mobile refusal cancellation
  produces no ninth request. This is not a real provider, HTTP controller or SQL
  browser integration test. No production connection or financial writes.
- Final rendered checks passed: expected URL/title, meaningful DOM, no framework
  overlay, no console warning/error, no failed resource or unexpected external
  request. Desktop pending-admission and mobile confirmed-return/actions screenshots
  were visually inspected. Initial harness issues (missing bundled Chromium,
  stripped Edge channel environment, missing synthetic site_config, hidden native
  checkbox locator, duplicate toast/alert locator and transitional screenshot)
  were corrected before the final run; no forced clicks or test gate removals.

Frontend-testing skill required the rendered loop and kept the temporary harness
and screenshots outside the repository, under an owned system-temp directory.
Each final script run closes its owned browser in `finally`. User confirmation of
new images is unchanged; this increment performs no image/cache maintenance.
Production runtime roles/Hyperdrive, real providers, Redis logout semantics,
legacy-client retirement, Linux/workerd/CI and coordinated release remain open.
No staging, commit, push or deployment; original nine staged files preserved.

## Joined Admin / HTTP / native SQL acceptance (2026-09-15)

The previous mocked browser transport is now supplemented by a repeatable,
explicit opt-in workflow. `vitest.admin-refund-browser.config.ts` selects only
`test/browser/admin-refund-operation.acceptance.ts`; it is not a skipped browser
case inside ordinary unit/CI tests. The portable runner accepts the fixed
`audit:admin-refund-browser` command only outside schema-maintenance mode and
requires existing absolute browser package/executable/output paths. No browser
dependency was installed. Browser output must be outside the checkout.

The workflow now also includes proactive creation/quote and original-creation
recovery. The counts and prior decision-only run below are historical; see
[the latest creation frontend and joined acceptance](admin-refund-creation.md#admin-confirmation-and-joined-browser-acceptance-latest-2026-09-15)
for the extended source, nullable-receipt-time fix, final150 ordinary tests plus
one joined browser test, nine SQL checkpoints and current cleanup evidence.

The actual Vite Admin page calls its real Axios API through a loopback HTTP
bridge into `createApp()` with the existing CORS/cache/auth/permission/controller
and refund service graph. Only `createContainer` is redirected to the freshly
created test-owned SQL container; JWT verification and SQL authorization are
not replaced. The manager has a real synthetic level1/role2 SQL identity with
`refund.view,refund.manage`, not super-admin UI bypass. Fixture session tokens
travel over parent/child IPC, not URLs, arguments or artifact files; the child
environment is stripped to Windows runtime/path/temp essentials. Only the shell's
site-config/todo endpoints are synthetic responses. Refund reads and ordinary
operation responses come from the real application.

Native PostgreSQL16.15 runs as `finance_test`, NOSUPERUSER/NOCREATEROLE in a new
database. Final runs use the canonical receipt DDL, including composite primary
key, four CHECK constraints and history index, not the generic fixture's
column-only projection. Other business tables remain scoped fixture projections;
this does not replace the nine-path complete catalog audit or the guarded public
installer. This role owns its test tables and is not a production least-privilege
runtime-role proof. No Hyperdrive, Redis, workerd, real payment gateway or production
database is involved. Unconfigured fetch and Alipay operations fail the test.

### Observed flows and invariants

1. Balance refund28: the real HTTP response is fetched after SQL settlement and
   deliberately dropped before reaching the browser. The page persists pending
   state. SQL verifies wallet +5.00, exactly one refund bill, product and SKU stock
   +1 each. The fixture then removes its refund/order rows. Reload and the ID
   recovery entry read the durable receipt and resolve without another execute
   request, despite the expected missing-detail error.
2. Provider refund29: a simulated lost gateway response leaves real SQL UNKNOWN
   and a durable provider-admitted receipt. Lookup and attempted abandonment do
   not query/cancel the provider or resolve the guard. Explicit original-key/body
   retry performs one query of `CNSR29` for500 cents, then the real finalizer
   settles synthetic SUCCESS. Total provider calls: one request, one query.
3. Return approval35: the bridge captures an original request before admission
   and reports503. Null receipt lookup keeps new decisions disabled. Real
   abandonment commits its fence; only then is the captured original packet
   passed into the real app. It returns abandoned/replayed with no status write.
   A new, explicitly confirmed key subsequently approves return exactly once.
4. At the final SQL checkpoint there are four receipts (balance-settled,
   provider-admitted, abandoned and return-approved), one balance-refund bill,
   wallet5.00 and one approval status for35. Mobile refusal confirmation/cancel
   sends no additional operation. Browser transport records ten operation
   requests; the deliberately retained late packet is one additional internal
   real-app execution, explicitly excluded from that browser-request count.

### Final evidence and reproduction

- One multi-checkpoint joined browser/SQL acceptance passed; four ordinary
  regression suites passed103 cases/0 skipped (SFC/API49, v3 client25, v2 parser15,
  CLI boundary14). Counted once each: five files104 tests, not a full repository run.
- Worker unit/runtime typechecks and driver syntax check passed. No frontend
  implementation changed in this increment; its previous production build is
  recorded above, not claimed as a new build here.
- Edge153.0.4234.32 / Playwright1.62.1, actual final URL
  `http://127.0.0.1:5173/refund`,1440x1000 and390x844. Page title/meaningful DOM,
  absence of framework overlay, screenshots, receipt-recovery and mobile cancel
  interactions passed. Two console errors are expected fault injections (dropped
  response and deliberate503); unexpected errors/warnings/external requests:0.
- The final five SQL checkpoints reported receipt counts1,2,2,3,4. Desktop
  missing-detail recovery, provider admission, mobile result/actions screenshots
  and `joined-browser-result.json` are retained in the owned system-temp directory
  `cinashop-refund-joined-7eea296a2bcc4b869d18a9010b707600`, outside the repository.
  Screenshots were visually inspected after the final run.
- The first run used projected receipt columns and passed before strengthening
  the DDL. Initial unit types rejected the environment object's augmented
  ProcessEnv shape and unsupported ForkOptions.windowsHide; both were corrected
  without casts/suppressions. Earlier suppressed test-console output was also
  fixed so final checkpoints are directly visible. Earlier runs are not added
  to the final test count or substituted for final-source evidence.

Set process-local `TEST_BROWSER_PACKAGE_JSON` to the existing Playwright
`package.json`, `TEST_BROWSER_EXECUTABLE` to the installed browser executable,
and `TEST_BROWSER_OUTPUT_DIR` to an owned existing directory outside the repo.
Then, from workers-ts:

```text
node scripts/run-local-finance-postgres.mjs <trusted-pg16-bin-dir> audit:admin-refund-browser
npm run test:unit -- test/local-finance-postgres-runner.test.ts test/admin-refund-frontend.test.ts test/admin-refund-operation-client.test.ts test/admin-refund-intent.test.ts
npm run typecheck:unit
npm run typecheck:runtime
```

The frontend skill required rendered proof and external artifact storage; the
legacy Browser plugin/`browser` skill is still not listed, so existing regular
Playwright was used (`Browser plugin not available` under that skill's routing
definition). The Workers skill guided the bounded bridge, awaited work and
credential isolation. Current [Workers guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
was retrieved; latest types metadata failed with socket EACCES, so installed
5.20260828.1 definitions and local Wrangler schema/config were inspected. No
production binding or dependency configuration changed.

All three owned clusters (znQDPd, BInOzp,0oPwzL) reported fixture databases/roles
cleaned. Independent pg_ctl checks returned3, with no postmaster PID/bootstrap
password files. No owned PostgreSQL, driver or Playwright process remained;
frontend5173 and PostgreSQL61240/63281/51701 ports refused connections. Stopped
cluster diagnostics are retained in ignored `.cache`; no system service or user
environment was installed/changed. No production/image/cache writes, staging,
commit, push or deployment. Original nine staged files remain; checklist stays
**240 checked /164 open /404**. Next gates are legacy-client retirement and the
remaining platform/provider/production release requirements, not another mocked
browser-only acceptance run.
