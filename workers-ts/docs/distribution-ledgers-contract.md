# Distribution commission and withdrawal ledgers

The dedicated `/pages/user/distributionLedgers` restores the PHP `view/uniapp/pages/users/user_spread_money/index.vue` and timeSlot appearance from immutable commit `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`. Finance offers commission and withdrawal record actions through the actual legacy route resolver. Both client and Worker aliases for `/pages/users/user_spread_money/index` now reach this registered page with their query preserved: type1/2 means commission, type4 means withdrawal. The prior finance page ignored type4 and always selected first-level commission. Existing compact finance summaries and withdrawal submission/recovery remain separate.

## Authoritative PHP scopes

The page calls v2 `user/money_list/3|4`, not the old monthly spread/commission endpoint. PHP `UserBrokerageServices::userBrokerageList` includes every caller-owned user_brokerage row regardless of ledger type or status. Search applies to title/UID or the **caller’s** own account, nickname and phone. It does not search downline buyers, products or other users. String0 is a real search; parameterized SQL LIKE wildcards `%` and `_` are retained. Income sums the same filtered scope where raw pm1 except extract_fail, while expenditure sums raw pm0. Neither is a page subtotal, current balance, or a new withdrawal entitlement.

Withdrawal records remain the caller’s extract/extract_money/extract_fail ledger rows, ordered by ledger ID descending; they are not a pagination of withdrawal applications. Date filters apply and keywords are unavailable. Both modes use a flat list; the original commented monthly grouping is not invented here.

PHP formats a nonzero ledger timestamp as Shanghai `YYYY/MM/DD HH:mm`; zero is blank. Modern dates are both0 or complete positive-int32 Shanghai calendar days including the final second. Legacy ledger3/4 separately retain ModelTrait’s closed BETWEEN semantics, including zero endpoints, and its +86400 expansion for equal bounds or an ending midnight. Balance/cash ledger0/1/2 time semantics are unchanged.

## Bounded additive read

`POST /api/v2/user/money_list/3|4?view=distribution_ledger` is an explicit read projection; legacy GET continues to return its existing shape. Only canonical path3/4 and one URL view key are accepted. Scalar UTF-8 JSON accepts page1..500, fixed limit20, start/stop and a Unicode keyword up to64 code points. Duplicate JSON keys, unpaired surrogates, controls, unknown authority/sort fields, scalar coercions, noncanonical numeric values and partial dates are refused. Commission keywords are trimmed; withdrawal keywords must be absent or the exact empty string.

```
{owner_uid,mode:'commission'|'withdrawal',query:{page,limit:20,start,stop,keyword},
 count,income,expend,list}
// rows:
{id,title,type,pm,number,add_time,time,withdrawal_status,withdrawal_message}
```

Count covers all matching records before paging. Commission aggregates remain available even on an empty last page; withdrawal aggregates are null and no income/expenditure summary appears. Signed two-place SQL decimal strings are not narrowed through numeric(14,2) or Number. The page applies the PHP income/expenditure direction to raw signed numbers mathematically, avoiding doubled minus signs on anomalous negative values. A historical raw pm other than1 takes PHP’s expenditure display direction0; it is not silently included in the raw pm0 aggregate. No ledger-status exclusion is introduced.

The active authenticated account, rows, count, sums and withdrawal-authority metadata share one deadline-bounded repeatable-read/read-only transaction. The projection excludes full ledger records, personal contact data, bank/payment accounts, request keys and credential fields. It touches no KV, queue, media or payment provider.

## Withdrawal status is owned application data

Ledger status is not withdrawal review status. PHP type4 did not supply the extract-status fields that its UI attempted to display, so copying ledger status0/2 into review badges would reproduce a bug. Modern extract/extract_fail rows resolve an application only by both caller UID and a valid linked application ID. Only a known application status -1/0/1 becomes a review result; missing, foreign or unknown states are null and show no invented result. A reason appears only for that caller’s rejected application. The original extract_money historical branch remains approved1 without disclosing linked data. This is an explicit modern projection improvement over PHP type4, not a claim that PHP already provided the result correctly.

Legacy compatibility fixes are restricted to ledger3/4: ModelTrait dates, un-narrowed sums, and owner-constrained extraction lookup. Expanded legacy bounds compare as bigint, and out-of-int4 linked IDs are treated as missing instead of causing a query error. Legacy response keys and other money-list modes remain intact.

## Page lifetime and validation boundary

Search/date changes reset page1 and abort the previous generation. Dates keep the submitted commission keyword. Failed appends retain accepted rows and aggregates and retry the same page. Count/sum changes, duplicate IDs or an inverted ID boundary refuse append and request a refresh. Hide, unload, logout, renewal and account replacement clear private rows and aggregates and invalidate pending callbacks. Guests make no ledger read; malformed route types show a readable error without a read or confirmation dialog. Pagination ends from the full count and is capped at10000 records. Custom drafts do not relabel the accepted date range.

Runtime tests execute the real Vue/Pinia page, request adapter and projection across commission/withdrawal routes, pagination, transport loss, strict responses, account/session changes, full-day filters, signed money and actual template compilation. Three-platform builds inspect actual output resources and component bindings. The native PG16 suite uses real API JWT and commissioned App LOGIN, all283 tables and all sequences, exact scopes/ownership and repeatable-read concurrency. The opt-in Browser host serves actual built H5 and the registered Worker with real records; it records actual HTTP bytes, full source/build manifests and complete read-only snapshots. QA document replacement is recorded separately from same-instance runtime races. No external provider, live PHP deployment or native-device acceptance is claimed.
