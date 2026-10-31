# Baseline CI failures, 2026-10-30

This records the completed [run 41068214196](https://github.com/cinagroup/cinashop/actions/runs/41068214196) for `42756fe6946115fefdab1fe65fc36a30f210aba9`. These are historical results for that immutable head, not results for the current migration branch.

## Structured unit results

The actual uploaded `unit-shard-results.json` files report:

| Shard | Tests | Passed | Failed | Pending/skipped | Failed file entries |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 19,347 | 18,972 | 375 | 0 | 48 |
| 2 | 18,310 | 17,731 | 542 | 37 | 56 |
| Total | 37,657 | 36,703 | 917 | 37 | 104 |

`numFailedTestSuites` also counts nested describe blocks and is not used as a file count. The earlier local 223-failure subset is neither the complete CI result nor a classification of these 917 failures.

| Artifact | ID | Result JSON SHA256 |
| --- | --- | --- |
| `unit-shard-1-42756fe6946115fefdab1fe65fc36a30f210aba9` | 12987674190 | `191f5309615938dbdc3b2dcf13737401094572d404d90c3ce70bbd446e7f2e72` |
| `unit-shard-2-42756fe6946115fefdab1fe65fc36a30f210aba9` | 12990714453 | `017588e6c5926e05c221511fb2fe70179c4d15cd88e9f790a74260b80455d503` |

The artifact files were retrieved through authenticated read-only GitHub CLI calls. The failing-step console download alone did not contain the complete first-shard failure summary; the uploaded structured result establishes these counts. Temporary copies and extracted summaries remain under `/tmp/cinashop-phase21-validation/`.

Filename grouping helps route investigation but does not establish a failure's root cause:

| Group | Shard 1 files / failed assertions | Shard 2 files / failed assertions |
| --- | --- | --- |
| `source-binding` filenames | 11 / 201 | 16 / 360 |
| frontend/navigation/design filenames | 12 / 63 | 9 / 28 |
| native/postgres filenames | 9 / 37 | 16 / 122 |
| Other filenames | 16 / 74 | 15 / 32 |

A failed suite setup can leave a failed file with zero failed assertion entries, as in `customer-cashier-capabilities-native.test.ts`. Pending cases cannot be counted as passed. Native and financial failures still require actual reproduction and inspection; they are not certified as fixture-only errors by this grouping.

## Repairs in the current branch

- Uni toolchain: restore the union of 100 direct test files and the original 23 independent npm script chains from the two true parents. Previously the commands after the first npm script were accidentally passed as arguments. Keep the final security-backports task.
- workerd: assert the current 12 maintenance roots, including the existing single `live_sync_dispatch`, without changing production scheduling. The PGlite experiment also hit prohibited dynamic Wasm compilation, so its adapter was removed. Run the unchanged 49 SQL/RSA payment cases against a strictly validated, separately owned PG16 database through the actual workerd Postgres.js driver. The test-only URL and CI service do not change production bindings. The real TCP replacement passed 53 targeted cases (the original 49 plus four lifecycle cases), then all 30 configured runtime files / 410 cases with zero skips, parent exit 0 and remaining=0/stopped. The installed driver uses the narrowly pinned [CF close backport](../vendor/README.md), with all 36 other upstream files unchanged. Full-run native host stderr still contains pipe/disconnect messages; stage 21 records those diagnostics and their remaining attribution limit. This is not a claim of warning-free execution.
- Secret scan: review all 277 findings, retain only their 276 unique immutable fingerprints, and verify three newly generated secret types in an independent temporary repository. See [the exact review](../../docs/security/gitleaks-reviewed-findings-20261030.md). Default scanner rules and the full-history scan remain enabled.
- Admin navigation checker: accept the actual `/system/frontend-log` branch only with `authStore.isLoggedIn`, retaining the exact membership guard. The historical 101 route/permission pairs from parent `8cdf74a8f14ed95dd35deb804c5a25613ff58046` and their original digest remain. Sixteen additions trace to checkpoint `d715da71abf6ce6f3dba6f2ee1b57e143744ebe3`; tests check their exact permissions and connected registered Admin routes. New negative cases reject unconditional and inverted login gates and disconnected routes/layouts.

These repairs are not a claim that all 917 baseline failures are resolved. Actual current execution results are recorded in stage 21 of [the migration notes](php-ts-wechat-routine-20261029.md), after the corresponding commands finish.

## Outstanding investigation

- The 17 membership-level frontend cases still mount an earlier form/list protocol. The current page uses `levelAuthor` catalog/commit/receipt/resolve and a durable journal. Reconnect the scenarios to the current actual SFC and protocol; do not remove recovery semantics or rewrite the product to satisfy the old fixture.
- Missing historical build/native logs, absolute local cache references and frozen whole-source inverses need provenance-aware treatment. Do not create fictitious evidence, rewrite accepted proof hashes or classify old acceptance as current execution.
- Native SQL/financial failures, remaining schema/parity assertions and the second shard's child-diagnostic failure need their own bounded checks. A complete rerun is still required before declaring the CI gate green.

The following narrower findings come from the original structured errors and current source inspection, without a new native reproduction:

| Original file | Observed result and first boundary | Next bounded verification |
| --- | --- | --- |
| `pink-virtual-timeout-postgres.test.ts` | 41 failed, all with the payment-attempt storage readiness exception during the first balance payment in `beforeEach`. Its limited quote fixture lacks the immutable routine ledger installation. | Reproduce one original case with the actual ledger installer and approved local payment identity, then run the complete file. Do not mock readiness or replace the ledger with an ORM-only table. |
| `coupon-gift-use-window-postgres.test.ts` | 10 failed / 9 passed. Failed paid-outbox paths encounter the same readiness exception; registration paths pass. Base migrations through 0184 and general runtime commissioning do not install the separate routine addon. | Install and commission the actual addon for the fixture's fixed identities, prove one original paid path, then run the whole file. Keep read-only quote fixtures unchanged. |
| `supplier-proactive-refund-service-native.test.ts` | 18 failed / 31 passed. Four failures explicitly reject local `applyPayment` being used to simulate provider-verified payment. Fourteen fail querying `routine_payment_attempt` from the dynamically created paid-consumer context; source inspection shows that context is outside the addon's fixed local-role grants. | Use the commissioned local writer for balance payments and the existing trusted provider-settlement/callback boundary for external payment fixtures. Capture actual session identity, privileges and complete SQL cause in the first reproduction; the original artifact did not expose SQLSTATE, so 42501 is not claimed as observed. |

Product-detail coverage now has 39 remaining failures in the local six-file run: one shared baseline and 38 mutants stop before their mutation assertion. The checker expects image budgeting/encoding directly in `createOrdinaryProductDataUrl`, while current code delegates through `codeDataUrl`, `fetchWithTokenRefresh` and `fetchCode`. A future repair must inspect that complete real chain, including the existing provider size/deadline and credential-source checks, and retain the negative cases. Static inspection also found the shared backend image helper accepts GIF while the product frontend accepts PNG/JPEG; this is a fail-closed compatibility gap requiring controlled-provider reproduction and a product-specific format constraint, not a reason to certify the old and new chains as equivalent.

No production data, credentials, provider endpoints, deployment or runtime permissions were changed by reading these artifacts.
