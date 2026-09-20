# Legacy Admin refund retirement candidate

2026-09-15. Local candidate only, **not deployed**. This is an intentional
availability change, not proof of PHP feature parity or a production cutover.
See [the versioned operation contract](admin-refund-operation-http.md).
The [proactive creation service candidate](admin-refund-creation.md) now supplies
local durable creation/financial composition, versioned quote/create/execute/
receipt/abandon HTTP, guarded schema registration and local Admin confirmation/
recovery with joined browser/SQL evidence. Physical split parity and production
activation remain unfinished. It does not translate,
redirect or revive these old URLs.

## Exact boundary and callers

Seven currently registered POST routes share the same retirement handler:

| URL | Previous operation | Replacement status |
| --- | --- | --- |
| `/adminapi/refund/refund/:id` | Reviewed return approval or funds refund | v3 Admin original-operation execute |
| `/adminapi/refund/refuse/:id` | Reviewed refusal | v3 Admin original-operation execute |
| `/api/admin/refund/agree/:id` | Alias of reviewed approval/refund | Same versioned protocol |
| `/api/admin/refund/refuse/:id` | Alias of reviewed refusal | Same versioned protocol |
| `/api/admin/order/refund` | Embedded Admin decision by public number; may create a proactive refund | Existing-application decisions use v3; separate proactive HTTP is a local candidate, not old-body translation |
| `/api/admin/order/refund_agree/:id` | Embedded Admin return approval | Requires a fresh explicit review through v3, not ID-only translation |
| `/api/admin/order/open/refund/:id` | Proactive whole/split refund | Local creation HTTP candidate only; UI/physical split/rollout pending, legacy URL remains unavailable |

`routes/index.ts` mounts v1 directly at `/api`, not `/api/v1`. There are no
automatic extra v1 aliases. Unregistered legacy PHP GET/PUT spellings retain
their existing not-found/unavailable behavior and must not be rewritten to POST.
In particular, PHP Admin `view/admin/src/api/order.js:148` is a **GET form
read**, not a caller of the retired POST. Its old order-table approval at
`view/admin/src/pages/order/orderList/components/tableList.vue:1577` uses GET
`/refund/agree/:id`, which was not an executable Workers route.

The sibling PHP source's `view/uniapp/api/admin.js:118,427,681` calls the three
embedded Admin POST URLs above. Its `/store/...` calls are a different authority
domain. In current TypeScript frontends, only the unused exports
`apiAdminRefundAgree` / `apiAdminRefundRefuse` still referenced the retired
reviewed POSTs; they have been removed. RefundList already uses
`apiAdminRefundOperation`, never falls back, and preserves all v1/v2 markers.
No PHP source, archived compiled bundle or supplier/customer-service client was
rewritten. No traffic inventory of external clients has been obtained.

The five historical controller exports also resolve to the retirement handler,
so another mount of those names cannot revive their old implementation. The
shared core and legacy mobile service remain for offline confirmation, existing
non-HTTP regression evidence and future explicit migration; their old refund
methods are no longer called from production Admin controllers. Supplier, Kefu,
Out API and customer application/cancellation workflows are unchanged. This
does not give their mutations an Admin receipt, or fence their independent work.

## HTTP behavior

- Existing real Admin authentication and `refund.manage` run before HTTP410.
  Missing/invalid/revoked sessions and read-only roles retain their authentication
  or permission error envelopes. No privilege is added by retirement.
- Cache-Control `private, no-store, max-age=0` and Pragma `no-cache` are set
  before auth, including errors; the app's default no-store policy remains.
- Authorized retired calls return actual HTTP410 plus
  `{status:410,msg:<upgrade/manual-review notice>,data:null}`. No Location,
  fabricated success receipt, inferred refund outcome, or automatic redirect.
- The handler does not inspect IDs, parse/await a body, hash a request, install
  a missing table, call a financial service or create a fence. Even a stalled
  or malformed body is irrelevant. Providing valid new headers/body does not
  upgrade a legacy URL.
- Explicit `*Unavailable` route handler names let the existing static parity
  audit classify registered PHP matches as unavailable, not executable. This
  is not a manifest removal or an excuse to reduce the PHP denominator.

## Old records are not recoverable through invented keys

An HTTP410 means only that this particular request reached this new handler.
It proves nothing about an earlier attempt or an invocation already running in
an old deployment. Old v1/v2 browser nonces were never written to the new ledger.
Never clear them based on a null lookup, a newly created abandonment fence,
the current business status, a fresh login, or a timeout. This includes old v2
`resolved` markers. Do not translate legacy mobile proactive fingerprints to
UUIDv4 keys. Do not delete or relabel prior payment/admission evidence.

For an unknown old operation, preserve the original actor, request and browser
record without copying credentials into reports. A separately authorized review
must establish the corresponding audit/payment outcome and exclude remaining
old senders before any new business decision. If the old operation cannot be
uniquely established, keep it blocked. Provider admission is not settlement and
cannot be undone by an Admin abandonment call. Callback/reconciliation processing
for already admitted payments must remain supported during maintenance.

## Required coordinated rollout (not executed)

1. Review the exact immutable release diff and all routes/clients in scope.
   Agree the maintenance window and the temporary loss of proactive/split
   refunds, or implement and verify their versioned replacement first. Preserve
   browser intents and durable receipts; export only authorized audit evidence.
2. Stop new Admin refund decisions at an independently enforced maintenance
   boundary covering custom domains, workers.dev, Pages proxies, direct URLs,
   alternate deployments and any PHP writer still targeting the same data.
   A banner, cache purge, closing a tab or token renewal is not that boundary.
3. Establish that old write-capable invocations/transactions and admitted
   provider operations are accounted for. A fixed sleep or zero sampled traffic
   is not proof. The new code cannot retroactively fence old invocations; the
   older mobile core also lacks the new actor/receipt checks. If quiescence or
   effective withdrawal of old write authority cannot be demonstrated, keep
   maintenance in force. Any database/provider authority intervention needs
   its own reviewed scope; none is performed by this candidate.
4. Run the existing guarded receipt installer and catalog/ACL checks with the
   approved maintenance role. Verify the production runtime can append/read
   but cannot update/delete receipts. HTTP handlers must never self-install.
5. Deploy the API with retirement enabled to every reachable writer route,
   without a mixed old/new traffic split for these mutations. Then deploy the
   matching v3 Admin. Verify denied/read-only identities, old-route rejection,
   same-key lookup/replay/fence, no-store and documented provider behavior on
   the actual production roles/Redis/Hyperdrive/runtime. Test writes require
   separately scoped approved fixtures; no real refunds by default.
6. Reopen only the verified supported workflow. Keep unresolved old markers
   and unavailable proactive/split routes blocked. Monitor meaningful failures
   without logging tokens, full customer payloads or original keys in URLs.

Rollback must preserve the receipt schema/rows and keep old mutation ingress
closed. Rolling back to an arbitrary pre-receipt Worker would re-enable unkeyed
writes; use a reviewed compatible rollback build or remain in maintenance.
Neither migration rollback nor deleting browser storage is a recovery strategy.

## Validation scope

The dedicated `admin-refund-retirement.test.ts` uses the assembled app and
native isolated PostgreSQL, canonical receipt DDL, real JWT/role checks and
forbidden financial/provider calls. It asserts the exact seven mounts, all
legacy bodies, keyed requests, auth failures, malformed/stalled bodies and
missing ledger, alternate methods/path spellings, preserved read routes and a
late packet reaching the new deployment after a versioned fence. It does not
simulate killing an invocation already running old code.

Existing decision/evidence tests now use the real versioned HTTP controller
and receipt DDL instead of obsolete legacy success expectations. They retain
post-auth actor/role/menu/expiry changes, decision/amount/stage checks, no-money
return/refusal invariants and real provider-admission persistence. Provider
transport is synthetic; SQL writes and decision locks are real. Direct shared
core concurrency tests remain, not replaced by mere HTTP410 assertions.

Production role/Hyperdrive/Redis/provider acceptance, platform runtime/Linux/CI,
external client inventory, proactive/split replacement and the coordinated
release are still open. No production write, image/cache change or deployment
was performed. Checklist stays **240 checked /164 open /404**.

### Executed evidence

- Final native PostgreSQL16.15 run: seven files,111 passed/zero skipped.
  Retirement13, reviewed decision29, evidence20, actual HTTP31, independent
  backend locks8, embedded Admin migration5, frontend API contract5. New local
  clusters use `finance_test` NOSUPERUSER/NOCREATEROLE, not production authority.
- Frontend regression run: five files,99 passed/zero skipped. Of these, the two
  five-case migration/API suites overlap the native batch. Count each suite
  once: **ten files,200 tests**, not210 and not a full repository run. The unique
  frontend suites are actual compiled SFC/API49, v3 protocol25 and legacy intent15.
- Worker unit/runtime typechecks and Admin production build passed. A direct
  typecheck first exhausted Node's default2GiB heap; rerunning with the project's
  existing4GiB script setting passed. Two pre-existing VueUse PURE annotation
  warnings remain. No dependency or deployment configuration was changed.
- The first native batch had two fixture failures: an empty credential was
  encoded as malformed `Bearer ` instead of genuinely absent, and the simulated
  reviewed return state did not match SQL. After fixing these, a second run
  exposed the test's incorrect assumption that a lost gateway response yields
  PROCESSING success. The evidence test now explicitly models PROCESSING and
  verifies receipt persistence on a later core error. The existing actual HTTP
  UNKNOWN/lookup/original-key recovery test remains unchanged and passed. No
  authentication, state, receipt or rollback assertion was relaxed.
- Static route audit succeeded against the sibling PHP source:1904 PHP routes,
  882 matched,861 executable matches,21 unavailable; the three matching embedded
  refund routes are explicitly unavailable. The other four retired POSTs are
  Workers aliases, not exact PHP method/path matches. Static percentages are not
  the404-item migration checklist or a functional completion measurement.
- All three owned clusters (`8USuR4`, `a55QJc`, `IEG7L0`) reported zero fixture
  databases remaining and were independently checked: pg_ctl status3, no
  postmaster PID/password files, zero owned PostgreSQL processes. Diagnostic
  directories remain in ignored `.cache`; no service or user environment edit.
- Whitespace checks passed. Original nine staged files remain unchanged in the
  index. No stage, commit, push or deployment. No new rendered browser run is
  claimed; the preceding joined browser evidence is documented separately.

The Workers best-practices skill guided typed rejection, no-store before auth
and not consuming an unneeded/unbounded legacy body, following the retrieved
[official guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
The previously unavailable latest npm types retrieval used the installed
5.20260828.1 definitions and local Wrangler schema fallback; no config upgrade.
