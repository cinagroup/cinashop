# Customer growth records

The customer membership screen now links to `pages/user/growthRecords`. The
legacy `/pages/users/user_vip_areer/index` alias resolves to that page in both
route registries. The existing membership overview and activation flow retain
separate destinations. User-center configured entries retain the membership
capability gate.

## PHP contract

Reference: `cinashop-php` commit
`8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`:

- `view/uniapp/pages/users/user_vip_areer/index.vue`: page size 20, append then
  group by the first occurrence of each month, original empty illustration.
- `UserLevelServices.php::getUserExpList`: `{count,list,time}` with singular
  `time`, snake-case display dates and month keys.
- `UserBillServices.php` and its DAO: current user's `category=exp`, `status=1`,
  descending record ID. Dates do not determine record order.
- `config/app.php`: `Asia/Shanghai`. Signed integer timestamps preserve their
  dates; zero means missing, not the Unix epoch.

The Worker reads count and page in one SQL statement, verifies the active
account, and returns exact `numeric(12,2)` strings. It does not cast amounts to
JavaScript numbers. A historical negative amount retains its raw value and
stored direction; the UI displays their combined signed amount and an explicit
raw-value note.

The migrated endpoint deliberately bounds default reads to page 1 / limit 20,
with page 1–1000 and limit 1–100. Known query keys must be single canonical
positive integers. This bounds the older PHP service's possible unpaginated
fallback. Unknown query keys cannot select another user: authentication owns
the UID. Responses use `private, no-store, max-age=0`.

## Page behavior

The monthly cards, row spacing and empty text follow the PHP page. Empty art
reuses the already migrated original `static/php-points/noOrder.gif` (440×360,
138859 bytes, SHA256
`6b56971c5aa9c69b13740fa361812a327a2e96ec74d7f51d93cf702e5c4bcceb`).

A successful refresh starts at the top, preventing the shorter first page from
triggering another bottom-reached append. Append and refresh failures keep the
last proven records and allow an explicit retry of the failed page. Unknown dates remain explicit. Duplicate or
incomplete pages, changed counts, invalid decimals or inconsistent month keys
are rejected without advancing pagination. One in-flight request prevents
scroll/click duplication. Hide, unload, logout and session changes clear
private records and reject late responses. Guests choose login explicitly.
The page never calls detection, activation, reward or financial write APIs.

## Validation boundaries

`growth-records-runtime.test.cjs` executes the actual Vue/Pinia stores, request
adapter, composable and SFC setup, replacing only native lifecycle/I/O.
`user-growth-records-postgres.test.ts` exercises the registered application,
JWT/account checks and SQL against an owned two-table/two-sequence fixture;
normal execution uses PGlite, and the explicit local runner selects PG16.

The opt-in browser host serves the fresh H5 build and actual Worker responses
on owned PG16. It records complete table/sequence and resource snapshots,
source/build hashes, response bytes and DOM-to-response links for mobile and
desktop phases. QA session bootstrap does not prove the login form or an
independent PostgreSQL LOGIN ACL. Setup fixtures are distinct from the
zero-write business-read observation interval.

A separate exact manifest inverse removes only this six-line page registration
before entering older points/sign/community audits. Historical fixtures and
helpers remain unchanged; historical browser evidence retains its original
scope. Current route, alias and capability tests inspect current sources.
