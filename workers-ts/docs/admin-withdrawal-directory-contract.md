# Admin withdrawal directory and historical collection codes

The PHP reference is commit `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5` in `cinashop-php`: `view/admin/src/pages/finance/userExtract/index.vue`, the Admin UserExtract controller, UserExtractServices, UserExtractDao, the UserExtract model, `crmeb/traits/ModelTrait.php` and `config/app.php` (Asia/Shanghai).

## Read projection

GET `/adminapi/extract/directory` and `/api/admin/extract/directory` return `{version:1,actor_id,query,period,count,statistics,list}`. Existing list and review routes retain their contracts. Directory and media requests require current `extract.view` permission; the existing `extract.manage` implication and platform level-zero semantics remain. The exact directory namespace cannot confer permission on other children or write verbs.

The current Admin identity, password version, scope, active platform roles and natural JWT deadline are checked inside one REPEATABLE READ, READ ONLY transaction. List/count/statistics use one report statement. All dates and money are computed from persisted data; reading cannot write financial state or issue a payout.

Only `page`, `limit`, `status`, `extract_type`, `keyword`, `start`, `stop` are accepted. Page is 1..1000, limit20, status is all/-1/0/1, and channels are all/bank/balance/weixin/alipay (legacy wx normalizes to weixin). Repeated/unknown selectors, malformed UTF8/percent encoding, controls, unpaired surrogates, coerced scalars, bodies and unsupported framing are rejected. Keyword is at most64 Unicode code points and retains raw SQL LIKE wildcard semantics. PHP's exact string `0` disables keyword filtering; `00` and `0 ` do not. Search covers stored name, extraction ID, bank/Alipay account and related nickname, without adding UID/phone/WeChat search.

The additive endpoint accepts two zero timestamps or a closed pair of positive signed-int32 minute timestamps. Equal endpoints take precedence and add literal86400 seconds to the inclusive stop; otherwise an actual Asia/Shanghai midnight stop gains86400. Nonmidnight stops stay literal. The expanded stop uses bigint and may exceed int32. IANA Shanghai summer time is preserved. The frontend rejects missing or ambiguous wall minutes; the numeric backend still accepts either explicit historical fold instant. These input boundaries do not claim PHP's broader legacy named/open-ended date parser rejected the same requests.

Rows are ordered by extraction ID descending. Missing, disabled or deleted related users do not erase history. Signed historical ID/UID/status/time and signed exact decimal money remain visible. PostgreSQL ILIKE follows its configured collation; this does not claim every MySQL accent/case equivalence. Row gross is net plus fee, and no floating-point arithmetic computes financial values.

## PHP statistics scopes

- `price`: gross pending amount (status0), with time/channel/keyword filters.
- `priced`: gross approved amount (status1), with time/channel/keyword filters.
- `brokerage_count`: brokerage number at pm1/status1, excluding extract_fail/refund, with only the selected time filter.
- `brokerage_not`: max(brokerage_count minus priced,0).

The selected list status does not narrow the two extraction totals. Channel and keyword do not narrow brokerage totals. No active-customer, frozen-time or additional UID predicate changes these historical scopes.

## Opt-in historical media

GET `/adminapi/extract/directory/:id/media` and the `/api/admin` alias require one canonical positive int32 ID and exact64-lowercase-hex revision. The eight-field response is `{version:1,actor_id,id,revision,available,reference,preview,expires}`; unavailable means the last three fields are null. Missing positive IDs are unavailable. A changed existing record or attachment version returns HTTP409. Nonpositive/malformed IDs do not sign anything.

The HMAC revision binds the current Admin identity/auth version/session expiry, extraction ID/xmin and selected attachment xmin. Same-value ABA updates therefore invalidate old revisions. It is a read version, never authorization for a financial mutation.

Eligibility requires a modern canonical user asset, matching historical record UID and attachment owner/type/module/file/image metadata, safe owner namespace, supported image extension and matching MIME. A historical customer's current activity does not determine Admin access. Lists do not expose a QR reference, signed URL, intent identifier/hash, object key, password or phone.

Issuance checks SQL metadata and uses the existing900-second signer without probing R2. `media_available` proves metadata eligibility only. The later ordinary signed asset GET reads R2 and can fail if an object is missing, truncated or undecodable. A signed URL is a bounded bearer capability until its natural expiry; this change does not add immediate revocation to previously issued URLs.

Frontend reads capture immutable credentials, request/owner generations and exact accepted filters. Draft filters do not relabel accepted rows, and paging retains accepted filters. Owner/capability change or unmount clears retained private data. Media is fetched only on request, bound to its row revision, erased on expiry/error/close and renewed only by an explicit read. An old image error or HTTP401 cannot change replacement-owner state. Existing financial review behavior remains a separate retained workflow.

Validation receipts must distinguish pure API checks, the actual Vue renderer tests, strict types, PostgreSQL execution, builds and rendered browser acceptance. Syntax-only candidates do not prove those later checks passed.
