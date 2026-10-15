# Independent read-only review: true Admin product GET

Reviewed 2026-10-15T04:34:45.525674+00:00 against the actual shared worktree and pinned PHP/old Vue source report. No tests, typechecks, migrations, providers or stress reproductions were run by this reviewer. No repository source was edited.

## Confirmed P2 findings

### P2 — Read extensions make a valid complete-form product impossible to resave under the current 1 MiB body limit

`AdminLegacyProductReadService.ts:223-225` always adds a full description_preview beside description. `AdminLegacyProductInput.ts:9` and its strict HTTP reader enforce 1 MiB on the complete incoming JSON, including bounded ignored DTO fields. The real old Vue replaces formValidate with the whole GET DTO and later posts it; the local helper likewise spreads all info fields (`helpers/adminLegacyProductRead.ts:5`).

Concrete bounded reproduction using supported input: create a product with description `<p>` + `中`.repeat(180000) + `</p>`. The description has approximately 540 KB UTF-8 and fewer than 200,000 codepoints, so the actual initial POST/HTML input bounds allow it. GET includes both that description and the same preview (about 1.08 MB total), which still passes the new GET 2 MiB response limit. An unchanged whole-DTO old-form save now exceeds the strict 1 MiB POST wire limit and is rejected. The normal short-description roundtrip tests do not cover this regression. stored_custom_form/custom_form/custom_form_info and retired extensions can compound the mismatch.

Fix the read-extension/echo budget contract before claiming complete-form roundtrip for all accepted inputs. Keep the editable original and useful preview, but avoid having new read-only extensions invalidate an otherwise accepted unchanged business body. Add an actual GET -> old helper -> POST test with the bounded multibyte input, not an artificial unbounded payload.

### P2 — Capacity is checked after unbounded database text fetches and output expansion

`AdminLegacyProductReadService.ts:146,149-151,171-173` selects full main/attr/SKU/description/form rows, including unbounded PostgreSQL text fields. Row LIMIT10001 does not bound byte size. JSON text decoding caps apply only after transport/deserialization, and the final response check (`:225`) first allocates JSON.stringify output and then a UTF-8 TextEncoder buffer. That cannot protect a Worker from large historical text rows or an allowed large set of retired SKU fixed contents being materialized first.

There is also a compact amplification path even after adding a SQL raw-byte budget: system_form.value = JSON.stringify(Array(100000).fill(0)) is about 200 KB, within decode(...,512KiB). `formInfo` at lines66-78 performs Object.values(...).map without a field-count or input-shape guard and allocates 100,000 default eight-field objects. Only afterward does the final response size check reject the tens-of-megabytes projection. No stress execution is needed to establish the allocation order in these statements.

Bound large scalar reads in SQL (including cumulative text budgets on complete row sets) before loading them, reject overflowing form item counts/shapes before map, and track a conservative cumulative projection budget before expansion/signing/JSON serialization. The existing new dimension product<=200 guard already correctly checks the Cartesian size before allocating; use the same principle for forms and total bytes.

## Test fidelity limit requiring correction or explicit qualification

`helpers/adminLegacyProductRead.ts` currently sets supplier_id only when owner type===2. Pinned Vue infoData instead sets supplier_id=data.relation_id unconditionally, and productTypeTap then clears it for nonphysical products. Therefore a physical owner1 product sends relation_id as supplier_id in the real old form, but the local helper substitutes0. This changes the pending is_verify/cart special branch that the save coordinator deliberately preserves. The real imported JS HTTP helper is genuine, but the whole-form transformation is a handwritten approximation and currently does not prove owner1 roundtrip. Model actual product_type===0 ? relation_id :0 behavior and test that branch, or state this gap.

## Reviewed behavior without another confirmed P0–P2

- Fixed disk_info is preserved as an actual SKU value under the existing product.view detail boundary, and ordinary/HTTP tests explicitly retain it through a whole-form save. This follows the selected contract; this review does not mislabel that value as secret-redacted.
- Inventory card credentials are absent: the service groups only product_id/attr_unique/uid counts and never reads the stale attr_result credential snapshot. virtual_list stays empty and aggregate counts remain separate from fixed delivery contents. The new native test intentionally removes card_no/card_pwd column SELECT while permitting only those aggregate inputs.
- Single/multi reads rebuild ordinary active rows from real SKU and dimensions; stable identities are preserved, retired rows remain separate, and missing single-SKU uses an unpersisted main template. Ambiguity is refused instead of copying PHP checkProductAttr hidden writes. The dimension row/value length/product-count guards now precede Cartesian allocation.
- Source shipping selectors include inactive/deleted platform history, user labels now use source idDESC, empty slider text retains PHP decode null, category tree uses a linear child map, and main association columns are authoritative rather than a stale relation union.
- Editable HTML is canonical and unchanged except private-reference normalization. description_preview is separately sanitized, and private image references are checked under actual product owner before signing. The foreign-reference preview and no-provider tests cover a representative path; they are not a full frontend/browser proof.
- Authorization uses actual current platform account/password version and product.view (including exact620) in RR READ ONLY. The final DB clock check rejects expiry. The native fixtures use a real owned non-superuser LOGIN, independent verified PID peers, actual permission denials/snapshots and no fabricated SQL results.
- The earlier GET wildcard shadow of get_rule/rule has been corrected in current adminapi.ts: literal selectors are registered before the dynamic resource GET. The parent is running the existing real rule HTTP regression as well.
- The legacy-php-json optional capacity argument retains the prior 32,768-character default for existing consumers and changes only explicit new callers. Its parser/depth/number semantics remain unchanged. This is a character cap, not proof of a cumulative runtime memory/response-byte budget.

## Evidence and scope

The completed read-http status receipt/log were directly inspected: exit0, two files and16 tests passed. Those tests predate any fixes to the two findings above and do not prove their boundary behavior. Native/type/runtime gates were not certified by this review; an in-progress run is not counted as passed.

The true GET route is an incremental backend contract. generate_attr, full Vue edit/copy UI, trusted copy handling, unknown save-outcome recovery, all historical encoding edge cases and production ACL/provider acceptance remain outside any completion claim. This report does not close the parent migration objective.

## Reviewed source SHA-256

- `workers-ts/src/services/admin/AdminLegacyProductReadService.ts`: `32550c2dd5dbb4511245eb477e53a0139a55c4cfc3d21e2d2147f3f73752fff2`
- `workers-ts/src/controllers/api/v1/AdminLegacyProductReadController.ts`: `5b3e94cae8d3ac9b058feb99cf28c89ebae00ac30b47d85da147678aea1478f1`
- `workers-ts/src/utils/legacy-php-json.ts`: `b9dc7e6e39442de62677817c9c1f17be9bbd711dcbbf2b3ed97d157b600ace77`
- `workers-ts/test/admin-legacy-product-read.test.ts`: `89daa79b32451b3af433db463c347f99e6b571448e188e34e784294f85af0ccf`
- `workers-ts/test/admin-legacy-product-read-http.test.ts`: `15e142e455fbcf5f7476927285da25865198a7074397188666c0b85207c6cb4a`
- `workers-ts/test/admin-legacy-product-read-native.test.ts`: `8b10e0261e1de31f6ebfbf539b1b892cc37e8dd1e3706498d07b7c77c541ea72`
- `workers-ts/test/helpers/adminLegacyProductRead.ts`: `fcf52dab04b47863c079c76575d323133a341cb717cd574ad95890407f595a2d`
- `workers-ts/src/routes/adminapi.ts`: `d8882a1782a22c3b144a662ef8239b6d88a7c68671f44827e89bf69acaf43a1b`

## Follow-up disposition (original findings retained)

The current fixes, residual form-duplication example and intentional 768 KiB editable DTO limit are reviewed in [independent-review-addendum.md](./independent-review-addendum.md). That addendum updates the original P2 dispositions, records the exact PHP description model/service decode chain and generic import provenance gap, and separates completed earlier validation from the latest pending boundary test. It does not replace the original report or claim the overall editor/data migration is complete.
