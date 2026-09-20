# Admin proactive refund creation candidate

2026-09-15. Local candidate: versioned quote, create/execute/receipt/abandon
HTTP, guarded creation-table registration and the Admin confirmation/recovery
surface are implemented locally. A joined rendered-browser/HTTP/native-SQL
acceptance now covers proactive creation as well as existing-refund decisions.
The subsequent [quantity reservation increment](refund-quantity-reservation.md)
adds application-time holds, cancellation/refusal release and no-double-count
settlement for marked applications; its local tests are recorded separately.
The later [line-based refund quotation](refund-line-finance.md) corrects modern
freight allocation and preserves completed-claim residues; actual Admin quote
and immutable creation receipt coverage is recorded there, without a new UI or
protocol version. Existing admitted requests are not re-priced on recovery.
**Physical split/refund parity, production migration, deployment and live
payment acceptance remain unfinished**.
This does not close the proactive/split-refund PHP migration item or make the
[retired legacy URLs](admin-refund-legacy-retirement.md) executable again.

## Source contract and intentional boundaries

The sibling PHP repository supplies the behavior reference, not historical data:

- `app/controller/api/admin/order/StoreOrder.php:898` accepts a manual cash
  amount and optional explicit `cart_id`/`cart_num` selection, then creates
  `apply_type=4` and executes it. Its one-second cache marker is not durable
  operation evidence. Its success-time refund-record deletion is not reproduced.
- `app/services/order/StoreOrderRefundServices.php:267` checks active refunds,
  the configured after-sale window, ownership/support/quantity, and the selected
  cash maximum. It allows the requested amount below that maximum and copies
  both store and supplier ownership. PHP stores the requested and maximum
  amounts separately and reserves cart quantities during application.
- The same service's `agreeSplitRefundOrder` at line697 calls `equalSplit`,
  updates physical child orders and repoints refund associations. A quantity
  snapshot on the original TypeScript order is **not** equivalent to that flow.

The candidate supplies the missing durable **creation** stage. Existing
[versioned financial operations](admin-refund-operation-http.md) identify an
already-created refund and cannot alone prove which refund a lost creation
request produced.

## Captured creation intent

`AdminRefundCreationProtocol.ts` validates and copies all values before any
asynchronous work. Unknown fields are rejected. The exact body is:

```ts
{
  version: 'admin-refund-creation-v1',
  review: {
    id, orderId, uid, storeId, supplierId, payPrice,
    totalNum, status, refundPrice, payType
  },
  mode: 'remaining' | 'items',
  items: [{ cartId, cartNum }],
  quotedPrice: '5.00',
  refundPrice: '3.00',
  reason: 'Explicitly reviewed reason',
  quoteFingerprint: '<64 lowercase hex characters from the current quote>'
}
```

Here `review.id` is the order primary key; `review.orderId` is its public
number; `review.refundPrice` is the order's cumulative refunded amount. The
top-level `quotedPrice` is the selected-goods maximum and `refundPrice` is the
actual amount explicitly requested. Money uses canonical two-decimal strings.
`items` mode requires 1–100 unique canonical cart IDs and positive quantities;
`remaining` requires an empty list. Row-ID aliases and silent coercions are not
accepted. Item order is canonicalized before hashing.

The creation ledger uses `(admin_id, request_key)` as its primary key, with a
UUIDv4 key and a SHA-256 hash of the complete normalized body. The current Admin
identity comes from authenticated context, never from that body. Changed
reason, selection, amount, mode or reviewed order under the original key is a
conflict, not a new operation.

`quoteFingerprint` is now mandatory in this still-unpublished creation contract.
It binds the complete current order/cart/refund source snapshot, resolved
after-sale days and receipt time. Changing the same-price goods, receipt facts
or effective policy invalidates the old quote. It is a stale-review check, not
an authorization credential. Never retrofit this field into an old persisted
intent to claim it was the same reviewed request.

## Read-only quote HTTP

Both locally assembled routes use real Admin authentication and `refund.manage`:

- `POST /adminapi/refund/creation/quote`
- `POST /api/admin/refund/creation/quote`

Send `X-Refund-Operation-Scope: v1:admin:<current Admin ID>` and UTF-8 JSON.
The endpoint accepts at most 8 KiB, no compressed body, no query parameters and
no `Idempotency-Key`. It creates neither an operation key nor a reservation.
Private no-store/no-cache response headers are applied before authentication,
including error responses.

```ts
{
  version: 'admin-refund-creation-quote-v1',
  orderId: 123, // order primary key, not the public order number
  mode: 'items',
  items: [{ cartId: 456, cartNum: 1 }]
}
```

Use `mode:'remaining', items:[]` to review all remaining goods. The response
contains only the allowlisted `review`, mode, actual selected items and quantity,
cash maximum, effective after-sale days, receipt time and source fingerprint.
It does not expose raw order/cart snapshots, credentials, refund IDs or receipts.
For a subsequent remaining-mode creation intent, retain `items:[]` and the
returned fingerprint; the shown concrete items are bound by the source hash,
not silently copied into a different selection mode.

The quote and creation both execute the same locked eligibility/quantity/price
preparation. The quote returns **before any INSERT/UPDATE**; it does not create
then roll back an application or consume an ID sequence. It works without a
creation ledger installed. Source cart rows are limited to 100 and their total
JSON byte length to 1 MiB before loading the full snapshots. The HTTP route has
no financial side effects. Creation/recovery use the separate endpoints below;
a keyless quote body is never translated into an operation.

## Versioned creation and recovery HTTP

The same router is mounted at `/adminapi/refund/creation` and
`/api/admin/refund/creation`. All four POST endpoints below require real Admin
authentication, `refund.manage`, `X-Refund-Operation-Scope: v1:admin:<ID>` and the
**original** UUIDv4 `Idempotency-Key` header. Keys never appear in URLs or body
fields. Scope is only a precondition; the authenticated SQL identity supplies
authority, rechecked after body reads and within each business phase.

| Suffix | Exact body | Effect / evidence |
| --- | --- | --- |
| `/create` | Full creation intent above, at most 8 KiB | SQL-only application and creation receipt; no funds/provider call |
| `/execute` | The same full original intent, at most 8 KiB | Commit creation, then independently admit/settle the financial operation |
| `/receipt` | `{version:'admin-refund-creation-v1'}`, at most 512 bytes | Read current owner's creation receipt only; no financial dispatch |
| `/abandon` | The same full original intent, at most 8 KiB | Fence an uncreated original key; an existing created receipt wins unchanged |

Transport is UTF-8 JSON with no compression or query parameters. Byte limits
apply to the actual stream even with a false small Content-Length. Invalid
UTF-8, legacy fields, body-provided authority, missing/changed scope and keys,
unknown versions and fields are refused. Error responses are no-store;
route-level Cache-Control/Pragma run before authentication. GET/HEAD/PUT/DELETE
do not dispatch these actions. Existing CORS only advertises allowed origins;
it is not server-side authorization for clients which already hold a token.

Successful responses retain the usual `{status:200,msg,data}` envelope. Shapes
below are notation, not request bodies:

```text
// create
data = {version:'admin-refund-creation-v1',receipt,replayed};
// receipt and abandon
data = {version:'admin-refund-creation-v1',receipt};
// execute
data = {
  version:'admin-refund-creation-v1',
  creation:{receipt,replayed},
  operation:null | {receipt:financialReceipt,replayed,execution:null | {completed,status}}
};
```

A created receipt records an application, not payment success. The execution's
`operation` is null when creation was already abandoned. A provider-admitted
receipt is not settlement; check the separate execution result. Financial and
creation receipts have different request hashes and protocol domains even
though execution deliberately reuses the original Admin/UUID and refund ID.
No raw customer/cart/reason/auth data is added to these responses.

An execute error or lost response can occur **after creation committed**, or
after provider admission. Do not infer whole-operation rollback, replace the
key/body, requote an unknown original request, or retry a legacy URL. Read the
original creation receipt; if created, financial evidence can separately be
read through the existing `/refund/operations/receipt` alias using its own
`admin-refund-operation-v1` body and the same original key/scope. That lookup
does not query a provider. Only explicit original `/execute` recovery may
resume financial processing; provider leases prevent an in-flight duplicate
from issuing a second request.

A null creation lookup does not fence a delayed create. Explicit abandonment
can fence an uncreated original key. If creation already committed, abandonment
cannot cancel its application, stop admitted payment, or claim no money moved.
Missing schema fails closed without self-installation. In particular, if the
financial ledger is missing after creation, the created receipt remains
recoverable; it must not be erased to conceal incomplete installation.

## Current after-sale policy

Both quote and new creation read `refund_time_available` directly from SQL
**after acquiring the order lock**, never from CONFIG_KV. Global `is_store=0`
and the existing `SystemConfigDao` precedence (`sort DESC, id DESC`) are used;
store configuration cannot override it. Missing or explicitly blank values
mean zero/unlimited, as in the existing PHP/default behavior. JSON string
scalars are normalized. Invalid, fractional, negative or over-36500-day values
fail closed rather than becoming zero.

The selected configuration row is SHARE/NOWAIT locked to avoid waiting in an
order/config writer cycle. Configuration changes committed before a pending
quote acquires its order lock are observed when it resumes. The latest
`user_take_delivery`/`take_delivery` timestamp determines the inclusive deadline;
no receipt means no started deadline. At exactly `receivedAt + days*86400` the
request remains eligible; one second later it does not. Customer and automatic
refund entry points retain their existing policy resolver/default behavior.

An existing durable creation receipt is recovered before checking today's
policy. Policy changes or even malformed current configuration must not erase
evidence of an application which already committed. New admission still uses
the current configuration and source fingerprint. Other mutable facts may also
make a quote obsolete; the UI must preserve unknown original operations rather
than replacing their key with a freshly quoted request.

The application number is `AR` + base36 Admin ID + `_` + base64url UUID bytes.
It retains all identity bits and is at most 31 characters, fitting the existing
32-character `user_bill.link_id`; it is not a truncated hash. The external
provider number remains the financial executor's `CNSR<refundId>`.

## Commit and recovery rules

1. **Creation transaction:** lock/revalidate the current Admin and role;
   serialize the original creation key; lock the order; recheck current auth
   and the full reviewed order identity; recompute quantities and the cash
   maximum; reserve selected cart quantities and create the application, audit
   and creation receipt atomically.
   `storeId` and `supplierId` are copied from the locked order. No funds or
   external provider work occurs in this transaction.
2. **Financial operation:** only after the creation transaction commits,
   explicitly call the existing reviewed financial executor with that refund
   ID, the same original key and the captured actual amount. It reauthorizes
   independently. Balance settlement and its receipt commit together; provider
   admission commits before network I/O.
3. **Recovery:** the original key/body recovers the creation and then resumes
   its existing financial operation. A created application followed by a
   financial rejection or unknown result remains a created application, not
   evidence of rollback or permission to invent another key.

Both service entry points require a root database client; callers may not wrap
these phases in a transaction. SQL operations use transaction-local limits and
the consistent actor → key → order lock order. The separate creation advisory
namespace is 731609; the full primary key, not the advisory hash, determines
identity. There is no cache dependency, expiry, automatic DDL, or provider call
in receipt lookup or creation abandonment.

`lookupAdminRefundCreation` returns owner-only durable evidence without joining
mutable business rows. A null lookup does not prevent a delayed create.
`abandonAdminRefundCreation` can durably mark an uncreated original key as
abandoned. An already-created receipt wins unchanged: abandonment is **not**
application cancellation or payment cancellation. Missing or malformed ledger
state fails closed. A matching business number without its creation receipt is
an inconsistency; it is never adopted as proof of this request.

Deletion after terminal settlement does not erase either receipt. Deletion
after creation but before financial admission prevents new funds movement;
the creation receipt still accurately records what committed.

## Partial amount allocation

The shared creation core now accepts an explicit Admin requested cash amount
only with `applyType=4`, privileged Admin context and a locked authorization
callback. The existing expected amount still binds the **quote**, not the
discounted requested amount. Non-integral cash refunds must be positive and
cannot exceed that quote.

Example: a two-unit 10.00 order allocates 5.00 to each unit. Refunding the first
unit for 3.00 must not silently quote the second at 7.00. The remaining selected
goods quote is 5.00 and the final explicit cash total can therefore be 8.00.
Normal exact-amount allocation retains deterministic integer-cent tails.

Mandatory system whole-payment recovery is a different operation. The existing
`ensureAutomaticOrderRefund` path retains the remaining-payment target when
recovering outstanding quantities; it must not inherit the Admin selected-goods
quote cap. Combined activity/manual-discount behavior, including already fully
refunded quantities, still requires dedicated policy and lifecycle acceptance.

## Guarded creation-table registration

The canonical `admin_refund_creation` DDL is registered in external migration
`0156_admin_refund_creation.sql`, embedded step `0162` and the ORM export. The
external file and embedded SQL must be byte-equal. The standalone
`runAdminRefundCreation` is the bounded upgrade entry point for an existing
database; never replay historical `runAll` against an existing deployment just
to install this table. No request handler or startup hook self-installs it.

The installer uses an explicit root, read-write READ COMMITTED transaction,
public-only search path and PG16 catalog contract. Statement, lock and idle
limits are capped at 30s/1s/5s without relaxing tighter limits. Its separate
installation advisory namespace is 731610. Existing tables must match before
and after an ACCESS EXCLUSIVE NOWAIT lock. A busy table is refused; there is no
automatic retry, replacement, backfill, permission repair or data deletion.

Checks cover all seven columns, four CHECKs, the primary key and history index,
including nullable `refund_id`: created evidence needs a positive ID, while
abandoned evidence requires NULL. Exact types, defaults, collation, index and
constraint state are required. Extra/dropped columns, indexes, triggers, rules,
incoming FKs, RLS/policies, persistence/replica/storage drift, enabled DDL event
triggers and replica mode are rejected. Unsafe default grants roll back a new
installation. Both created and abandoned evidence survive repeat installation.

The catalog check requires the current maintenance owner; runtime needs only
schema USAGE and table SELECT/INSERT. No sequence exists for this receipt table.
Non-owner table/column grants outside SELECT/INSERT, PUBLIC grants and grantable
ACLs are refused, not repaired. A real isolated LOGIN verifies append/read,
same-key recovery and conflicts, plus PostgreSQL `42501` refusals for UPDATE,
DELETE, TRUNCATE, ALTER and recovery of the maintenance role. This is a direct
table/column ACL contract, not an audit of all production role memberships,
schema ownership or security-definer functions; those remain rollout gates.
See PostgreSQL's [privilege model](https://www.postgresql.org/docs/16/sql-grant.html)
and [NOWAIT locking](https://www.postgresql.org/docs/16/sql-lock.html).

All nine full-schema audit paths must already contain a compatible creation
table **before** any standalone repeat. Each path checks repeat OIDs and storage
files, then compares the complete five-category catalog. The candidate contract
is now 266 tables; the dated 263-table production snapshot is unchanged and is
not evidence that either refund receipt table exists in production.

## Activation gates still open

- Guarded registration and isolated runtime ACL verification are local code.
  Inspect actual production catalog, owner/default grants, role memberships and
  runtime privilege paths before a coordinated standalone installation. No
  production database, migration or role was changed by this candidate work.
- Versioned quote/create/execute/lookup/abandon HTTP and the confirmation/recovery
  frontend now exist locally. This is not a deployed contract. Coordinate the reviewed
  client and API release, with no legacy body-to-new-key translation or fallback.
- Configured after-sale policy is now wired for new creation and quotation.
  Deployed configuration, runtime permissions and concurrent configuration
  administration still need deployment-level acceptance.
- Audit PHP postage/change-price/rounding and maximum-versus-requested amount
  display, ordinary zero-cash orders, promotions, write-off and allocation
  boundaries. Pure-integral handling remains the existing core's special case,
  not acceptance of all zero-payment orders.
- Implement and test actual fulfillment/order splitting or explicitly resolve
  that migration requirement. Application-time quantity reservations now exist
  locally for marked applications; PHP split/full-refund counter redistribution
  remains open. Coordinate all writers/executors/callbacks to avoid old code
  incrementing a marked hold a second time during settlement.
- The local frontend now confirms quantity, maximum/requested cash and reason,
  persists original actor/key/body before dispatch, distinguishes creation from
  financial admission/settlement and protects session/multi-tab races. Existing
  v1/v2 decision markers are neither cleared nor upgraded. Cross-device/browser
  loss of local storage and legacy in-flight clients still require operational
  reconciliation; receipt lookup is not a global pending-operation search.
- The joined browser → real HTTP → PostgreSQL flow now passes locally. Exercise
  bounded production runtime permissions, deployed Hyperdrive freshness and
  actual provider callbacks in their own acceptance stages. Synthetic provider tests are not live
  WeChat/Alipay acceptance. Coordinate legacy in-flight work before rollout.

## Local verification

### Admin confirmation and joined browser acceptance (latest, 2026-09-15)

The `/refund` page now contains `RefundCreation.vue`, with an order-detail link
that supplies only the numeric order ID. Opening the panel reads local original
intent only; it never automatically quotes, creates or refunds. Order detail
also displays the canonical cart identifier used by the quote selector.

- Read all remaining goods, optionally change individual quantities, then obtain
  a fresh selected-goods quote. Quantity changes invalidate the displayed quote.
  Confirmation includes public order number and numeric ID, UID, cart IDs and
  quantities, maximum and requested cash, and reason. The panel also displays
  payment method, store/supplier ownership and already-refunded cash. Item names
  are not invented from numeric cart IDs; use order detail to cross-check them.
- Choose SQL-only creation or explicit creation-plus-financial execution. A
  created receipt is not settlement. Unknown, null lookup and provider-admitted
  states block a new intent; only bound terminal evidence releases that guard.
- `refundCreation.ts` owns the strict normalized body, creation hash, receipt
  binding, and the distinct composed financial hash. Unit tests compare both
  hashes and the AR application number with the actual server implementation.
  The original body is copied before hashing, stored before dispatch, and never
  replaced with a new quote during recovery. No token is persisted in this record.
- Storage key `admin-refund-creation-v1:<adminId>:<orderId>` retains a terminal
  tombstone. Reads reject over-32,768-character records, invalid shape/hash or
  storage changes while verifying. Writes use compare-and-swap plus read-back
  verification under the order Web Lock. Unsupported locking/storage fails
  closed; no fallback to automatic retries, new keys or legacy mutation URLs.
- Creation lookup and financial lookup are separate read-only actions. The
  latter derives the original existing-refund operation from the creation receipt
  and original body, never generates another nonce. Explicit recovery can run
  not-yet-admitted financial work or query the provider. Abandonment only fences
  an uncreated request and never claims to cancel an existing refund/payment.
- Session/route invalidation is sticky and clears the mounted surface; stale
  responses cannot repopulate it. Local records survive reload, transport loss
  and business-row deletion. Cross-tab changes invalidate stale confirmations.
  Existing decision v1/v2 markers remain untouched by this separate namespace.

Final ordinary regression: **6 files / 150 tests, zero failures or skips**,
52.44 seconds. Breakdown: creation client31, compiled actual Admin SFC/API60
(including11 new creation interactions), existing operation client25, legacy
intent15, frontend API contract5, local runner boundary14. Earlier102/116 batches
are not added again. Admin `vue-tsc -b`, production Vite build and Worker full
source/runtime-target typechecks pass. Vite reports two dependency PURE-comment
annotation warnings in `@vueuse/core`; no build failure or source suppression.

The existing opt-in `audit:admin-refund-browser` workflow was extended, not
replaced by a mocked frontend-only test. It runs actual Admin/Vite/Axios →
loopback HTTP → real `createApp` JWT/SQL authorization/controller/services →
new native PostgreSQL16.15, non-superuser `finance_test`. Both receipt tables
use their canonical DDL. Business tables remain isolated fixture projections,
not proof of the complete production catalog or runtime minimum privileges.

One **joined browser test** passed (31.94 seconds), including all prior decision
flows plus these new proactive-creation SQL checkpoints:

1. Order1: select one of two items (quote5.00), request3.00, then drop the real
   response after balance settlement. SQL verifies the wallet increased by3.00
   and exactly one additional balance bill. Delete the owned fixture's business
   rows; reload, creation lookup, then financial lookup recover terminal evidence
   with no second creation execute. Creation lookup alone stays pending.
2. Order2: retain its execute packet before admission and report503. A null
   lookup still blocks new creation. Commit abandonment, then deliver the actual
   retained packet; it returns abandoned/replayed with no refund application.
3. Order3: simulated WeChat response loss yields real UNKNOWN/payment admission.
   Read-only lookups do not query the provider. Explicit recovery reuses the exact
   original body/key and queries once, then settles synthetic SUCCESS. Including
   the prior refund29 scenario, total provider requests2 and queries2.
4. Order4: SQL-only creation remains pending across financial lookup and reload.
   Its financial receipt is absent and its application remains unexecuted.

There are14 creation-endpoint browser requests and13 existing-operation endpoint
requests (including three financial lookups for proactive creation). Two retained
packets are additional internal app executions, not browser requests. At the
final checkpoint: four creation receipts (three created/one abandoned), six
financial-operation receipts, two balance bills and wallet8.00 (5.00 from the
prior decision fixture plus3.00 from creation). Provider work is simulated; no
real WeChat/Alipay, production, Redis, Hyperdrive or workerd acceptance is claimed.

Browser: installed Edge153.0.4234.32 / Playwright1.62.1, URL
`http://127.0.0.1:5173/refund`,1440×1000 and390×844. Identity, meaningful content,
no framework overlay, original-key recovery interactions and screenshots pass.
Four console errors correspond to two deliberately dropped responses and two
deliberate503 faults; unexpected errors/warnings/external requests:0. Desktop
recovery and mobile pending-creation screenshots were visually inspected.
The frontend testing skill required this rendered loop and external evidence
storage. Its dedicated Browser skill was not listed, so existing Playwright was
used (`Browser plugin not available` under that routing definition), with no
dependency or browser installation.

The first joined run correctly failed: the client rejected the server's
`receivedAt:null` for an unreceived order. The parser now explicitly preserves
nullable receipt time; three regression cases cover null/zero/timestamp. No
server fact, fixture value, assertion or timeout was weakened to pass the UI.

Evidence is outside the repository in
`C:/Users/cina/AppData/Local/Temp/cinashop-creation-browser-d13bf3dd63d84161871c124c4739dda2`:
`joined-browser-result.json`, `joined-creation-recovered.png` and
`joined-creation-mobile.png`. The initial failure screenshot is retained there.
Both clusters (`finance-postgres-uT1HWp`, `finance-postgres-z4pSBv`) independently
report `pg_ctl status` exit3, with no PID/bootstrap-password files; trusted PG
runtime processes, browser drivers and used listener ports all count0. Browser
and Vite close are awaited by the driver. No production access, financial
transaction outside synthetic fixtures, image/cache edit, staging, commit, push
or deployment occurred. The migration checklist stays240 checked/164 open;
local UI acceptance does not close physical split/parity or production gates.

`test/admin-refund-creation.test.ts` executes actual application/ledger/financial
SQL against disposable fixtures. It covers manual amounts and quantities,
same-key replay/conflict/abandonment, current authorization, immutable input,
receipt-last-write rollback, committed-creation recovery, business deletion,
malformed/missing ledger, database PK/CHECK enforcement, and independent-backend
creation/abandon races and order-lock waits. Provider transport alone is mocked;
unconfigured network I/O is prohibited.

The prior creation-only revision's expanded batch reported 140 passed
and one fixture `beforeEach` timeout (30 seconds), across 10 files/141 cases.
The timeout occurred before the balance-payment rollback assertion in
`brokerage-paid-business-transactions.test.ts`; it is not recorded as a pass.
Both Worker typecheck commands passed. The entire timed-out file was then
retested independently without changing timeouts or assertions.

Independent rerun completed: **20/20 passed**, zero skips, in 91.75 seconds
on a fresh non-superuser PostgreSQL 16.15 fixture. Together with the unchanged
final batch, all **141 distinct cases across 10 files** have passed; 19 repeated
passing cases are not counted twice. The creation suite accounts for 30 cases.
The earlier 30-second fixture timeout remains part of the record; it was not
a business assertion failure and its root environmental cause is unproven.
No timeout, assertion, test configuration or privilege requirement was relaxed.
Those are historical results, not the result of the subsequent quote extension.

The quote extension adds `test/admin-refund-creation-quote.test.ts`, retaining
the actual app/route/auth/controller/SQL graph (only the database binding points
to the owned fixture). It checks both aliases, no business/sequence writes,
fresh SQL configuration versus stale KV, exact deadlines, same-price source
changes, original creation recovery, bounded inputs and independent-backend
order-lock waits. Its first run exposed a fixture mistake: the generic pricing
`setConfig` helper did not write the after-sale setting to SQL. Five related
tests failed; the fixture now performs explicit SQL inserts/updates instead.
Production validation and assertions were not loosened.

After that fixture correction, the expanded quote/creation/operation/retirement/
customer-after-sale batch passed **8 files, 136 tests, zero skips**, in 87.27
seconds. The new quote suite has 16 cases. Both owned clusters were independently
verified stopped (`pg_ctl status` exit3), with no PID or bootstrap-password file
and zero processes from the owned PostgreSQL runtime. This is real local HTTP
and SQL evidence, not a new browser run or deployed Hyperdrive/provider evidence.
No production/image/cache mutation, staging, commit, push or deployment occurred.
Both the Worker source and runtime-test TypeScript checks passed after the quote
extension; the shared source diff also passes `git diff --check`.

### Versioned HTTP verification (earlier HTTP phase, 2026-09-15)

The final native PostgreSQL 16.15 batch passed **5 files / 131 tests, zero
failures or skips**, in 99.45 seconds: creation HTTP41, quote16, creation
service30, existing financial-operation HTTP31 and legacy retirement13.
Earlier native batches passed 101 and 131 cases; repeated cases are not added
to the final distinct count. This is not a full repository regression run.

The new 41 cases use actual `createApp` Request/Response routing, JWT/role
checks, controllers and SQL services. Only the database binding is directed to
owned fixtures, and provider request/query transport is simulated. Independent
PG backends have separate environment-to-container bindings, so parallel HTTP
tests do not race a mutable current-container variable. Observed blocker PIDs
prove create/abandon ordering; duplicate executes produce one application,
one balance bill and one stock effect.

Coverage includes both aliases, SQL-only creation and durable abandonment,
same-key conflicts/replay, current-owner isolation, renewed tokens, all four
endpoints under post-auth disable/password/role/expiry changes, actual stream
limits/UTF-8/cancellation, unsupported methods and CORS preflight. Creation and
financial insertion failures prove their different rollback boundaries;
missing schema never self-installs. Both WeChat and Alipay UNKNOWN transport
retain committed creation/admission and query only on explicit original-key
execution. An in-flight duplicate observes the existing lease and no second
provider request. Business deletion and invalid current policy cannot erase
previously committed evidence. New stale source facts remain inadmissible.

The first Worker all-source typecheck found missing `unknown` JSON response
guards and `Response | Promise<Response>` handling in the new unit tests.
Runtime object/envelope validation and an async sender corrected these; no
`any`, double cast, type suppression, config change or assertion relaxation was
used. The runtime-target config excludes root unit tests, so its early pass
was not treated as a substitute. Both final source and runtime-target checks
passed, as did `git diff --check`; the final 131-case batch uses the corrected
test readers.

All three fresh non-superuser clusters were independently checked stopped
(`pg_ctl status` exit3), with no PID/bootstrap-password files and zero trusted
PostgreSQL runtime processes. These tests use Hono `app.request`, not a live
HTTP listener, rendered browser or deployed workerd/Hyperdrive/Redis session.
Full-application production minimum privileges and real provider callbacks are
still separate acceptance gates. No real refund, production/image/cache write,
staging, commit, push or deployment occurred.

The Workers/PostgreSQL skills guided bounded typed HTTP, no-store errors,
explicit actor context and keeping provider work outside creation transactions.
Source hashes and execution/cleanup evidence are in the
[HTTP candidate audit](../audit/admin-refund-creation-http-20260915.json).

### Earlier guarded registration verification (2026-09-15)

The subsequent registration work passed **9 files / 246 distinct tests, zero
skips**, across three batches, not a single full-repository run:

- Creation and operation migration/ACL suites: 90 tests (49 creation, 41
  existing operation), real PostgreSQL 16.15, 51.48 seconds.
- Offline registration, data-scope/schema and runner-boundary contracts:
  97 tests across four files, 2.13 seconds.
- Creation, quote and table-metadata regression: 59 tests across three files,
  42.75 seconds. Business tests use a non-superuser native PG16 identity; the
  table-only metadata gate also executes its PGlite fixture.

Initial failures are retained: the offline parser did not recognize the new
unquoted CREATE TABLE name (1/97 failed), and the new runtime test incorrectly
treated a `withTx` DbClient callback as a container (1/90 failed). The table name
now follows the quoted repository convention, and the test passes the actual
transaction. The complete affected batches passed again. No production
permission, assertion or timeout was weakened.

The independent nine-path native PG16 audit passed: **266 tables, 3,722 columns,
587 constraints, 1,026 indexes and 227 sequences**, identical across all paths.
Both refund receipt tables were complete before standalone repeats, which
preserved their OIDs/storage files. The full external path has 158 files,
embedded has 163 steps, and fresh ORM has 1,096 statements. Both TypeScript
checks and `git diff --check` passed. All four owned clusters, including the
initial failed run, were independently confirmed stopped (status exit3), with
no PID/bootstrap-password files and zero trusted-runtime processes.

The PostgreSQL/Workers skills guided owner/runtime separation, short bounded
transactions, and refusal on drift without automatic repair. No source/index
staging, commit, push, browser run, deployment or production/image/cache change
was performed. Full hashes, counts, failures and stop checks are in
[the machine-readable registration audit](../audit/admin-refund-creation-registration-20260915.json).

To repeat the schema-only maintenance checks on a **new local fixture**:

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/admin-refund-creation-migration.test.ts test/admin-refund-operation-migration.test.ts
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin audit:orm
```

Maintenance mode is limited to allowlisted schema/ACL suites and creates a new
local test superuser only for ownership/event-trigger/real-LOGIN probes. It does
not elevate an existing server or the non-superuser business-test identity.

The latest Workers types metadata fetch was denied by the local network policy;
the review used installed `@cloudflare/workers-types` 5.20260828.1 and the local
Wrangler schema without changing dependencies or compatibility settings.

Run using the already trusted local PostgreSQL 16 runtime from `workers-ts`:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/admin-refund-creation.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

The runner creates a new loopback-only cluster and non-superuser test identity,
checks fixture cleanup and stops its owned cluster. It does not use production
URLs, install a Windows service or persist environment changes. Test counts and
the final independently verified stop state belong in the migration audit;
earlier browser and production runs are not rerun by this command.
