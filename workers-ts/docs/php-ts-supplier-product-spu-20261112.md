# Supplier ordinary product SPU creation — 2026-11-12

## PHP behavior and observed gap

At fixed PHP ref `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`, Supplier `StoreProduct::save()` calls shared `StoreProductServices::saveData()` with owner type 2 and the authenticated supplier. The insert branch assigns `createSpu()`, a 13-digit internal product reference; the update branch does not author it. The active product drawer supplies merchant `code` separately. All three inspected PHP files match that ref byte for byte; the PHP checkout remains read-only.

At base `0a12f40ad97accaeb491405c90b280e61a5de3fa`, ordinary TypeScript creation inserted the schema's empty SPU default. Three real JWT/App/PG16 create requests (physical 0, card 1, manual 3) succeeded but persisted empty SPUs. The filtered baseline records 3 expected failures and 12 skipped unrelated cases; it receives no full-file credit.

## Resulting behavior

Ordinary Supplier creation generates 13 decimal characters on the server using the same bounded random-byte-to-digit approach as the existing mature Admin/copy writer. Client `spu` values are ignored. Ordinary edits preserve every historical value, including empty and nonnumeric values, and do not include SPU in the SQL UPDATE target list. This is an internal reference, separate from merchant `code`, SKU `code`, barcode and SKU unique identity; no editor field or public metadata protocol was added.

Both existing POST routes (`/supplierapi/product/product` and `/supplierapi/product/product/:id`) share this save method; native acceptance exercises the active editor's `:id` route, including ID 0 creation. After all requested authors complete, deferred constraints are settled and the final product's SPU, owner, fulfillment type, deletion and pending-review state are reread. A rewritten SPU or unexpected scope/state returns 409 and rolls back business rows. PostgreSQL sequences are not transactional and are not claimed to rewind on late failure.

The existing copy service uses the mature Admin save pipeline, already generates a fresh SPU, and retains its terminal idempotent receipt. Its source, whitelist and tests are unchanged and its complete native suite is rerun. Admin, Out, schema, production privilege plan, ERP settings, merchant-code policy, SKU parser and frontend files are unchanged. This batch does not backfill history or claim global SPU uniqueness or protection from arbitrary uncooperating maintenance SQL after commit.

## Acceptance

| Check | Result |
| --- | --- |
| Ordinary SPU native acceptance, unfiltered | 16 passed / 0 failed / 0 skipped |
| Existing complete ordinary author native file, unchanged | 172 passed / 0 failed / 0 skipped |
| Existing complete trusted copy native file, unchanged | 27 passed / 0 failed / 0 skipped |
| Total native files | 215 passed / 0 failed / 0 skipped; each cluster stopped with 0 fixture databases/roles |
| Exact 52 complete unit files | 1,792 passed / 0 failed / 0 skipped |
| Original full Worker compiler roots | 4,371 roots, exact union of two serial 8 GiB partitions; original compiler options preserved; both passed |
| Original runtime compiler configuration | Passed |
| Complete unfiltered workerd configuration | All 30 files, 410 passed / 0 failed / 0 skipped; owned PG16 stopped, 0 remaining fixtures |
| Existing production dependency audit | 0 findings |
| Historical source-binding comparison | Baseline/current 178 passed / 10 known failures / 0 skipped; identical failure names |

The new native file exercises all three admitted fulfillment types, forged SPUs, repeated edits, preservation of empty/nonnumeric history, an `UPDATE OF spu` trigger proving the column is omitted on edits, authorization/scope rejection without business or sequence changes, and immediate/later-SKU/deferred/description rewrites with complete business rollback. It uses real JWT/controller routing and existing restricted App LOGIN grants; owned maintenance credentials only construct fixtures and probes. No outbound fetch occurred.

The unchanged 172-case native file finished its Vitest run in 586.58 seconds within the existing 600-second child deadline (598.84 seconds including cluster setup/shutdown). No deadline was raised.

All heavy commands ran under the shared serial validation wrapper. Unit execution uses one worker and no file parallelism; each native invocation runs one whole explicit file with one worker, and workerd uses one worker with file parallelism disabled. The native runner diff only adds this exact filename to its existing two reviewed selections; inverse removal reproduces the base script byte for byte. There is no deadline, privilege, arbitrary-command or filename-pattern relaxation. Source and critical dependency hashes were checked before and after every formal command.


## Attempts, evidence and remaining debt

Two test setup issues were preserved and corrected without changing existing tests: the initial manual-create request incorrectly supplied independently configured fixed delivery content; four later preflight cases tried to replace a historical multi-SKU editor with a new-product body. The final historical cases instead create a valid product of each actual type, seed its legacy SPU in the owned fixture, and edit its current editor state. The late description test also edits the current state. `preflight-baseline-create.log` and `preflight-native-spu.log` remain available and receive no formal acceptance credit.

Source-binding proof remains a historical debt: baseline and current each have 178 passing / 10 failing / 0 skipped cases, with exactly matching failing names. The old refund materialization literal assertion is unchanged and carried without rerunning; its earlier baseline/current comparison is recorded by the integral batch. Previous main CI run [43347865984](https://github.com/cinagroup/cinashop/actions/runs/43347865984) is terminal: the other ten jobs, including workerd, passed; both Worker unit shards failed before tests because the fixed PHP ref cannot be fetched, and their aggregate failed. The fixed ref and CI gates are unchanged.

Evidence root: `/tmp/php-ts-supplier-product-spu-20261112/`. It contains raw attempts and formal logs, PHP/source/dependency hashes, exact unit and runtime file lists, compiler partitions, unchanged ignored-resource receipts, and source/full-file/exact-commit secret scan receipts. Zero findings for all three secret scans are required before delivery; the final external `completion.json` records merge, push, clean main, remote verification, branch cleanup and preserved user symlinks. There is no deployment, PHP upload or live provider call in this batch. Whole PHP-to-TypeScript migration completion remains unproven.
