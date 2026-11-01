# Historical Routine refund foundation

This phase adds explicit PG16 storage, maintenance refund-account approvals and a separately declared Financial permission upgrade. It does **not** enable historical-account refunds. The existing refund request/query/callback paths do not consume this protocol yet. Installation, a registry entry or an approval cannot send a refund, assign ownership or settle money. First-adoption and cross-AppID activation remain closed.

The three optional tables install atomically through `runRoutineRefundUpgrade`:

| Table | Purpose | App permissions | Financial addon permissions |
| --- | --- | --- | --- |
| `routine_refund_account_policy` | Owner-authenticated account revision journal | SELECT | SELECT |
| `routine_refund_dispatch` | Reserved immutable first CNSR dispatch | SELECT, INSERT | SELECT, INSERT |
| `routine_refund_provider_evidence` | Reserved immutable request/query/callback facts | SELECT, INSERT | SELECT, INSERT |

The latter two tables have no production writers or consumers in this phase. Their structural checks are storage checks, not authenticated provider evidence. Synthetic test rows do not prove a refund. The unique refund ID and exact `CNSR` plus decimal refund ID prevent multiple first dispatch rows; a future service must authenticate and pin the full original/order/actor/account/material intent before using one.

All three tables have maintenance ownership, no sequence/default/FK, bounded object payloads, exact canonical checks and indexes, and invoker triggers refusing UPDATE/DELETE/TRUNCATE. App cannot INSERT policy. Admin, Manager and Cashier receive no new grants. Runtime probes require the actual independently authenticated App or fixed Financial LOGIN, matching session/backend role OID, RC/RW PG16, public resolution and finite SQL timeouts. A missing entire namespace is optional; partial, orphan, drifted and owner-only unfinished commissioning refuses. No request installs or repairs it.

Maintenance installation retains the exact existing App/Admin profile and explicit local/case-lock/peer/App-reader declarations. It authenticates the maintenance database/LOGIN/backend and uses the independent `(731718,0)` gate. Complete repeat changes neither DDL/ACL nor rows. Caller rollback rolls installation back. The gate is distinct from the existing payment-account gate and ThemeSettings gate.

The Financial upgrade is a separate explicit forward operation, declared with `{routineRefund:true}` in its full current profile. It adds the three new-table grants above and SELECT on `routine_original_payment_evidence`, `routine_payment_account_policy` and `routine_payment_account_use`. Those historical sources never gain Financial INSERT/UPDATE/DELETE. Existing manual-refund and second-card reader declarations stay explicit. The two historical catalog inspectors accept this extra reader only with the complete new addon and exact joint ACLs, never by learning an arbitrary grantee. Gift peer declarations carry the new addon so later full App/Admin audits retain the exact Financial profile.

`appendRoutineRefundAccountPolicy` is the only production policy writer. It is an explicit maintenance API, with no HTTP author or runtime writer. The input is exactly `{operationId,expectedRevision,data}`; data has exactly:

```
accountId, state, appId, merchantId,
credentialRef, credentialVersion, credentialStamp,
purposes, validFrom, validUntil
```

`state` is active/revoked. Purposes are a nonempty unique subset of `refund_request`, `refund_query`, `refund_notify`; the older payment query/notify purposes do not qualify. Validity is positive seconds with at most 366 days per revision. An operation uses UUIDv4, exact revision CAS and at most 64 complete chained revisions per account. Unknown fields, accessors, sparse/custom arrays, nonprimitive identities and coercion objects refuse before opening SQL.

The maintenance input, deployment strings and declared target are copied before asynchronous BEGIN. The signed journal binds the actual database/maintenance names and OIDs, independent refund purpose/domain, previous record ID, revision, public policy and database time. Each history is read completely within its bounded limit and authenticated; a structural row or an HMAC from another domain is insufficient. The operator must independently establish provenance and organizational authority; the software does not infer them from current configuration, OpenID, code2Session, INIT/PREPAY or a successful payment query.

The existing closed `ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS` registry and `routinePaymentCredentialCommitment` bind the explicitly provisioned archived ref/version, pair and every material byte. An active new revision requires an exact commitment. This API does not expose merchant materials or introduce path/URL/env-var selectors. Only public metadata is stored. Secrets can be removed without erasing an exact existing receipt or preventing revocation. Reusing an operation UUID for another account or changed intent refuses.

`readRoutineRefundAccountPolicyTx` returns frozen policy metadata in the caller's real App or Financial transaction. It checks only the latest exact revision, SQL-clock validity, explicit refund purpose and current exact material commitment. Missing/revoked/future/expired/invalid/latest-withdrawn records never fall back. This function returns no provider capability, merchant secret or historical payment identity. No caller invokes it from the current refund flow.

Remaining work before historical refunds can run: authenticate the original paid store-order evidence and conflicts; preserve physical root/child/buyer scope and existing live Financial actor receipts; append the first immutable dispatch with the business CNSR admission in one transaction; use only its pinned archived merchant for signed request/query/AES callback; verify negative query responses before allowing a POST; commit genuine provider evidence and the mutable payment projection together; and finalize accepted SUCCESS through durable provenance after retirement without a backwards maintenance lock. Native service-level request/query/callback and actor recovery acceptance is still required.

Validation details, exact input batches and limits are recorded in phase29 of `php-ts-wechat-routine-20261029.md`. Tests use an owned local PG16 host and independently authenticated restricted LOGINs. This is not production DDL, a real provider call, Browser, Workerd/Hyperdrive or deployment acceptance.
