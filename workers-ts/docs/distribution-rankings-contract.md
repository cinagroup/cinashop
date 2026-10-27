# Distribution rankings: PHP consumer page parity

The finance page now exposes separate 推广人排行 and 佣金排行 pages. The two PHP aliases resolve consistently in the client and Worker FAB registries to `/pages/user/promoterRank` and `/pages/user/commissionRank`, with registered Uni pages. Supplier, Admin finance writes, payments, withdrawals and distribution relationship mutations are outside this increment.

## Original UI and business authority

Reference: immutable PHP commit `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`, `view/uniapp/pages/users/{promoter_rank,commission_rank}/index.vue`, `user_spread_user/index.vue` and `api/user.js`.

The peach promoter header, trophy, gold/black commission background, first-three medals, week/month tabs, white rounded list and commission-only fixed caller footer follow those source pages. The seven raster files are copied byte-for-byte, with original paths, sizes and SHA-256 in `view/uniapp-ts/src/static/php-rankings/provenance.json`. Native title bars use platform navigation with matching colors; original PHP mini-program custom title-bar positioning is not reproduced. This is source-based visual restoration, not a pixel-perfect comparison against a running PHP deployment. The promoter PHP footer tests commission-only response fields and is unreachable under the actual promoter response; the TS promoter page keeps its header ranking and does not invent a commission footer.

Existing legacy `/api/rank` and `/api/brokerage_rank` responses and their old consumers remain unchanged. Only requests with a `view` key enter the bounded new projection. `view=leaderboard`, `type=week|month` (default week), `page=1..500` (default1) and fixed `limit=20` are the only keys, each occurring once. Invalid view/query values are rejected; a client-supplied UID has no authority. The response contains exactly:

```
{owner_uid, kind, type, page, limit:20, list, self}
// each list/self record:
{uid, position, nickname, avatar_source, avatar, value}
```

`kind` is `promoter` or `commission`; global `position` is computed before slicing. The caller retains their real rank even when beyond the loaded page; rank0 and value0/0.00 mean unranked. Promoter values are integer strings. Commission values remain SQL decimal strings with two fraction digits, including sums above an individual ledger field's range. Frontend comparisons use integer units and never coerce amounts to binary floating point.

Promoter ranking counts historical `user_spread` events in the chosen period, not current `user.spread_uid`. Commission ranking sums positive-direction brokerage excluding `refund` and `extract_fail`, with positive aggregate totals. As in the existing migrated service, pending/frozen ledger status is not a new exclusion, outgoing/refund restoration rows are not incoming earnings, inactive/deleted/missing users are excluded, and ties resolve by UID descending. Period starts are Monday00:00 or first-of-month00:00 Asia/Shanghai, with inclusive start/current-second endpoints. The older promoter response's rolling previous-month auxiliary statistic is not substituted for the monthly board.

## Snapshot, media and lifecycle

The new service validates the active account, computes rows/caller and resolves persisted avatars in one bounded repeatable-read/read-only transaction. Caller/participant attachments require their actual UID, namespace and metadata via `UserAvatarPolicy`; a configured fallback avatar is read from the SQL configuration winner and grants only platform media. Source references stay separate from signed previews; capability signing occurs after the transaction. Missing keys or invalid media fall back to an initial without generating an unauthorized asset URL. Images that fail, expire, or belong to an old page generation cannot hide a fresh slot or be refreshed with a financial write.

Page/account/session/period generations own all requests and media callbacks. Switching period immediately aborts and resets the previous read, including while loading. Failed append preserves accepted rows/self and retries the same page. Cross-page duplicate participants, inverted ordering or changed caller data reject the whole append and ask for refresh. This does not promise a single snapshot across independent pagination requests when other users earn new commissions. The finite UI read bound is10000 displayed positions; a full final bounded page says so explicitly.

Guests make no ranking read and receive an explicit login button. Hide/unload/logout/token renewal and account changes clear private state; on show the page synchronizes persisted identity. No confirmation modal is introduced. The two new flows make GET requests only.

## Validation

`view/uniapp-ts/scripts/distribution-rankings-runtime.test.cjs` exercises the actual Vue/Pinia pages and adapters, pagination/retry, rapid period changes, stale callbacks, account/session lifecycle, response integrity, signed avatar lifetimes, exact large monetary strings, registered alias resolution and immutable asset hashes. H5, Weixin and App builds compile the same source; native device runtime behavior is not claimed by compilation.

`workers-ts/test/distribution-rankings-postgres.test.ts` uses native isolated PG16, a separately authenticated commissioned App LOGIN and actual API JWTs. It compares the legacy contracts, global page/caller semantics, period boundaries and income exclusions, authentication errors, persisted avatar ownership/metadata, exact R2 response bytes, repeatable-read behavior, every complete schema table and every sequence.

The opt-in `audit:distribution-rankings-browser` runner serves the actual built H5 and registered Worker against an owned complete283-table PG16 fixture. The hidden browser traverses real finance buttons, both periods/boards, page2 truncation/retry and termination, unranked caller, empty/restored fixture and a wider viewport. QA session controls replace iframe documents; same-instance identity guards are separately tested by the runtime suite. A held old-owner HTTP response proves transport isolation and does not by itself prove a late JavaScript callback. Empty-state controls only move the finite synthetic event timestamps and restore exact originals; they are explicitly recorded outside business reads. Each real request/response, full table/sequence state, resource byte identity, source/build manifest and final host cleanup is retained outside the repository for independent verification. No live login, provider, native release or production deployment acceptance is claimed.
