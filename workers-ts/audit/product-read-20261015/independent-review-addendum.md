# Product GET review addendum — bounded editor projection and source encoding

Reviewed 2026-10-15T04:43Z against the actual shared worktree. The original `independent-review.md` is retained as historical evidence; this addendum updates its dispositions. This reviewer ran no tests, typechecks, builds, migrations, providers or stress reproductions, and edited no repository source during this follow-up. The SQL budget helper was authored by this reviewer in the preceding delegated task, so its inspection here is not an additional independent implementation review.

## Release disposition

No remaining confirmed P0–P2 code blocker for the explicitly bounded incremental GET batch was found after the latest 768 KiB guard. The original two P2 findings are addressed by SQL preflight plus bounded projections, by moving new read-only expansions outside `productInfo`, and by refusing an oversized complete editable DTO before preview/signing. The form duplication example discovered during this follow-up is addressed by deliberate capacity refusal, not by proving that every accepted POST can later be edited through this GET.

The newly added 768 KiB rejection case and final current-input validation must still pass before publication. The observed completed receipts below predate this last guard/test; they are not evidence that the newly added case passed. Source-import description normalization and full Vue/generator/copy integration remain explicit migration gaps and are not completion claims of this batch.

## Fix verification from current source

- `AdminLegacyProductReadService.ts:151-165` authorizes first and then preflights main, ordinary dimensions/SKUs, ordinary description, product coupons, platform shipping/category collections and site configuration before full main/collection reads. `:185-199` derives current main selections and performs phase two with the remaining shared 1 MiB budget before loading label, coupon-issue, recommendation and current form rows. Both phases share the same RR READ ONLY transaction; concurrent writes cannot replace already-budgeted bytes between preflight and materialization.
- `AdminLegacyProductReadBudget.ts:28-52` counts a WHERE-scoped LIMIT 10001 subquery. Its inner projection calculates row bytes from actual PgText/PgVarchar/PgChar `octet_length` plus 64 bytes per column and 64 per row. The outer sum references the subquery's scalar `row_bytes` alias rather than an out-of-scope original table column. Only two aggregate decimal values cross the driver boundary; BigInt checks avoid sum precision loss. Empty rows cost zero, including a zero remaining budget; more than 10000 rows or a cumulative overflow produces 503. This helper has no DML, sequence operation or row lock. No card table is passed to it, and inventory aggregation still selects only product_id/attr_unique/uid inputs.
- `AdminLegacyProductReadService.ts:43-52` bounds decoded JSON nodes (30000), depth (24) and arrays (1000). `:74-87` rejects more than 100 current form fields before mapping the eight-field formatter. Dimensions still check the Cartesian product before allocating combinations (`:99-106`). Together with the SQL byte preflight these remove the original unbounded text transport and 100000-row form expansion paths; the final 2 MiB serialization check is now a final response limit rather than the sole memory bound.
- `:222-230` retains source-required `custom_form` and `custom_form_info`, checks the actual UTF-8 JSON size of the full `productInfo` at 768 KiB before preview/signing, then places `stored_custom_form`, `retired_attrs` and `description_preview` in the sibling `editor` object. The old Vue's whole-productInfo echo therefore no longer includes the newly introduced duplicate description or the historical snapshot/retired extensions. Actual fixed SKU delivery content is still retained, not silently blanked.
- `test/helpers/adminLegacyProductRead.ts:5` now mirrors physical-product supplier echo as `product_type === 0 ? relation_id : 0`. This agrees with pinned Vue `infoData` (`productAdd/index.vue:3439-3442`) and `productTypeTap` (`:3258-3267`). Ordinary test `admin-legacy-product-read.test.ts:168-175` covers real pending owner1/cart behavior after read-save. It is a handwritten consumer transform using the real HTTP API/request/Axios source; it is not a mounted Vue proof.
- `routes/adminapi.ts:421-426` retains literal GET get_rule/rule registrations ahead of the dynamic GET `:id`, and the existing actual rule HTTP file is included in the parent's native regression. The controller still maps classified 409/503 to the old helper's rejecting status400 envelope and marks reads private/no-store (`AdminLegacyProductReadController.ts:8-15`).

## Capacity narrowing is part of the contract

During this follow-up, the first metadata relocation alone left a concrete source-field duplication path: a current template containing `[{name:'texts',value:'x'.repeat(500000)}]`, an empty stored custom_form, and a 100000-byte description. Approximately 600 KiB of raw SQL text fits the 1 MiB preflight and field/node guards, but productInfo formerly duplicated that 500000-byte value in both custom_form and custom_form_info, yielding an approximately 1.1 MB old whole-form POST. The initial save selecting that template with custom_form=[] fits the POST limit.

The current source deliberately refuses that GET at the full editable DTO guard. The new genuine old API/helper test `admin-legacy-product-read-http.test.ts:122-127` first accepts the selected-template save, then requires the GET to reject with the 768 KiB message and verifies the entire business snapshot is unchanged. This is an acceptable explicit limit for this incremental release. It does not truncate the current template or alter the old source-required formatter. The supported long Unicode description roundtrip remains covered separately at `:111-119`.

Do not describe 768 KiB as a universal roundtrip theorem. The reserved headroom is for normal submit-time SKU/coupon/selection expansion. Historical field values, JSON topology, identifier limits, authentication changes and the stricter POST contract can still make a product unavailable for unchanged editing. A valid POST can also select a subsequently oversized live template. Classify these complete-read refusals and document the limits; do not claim all accepted saves or all historical products can be reopened through the old editor.

## PHP description import is a confirmed provenance gap, not a new safe-push blocker

The actual PHP call chain is more specific than the earlier source report's shorthand "decode once":

1. `StoreProductServices.php:982` calls `StoreDescriptionServices::saveDescription`; that method applies `htmlspecialchars` before SQL persistence (`StoreDescriptionServices.php:52-61`).
2. `StoreDescriptionDao.php:40-42` calls BaseDao::getOne. BaseDao `:172-175` delegates to `get`; `:143-145` returns a Think model via find(). The `StoreDescription` model accessor applies `htmlspecialchars_decode` on the description property (`StoreDescription.php:32-34`).
3. `StoreDescriptionServices::getDescription` accesses that model property and explicitly calls `htmlspecialchars_decode` again (`:38-42`). `StoreProductServices.php:400` uses that service result for the true editor GET. Thus the normal model/property path performs two decode stages; exact literal-entity behavior must be tested in a future source normalization contract rather than guessed from the service alone.

Current TS saves canonical editable raw HTML without PHP escaping (`AdminLegacyProductSaveService.ts:68,174-175`) and GET canonicalizes private references without a general HTML entity decode (`AdminLegacyProductReadService.ts:214`; `ArticleContentPolicy.ts:243-264`). For TS-created rows this preserves literal text and avoids accidentally converting an intentional `&lt;...&gt;` into markup. Blindly adding one or two decodes to GET would corrupt the raw TS contract and is not an appropriate patch for mixed-source data.

The generic migration path currently preserves this difference: `scripts/data-migration/manifest.ts:374-377` registers the description table's logical key but no encoding normalization; `runner.ts:307-313` treats text-to-text as directly compatible, and `:1277-1281,1313-1326` reads raw MySQL columns and applies only the listed type conversions (`:24-32,1044-1118`), none of which is HTML decode. Therefore a PHP storage row `&lt;p&gt;商品&lt;/p&gt;` is imported unchanged, and the current TS editor returns that escaped text rather than PHP's effective `<p>商品</p>`. This is a real source-data semantics gap, not evidence that PHP snapshots have already been imported successfully.

For this explicitly limited code push it is a documented follow-up, not a reason to broaden GET into heuristic entity decoding. It blocks acceptance of "raw PHP descriptions are fully migrated/equivalent" and of production use of unnormalized legacy description rows as a completed source migration. A future change needs explicit source provenance or one-time audited import normalization, retained source values/checkpoints, and tests for ordinary markup, literal named/numeric entities, nested encodings, private assets, and raw TS rows. No live MySQL/PostgreSQL source dataset or production commissioning was inspected in this review.

Exact source references for the correction (full-file SHA-256):

| Path | Relevant lines | SHA-256 |
| --- | --- | --- |
| `/home/cina/cinagroup/cinashop-php/app/services/product/product/StoreProductServices.php` | 400, 982 | `edf89202f65c2f6b161dbbccdb7cc68ef6270ae31c11afe91ab26aa285722943` |
| `/home/cina/cinagroup/cinashop-php/app/services/product/product/StoreDescriptionServices.php` | 38-42, 52-61 | `ba4f5434c0d76432fe962eac2f8f8cca233753c6259438fbc018b80224094acd` |
| `/home/cina/cinagroup/cinashop-php/app/model/product/product/StoreDescription.php` | 28, 32-34 | `90582355c2949f87c5590c259e8ea2e74e48ed6dfc61253ff4f35a67e913799f` |
| `/home/cina/cinagroup/cinashop-php/app/dao/product/product/StoreDescriptionDao.php` | 40-42 | `8fbe9fc7c6f0533e19bc21c434b2b20abf7f01cf989012f0fe42c19644223e11` |
| `/home/cina/cinagroup/cinashop-php/app/dao/BaseDao.php` | 136-145, 172-175 | `43fd77897402aed4ccf5f3504251df696ccc8ab4a1decdc6c1054ecb208ea603` |
| `/home/cina/cinagroup/cinashop/workers-ts/src/services/content/ArticleContentPolicy.ts` | 191-201, 243-264 | `28fa50b40dcdd61d08a8742c4eff417c05ff5760eaf7ab25c075c10a0b3f6126` |
| `/home/cina/cinagroup/cinashop/workers-ts/scripts/data-migration/runner.ts` | 24-32, 307-313, 1044-1118, 1277-1326 | `0fb05f86d750dd933f61bd4e763a8655d160d54665cc403b59651045fa818edc` |
| `/home/cina/cinagroup/cinashop/workers-ts/scripts/data-migration/manifest.ts` | 374-377 | `9668231ce2b89336befab2780e63dbb962df3012d474437194a99296e23a79f1` |

This explicitly corrects source report S22's "decode once" summary. The source report is retained as the earlier artifact; do not use that shorthand as the acceptance rule for imported description values.

## Observed validation evidence

- `read-budget-status.json`: exit0, completed 2026-10-15T04:38:50Z; matching log has 2 files/19 tests passed. Covers the first SQL/form/editor/owner1 corrections and the long Unicode case.
- `native-final-status.json`: exit0, completed 2026-10-15T04:41:58Z; matching log has 4 files/34 tests passed and owned native fixtures cleaned up. Includes actual PG16 SELECT-only/card-column permissions, RR peer snapshot, DB clock expiry and existing rule HTTP regression after SQL budget integration.
- These completed results precede the later 768 KiB check and duplicated live-form test. `native-sealed.log` had appeared while reviewing, but no completed current-input receipt was certified here. Final tests/type/runtime gates remain the parent's serial work.

## Source SHA-256 at the final static read

- Read service: `ecf74aec76992f9ab0c0209bca461538b04d9f2f8a8c601074c2e73139d86a5c`
- SQL budget helper: `8bcf095d8b85108365f6af890f9761222c1729701ec032cf1753c26499d03e2c`
- Old-form transform helper: `c294a523f5223975aff4b27f96deddd920b25b3512d8a15576ce560a604d0238`
- Ordinary read tests: `3650db59ba5802a3d2ec041c47744698750fecca0c23436a9ab8b324ef824225`
- HTTP read tests: `cbbc1a0fe53b5c5eeea102aa55628f5982ab534026b630ff96274113db290c7a`
- Native read tests: `8b10e0261e1de31f6ebfbf539b1b892cc37e8dd1e3706498d07b7c77c541ea72`
- Read controller: `5b3e94cae8d3ac9b058feb99cf28c89ebae00ac30b47d85da147678aea1478f1`
- Routes: `d8882a1782a22c3b144a662ef8239b6d88a7c68671f44827e89bf69acaf43a1b`
- Legacy JSON utility: `b9dc7e6e39442de62677817c9c1f17be9bbd711dcbbf2b3ed97d157b600ace77`
- PHP description service: `ba4f5434c0d76432fe962eac2f8f8cca233753c6259438fbc018b80224094acd`
- PHP description model: `90582355c2949f87c5590c259e8ea2e74e48ed6dfc61253ff4f35a67e913799f`
- Generic migration runner: `0fb05f86d750dd933f61bd4e763a8655d160d54665cc403b59651045fa818edc`
- Migration manifest: `9668231ce2b89336befab2780e63dbb962df3012d474437194a99296e23a79f1`
