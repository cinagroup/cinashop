# Legacy product generator independent static review

Reviewed 2026-10-15T05:02:52.187136+00:00 against actual shared source plus the pinned PHP generator investigation. No reviewer-run tests, typechecks, builds, PHP execution, providers or migrations. No repository source was modified during this review. The reviewer authored the new native test file and the original budget helper in earlier delegated tasks; their inspection here is not a second independent implementation review of those authored portions.

## Disposition

No additional confirmed P0–P2 code finding in the selected bounded generator contract. The exact191 grant is isolated from product writes, the new endpoint reads a genuine RR READ ONLY snapshot, and response modes do not expose card credentials or allocate identities. Release gates are still unproved at this review point: generator-core has no completed receipt and its observed log is empty. This is a static review result, not test certification.

## Capacity and projection

- Service lines15 and70 select only main id/type/relation_id/product_type. Huge irrelevant custom_form/description fields are not first loaded and rejected afterward. The SKU projection is an explicit constant list (lines16-23), with a WHERE-scoped SQL aggregate budget before its actual SELECT (lines76-79). It includes potentially large disk_info and varchar string bytes; no text payload is transported by preflight.
- Budget helper's new optional selectedColumns only narrows the declared trusted internal projection. Existing GET callers omit it and retain the original full-column accounting. The generator passes Object.values(skuColumns), identical to its actual selected fields. Row count is still based on LIMIT10001, not a filtered subset after loading; outer sum refers to the subquery scalar alias. No external field list, table or predicate is accepted.
- HTTP body uses the existing strict duplicate-key JSON parser and UTF-8 streaming 64 KiB bound. Dimensions are normalized/bounded before Cartesian allocation: up to3 dimensions,50 values each, codepoint names32/options64, unique normalized names/values, no comma/control/surrogate/reserved prototype names, total combinations<=200. Bounded ignored items/UI echoes cannot set SKU prices, inventory or ownership.
- Returned rows are generated once per distinct normalized combination. A matched stored row cannot be amplified into arbitrary repeated copies by duplicate body options. SQL1 MiB selected-row budget plus200 combinations bounds the subsequent response allocation; final actual1 MiB response guard is not the sole protection. Current asset/auth helper queries have their existing independent boundaries; do not describe this SKU preflight as a cumulative budget for every auxiliary auth/asset query.
- mode1/2 still budget/select disk_info although it is omitted from their response. This is a deliberate stricter raw-read capacity bound, not silent field truncation. An over-limit historical complete set may be refused even if the requested output subset is small.

## Source modes, header and identities

- Positive id loads actual parent owner and product_type; missing parent fails. A valid forged body product_type0/1/3/4 does not change an existing product's effective fulfillment. New id0 uses body/default type. Unsupported type2 is explicitly rejected; path mode2 remains an independent valid generation mode. Unsupported body type values are rejected by input validation even for an existing id rather than ignored; this is a validation narrowing, not an ownership bypass.
- Only active ordinary type0 SKU rows are matched. Existing active duplicate suk/unique maps are refused. Retired/activity rows do not supply existing values. Mode0 skips requested missing combinations; modes1/2 include defaults. The latter can show a default candidate matching a retired historical name, but generation cannot restore it and the existing save primitive still forbids ordinary-save resurrection. Do not call the generated rows proof that all subsequent saves will be admitted.
- Empty attrs produces empty value with static header for the source Vue's unconditional single-spec auto-call. When mode0 emits no rows, the dimension header is absent. Admin supplier-owned rows add settlement while retaining sale/cost/ot_price; ordinary and card fulfillment add their own source columns. Header order/widths and final action column match the visible PHP code. Numeric-key/empty/helper normalization behavior is an explicit TS deterministic contract because attr_format is opaque.
- Each row has values/detail/valueN plus source editable numeric/string fields. No id, unique or suk is emitted; no identity generator or mutation primitive is called. Submitted items/current SKU echoes are ignored as source generation semantics require.

## Cards, fixed contents, second-card rights and media

- No card_no/card_pwd or stale attr_result text is selected. Only product_id/attr_unique/uid aggregate inputs are used, and only for positive-id card mode0. Assigned cards contribute to total but not available; virtual_list remains empty.
- Card mode0 exposes real fixed disk_info under the explicitly selected source generator191 authority. This is not a claim all delivery contents are redacted. Modes1/2 omit disk_info and virtual_list, including matched fixed-content rows, exactly as the visible source branch does. They do not establish trusted-copy state or copy credentials. Source mode0's double getArr credential read is deliberately not reproduced.
- Matched second-card write_times/write_valid/write_days/start/end are selected and projected from real SQL values; Shanghai date rendering uses the existing range bound. This intentionally corrects PHP's omitted SELECT fields rather than pretending source preserved those values. Fresh defaults use1/1/0 and empty section_time; source eventually formats two empty date strings, so [] here is a small declared template normalization rather than byte-identical source output. Inputs with more than one generated combination are refused for type4.
- Private image references are checked against actual persisted parent ownership and current metadata in the same snapshot, then signed after the transaction. Request owner/type/relation fields are ignored; no provider or R2 byte delivery occurs. Source-image and metadata authorization changes require fresh reads; this is not mounted frontend acceptance.

## Exact191 permission isolation

`AdminPermissionService.ts:301,306` defines product.sku_generation_view and permits product.manage as the containing modern capability. product.view and seed620 do not satisfy it. The synthetic key is intentionally absent from selectable stored permissionKeys; actual seed191 can resolve to it internally without becoming a canonical role token.

`requiredAdminPermission` catches the entire product/generate_attr namespace before generic product POST mapping. Only canonical POST id/mode route shapes return the dedicated capability; other verbs/children fail closed. Route controller validates canonical numeric bounds again. No-store middleware covers the namespace even when admission rejects before controller.

`productGenerationMenuBinding` at lines796-805 treats **id191 itself** as protected even if all path/method/auth fields are rewritten. Only exact auth_type2, POST, API product/generate_attr/<id>/<type>, menu_path /adminproduct/generate_attr/<id> and empty unique_auth return the generation key. Both live SQL menu resolvers retain existing type1/access1/not-deleted filters and share the protected branch before unique_auth, page mapping or generic API fallbacks. Copied generator paths under another menu id likewise return no grant; a forged product.manage field cannot win over the protected branch. canRetainOpaqueLegacyMenu rejects protected claims, preventing a malformed191 from being retained as an unproved opaque grant.

Consequently exact191 alone cannot become product.manage/product.view or pass the full-save gate. A role that already separately owns product.manage can still generate and write by that separate authority. The new tests cover actual SQL single/many resolution, tuple rewrites, access/deletion filters and real old helper191/620/105 separation, but their current execution has not been certified here.

## Shared authority, transaction and error boundaries

The extraction from previous GET preserves current platform account/adminType/relation0/status/not-deleted/level, password-version constant-time comparison, bounded role-reference history, active role/menu resolution and final database clock_timestamp expiry. It adds a permission parameter whose default stays product.view; the new generator passes only its fixed dedicated capability. It is not a request-controlled required permission. No write authority barrier or row lock was introduced in this read helper.

Generator sets RR READ ONLY before current auth/main/SKU/card/asset reads, with local statement/lock/idle deadlines. Preflight and materialization see the same snapshot, including absent rows. Native timing proxies pause only after real authority SELECT and do not fabricate SQL results. The planned fresh peer snapshot/expiry test is meaningful but remains unrun evidence until the parent has a successful native receipt.

Only known contention codes55P03/40P01/40001 become409 and known permission/timeout/missing-column/table readiness codes become503. Controller converts classified409/503 into the existing rejecting old-Axios status400 envelope; unknown exceptions are rethrown and preserve the global unknown-error boundary. No visible business DML, audit/outbox insert, sequence or SKU repair occurs. The legacy source's route-level async access audit is a documented difference, not a hidden TS write obligation.

## Evidence status and scope

Directly inspected generator-initial-status.json records exit1 at2026-10-15T04:58:21Z before tests started: shared validation.lock open failed with Read-only file system. Its cwd was the repository root. This is infrastructure/pre-launch failure, not a failed generator assertion. Parent reported a corrected-cwd/escalated generator-core attempt; at review its log was0 bytes and there was no completed status. Neither that attempt nor native/type gates is counted as passed.

Source reports remain `/tmp/cinashop-product-generator-source-20261015.md` and `.json`, with24 PHP full-byte pins and10 TS/modern Vue baseline Git pins. attr_format's exact encrypted helper implementation remains unexecuted; ordered Cartesian/default/empty behavior is a supported target contract. Full mounted Vue edit/generator/copy, unknown save-outcome recovery, product_type2 coupon fulfillment, production ACL/provider acceptance and original PHP description source normalization remain open. This review does not close the migration objective.

## Actual reviewed file SHA-256

- `src/services/admin/AdminLegacyProductGenerateService.ts`: `8164ba13773e75013927b78b535866c5239f7580b2c9eee7487072571161d7d0`
- `src/services/admin/AdminLegacyProductGenerateInput.ts`: `dbe0de34428b53e95db8198481cd9a1060280c960e04b4b0dd40515b30bf3f5c`
- `src/controllers/api/v1/AdminLegacyProductGenerateController.ts`: `d2479beaad5547c8b6817f683358c50820b1a15515f494faf1be1e73a48419a8`
- `src/services/admin/AdminLegacyProductReadAuthority.ts`: `50984ed698767bd966362fb3880e652917ec72c93d351e567254fb818a114cb1`
- `src/services/admin/AdminLegacyProductReadBudget.ts`: `b171b1d016a1033d2ddee1b23fc7e594ce776060e8d06e55fb2e61d6f3c877a2`
- `src/services/admin/AdminLegacyProductReadService.ts`: `2fb2a8714b043d02ef4add3cbe0d3228b5918278c94f0d20ce60f87455f8913d`
- `src/services/admin/AdminPermissionService.ts`: `63d25d84b865af57f0240011986e77f66a17f9e350b9cc3c01e113377c9819f1`
- `src/routes/adminapi.ts`: `437e43e31ec86a63d7acb62a0661499b3dd62db57987a76f82c7c80b325917fe`
- `test/admin-product-generate-permission.test.ts`: `b8a992d8f5e2e33a8cb461a01c6af615800b3d355b490eb489a408936e87784d`
- `test/admin-legacy-product-generate.test.ts`: `b76b6d6b009f9a842bdacc8a459544ea53297b640e676544ac4d28393808dea9`
- `test/admin-legacy-product-generate-http.test.ts`: `acdd122086a51f04a2456347c851298e86f86061dbdb4c99aa8900dcde5f6f7f`
- `test/admin-legacy-product-generate-native.test.ts`: `dacb4c23d4ee0dee447eeb7e2448fd9a1165da4174790abd805bcd58be6c668f`

## Follow-up observation — 2026-10-15T05:03Z

The earlier empty-log/no-completion observation above records the first inspection during this review and is retained as history. A later direct read now confirms generator-core-status.json completed exit0 at05:01:53.520901Z in the correct workers-ts cwd. Its matching log has3 files/31 tests passed, Vitest start05:01:30 and duration22.97s. The command's earlier start04:58:36 includes shared serial-lock waiting; this is one successful execution, not another test attempt or duplicated coverage. No failure from that wait is inferred.

Current service line104 now emits fresh second-card section_time as `[date(0),date(0)]`, namely `['','']`, matching the effective PHP output. The corresponding ordinary test expectation is synchronized. This supersedes the initial static paragraph's earlier `[]` template difference; actual stored second-card write fields remain preserved as the deliberate PHP omitted-select correction. Removing the unused HTTP import changes no runtime behavior.

The core result predates these last tiny source/test edits. The parent reports a five-file generator-http run in progress; no completed result for that run, native gate or typechecks is certified here. Current directly rehashed files:

- Generate service: `8164ba13773e75013927b78b535866c5239f7580b2c9eee7487072571161d7d0`.
- Ordinary generate tests: `b76b6d6b009f9a842bdacc8a459544ea53297b640e676544ac4d28393808dea9`.
- HTTP generate tests: `acdd122086a51f04a2456347c851298e86f86061dbdb4c99aa8900dcde5f6f7f`.

No additional confirmed P0–P2 issue arose from this small output alignment. Final current-input validation remains required.
