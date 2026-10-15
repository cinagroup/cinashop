# Actual legacy Admin product SKU generator — source investigation (2026-10-15)

Read-only source investigation. No PHP execution, tests, builds, external providers or repository edits. PHP findings below are static facts; `attr_format` is opaque, so no exact PHP runtime oracle is claimed. TS comparison is pinned to baseline commit `b2297262f76d5bdb0c12c26cba38c990ee5e2965` before the next generator implementation. JSON companion contains machine-readable contracts, required branches and full-byte SHA pins.

## What the actual endpoint does

POST `/adminapi/product/generate_attr/:id/:type` is the true endpoint, not the category editor or the activity SKU getter. Old `generateAttrApi` sends the body unchanged. The controller accepts `attrs=[]`, `items=[]`, `product_type=0`; getAttr consumes **attrs as dimension definitions**, ignores items entirely, and does not accept a current edited SKU row array as the matching authority. On positive id the controller first loads actual owner type/relation_id; the service loads the current product again, and persisted product_type wins over body. Missing positive id is refused; source does not add deleted/platform-only predicates. Success is `{status:200,msg:'ok',data:{info:{attr,value,header,product_type}}}`. [S01,S02,S03,S09,S23]

The four unrelated type concepts must stay separate: route `:type` is generation mode; main `product_type` is fulfillment; main `type` is owner0/1/2; Vue `formValidate.type=this.type` is the separate import/copy mode from query.type. Neither route mode2 nor `product_type=2` is a trusted local-copy authorization. [S03,S10,T06]

## Modes and row projection

| Route mode | Positive-id matching row | Positive-id missing row | id0 | Card projection |
| --- | --- | --- | --- | --- |
| 0 | Read current SKU | Skip combination | Emit fresh defaults | virtual_list and disk_info fields |
| 1 | Read current SKU | Emit zero/empty defaults | Emit fresh defaults | Both fields omitted |
| 2 | Same as1 | Same as1 | Same as1 | Both fields omitted |

This is the actual visible branch structure, not separate behavior invented for2. Only mode0 is tested by PHP's missing-row `if ($type == 0)` and only falsy mode exposes card fields. Visible PHP accepts other integer modes too; restricting TS to0/1/2 is an explicit supported-contract bound. Searched old Admin callers invoke0 on initial detail/draft and1 on button/rename; no Admin caller of2 was found. [S03,S10,S11]

`attr_format($attr)[1]` supplies detail objects. The service trims each detail **value**, keeps the helper's key/iteration order (sorting is commented out), joins with comma for suk, and queries ordinary type0 rows by product_id+suk. This is one SQL lookup per generated combination, with the exact select whitelist in JSON. DAO uses raw where/column and does not fetch hidden fields, filter retirement, or define a duplicate winner order. An existing SKU's unique is selected only to query virtual inventory; the response does **not** emit id, unique or suk. It emits value1..N, values=comma-joined text, detail and editable common fields. [S03,S04,S05,S06]

Common row fields: pic/string, price/settle_price/cost/ot_price/vip_price/weight/volume/brokerage/brokerage_two as floats, stock as integer, bar_code/code strings. Default rows have empty strings and numerical0; vip_price falls back0 even though not assigned in the default block. Rows are dense: count advances only for emitted combinations. Nothing is persisted or identity-allocated by this projection. [S03]

### Actual second-card SELECT omission

The explicit existing-row select is:

`unique,bar_code,code,cost,price,settle_price,ot_price,stock,image as pic,weight,volume,brokerage,brokerage_two,vip_price,disk_info`

It contains none of write_times, write_valid, write_days, write_start or write_end. Output code later reads those nonexistent keys and defaults to1/1/0/['','']; missing/default rows also resolve their section_time to ['',''] at output even though an internal default is []. Thus source's matched second-card rows do **not** actually preserve real database write-count/time settings. No SKU model accessor or DAO field expansion supplies them. A TS generator that preserves actual current write fields is a deliberate correction of the source omission and should have a regression proving that choice; do not cite the visible switch as proof PHP selected them. TS existing second-card save is single SKU/single specification and validates actual settings. [S03:530,652-657,S04,S05,S06,T02]

### Card and coupon boundaries

Source product_type1+mode0 calls getArr twice on the same matched row. getArr selects card_no/card_pwd for unique+product_id and does not filter uid, so it can echo assigned credentials too. It also exposes fixed disk_info. Modes1/2 omit both fields even for matches; they still expose common stock. TS must intentionally keep credentials unread/redacted, use aggregate counts/empty lists, and preserve source fixed-content fields only under the declared mode/permission contract. Do not run the source getArr path to manufacture an oracle. [S03,S07]

Source product_type2 has internal coupon_id=0 assignments for defaults but never emits coupon_id, and has no coupon-specific header. Old UI's actual product type selector includes only0/1/3/4. Existing TS input/editor likewise refuses2. Supporting path mode2 does not support coupon fulfillment2; refuse unsupported new or persisted type2 explicitly rather than silently producing a coupon SKU without coupon identity. [S03,S10:2336-2341,T02,T06]

## Exact Admin header contract

All entries align center. Dimension columns appear **only if at least one row is emitted**, in detail key order, with title=name, slot=valueN and minWidth130. If positive-id mode0 skips every combination, header has only the fixed columns below. [S03]

| Order | Title | slot | minWidth | Condition |
| --- | --- | --- | ---: | --- |
| after dimensions | 图片 | pic | 80 | always |
| next | 结算价 | settle_price | 120 | actual Admin product owner type2 only |
| next | 售价 | price | 120 | Admin |
| next | 成本价 | cost | 140 | Admin |
| next | 划线价 | ot_price | 140 | Admin |
| next | 库存 | stock | 140 | always |
| next | 商品条形码 | bar_code | 140 | always |
| next | 商品编码 | code | 140 | always |
| next | 重量(KG) | weight | 140 | product_type0 |
| next | 体积(m³) | volume | 140 | product_type0 |
| alternative | 卡密商品 | fictitious | 140 | product_type1 |
| final | 操作 | action | 70 | always |

No vip_price header is active; no special second-card columns are emitted here. is_supplier=true is a different shared-service call used by supplier controller: shows settlement and omits Admin sale/cost/ot_price. Do not reuse that header just because a product is supplier-owned. Admin owner2 adds settlement **and** retains Admin price/cost/ot_price. [S03:663-694,S24]

## Old Vue data flow, edits and copy

- Page `this.attrs` is the dimension array loaded from GET data.items (or cached data.items), editable via createAttrName/remove/double-click. Its per-option selection helper mutates a `details` UI property; a strict endpoint must account for bounded harmless UI echoes rather than mistake attrs for SKU rows. Empty attrs occurs on ordinary single-spec initial load: infoData loads [] and unconditionally calls generate(0). The opaque helper's exact empty behavior is not proved; target can explicitly choose empty attr/value plus fixed header without treating this auto-call as malformed. [S10:3108-3120,3422-3464,3911-3934]
- Body contains only `{attrs:this.attrs,product_type:formValidate.product_type}`. Client unsaved manyFormValidate prices/cards/identity are not sent to this generator. The server can therefore reload persisted matching values rather than preserve unsaved prices; a TS server cannot infer them from ignored items. [S09,S10:3867-3868]
- On success Vue reads res.data.info, deep-copies full header into formValidate.header, takes info.attr into attrData, removes final action from info.header for batch columns, adds select=true to rows and invokes client getAttr for selection controls. Mode1 addmanyData overwrites every pic with main image, not merely missing pics. Async initial generate(0) can replace manyFormValidate after infoData seeded data.attrs. [S10:3853-3900,S11]
- Rename mutates the dimension first, then calls generate(1,callback); callback string-replaces old option text in existing rows/detail instead of applying server value rows. This preserves some local edits but does not authorize mutating an existing stored SKU's identity. Existing TS save's no-rename/no-delete invariant still applies. [S10:4409-4434,T02]
- Copy loads source GET via route id or query.copy, retains source productInfo.id for generation, and calls mode0. Only submit later sets id0 and clears soure_link. There is no copy flag in generator body/path and no route-mode2 special copy branch. External import query.type controls a separate form mode (`-1` suppresses an initial replacement in generate). Full mounted copy and trusted copy HTTP policy remain future work. [S10:2880-2885,4008-4025,4245-4252]

## Permission and side-effect facts

Installer API seed is **191**, parent22, auth_type2, POST `product/generate_attr/<id>/<type>`, menu_path `/adminproduct/generate_attr/<id>`, unique_auth empty, access1/is_del0. Seed620 is a separate GET product detail. Exact seed191 should gain only a dedicated generator capability (planned `product.sku_generation_view`), not complete product.manage. Modern product.manage may generate; product.view/620 must not inherit generator just because results are read-only. Current baseline TS broad product POST fallback would otherwise map191 to full manage; isolate both runtime route and legacy tuple resolution, including forged metadata, role delegation and retained opaque menu classification. [S12,S17,S18,T05]

Visible getAttr+SKU/card DAO path has no save/update/delete/sequence and does not call checkProductAttr; controller checkActivity is commented. The encoded helper cannot be audited for executed purity. At the HTTP boundary the source route group additionally runs AdminLogMiddleware, dispatches AdminLogJob, and that job writes SystemLogServices.recordAdminLog. Therefore "source generator has no visible product DML" is accurate; "entire PHP HTTP chain never writes" is false. The TS design can deliberately be pure RR READ ONLY with live auth and final database-clock expiry, with no business audit/outbox/provider/sequence writes. [S01,S02,S03,S08,S19,S20,S21]

## attr_format implementation provenance and proof limit

No readable definition was found in app/common.php or searched readable PHP source. Composer explicitly autoloads app/helpers.php and the installed composer list does too. helpers.php is a105440-byte `swoole_loader` encoded payload, and the literal function name is not visible. This makes it a likely implementation source but does **not** prove that its encrypted contents define attr_format. The call sites prove only that return index1 contains entries with detail maps. Exact helper validation, empty/numeric-key handling, duplicate normalization and Cartesian order are not execution-proved. Record an intentional bounded, deterministic ordered Cartesian contract in TS; do not claim an unrun source oracle or invent an external implementation. Hash the entire raw payload, not decoded lossy text. [S03,S13-S16]

## TS comparison and recommended implementation

Existing ProductSkuInput already normalizes1..3 dimensions, names32, options1..50/value64 and combinations200; buildSkuCombinations checks after each expansion, so the new endpoint should pre-check multiplication before allocating. Existing strict SKU normalizer requires complete populated rows and positive sales price, so it cannot be used for zero-price generated templates. Reuse dimension validation selectively with explicit empty handling/comma/control/prototype rejection; build a separate read-only legacy generator projection. [T01,T02]

ProductSkuEditorService loads real actual write fields and active/retired rows, and replaceProductSkuEditor is a mutation path with advisory/row locks, unique allocation, DML and inventory invariants. Never call replace/rebuild from generator. Match active ordinary rows only, refuse ambiguous duplicates/retired collisions, use explicit budgeted/select-only SQL, and never let generation resurrect retired rows or establish new identity. Retaining actual second-card values is an explicit source omission repair. [T02,T07]

Modern Admin ProductForm uses a local skuCombinations/regenerateSkuRows/template flow, keyed by current client row.suk. New local rows inherit main price/stock rather than source generator0 defaults. It uses modern image/DTO and `/product/detail/:id`, `/product/add`, `/product/edit/:id` APIs; no actual old generator call is wired there at this baseline. Supplier TS endpoint reads body.items and returns `{items,combinations}`, without legacy info/header/current-product matching; do not expose it as Admin parity. [T03,T08,T09]

Recommended target: `AdminLegacyProductGenerateService.generate(id,mode,body,actor)` under actual legacy POST, shared current read authorization with an isolated exact191 generator permission, source envelope/header/no id/unique output, owner/product_type from current main, mode0 skip and1/2 default semantics, intentional credential redaction, preserved actual second-card settings and supported0/1/3/4 only. Use RR READ ONLY, bounded SQL projections before loading historical text, no provider, final PG clock expiry, classified old-Axios rejecting failures. Capacity and compatibility differences must be explicit. This endpoint alone does not complete old Vue generation/edit/copy migration.

## Required branch tests

1. Actual old generateAttrApi/request/Axios -> real Hono/JWT/SQL: response.data.info attr/value/header/product_type and classified failures reject.
2. ID0 modes0/1/2 with ordered dimensions produce fresh default rows; never allocate id/unique or write row/audit/outbox/sequence.
3. Positive ID current owner and product_type win over forged body product_type/type/relation fields; nonexistent/deleted/foreign-owner policy explicit.
4. Mode0 mixed matched/missing combinations emits matching subset only; mode1/2 emit complete combinations with defaults for missing; all-missing mode0 fixed header only.
5. Matches only current ordinary active SKU; no activity type rows, no retired resurrection, no stale attr_result data, duplicate/ambiguous topology refused.
6. Positive-ID matches preserve monetary values, stock and fixed-content contract; no stale submitted items/rows may override SQL truth.
7. Header exact order/title/slot/minWidth for new platform, owner0/1, owner2 and each supported product_type; no supplier-only header leak.
8. Card mode0 virtual_list stays empty with aggregate uid0/total counts, actual fixed disk_info preserved; modes1/2 omit disk_info and virtual_list by explicit source contract. Assigned cards and stale snapshots never leak.
9. Actual SELECT-only non-superuser LOGIN reads through service despite card_no/card_pwd SELECT denied; card credentials, DML and nextval prove denied.
10. Second-card default rows use1/1/0/empty dates, matched rows preserve actual SQL writeTimes/writeValid/writeDays/start/end as documented source-select repair; enforce one combination.
11. Body product_type2 on id0 and persisted product_type2 on existing ID rejected as unsupported; route mode2 remains supported for0/1/3/4.
12. Empty attrs automatic single-SKU call produces deterministic empty value/fixed header; malformed dimensions, >3, >50 values, >200 Cartesian product refused before allocation.
13. Whitespace/comma/control/numeric-key/prototype-key/duplicate name/value cases and bounded ignored items/details UI echoes; strict canonical path/mode/query/body size/UTF8.
14. Exact seed191 generates and cannot save/mutate; product.manage generates; product.view/620/order.view and forged191 method/path/authType/uniqueAuth/rewritten unrelated tuple rejected.
15. RR same-snapshot peers update current main owner/product_type/SKU/catalog facts; current result stable, next call sees change; actual DB clock expiry wins over frozen app clock.
16. Private asset URLs use actual stored product owner under current metadata ACL; no provider/network; whole DB/sequence snapshot unchanged on success and every refusal.
17. Rename callback preserves client unsaved row values without trusting them as DB identity; source copy flow keeps original ID until submit and is not silently granted trusted-copy behavior.
18. Actual Vue mounted copy/edit/generator integration remains separate acceptance; DTO helper and local modern template generation do not prove full six-step editor completion.

## Source and baseline pins

| Ref | Absolute source path | Lines | Full-file SHA-256 |
| --- | --- | --- | --- |
| S01 | `/home/cina/cinagroup/cinashop-php/route/admin.php` | 1464, 1534-1535, 1658-1663 | `8350eca9e328ed615cea117089589274d7e262324b979af588a714415f522652` |
| S02 | `/home/cina/cinagroup/cinashop-php/app/controller/admin/v1/product/StoreProduct.php` | 593-619 | `c25566e19ed22fdec15380467996f821f4f57a38ea915a39599404e962c6ba60` |
| S03 | `/home/cina/cinagroup/cinashop-php/app/services/product/product/StoreProductServices.php` | 502-695 | `edf89202f65c2f6b161dbbccdb7cc68ef6270ae31c11afe91ab26aa285722943` |
| S04 | `/home/cina/cinagroup/cinashop-php/app/services/product/sku/StoreProductAttrValueServices.php` | 282-285 | `eb77e534bf4aa2beb1881eea73e1012631141128ea85cbf3cd6256a98393b5f8` |
| S05 | `/home/cina/cinagroup/cinashop-php/app/dao/product/sku/StoreProductAttrValueDao.php` | 119-138 | `a6c3f481a168544605185059287e9e86c541a31b296a82d18421725dc05e3b8e` |
| S06 | `/home/cina/cinagroup/cinashop-php/app/model/product/sku/StoreProductAttrValue.php` | 25-58, 89-106 | `5f314d6aa61ea7cbf86803616cb49e948b441d9c69dd09a6f78e6ed54de2366d` |
| S07 | `/home/cina/cinagroup/cinashop-php/app/services/product/sku/StoreProductVirtualServices.php` | 32-39 | `1a44c129483d02f79b0f70f972fd5954b543eb7afb246a9e083de99e887613a1` |
| S08 | `/home/cina/cinagroup/cinashop-php/app/dao/BaseDao.php` | 136-145, 172-175, 198-204 | `43fd77897402aed4ccf5f3504251df696ccc8ab4a1decdc6c1054ecb208ea603` |
| S09 | `/home/cina/cinagroup/cinashop-php/view/admin/src/api/product.js` | 268-277 | `54d74b9804719d3e35d3eb9942c76af886a1cf9dc12f8204adb9e9e0ddc72e42` |
| S10 | `/home/cina/cinagroup/cinashop-php/view/admin/src/pages/product/productAdd/index.vue` | 633-643, 2336-2341, 2498-2508, 2536-2545, 2670, 2788-2838, 2880-2885, 3108-3120, 3422-3464, 3853-3900, 3911-3934, 4008-4025, 4162-4169, 4245-4252, 4409-4434 | `3146b4167f07bdcdd5f996be46a1e7f7801465e8b06c7afdfa81543dcea7019f` |
| S11 | `/home/cina/cinagroup/cinashop-php/view/admin/src/pages/product/components/productDetails.vue` | 2990-3002, 3401-3437 | `c241be57347a9ba5ac66dad8a95919247232fa31128928c3060f8377e631fb6f` |
| S12 | `/home/cina/cinagroup/cinashop-php/public/install/crmeb.sql` | 8660, 8676, 8775, 9101 | `0096d86464b81935106311e4bb4092b647ab3acaf2bab0febe5695f8f66c593a` |
| S13 | `/home/cina/cinagroup/cinashop-php/composer.json` | 57-67 | `2651664ff3cb15ac5968ffbc1a1f5b29c6a4b3c17e8a0c9d923788cf2629277f` |
| S14 | `/home/cina/cinagroup/cinashop-php/app/helpers.php` | 1 | `5ed1ad26409bc86839701855d620c3855f34163d76bd88be2243031f98f5d8a5` |
| S15 | `/home/cina/cinagroup/cinashop-php/app/common.php` | 1-20 | `aa8ec005680a709ae3f7324dadcbe91c8e305c0a685e1b7c08f3b24f1d63c8f9` |
| S16 | `/home/cina/cinagroup/cinashop-php/vendor/composer/autoload_files.php` | 33 | `005b23153fab8435c097ae057e1e51f23506ddb5b3f8aee00c2f12615dd85d26` |
| S17 | `/home/cina/cinagroup/cinashop-php/app/http/middleware/admin/AdminCkeckRoleMiddleware.php` | 28-39 | `61d841ef746d5e8031f9ad4d24bc351c7f742659f8fa0b4d62af8f2ce9e48881` |
| S18 | `/home/cina/cinagroup/cinashop-php/app/services/system/SystemRoleServices.php` | 92-116, 125-150 | `9c85f2b36a3584e6fb87fc79a20a819001a13c5e1490a7a20513794cdf7d906d` |
| S19 | `/home/cina/cinagroup/cinashop-php/app/http/middleware/admin/AdminLogMiddleware.php` | 31-38 | `d1c2ec74ae5f9ff88b1f73e1183ee906a26085381f2606a77484fc68028cd8f2` |
| S20 | `/home/cina/cinagroup/cinashop-php/app/jobs/system/AdminLogJob.php` | 30-32, 44-53 | `97498993ec646463ce2825448c7d6a9040b53afe23987096f8c478e779db1535` |
| S21 | `/home/cina/cinagroup/cinashop-php/app/services/system/log/SystemLogServices.php` | 46-67 | `71944fc9e0a5d039f22eb33f6802c0b284f33b3c746e1a5ac294eb502c00ac00` |
| S22 | `/home/cina/cinagroup/cinashop-php/config/app.php` | 36-38 | `2fb949c2609d813c05ae974aef4379957decc2be6ad56d56be822c264820cfb3` |
| S23 | `/home/cina/cinagroup/cinashop-php/crmeb/utils/Json.php` | 66-83, 97-107, 115-122 | `b6d6bc57ab5ee6e8fdb66b7cd294e7a23b17737d526eae94ca02768ddb0208f5` |
| S24 | `/home/cina/cinagroup/cinashop-php/app/controller/supplier/product/StoreProduct.php` | 410-420 | `f277e42009e9a4250c15e9731f8d54b47f502f36ce5a8e6fd8d62a37e1fb93c1` |
| T01 | `/home/cina/cinagroup/cinashop/workers-ts/src/services/product/ProductSkuInput.ts` | 122-150, 185-251 | `c96247e8ac7befe362e9d2596c2d2a69d9b113930aa6c388ec1a78755ab1f23f` |
| T02 | `/home/cina/cinagroup/cinashop/workers-ts/src/services/product/ProductSkuEditorService.ts` | 108-194, 241-330, 584-678 | `579c27f721ef0a01cf37685da8d923c2e1ae8f7aceba9b279554d0d3c4acc2b2` |
| T03 | `/home/cina/cinagroup/cinashop/workers-ts/src/controllers/supplier/SupplierController.ts` | 708-718 | `918b94773986a2703fafecf233fd6bc912f931ef45d470c799bb7e1b4d4165ce` |
| T04 | `/home/cina/cinagroup/cinashop/workers-ts/src/routes/adminapi.ts` | 305-306, 421-426 | `d8882a1782a22c3b144a662ef8239b6d88a7c68671f44827e89bf69acaf43a1b` |
| T05 | `/home/cina/cinagroup/cinashop/workers-ts/src/services/admin/AdminPermissionService.ts` | 58-63, 466-495, 630-631, 1666-1680 | `6ab97a3585adfb0b978214ac8e87e5952f8c539184750dc38846b20e3a94b90f` |
| T06 | `/home/cina/cinagroup/cinashop/workers-ts/src/services/admin/AdminLegacyProductInput.ts` | 178-185, 197-220 | `ff09af33cff61cfbcaf0ec38aa942cc7364a9485462f32669c0b7c4cde8aa248` |
| T07 | `/home/cina/cinagroup/cinashop/workers-ts/src/services/admin/AdminLegacyProductReadService.ts` | 110-128, 151-165, 264-273 | `ecf74aec76992f9ab0c0209bca461538b04d9f2f8a8c601074c2e73139d86a5c` |
| T08 | `/home/cina/cinagroup/cinashop/view/admin-ts/src/pages/product/ProductForm.vue` | 13-16, 192-216, 538-561, 607-651, 839-868 | `78f5c7ce4149accace5e62b833c4115cee87197d497eb0378c492c296dafbb8f` |
| T09 | `/home/cina/cinagroup/cinashop/view/admin-ts/src/api/product.ts` | 29-94, 399-425 | `fa89248718515698885a8160da43ac3eafeb66f8ad7a465b6f02f6390264c1ec` |
| T10 | `/home/cina/cinagroup/cinashop/workers-ts/test/product-sku-editor-migration.test.ts` | 28-70, 73-104 | `48a6474a037f31b0c45af86732d3aaf0b6cbef85c8db8e957da7e6f556c3894d` |

S pins are current raw-byte source files; T pins are file content from the named baseline Git commit, retained as a comparison even when the next implementation edits those files. S14 line1 means only the readable loader prefix; the whole binary payload SHA remains authoritative. No hidden helper plaintext or real source datasets were executed.
