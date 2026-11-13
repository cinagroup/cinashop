# Ordinary product creation defaults — 2026-11-12

## Source contract and observed gap

Fixed PHP ref `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5` uses shared `StoreProductServices::saveData()` for Supplier, Out and Admin creation. Its insert branch assigns the configured initial rating (`config/admin.php`: `product_default_star = '5.0'`) and a 13-digit decimal SPU. Its update branch leaves these server-owned values alone. Five PHP source/configuration files match that ref byte for byte; the PHP checkout is read-only.

At base `03f74aacdf73046f53c21a724e03cc7fe1c90a12`, all twelve admitted ordinary creation combinations succeeded but persisted rating 3.0. The filtered baseline has 12 expected failures / 23 skipped unrelated cases and receives no full-file credit. Its actual row observations also show the SPU differences:

| Writer | Admitted types covered | Before | After |
| --- | --- | --- | --- |
| Supplier ordinary | 0, 1, 3 | rating 3.0; decimal SPU already implemented | rating 5.0; 13-digit decimal SPU |
| Modern Admin primitive | 0, 1, 3, 4 | rating 3.0; empty SPU | rating 5.0; 13-digit decimal SPU |
| Out platform | 0, 1, 2, 3, 4 | rating 3.0; 13-character hexadecimal SPU | rating 5.0; 13-digit decimal SPU |
| Mature Admin and trusted copy | Existing admitted types | explicit rating 5.0 and decimal SPU | Existing caller implementation retained |

## Implementation and resulting behavior

`ProductCreationDefaults` supplies only the fixed initial rating and bounded decimal SPU generation. The three ordinary writers call it only for new rows. Existing rows retain their actual rating and SPU, including zero ratings, empty references and legacy hexadecimal references. Client `star` and `spu` fields cannot replace those values. The native `UPDATE OF star,spu` probe proves these columns are omitted from ordinary edits.

Supplier reuses its final SPU readback for rating validation. Out binds both fields into its existing selection readbacks without changing normalized request hashing or receipt lookup; committed retries return the same product and preserve feedback recorded since creation. Modern Admin settles its primitive audit/SKU triggers and rereads metadata after the last writer. The mature legacy caller continues supplying its own creation object and owning its complete-row proof. Its caller source, editor protocol, copy protocol and tests are unchanged.

Immediate insert rewrites, later SKU/description/audit/receipt rewrites, deferred changes and late edit changes must roll back the business write. Supplier and modern metadata checks use 409. Out retains its established 400 response when the earlier schedule/full-main fence detects the change; its new explicit creation check uses 409. Tests verify the exact existing paths and a successful retry of an Out key whose failed receipt transaction rolled back. PostgreSQL sequences are not claimed to rewind on late rollback.

No schema default is changed, and no history is backfilled. The existing SQL defaults remain available to historical/import paths; the registered API writers now explicitly reproduce PHP's creation-time overrides. SKU unique generation, merchant/SKU codes, barcodes, fulfillment admission, ERP activation, production privileges and frontend code are unchanged. The modern primitive's existing omission of top-level barcode authoring is preserved. No new UI field, public DTO field or product type is enabled. Global SPU uniqueness is not claimed.

## Acceptance

| Check | Result |
| --- | --- |
| New unfiltered creation-defaults native file | 35 passed / 0 failed / 0 skipped |
| Existing complete Supplier ordinary native file | 172 passed / 0 failed / 0 skipped |
| Existing complete Supplier SPU native file | 16 passed / 0 failed / 0 skipped |
| Existing complete Out boundary native file | 49 passed / 0 failed / 0 skipped |
| Existing complete mature Admin editor native file | 17 passed / 0 failed / 0 skipped |
| Existing complete Supplier trusted copy native file | 27 passed / 0 failed / 0 skipped |
| Total native files | 316 passed / 0 failed / 0 skipped across six whole files; every owned cluster stopped with 0 remaining fixtures |
| Exact 56 complete unit files | 1,821 passed / 0 failed / 0 skipped |
| Original full Worker compiler roots | All 4,373 roots, exact union of two serial 8 GiB partitions; original compiler options preserved; both passed |
| Original runtime compiler configuration | Passed |
| Complete unfiltered workerd configuration | All 30 files, 410 passed / 0 failed / 0 skipped; owned PG16 stopped with 0 remaining fixtures |
| Existing production dependency audit | 0 findings |
| Historical source-binding comparison | Baseline/current 178 passed / 10 known failures / 0 skipped; identical failure names |

All heavy commands used the shared serial wrapper. Unit tests use one worker and no file parallelism; each native command runs one complete explicit file with one worker, and workerd uses one worker with file parallelism disabled. The runner diff adds only this exact filename to its two existing reviewed selections. Inverse removal reproduces the base runner byte for byte; no deadline, arbitrary-command capability, privilege or filename pattern was relaxed. Every formal command checked frozen source/dependency bytes before and after execution.


The twelve default/history cases use actual JWTs, independently authenticated commissioned App/Admin profiles, all registered migrations, and real HTTP controller routes. Each creates a product, checks persisted defaults, reads the published public detail and score ranking, seeds historical metadata explicitly in the owned fixture, edits and verifies that public consumers retain it. Supplier uses the actual Admin review endpoint. All five Out cases also replay the original create key after a newer rating/SPU is present and prove that neither resets. These are historical-data preservation probes, not claims that a new buyer review or payment was manufactured.

## Attempts and carried debt

Raw attempts remain available. The first baseline omitted Out physical delivery selection; the corrected baseline records all twelve successful creates with rating 3.0. An empty filtered probe selected no cases and receives no credit. The first patched create preflight had four extra assertions expecting the modern primitive to author a top-level barcode; its established contract omits that field, and the new assertion was corrected without changing production barcode behavior. The first full native attempt passed 31 cases and failed four new status expectations where the existing Out fence returned 400 instead of 409. Exact legacy status/message expectations were restored; no existing test or production rejection was weakened.

Historical source-binding remains a separate debt: baseline/current each have 178 passed / 10 failed / 0 skipped cases, with the same failing full names. This is a comparison, not a passing historical gate. The old refund materialization literal assertion is unchanged and carried without rerunning, as recorded by the integral batch. Previous main CI [43353835255](https://github.com/cinagroup/cinashop/actions/runs/43353835255) is terminal: ten jobs passed, including workerd; both Worker unit shards failed before tests while fetching the fixed PHP ref, and their aggregate failed. This batch does not change the ref, upload PHP or weaken those gates.

Evidence root: `/tmp/php-ts-product-creation-defaults-20261112/`. It retains baseline rows, raw failed and passing attempts, frozen source/dependency hashes, exact file sets, compiler configurations, native cleanup receipts and secret scan outputs. Source/full-file/exact-commit scans must each have zero findings before delivery. External `completion.json` records main merge/push, remote verification, clean main, branch cleanup and preserved user symlinks. No deployment or live provider call is part of this batch. Whole migration completion remains unproven.
