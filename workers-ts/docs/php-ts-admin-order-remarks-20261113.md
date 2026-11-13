# Admin order remarks — 2026-11-13

Base: `04ed78833c7806d23bc0726aabe82673dcd85c8f`. This batch restores desktop order remark writes and shares one transaction implementation with embedded mobile Admin. The complete PHP-to-TypeScript migration remains open.

## Proven gap and source contract

The fixed PHP reference remains `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`. The Admin route registers `PUT order/remark/:id`; `app/common/controller/Order.php::remark` selects by internal primary ID and refuses empty content, including string `"0"`. The old Admin client calls that PUT route. Its controller, trait, route file and client API file were checked byte for byte against the fixed reference.

The current TypeScript desktop client instead uses `POST /adminapi/order/remark/<order number>`. Its router declared `:id`, while the controller read only `orderId`, so valid requests looked up an empty number. The PHP PUT route fell through to 501. Both counterexamples were reproduced through the actual assembled app, real JWT authentication and commissioned native PostgreSQL LOGIN roles: POST returned 400, PUT returned 501. Neither initial request reached the intended successful audit assertion.

The old desktop implementation also performed order update and status-log insertion as separate DAO calls. Reusing it after fixing only the parameter would retain partial-write behavior. The replacement uses a transaction for the whole operation.

## Delivered behavior

| Entry point | Authoritative target |
| --- | --- |
| `POST /adminapi/order/remark/:id` | Exact order number; `:id` is the existing modern route parameter name |
| `PUT /adminapi/order/remark/:id` | Internal primary ID, matching fixed PHP |
| `POST /api/admin/order/remark` | Existing `order_id` body field |
| `POST /api/admin/order/remark/:orderId` | Exact order number from the path |

Path identities override body echoes. A numeric order number is never guessed to be a primary ID; a native case creates different orders whose number and primary ID overlap and verifies each target separately.

All four paths share `AdminOrderRemarkService`. The service uses the existing bounded Admin authority barrier and a current `order.manage` actor with the verified password version and token expiry. It selects one active order with an immediate row-lock refusal on contention. User-deleted, system-deleted and missing orders remain unavailable, preserving the existing mobile policy. Client-supplied actor IDs, payment fields, buyer IDs and alternate order IDs cannot enter the SQL update.

The shared parser retains outside trimming and multiline content, rejects empty or PHP-false `"0"`, NUL and lone surrogates, and admits up to 512 Unicode codepoints within the existing remark column. The formerly stricter UTF-16 count is corrected so 512 valid supplementary characters fit the actual PostgreSQL column. Bodies remain bounded at the existing mobile 8 KiB limit; malformed JSON/objects and oversized content fail before business or audit-sequence allocation.

All seven unbounded text columns enter the order proof as database-side NULL/byte-length/SHA-256 fingerprints; their plaintext is never fetched into the Worker for this operation. The functions are explicitly qualified in `pg_catalog` and are built into the installed PostgreSQL 16 catalog; no extension or new grant is introduced. Large valid historical content can still be preserved and remarked. Native acceptance preserves a 262,145-byte historical value, rejects a later same-length rewrite, and distinguishes NULL from empty text.

Only `remark` is authored on the main row. The service inserts one canonical `admin_order_remark` status entry identifying the verified actor without embedding the remark text. It settles deferred constraints, compares every bounded order column, all seven text fingerprints and the intended audit row, and reloads live actor authority before committing. An audit insertion error, missing/rewritten audit, changed financial/owner fields, deferred deletion, role revocation or password change rolls back the complete transaction. Repeating an already committed identical remark is a no-op and consumes no audit sequence. This does not introduce an operation-ID receipt or promise replay after a different later remark.

Private no-store headers are applied before authentication on all four routes, including denied requests. Success envelopes remain PHP-style with `data: null`. The desktop detail route reads the committed remark. Existing price, writeoff and delivery implementations are byte-identical to base; no schema, grant plan, frontend source, provider, financial workflow or fixed PHP reference is changed.

## Validation

| Check | Result |
| --- | --- |
| Complete native file: remark | 28 passed / 0 failed / 0 skipped |
| Complete native file: assignment | 11 passed / 0 failed / 0 skipped |
| Complete native file: generations | 20 passed / 0 failed / 0 skipped |
| Total native acceptance | 59 passed across three whole files; every cluster stopped with 0 remaining fixtures |
| Exact complete unit files | 64 files, 2,039 passed / 0 failed / 0 skipped |
| Original Worker compiler roots | All 4,383 roots; exact union of two serial 8 GiB partitions with original compiler options; passed |
| Original runtime compiler configuration | Passed |
| Complete workerd configuration | All 30 files, 410 passed / 0 failed / 0 skipped; owned PostgreSQL stopped |
| Production dependency audit | 0 findings |
| Historical source-binding comparison | Baseline/current 178 passed / 10 known failures / 0 skipped; identical failure names |

All heavy commands use the shared serial wrapper. Unit and native runs use one worker with file parallelism disabled; each native run selects one complete explicit file without case filters. Workerd retains its original single-worker configuration. Source and 53 unchanged dependency hashes are checked before and after every final formal command. The native runner adds only the exact new filename to its two existing reviewed selections; removing those two entries reproduces the base runner byte for byte. Deadlines and privileges are unchanged.


The new native file performs HTTP requests through the actual app and real JWT middleware. It commissions the unchanged runtime privilege plan and uses independent App/Admin LOGIN connections. Its explicitly seeded orders are unpaid test configuration; no payment or fulfillment success is manufactured. Maintenance is used for setup, snapshots, independent contention peers and owned test triggers. Outbound fetches are forbidden and checked. The 512-character case reads the committed value through the real desktop detail endpoint.

The positive controls remove a deliberate trigger or release a real peer lock, then retry the identical valid request successfully. Admission failures and no-ops compare real audit sequence state; later failures compare business snapshots without falsely claiming rollback of PostgreSQL sequence allocation. The audit-error test deliberately expects an API 500 from a raised database exception, confirms rollback, and then succeeds after removing the trigger; that expected application error is not a failed Vitest case.

The existing Admin order frontend lifecycle test compiles the actual Vue SFCs and client with a finite HTTP adapter. It is client-contract coverage, not a browser or database authorization claim. No frontend source changed, and no browser acceptance is claimed for this batch. The installed browser plugin remains available for rendered UI work.

Two earlier frozen attempts completed their current native child and cleaned the owned database, then the source-freeze guard stopped them when the text-proof implementation changed. Their logs and passing child results are archived without final acceptance credit. The delivered fingerprint design preserves large text; the intermediate conditional size rejection is not delivered. Final acceptance reruns from the first formal command on one frozen source image.

## Existing debts and delivery

The fresh historical source-binding comparison retains its ten known failures with identical baseline/current names; it is not a passing runtime gate. The preceding pushed CI run completed ten jobs successfully, including workerd, production audit, frontend builds and migration catalog. Its two Worker unit shards failed while fetching the unchanged fixed PHP reference, before tests, and the aggregate consequently failed. This batch neither changes that reference nor weakens its gate. Previously recorded refund-materialization literal and private-schema writeoff failures remain outside this batch.

All raw baseline/preflight attempts and final logs are retained in `/tmp/php-ts-admin-order-remarks-20261113`. The audit receipt binds source/dependency hashes, exact complete test selections, compiler root/option checks, original fixed PHP sources, ignored evidence-resource hashes and secret scans. The main branch is merged/pushed and the batch branch cleaned only after final checks; post-push CI state is recorded separately in that evidence directory.
