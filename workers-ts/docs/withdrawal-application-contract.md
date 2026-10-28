# Withdrawal application and owned receipt

This slice restores PHP `view/uniapp/pages/users/user_cash/index.vue` and `status.vue` from immutable commit `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`. It preserves `UserWithdrawalService.apply`, the account lock, optional legacy keys, immutable financial effects/application outbox and review semantics. Modern input never creates a second debit implementation. Automatic WeChat records an application; it does not claim that a provider payout occurred.

## Strict modern projections

Legacy requests without a `view` retain their existing response and input contracts. New views require exact unique URL keys, scalar JSON strings, bounded fatal UTF-8 decoding, duplicate decoded-key rejection, no coercions or unpaired surrogates, and no caller UID or mode override. Every modern response is private/no-store.

`GET /api/extract/bank?view=withdrawal_application` returns exactly:

```
{owner_uid,brokerage_amount,withdrawable_amount,frozen_amount,
 min_amount,max_amount,fee_rate,freeze_days,channels,wechat_mode,banks}
```

The four channel names have PHP order `bank,balance,weixin,alipay`; only enabled persisted flags appear. Missing/empty flags use the existing profile default1; only parsed1 enables a channel. WeChat mode is `automatic` only for persisted brokerage_type1, otherwise `manual`. Banks follow the SQL configuration winner, PHP multiline/JSON-first-element convention, deduplicated in first-seen order, with at most100 entries/64 code points each. Modern bank applications select one of these banks. The fee is a normalized percent string with at most6 fractional digits; the actual calculation keeps PHP's truncated basis points and truncated cents, including zero fee for balance. Limits use exact decimal cents and must be configured consistently.

All monetary DTO values are exact two-place decimal strings. `brokerage_amount` retains a signed persisted balance; `frozen_amount` is the nonnegative sum of valid pm1/status1 future credits, without aggregate numeric(14,2) narrowing; `withdrawable_amount=max(0,brokerage-frozen)`. The application maximum does not truncate the displayed ledger balance. Owner, money, SQL config winners and available media metadata use bounded repeatable-read/read-only transactions. These services do not use cached SystemConfigService values or touch KV, queues or providers.

`GET /api/extract/bank?view=withdrawal_media&reference=/api/assets/<id>` returns exactly `{owner_uid,reference,preview}`. Only that exact canonical positive-int32 ID is authorized: persisted attachment type3/relation_id=owner/module_type3/file_type1/image_type8, exact canonical att_dir, a safe `attachments/user/<uid>/...` path, and matching supported extension/MIME. Platform defaults, supplier/visitor/other users, arbitrary HTTPS URLs, copied signatures and malformed paths do not establish ownership. Authorization occurs in the read transaction; only its single approved canonical reference is signed after the transaction. The preview is temporary and is never the durable intent/fingerprint reference.

`POST /api/extract/cash?view=withdrawal_application` accepts only:

```
{request_id,extract_type,extract_price,real_name,extract_number,
 bank_name,bank_address,qrcode_url}
```

The first three fields are mandatory. The remaining strings default empty; clients send all eight. Keys use the existing16–96 ASCII intent alphabet; amounts are positive ordinary decimal strings with at most10 whole digits/two fractional digits. Person/account/bank names are bounded64 code points, bank_address256 and code reference255. An Idempotency-Key header must agree with the body. The acknowledgement is exactly `{owner_uid,request_id,id}`; it is an application registration acknowledgement, not a payment receipt.

The existing funds transaction locks the active caller first and resolves `uid+request_key+normalized fingerprint` before new capabilities/media checks. A matching committed key returns its original ID even after channel/config/media changes. A changed payload produces409. Legacy successful payloads can replay through the modern view when they satisfy the scalar envelope; permissive legacy keyless requests remain supported by the legacy endpoint. Only a genuinely new modern application checks the latest SQL channel policy and owned receipt image. Bank/alipay require a recipient name; manual WeChat and alipay require a real owned code; bank/balance/automatic WeChat do not use a code. The code row is held FOR SHARE until the money transaction finishes. Existing gross debit, net/fee split, balance credit, capital effects and application outbox commit atomically. After commit, the original outbox dispatcher still runs; it can retry a lost Queue dispatch without repeating financial effects.

`GET /api/extract/records?view=withdrawal_receipt&request_id=<key>` returns exactly:

```
{owner_uid,request_id,found,receipt:null|{
 id,extract_type,gross_amount,net_amount,fee_amount,status,add_time,time,
 withdrawal_message}}
```

A missing or foreign key returns `found:false,receipt:null`; it never fabricates a success. Gross is exact persisted net+fee, not the client's remembered input. Known statuses are -1/0/1; unknown historical status is null. Only a caller-owned rejected row exposes its rejection message. No bank/card/contact/code/requestHash fields are projected. Nonzero signed-int32 timestamps use Shanghai `YYYY/MM/DD HH:mm:ss`; zero is blank. The receipt page uses this original server timestamp rather than PHP status.vue's current local time.

## Intent lifetime and acceptance boundary

The independent page and former finance modal share the original per-user pending storage key. A new request key is persisted with its immutable canonical payload before sending. Unknown transport/commit results and409 preserve the original intent and query its owned key; they never create a fresh debit automatically. Definitive validation rejection can release only the current original intent. Owner/token/session/visibility generations fence requests, uploads, navigation, toasts and storage removal; an old callback must not remove another account or renewed session's pending request. Missing or expired media previews can be refreshed only through the owned media view.

Ordinary customer uploads already have a real authenticated/rate-limited API and owner metadata. Registered attachment delete controllers are fixed to their admin/supplier scopes and cannot delete ordinary user3/module3 receipt images; this slice does not broaden generic material-library deletion permissions. Raw maintenance/production retention and external payment-provider rollout are separate operational responsibilities.

Validation uses isolated synthetic accounts and local PG16 only. Read tests compare all283 tables/229 sequences. Funds tests explicitly compare bounded allowed account/withdrawal/debit/outbox/balance/capital changes and exact sequence use; writes are not called read-only. Real JWT, separately authenticated commissioned App LOGIN, duplicate/invalid requests, channel/media authority, replay, concurrent identical keys and RR snapshots are exercised. Browser evidence must use real built H5/Worker responses and synthetic local funds, distinguish document replacement from same-instance lifecycle tests, and avoid any claim of production/provider payout or native-device acceptance.
