# Promoter people: PHP consumer parity

`/pages/user/promoterPeople` replaces the generic finance modal for 我的推广. The finance action and both client/Worker aliases for `/pages/users/promoter-list/index` reach this registered page. The PHP search pill, 一级/二级 or 代理商/员工 tabs, date chips, rounded white list, circular avatars, joining dates and three right-hand statistics follow immutable PHP commit `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`, `view/uniapp/pages/users/promoter-list/index.vue` and `components/timeSlot/index.vue`. Existing copied PHP empty-state assets are reused. This is source-based restoration rather than a comparison against a live PHP deployment.

## Relationship and report authority

PHP `UserServices::getUserSpreadGrade` and `getUserSpredadUids`, `UserStoreOrderServices::getUserSpreadCountList`, and `UserStoreOrderDao::getUserSpreadCountList` define the report. Both levels come from current `user.spread_uid` links, including for division, agent and staff accounts. They are not historical `user_spread` events and are not membership inferred from division/agent/staff IDs. The caller must be active. Existing migrated is_del/delete_time exclusions and the second-level self-cycle guard remain; this increment does not re-expose deleted users. A participant's status0 is not a new relationship exclusion.

Only a persisted caller `division_type==1` selects division commission and 代理商/员工 labels. No request type/UID can grant that mode or change its members. As in PHP, division status/end time are not additional conditions for this read. Other caller division types use ordinary first/second-level commission. Tabs appear for brokerage_level2 or division mode. A configuration change hiding the currently selected second level resets the visible page to first level with a fresh read; the underlying API retains PHP-compatible grade1 querying even under a single-level display configuration.

The unfiltered first/second totals and each person's immediate-child count are independent of keyword/date. Search matches nickname or telephone without returning telephone. Date filtering uses the person's spread_time, including literal zero endpoints in the legacy raw BETWEEN contract; it does not inherit promoter-order midnight expansion. The displayed joining date is Shanghai `YYYY-MM-DD` for nonzero spread_time, otherwise the creation date as `YYYY/MM/DD`.

Each person's order count and consumption are lifetime sums of all order types with pid IN(0,-1), paid1, refund status0/3 and both deletion flags0. Physical child rows are excluded from those purchase aggregates. Commission uses a different scope: only ordinary type0 orders with raw pid=0 and the same paid/refund/deletion conditions. Ordinary grade0 sums one_brokerage where spread_uid is the caller; grade1 sums two_brokerage where spread_two_uid is the caller. Division mode sums division_brokerage where division_id is the caller for either grade. Search and joining dates do not restrict commission. PHP returns this full-scope amount only for a nonempty page, and zero for an empty page; the new view preserves that condition.

Legacy sorting by childCount uses the stored spread_count before PHP replaces the displayed child count with the current relation count. The migrated shared query preserves that distinction and MySQL NULLS FIRST/LAST behavior for purchase sorts. A person without matching purchases retains legacy NULL order/consumption fields; the modern projection normalizes them to0 and `0.00`. Default sorting is creation time descending, with a documented deterministic UID-descending tie. Literal wildcard escaping, bounded legacy parameters, deletion guards and the tie are existing migrated extensions.

## Additive projection and corrected visible count

Only `POST /api/spread/people?view=promoter_people` selects the new view. The URL admits one view key and no others. A bounded scalar UTF-8 JSON body accepts only page1..500 (default1), numeric limit20, grade0/1 (default0), keyword up to64 Unicode code points, and start/stop. Unknown fields, duplicate JSON keys, malformed Unicode/control characters, noncanonical numbers and invalid types are rejected. The new date contract is both0, or a positive int32 complete Shanghai-calendar-day interval including its last second. The original legacy endpoint and response keys remain available.

```
{owner_uid,query:{page,limit:20,grade,start,stop,keyword},
 total,total_level,filtered_count,page_count,brokerage_level,division_mode,commission,list}
// each person:
{uid,nickname,avatar_source,avatar,add_time,joined_at,time,
 child_count,order_count,number_count}
```

PHP's legacy count is the current page length. The modern `page_count` preserves it while `filtered_count` counts every matching person before pagination. The new visible “共 N 位推广人” deliberately uses that full matched count so the caption does not drop from20 to3 on the last page. The header team totals remain unfiltered. A scope note explains commission whenever keyword/date filtering is active. There is no month grouping or invented per-person commission.

Money remains signed, two-place SQL decimal strings in the new DTO and UI. Large sums and negative source anomalies are not converted through Number or narrowed to an individual decimal column. A joining/creation timestamp provides the sort boundary without exposing addresses, contact data, passwords or complete user records.

A shared SQL report is reused by both contracts. The modern service reads the active caller, relation rows, aggregates, actual global SQL configuration winner and persisted avatar metadata in one deadline-bounded repeatable-read/read-only transaction. It does not consult or fill the legacy KV configuration cache. Missing brokerage config defaults to2, explicit empty config becomes0, and the modern value is bounded to int32. Signing follows the transaction only for references authorized against the actual participant UID and attachment metadata. Stored sources remain separate from preview capabilities.

## Visible-page ownership

Search and date changes abort the old generation and reset to page1. Dates retain the submitted keyword; changing grade clears keyword as PHP does and retains the selected interval. Custom drafts never relabel the accepted date range. Failed append retains accepted people and statistics and retries the same page. Changed count, commission, team/config metadata, duplicate people or an inverted creation-time/UID boundary reject an append. Separate requests do not promise an unchanging permanent snapshot during concurrent membership changes. Display is capped at10000 people.

Hide, unload, logout, renewal and account replacement clear private rows and identity statistics and invalidate pending requests/image callbacks. At the earliest signed-avatar deadline, signed slots fall back until refresh; static/HTTPS images remain. Guests make no report read and receive an explicit login action. No confirmation modal, relationship bind, payment, withdrawal or report mutation is introduced. Date and keyword helpers are shared with the existing promoter-order page without changing its behavior.

## Verification scope

The actual Vue/Pinia page runtime suite covers20/20/3 pages, full versus page counts, failed retries, grade/date/search semantics, cancelled drafts, configuration transitions, division labels, account/session fences, strict response integrity, signed exact money and mixed media leases. The original promoter-order runtime suite checks the unchanged extracted date/keyword functions. H5, Weixin and App builds check actual registered resources/component bindings; native-device release is separate.

The native PG16 suite uses real JWT authentication and separately commissioned App LOGIN roles. It covers the relationship hierarchy, lifetime purchases versus commission scopes, all persisted role modes, config winner/empty/missing values, legacy cache sorting and NULLs, bounded JSON/date inputs, exact negative/large amounts, avatar ownership and actual R2 bytes, repeatable snapshots and complete283-table/all-sequence read-only invariants.

The opt-in `audit:promoter-people-browser` host serves actual built H5 and registered Worker reads against an owned complete fixture. Hidden Browser traverses the real finance action, pagination/truncated200/retry, search, all calendar presets/custom dates, second level, unmatched empty results, account replacement, division labels, single-level display and desktop width. QA session controls replace documents and are not a substitute for same-instance callback tests. A finite QA control changes one owned brokerage-config row from2 to1 and back; its exact delta is recorded outside business reads. Every business request compares all tables/sequences and resource identities before/after. Full source/build manifests, HTTP bytes, snapshots and process cleanup remain outside the repository for independent verification. Production/provider and native-device acceptance are not claimed.
