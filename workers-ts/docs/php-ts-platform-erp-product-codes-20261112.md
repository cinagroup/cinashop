# Physical ERP product code admission — 2026-11-12

Base: `32ce5027d06f6e1960ae6400b9b1f04aa88f72b4`. This batch closes ordinary physical product code admission in the modern Admin and Out save routes. The PHP-to-TypeScript migration remains active; this document is not a whole-migration acceptance claim.

## PHP contract and demonstrated gap

The unchanged PHP reference is `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`. `StoreProductServices.php` checks global `erp_open`, requires physical (`product_type=0`) main merchant code, then requires a code for every submitted SKU. Its `empty()`/truthiness checks reject string `"0"`. Merchant code, generated SPU, barcode and SKU unique identity are separate fields. The four relevant PHP controller/service files match the fixed reference byte for byte; see the receipt.

Before implementation, four actual HTTP requests (modern Admin/Out × missing main/SKU code) succeeded with status 200 despite enabled ERP. The initial native run retains all four expected failures and confirms fixture cleanup. These were valid requests, including physical delivery configuration, through real controllers, JWT authentication and native PostgreSQL SQL.

## Resulting behavior

- Both modern Admin and Out physical saves use the existing ERP configuration advisory lock namespace/key. A concurrent exclusive config writer yields a bounded 409 before product writes. Duplicate, unrecognized or oversized global flags fail closed; store-specific settings do not become global policy. Missing/off flags allow empty codes. No ERP credential, connection activation or provider request is involved.
- ERP on requires main and every active SKU code, including edits. String `"0"` is rejected consistently in modern Admin, Out, Supplier and the mature Admin input adapter. Other nonempty codes such as `"00"` remain valid. ERP off and nonphysical saves retain optional code behavior.
- Modern Admin now authors explicit top-level `code` with the existing fifty-Unicode-codepoint validator. Omission leaves the column out of SQL and preserves stored bytes. A partial edit without SKU payload validates the actual active SKU rows, preserves their bytes, and fails closed beyond the existing 1,000-row bound. Physical creation with enabled ERP needs at least one active SKU.
- Out keeps its existing full-form normalization and request hash. An omitted main code means empty, including edits; it cannot borrow an old main code while ERP is on. Previously committed request replay still returns before current policy admission, without rewriting product state.
- New admissions capture the approved SKU rows and compare them after all later authors and deferred constraints. Final checks bind policy, main code, owner, product type and full SKU snapshot. The policy snapshot is checked even when initially off. Existing Supplier full-main proof and mature Admin coordinator barriers remain in place.
- Creation rating/SPU defaults, historical feedback, ownership, inventory identity, stock-preserving Out edits and public main-code projection remain covered by existing regression suites. No schema default, historical backfill, UI, credential, provider, deployment or fixed PHP reference is changed.

## Validation

| Check | Result |
| --- | --- |
| Complete native file: erp | 27 passed / 0 failed / 0 skipped |
| Complete native file: defaults | 35 passed / 0 failed / 0 skipped |
| Complete native file: supplier | 172 passed / 0 failed / 0 skipped |
| Complete native file: spu | 16 passed / 0 failed / 0 skipped |
| Complete native file: out | 49 passed / 0 failed / 0 skipped |
| Complete native file: admin | 17 passed / 0 failed / 0 skipped |
| Complete native file: copy | 27 passed / 0 failed / 0 skipped |
| Total native acceptance | 343 passed across seven whole files; every cluster stopped with 0 remaining fixtures |
| Exact complete unit files | 58 files, 1908 passed / 0 failed / 0 skipped |
| Original Worker compiler roots | 4378 roots; exact union of two serial 8 GiB partitions, original compiler options; passed |
| Original runtime compiler configuration | Passed |
| Complete workerd configuration | All 30 files, 410 passed / 0 failed / 0 skipped; owned PostgreSQL stopped |
| Production dependency audit | 0 findings |
| Historical source-binding comparison | Baseline/current 178 passed / 10 known failures / 0 skipped; identical failure names |

All heavy commands use the shared serial wrapper. Unit and native runs use one worker with file parallelism disabled; each native run selects one complete explicit file without case filters. Workerd keeps its original single-worker configuration. Source and protected dependency hashes are checked before and after every formal command. The native runner adds only the exact new filename to its two existing reviewed selections; inverse removal reproduces the base runner byte for byte. Deadlines and privileges remain unchanged.


Native acceptance installs the complete migration schema, commissions the existing runtime privilege plan, and performs HTTP calls as independent application/Admin LOGIN roles. Maintenance is used only to seed owned fixtures, hold independent locks, inspect state and install deliberate test triggers. Network spies reject live outbound fetches. Failed admission checks compare business-table snapshots and, where admission must precede allocation, real PostgreSQL sequence state. Trigger cases retry the same valid request after removing the trigger, proving that rejection was caused by the mutation. Out retries do not reuse a failed receipt.

The first full native attempt retained two fixture errors: `historical-spu` exceeded the real 13-character SPU column. The new fixture text was shortened and one stored-SKU history bound case was added; production code was unchanged. The existing primitive transaction double was updated to represent real code/rating/SPU defaults and the new global config read. It retains its existing strict rejection of unexpected SQL selections. Raw attempts remain in the evidence directory and are not counted as final acceptance.

After validation, the staging format check found one extra final LF in the new test helper. Exactly that byte was removed; adding it back reproduces the validated helper byte for byte. The receipt retains separate validated/delivery hashes and the failed staging log. No executable code changed; final-file and exact-commit scans cover the delivered bytes.

## Existing debts

The fresh baseline/current historical source-binding comparison retains the same ten failures; it is not a passing runtime gate. The preceding pushed CI run completed workerd and production audit successfully, but its two Worker unit shards failed while fetching the unchanged fixed PHP reference, before unit execution. This batch does not change the reference or gate. An older refund-materialization literal failure and mature private-schema writeoff failures remain outside this batch. Local owned acceptance does not prove all production migration capabilities or replace those debts.

The audit receipt records exact source/dependency hashes, complete test selections and counts, original compiler-root partitions/options, raw log hashes, secret scans and preserved ignored-resource hashes. Evidence: `/tmp/php-ts-platform-erp-product-codes-20261112`.
