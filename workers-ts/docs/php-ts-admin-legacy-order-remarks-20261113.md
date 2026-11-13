# Legacy Admin order remark parity — 2026-11-13

Base: `4c0ebe7b4ad8de71c8c480c5ba0e833f2a29de0a`. This batch completes the fixed PHP primary-ID remark behavior for deletion flags and raw text. It supersedes the prior batch's active-only lookup and shared trimming policy for `PUT /adminapi/order/remark/:id`. The modern and mobile number-based contracts retain their existing active-only, trimmed behavior. The overall PHP-to-TypeScript migration is still open.

## Fixed source and counterexamples

The unchanged PHP reference is `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`. Twelve relevant PHP files were checked byte for byte, covering the route, Admin controller/trait, service/DAO dispatch, model inheritance and old client/form.

`app/common/controller/Order.php::remark` calls `$this->services->get($id)`, assigns the posted remark directly, and saves. `BaseServices::__call` delegates to the DAO; `BaseDao::get` selects by primary key without calling the list/search filters. `StoreOrder` and its model ancestry do not apply a SoftDelete/global deletion scope. The old textarea uses ordinary `v-model`, and its API sends PUT with the primary ID. Therefore this writer can annotate a row with either deletion flag without restoring it, and saves nonempty raw text including surrounding whitespace. PHP's false string `"0"` remains invalid, while `" 0 "` is valid raw text.

On the base TypeScript implementation, four selected actual-native counterexamples failed: the history matrix returned 404 at `is_del=1`; padded text was saved after trimming; whitespace and padded zero returned 400. The other 28 existing cases were filtered out of this baseline probe and are not credited as acceptance. The initial command ran from the wrong working directory and failed before starting PostgreSQL; that raw error is retained separately without test credit.

## Delivered behavior

| Entry point | Target and text policy |
| --- | --- |
| `PUT /adminapi/order/remark/:id` | Exact primary ID, including deletion-flag states; preserve raw valid text |
| `POST /adminapi/order/remark/:id` | Exact order number, active rows only; trim outside whitespace |
| `POST /api/admin/order/remark` | Body `order_id`, active rows only; trim outside whitespace |
| `POST /api/admin/order/remark/:orderId` | Exact path order number, active rows only; trim outside whitespace |

The policy is chosen by the server-side service method. Client flags such as `include_deleted`, `kind`, `is_del`, alternate IDs and claimed Admin identities cannot change it. Existing `order.manage`, JWT/password-version checks, authority barriers, row contention handling and final live authorization remain unchanged. Anonymous, read-only, disabled and Supplier identities cannot use the historical writer.

The primary writer updates only `remark`. Its SQL predicate binds the deletion flags captured under the row lock, and the existing complete bounded-column/text-fingerprint proof checks them again after audit authors and deferred constraints. A hidden row remains hidden. Payment, owner, parent, fulfillment, visibility and deletion columns are absent from the UPDATE SET list, including when the request tries to supply replacement values. A real `UPDATE OF` trigger verifies that omission; late attempts to restore flags are rolled back. A successful write creates the same canonical actor audit without copying remark content into its message.

Legacy text is kept byte for byte within the existing valid Unicode/512-codepoint column contract. Empty text and exact `"0"`, non-strings, NUL and lone surrogates remain invalid. Whitespace, CR/LF, surrounding spaces and padded zero are preserved. Preserved padding counts toward the column limit; it is not discarded to fit. A trimmed-equivalent value is a distinct legacy write, while repeating identical raw text is a no-op with no new audit or sequence allocation. The existing 8 KiB JSON body bound and private no-store responses remain in place.

The existing seven database-side NULL/byte-length/SHA-256 text fingerprints are unchanged. Actual native acceptance preserves 262,145 bytes of deleted-order history and refuses a same-length late rewrite. No provider, financial operation, restore operation, new read projection, frontend source, schema, grant plan or native runner capability is introduced.

## Validation

| Check | Result |
| --- | --- |
| Complete native file: remark | 37 passed / 0 failed / 0 skipped |
| Complete native file: assignment | 11 passed / 0 failed / 0 skipped |
| Complete native file: generations | 20 passed / 0 failed / 0 skipped |
| Total native acceptance | 68 passed across three whole files; every cluster stopped with 0 remaining fixtures |
| Exact complete unit files | 64 files, 2,058 passed / 0 failed / 0 skipped |
| Original Worker compiler roots | All 4,383 roots; exact union of two serial 8 GiB partitions with original compiler options; passed |
| Original runtime compiler configuration | Passed |
| Complete workerd configuration | All 30 files, 410 passed / 0 failed / 0 skipped; owned PostgreSQL stopped |
| Production dependency audit | 0 findings |
| Historical source-binding comparison | Baseline/current 178 passed / 10 known failures / 0 skipped; identical failure names |

All heavy commands use the shared serial wrapper. Unit and native runs use one worker with file parallelism disabled; each final native run selects one complete explicit file without case filters. Source and 61 unchanged dependency hashes are checked before and after every formal command. The native runner, timeouts, configurations, grants and schema are byte-identical to base.


The complete existing native file is rerun without filters, including all prior cases and nine additions. Three old expectations are corrected to match the fixed PHP contract: the initial legacy success assertion now expects preserved padding, whitespace is invalid only on trimmed number routes, and deletion flags block number routes while remaining annotatable by legacy primary ID. Positive legacy assertions replace the old rejection expectations; the corresponding modern/mobile negative coverage remains. No cases are skipped or removed from final acceptance. The first complete preflight passed 36 cases and caught the remaining old trimmed-text success expectation; only that test assertion changed afterwards, with both production modules unchanged. The final frozen source is rerun from the first formal command.

Native tests use the actual assembled app, real JWTs and commissioned independent App/Admin LOGIN roles with the unchanged privilege plan. The seed orders are explicitly unpaid test configuration. Maintenance sets up the deletion-flag matrices and deliberate triggers; the application request only authors remark. Real actor audits, business-table snapshots, audit sequence checks for admission/no-op, immediate/deferred trigger interference, valid retries and private denied responses are checked. External fetches are forbidden. These are not claims of real payment, provider, deployment or browser acceptance.

All four states of `(is_del,is_system_del)` are exercised with actual manager and root identities, exact no-op retries and attempts to overwrite protected fields. Number-based callers cannot use body flags to reach deleted history. The existing complete fulfillment assignment and refund-generation read files remain part of regression acceptance, alongside full strict compiler-root coverage, original runtime types and complete workerd configuration.

## Existing debts and delivery

The fresh historical source-binding comparison retains its ten known failures with identical names; it is not a passing runtime gate. The previous pushed CI run's Worker unit shards failed before test execution while fetching the unchanged fixed PHP reference; workerd and production audit passed. This batch does not upload PHP, alter the reference or weaken that gate. Previously recorded refund-materialization literal and private-schema writeoff failures remain outside this batch.

Raw attempts and final logs are retained in `/tmp/php-ts-admin-legacy-order-remarks-20261113`. The audit receipt binds all four changed source files, unchanged critical dependencies, fixed PHP source files, exact complete test selections, compiler options/root union, ignored evidence-resource hashes and scans. Merge/push and batch-branch cleanup follow final checks, with post-push CI recorded separately.
