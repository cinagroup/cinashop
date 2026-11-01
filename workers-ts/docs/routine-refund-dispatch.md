# Historical Routine refund dispatch

Phase30 connects the phase29 storage to the actual App and explicitly commissioned Financial business roles. It preserves users, buyer UID, entitlements, orders and payments. An independent refund approval and archived credentials authorize a particular provider operation; they do not establish historical payment ownership. Unknown history remains unresolved. The global migration and account-switch activation remain incomplete.

## First dispatch

The existing live actor, refund quantity, physical order scope and provider-admitted decision remain prerequisites. The same business transaction then authenticates the original Routine payment, complete related evidence and approved-use histories, and NativeApp exclusion. It appends the immutable first dispatch and changes the refund payment to REQUESTING atomically.

The first record pins the actual database and maintenance names/OIDs; refund/root/child/buyer/store/supplier identities; original evidence ID/signature; exact root transaction, original total, refund amount, CNSR and reason; independent refund approval and archived credential commitment; callback URL; and first Financial actor/operation receipt when applicable. A lawful subsequent actor uses existing live qualification and operation-owner checks without rewriting the first actor. Financial receipt hashing normalizes its timestamp to epoch seconds, independent of the connection TimeZone.

The original reader authenticates all related Routine source rows and old approved-use journals within their fixed bounds. It requires a paid WeChat root with the same buyer, transaction and amount, and returns a frozen proof branded for that SQL transaction. A plain object, another transaction's proof, current merchant configuration, code2Session, INIT/PREPAY or a prospective identity map cannot substitute for that proof. The paid source can have been captured before the local paid projection was committed.

In the historical branch with an authenticated Routine original, an attempted legacy CNSR without a first dispatch is refused. Existing request times, attempt counters or a mutable SUCCESS are insufficient to reconstruct the original dispatch. Such cases require a separate maintenance recovery protocol. An order with no Routine original retains the existing legacy routing.

## Role and transaction boundaries

The addon authenticates the actual independently logged-in App or fixed Financial role, session/backend OID, full named catalogs, exact joint ACLs, public resolution and finite SQL bounds. The entire absent namespace retains legacy behavior; partial, drifted or uncommissioned state refuses. Fresh provider admission acquires the independent refund gate before physical refund/order locks. No runtime request installs or repairs schema or grants.

When the NativeApp namespace is present, contradiction checks use a separately authenticated App read-only connection. It proves the same database/name/OID, a different backend, actual App LOGIN/session/backend OID, and a random advisory-lock challenge against the physical business transaction. Root/child/refund/payment identity is checked before and after. A genuine conflicting APP SUCCESS refuses, even when the merchant pair agrees. INIT alone does not establish an original. Financial gains no NativeApp ledger SELECT and no business write is redirected to App. The old NativeApp current-account equality checks remain in place.

The NativeApp maintenance installer accepts complete explicitly captured peer/App-reader declarations so the full five-role fixture can coexist with the new Financial addon. Its exact target, local/case-lock rules, full before/after audits and real maintenance LOGIN/backend checks remain mandatory. It adds no runtime grants to other roles.

## Archived merchant operations

`ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS` is the closed credential registry. Fresh request, query and notification preflight authenticate the current independent `refund_request`, `refund_query` or `refund_notify` policy, complete policy history, validity and exact pinned account/ref/version/material commitment. Registry lookup alone is not authorization. Merchant secrets are nonenumerable request-local material and are absent from public policy, dispatch and provider evidence JSON.

The explicit `ROUTINE_REFUND_NOTIFY_ORIGIN` must be an exact HTTPS origin for first admission. The first dispatch fixes its callback URL:

```
/api/pay/notify/routine-refund/:dispatchId
```

It is independent of later current merchant/site configuration. Clearing or switching current configuration does not change the pinned original merchant. Fresh provider operations still require the archived material and appropriate live refund approval.

Preflight closes SQL before provider I/O. Production code signs the archived-merchant POST/GET and verifies the platform RSA signature and exact business identities before creating a private request-local result proof. Notification additionally decrypts AES-GCM, checks the decrypted merchant, exact transaction/CNSR/amount and matching event type. The generic current-account scalar callback refuses a historical dispatch.

Positive request/query refund responses require CNY and exact amounts; the signed 404 negative response has neither. The official refund query contract does not require a response `mchid`; an optional contradictory value is rejected. Binding also uses the authenticated outgoing merchant request and exact original transaction/CNSR. The notification contract requires decrypted `mchid` and does not specify a currency field. These differences follow the official [query contract](https://pay.wechatpay.cn/doc/v3/merchant/4013071041) and [refund notification contract](https://pay.wechatpay.cn/doc/v3/merchant/4013071196).

A lost POST becomes UNKNOWN and is queried using the same CNSR. Only a genuinely RSA-verified HTTP 404 with `RESOURCE_NOT_EXISTS`, bound to the current query lease, can authorize a retry after a fresh matching `refund_request` approval. Unsigned 404, `MCH_NOT_EXISTS`, a stored old negative or any history with a known provider refund ID cannot authorize another POST. The retry retains the exact CNSR and original request. This follows the official [refund retry guidance](https://pay.wechatpay.cn/doc/v3/merchant/4014959631).

## Provider evidence and completion

An adapter-created proof binds the dispatch signature, purpose approval, source/ID, query/request lease, normalized financial result, first raw body digest, verifier key, HTTP status and bounded issue/verification times. It is separate from both dispatch HMAC and payment observation domains. A plain gateway result cannot become historical refund evidence.

Acceptance locks the physical refund and order, reauthenticates dispatch/original/history, validates the private proof and its historical approval, and writes immutable evidence together with the mutable payment projection. It does not reacquire fresh provider authorization: an authentic result authorized before an in-flight retirement remains a fact. Local failures cannot mint SUCCESS evidence. Provider refund ID cannot change and accepted SUCCESS cannot be downgraded.

Request/query source IDs identify normalized financial facts, independent of lease, JSON key order, nonfinancial response fields or clock. Repeated facts preserve the first body digest and first immutable row. A fresh authentic repeated fact may repair UNKNOWN without adding a row. Callback source IDs remain provider event IDs. For a persisted event ID, replay requires the same first raw body digest as well as the financial facts.

The complete evidence set is authenticated with a 128-row/2 MiB bound; no successful prefix is accepted. New non-SUCCESS facts stop at 127 rows, reserving the 128th for the first authentic SUCCESS. At full capacity, a new event ID with an already durable identical SUCCESS can be acknowledged without creating a 129th row. That unpersisted event has no stored first body digest for future conflict checks. The 127/128 boundary has source and cross-author review; it has no native boundary-injection execution in this phase.

Finalization and Financial status authenticate durable original evidence, full conflicts/old approved-use histories, approval at dispatch/observation time, first Financial receipt where applicable, and accepted provider evidence against the mutable projection. They need no active approval, current material or fresh maintenance gate. Thus retirement and secret withdrawal cannot erase an accepted refund or block its durable local completion. Forged mutable SUCCESS remains UNKNOWN/unavailable and cannot finalize.

Financial status uses a real repeatable-read/read-only snapshot. Its operation-owner authentication performs read-only SELECT; writer authentication retains its existing row lock. Existing receipt ownership, live qualification and lawful resume checks remain required. Provider evidence and payment updates roll back together on a late failure; business materialization follows only proven SUCCESS.

## Current coverage and limits

Only App and the explicitly commissioned fixed Financial role consume this addon. Under an installed bundle, the protocol guard currently refuses positive WeChat execution through an uncommissioned Admin/Manager role, including cases without a proven Routine original. Old route readiness can reject earlier. Their existing status/receipt/replay paths have not yet been converted to the new durable-proof contract. Cashier has no separate refund-execute HTTP route and receives no addon rights; the qualified mobile Financial route still authenticates and uses its fixed Financial business role.

Separate Admin/Manager role commissioning and actor/status/replay integration, explicit recovery of already attempted CNSRs, other original-account consumers, full ownership manifests and account-switch activation remain outstanding. No production DDL, deployment or real provider request is part of this checkpoint.

Native acceptance uses an owned local PG16.14 cluster, independently authenticated restricted LOGINs, actual production services and generated independent RSA/AES keys. The provider transport is controlled; it verifies outgoing signatures and checks physical locks are released during HTTP. The six scenarios cover request/query/SUCCESS split finalization, cleared current configuration, callback replay, signed versus unsigned negative queries, real conflicting APP evidence, proof forgery, late projection rollback, revocation/secret withdrawal, fact deduplication and UNKNOWN recovery. This is not real WeChat, Browser or Workerd/Hyperdrive acceptance. Exact batches, early failures and compatible regression results are recorded in phase30 of [the migration log](php-ts-wechat-routine-20261029.md).
