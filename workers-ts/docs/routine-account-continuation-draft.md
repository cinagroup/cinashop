# Routine account continuation maintenance draft

`collectRoutineAccountContinuationDraft` consumes identity and payment rows
during the same complete, locked, repeatable-read, read-only inventory. It
returns the [identity diagnostic](routine-identity-continuation-draft.md),
payment classifications and their combined keyed commitment. Both component
`inventorySourceDigest` values refer to this inventory. It never combines a
finished identity report with a later payment read.

Run from `workers-ts` with an exclusively held maintenance PG16 LOGIN:

```text
ROUTINE_ACCOUNT_DRAFT_DATABASE_URL=<explicit maintenance PostgreSQL URL>
ROUTINE_ACCOUNT_DRAFT_FINGERPRINT_KEY=<independent random 32-byte lowercase hex key>
ROUTINE_ACCOUNT_DRAFT_AUTHENTICATOR=<authenticator of the stored signed records>
npm run audit:routine-account-continuation -- <database> <maintenance-login>
```

Supply actual values through the maintenance secret mechanism, never source,
shell history, logs or tickets. All three independent variables are mandatory;
there is no runtime `DATABASE_URL`, `APP_KEY`, current account or identity-CLI
fallback. The authenticator is limited to 4KiB UTF-8 and must differ from the
fingerprint key. It stays in the local decoder process and is not sent to SQL.
Remote URLs require full TLS verification. URL query parameters, fragments and
target-user/database mismatches are refused. The connection uses max one,
unprepared queries, bounded timeouts and default read-only mode. Do not share
the library's connection or install custom value transforms/network callbacks.

The complete [inventory](routine-ownership-inventory.md) retains its existing
source scope, actual LOGIN/database/OID checks, RLS bypass requirements, row
budgets, pre-snapshot relation locks and 30-second whole-operation deadline.
Payment classification selects only these nine named `ONLY public` heap roots:

| Sources | Interpretation |
| --- | --- |
| `routine_original_payment_evidence` | Durable original SUCCESS evidence |
| `routine_payment_account_policy`, `routine_payment_account_use` | Historical query/notify provenance |
| `store_order`, `user_recharge`, `other_order` | Current physical order fields |
| `routine_refund_account_policy` | Independent refund request/query/notify policies |
| `routine_shipping_account_policy` | Independent shipping upload policies |
| `routine_subscription_account_policy` | Independent subscription send/template policies |

Missing roots are listed. Same-named sources in other schemas, inherited
children and all other sources stay in the full inventory and unclassified
count. A selected payment partition root, wrong built-in column type or changed signed-record
layout refuses the entire diagnostic. Business order tables allow additional
columns; signed record tables require their exact reviewed field set. Selected
payment fields are bounded to 16,384 rows / 8MiB total, separately from the
identity component's cap. Aggregate selected-field overflow, timeout and unsupported source drift return
no successful prefix. The full inventory fingerprints untouched server JSON,
`xmin` and `ctid`; payment price comparisons preserve exact PostgreSQL numeric
tokens with Node 24 JSON source context and integer cents, without float rounding.
Real signed-query sidecars may be compressed. The inventory's finite
[named-column CHECK proof](routine-ownership-inventory.md#resource-and-output-boundaries)
admits their bounded text only after exact actual catalog verification, without
rewriting storage or evidence. Unknown compressed JSON remains refused.

## Separate facts, no activation decision

`originals.authenticity=verified_success` authenticates the provider observation
and durable record with existing runtime decoders. It does not assert current
order binding, paid settlement, identity adoption or present authorization.
Captured `bound.local.paid=0` remains valid. The current physical state separately
reports `unpaid_match` or `paid_match`; the latter requires WeChat payment and
the exact transaction ID. Missing/changed amount, buyer, transaction, duplicate
order numbers across all three domains, child store orders and unsupported
member types are explicit failures to match. Soft-deleted history is preserved
with an inactive flag. The payer may differ from the buyer and is never used
to reassign that buyer's current identity binding.

Related evidence includes every row sharing the order number **or** transaction
ID. Conflicting facts, invalid related rows and the runtime 64-row / 1MiB
capacity are separate states; no row-order preference selects a winner. Local
`has_authenticated_original` means that some authentic evidence with that
number exists, without asserting its binding or eligibility. Invalid evidence
and physical historical orders without evidence remain visible.

Each approved-use row is independently authenticated, linked to the original's
facts/source/source ID, and compared with its exact saved account/query journals.
`scopeMatches=false` is an authenticated, non-authorizing sidecar, not a bad MAC.
Missing/corrupt saved journals or incomplete policy histories produce unresolved
provenance. Zero approved-use rows remain `none_recorded`, including valid v1
records predating the optional addon. Namespace presence alone cannot prove a
sidecar was mandatory for that original.
Each policy history and each original's use set also retains the runtime
64-row / 1MiB bounds. Oversized histories become `over_runtime_capacity`, and
oversized use sets produce unresolved provenance within a complete diagnostic;
these local states differ from whole-inventory retention failure.

Policies expose independent authenticity, contiguous revision history,
latest-record, active/revoked state and validity interval at database snapshot
time. Expected signed scope comes from the actual database name/OID and the
actual owner name/OID of each policy table in that snapshot, never from the
payload's claimed owner. Query `accountRevisionReference=matched` means the
exact referenced account revision exists and authenticates; the account's own
chain, latest state and interval are separate fields. It is not query admission.
Later revocation does not erase an accepted SUCCESS or invalidate its original
historical authorization at `issuedAt`. Credential registry, credential
availability and provider state are not read or evaluated.

Refund, shipping and subscription journals retain their independent byte
domains, account subjects and purposes. Query/notify policies confer none of
these purposes. Shipping subjects bind AppID plus merchant; subscription
subjects bind AppID, with a separately validated unique sorted template list.
`templateCount` does not prove a current provider template or receiver exists.
Pure decoder extraction preserves fixed HMAC domains, exception behavior and
durable time checks. Fresh ingress clocks, SQL catalog/LOGIN gates, registry
reads, signing and Symbol/WeakMap capabilities remain in runtime services.

The report includes catalog names/OIDs/owners, counts, state labels and keyed
record/account/credential-reference/order/buyer commitments. It contains no raw
AppID, merchant ID, UID, order number, payer, credential reference, signature,
provider document, user entitlement or secret. It is an operator diagnostic.
Wrong authenticators and corrupt signatures both appear invalid, without
guessing which occurred. SQL/CLI failures are redacted.

`activationAllowed`, `permitIssued`, `switchCommissioned`,
`refundRequestAuthorized`, `shippingUploadAuthorized` and
`subscriptionSendAuthorized` are always false. Exit zero means the complete
diagnostic ran. Catalog commissioning, credentials, external work closure,
provider state, dispatch/results and cross-component identity attribution are
not established. This snapshot is not a writer fence: state can change after
it ends. No configuration, user, entitlement, order, evidence, grant or policy
is written; no provider, Redis, SMS or Queue is consulted. Full maintenance
manifest/consumer closure, a one-use permit and atomic switch/receipt recovery
remain necessary. The material AppID switch barrier remains closed.

## Local phase58 verification

The local acceptance covers the following current-source cohorts:

| Cohort | Accepted cases | Execution boundary |
| --- | ---: | --- |
| Approved account | 18 | 17 unchanged passes from check-05 plus the corrected literal case in check-06; no final whole-file rerun |
| Combined identity/payment checkout | 3 | Whole file, actual five-LOGIN PG16 fixture |
| Original payment evidence | 13 | Whole file |
| Refund, shipping and subscription policies | 30 | Three whole files |
| Existing inventory and identity | 34 | Two whole files, including existing exact fingerprint assertions |
| Pure codecs, classifier and three CLI rejection files | 112 | Five whole files |

This is 98 accepted PG cases plus 112 pure cases. Unselected literal cases and
intermediate duplicate passes are not added. The final pure batch and both
complete Worker unit/runtime type configurations passed in 420.98
seconds. All accepted PG runs have frozen-input, zero-fixture and owned-cluster
stop evidence. The final batches share 8,625 unchanged worktree inputs; each
batch also pins its driver, Node and three PG tools. Documentation was finalized
after these runs; the 23 exact proposed commit files are separately scanned and
checked against staged/committed bytes. Per-case reuse and raw logs are retained
locally in `.cache/php-ts-phase58-validation`.

The new combined fixture executes actual Admin checkout, signed RSA/AES payment
callbacks, App LOGIN identity services, maintenance reads and an independent
peer's committed DML. Provider/cache transports are controlled fixtures; phone
continuity uses server-verified fixture input. The new CLI's 19 child-process
cases cover early refusal, empty stdout and redacted stderr, without a positive
database-CLI or remote TLS acceptance claim. Its collector is exercised against
actual PG16. No live WeChat, browser, Workerd, Hyperdrive or production-scale
acceptance is implied.

Failed runs remain part of the evidence: initial new-test TS18046 errors;
check-03's 600-second combined-command timeout, followed by an exact owned PG
stop/status 3 without observed fixture-zero; check-04's causal reproduction of
an actual compressed pglz use being refused by the old reader; and check-05's
one incorrect new expected bound state for the runtime writer's intentional
`unresolved/order_ambiguous`. Check-06's native literal run passed with one
selected case and 17 unselected cases, but its harness falsely required
`failed==skipped==17`. The raw false result is retained. The corrected literal
result and 17 unchanged prior cases were reviewed separately; the checkout
stage that this harness never ran was completed by whole-file check-07.
Cross-review is read-only source/evidence review, not an independent rerun or
security audit.

These results establish a bounded local diagnostic, not the complete
maintenance manifest or an atomic switch. Remaining unclassified relations,
external dispatch/results, provider/credential availability, one-use permit and
switch recovery still require their own contracts. The user's remote-operation
deferral remains effective; no remote operation or deployment was performed,
and new-SHA cloud CI remains unverified.
