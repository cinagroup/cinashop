# Product GET publish review

Reviewed 2026-10-15T04:46Z against the actual shared worktree, the completed native-confirmed receipt/log and the current input freeze. This follow-up ran only read-only file/hash/receipt checks. No tests, typechecks, builds, migrations or providers were invoked and no repository source was edited. The original independent review and addendum retain their historical status statements.

## Decision

No additional confirmed P0–P2 issue blocks this explicitly bounded incremental GET batch. The previously pending 768 KiB full-form refusal case has now actually passed on native PostgreSQL. Current code inputs match the frozen set. Publication still depends on the parent's separate ordinary 12-file regression and both TypeScript gates; this report does not certify those as passed.

## Completed native evidence

`native-confirmed-status.json` records the four-file PG16 runner invocation, start 2026-10-15T04:43:41.715899Z, completion 04:44:25.130899Z and exitCode0. The inspected runner wrapper uses `/home/cina/cinagroup/tools/validate-serial.sh`. The log identifies PostgreSQL16.14 at the owned loopback fixture and contains an individual passing line for each of the following totals:

| File | Actual passing test lines |
| --- | ---: |
| `test/admin-legacy-product-read.test.ts` | 14 |
| `test/admin-legacy-product-read-http.test.ts` | 6 |
| `test/admin-legacy-product-read-native.test.ts` | 3 |
| `test/admin-product-rule-http.test.ts` | 12 |
| Total | 35 |

The final Vitest summary is 4 files/35 tests passed. The new HTTP test, "refuses a large duplicated live form before returning a whole DTO the old form cannot resubmit", has its own passing line (662ms). Current source `admin-legacy-product-read-http.test.ts:122-127` creates an active current form with a 500000-byte value, uses the actual old productAddApi to save the selected template plus a 100000-byte description, requires actual productInfoApi to reject with the 768 KiB message, and compares the complete business snapshot unchanged. This closes the last pending boundary-test evidence identified in the addendum. The long Unicode description read/save case also has its own passing line (691ms).

The log ends with `FINANCE_LOCAL_FIXTURES remaining=0` and `FINANCE_LOCAL_STOPPED /home/cina/cinagroup/cinashop/.cache/finance-postgres-S7wJa6`. Expected fault/dispatch stderr appears in the test log; it does not replace a successful effects delivery claim. No production ACL, Hyperdrive, provider or deployment validation is inferred from this local run.

Receipt SHA-256: `29d1e67317ee854d93f68aedde1f14d92552722cf8e6990616cbbed780d20dcb`.

Log SHA-256: `af0d2943b2f5345c241d0ed82cf6b9a7c399648478486590ccb23452b201a285`.

## Current source pin verification

Read-only `python3 /tmp/cinashop-product-read-20261015/freeze.py verify` completed exit0 and returned:

```
{"verified": true, "files": 3114, "sha256": "1b1bb3856cf216d098a7d7dea0b80a02063ac64b46889a927149622a68f03ae0"}
```

The freeze was captured 2026-10-15T04:43:37.762798Z before native-confirmed started, with base commit `ac04e154443267d8b7209cc7659066be5d02e478`. The verification recomputes both the current tracked/untracked input set and all individual hashes; it is more than a comparison of a stored digest string. The current source-inputs.json file hash is `5725c814196f6449f5fae57d82b96c51483b218f6e364f6ee2480832eb77d60f`.

| Relevant current file under `workers-ts/` | SHA-256 |
| --- | --- |
| `src/services/admin/AdminLegacyProductReadService.ts` | `ecf74aec76992f9ab0c0209bca461538b04d9f2f8a8c601074c2e73139d86a5c` |
| `src/services/admin/AdminLegacyProductReadBudget.ts` | `8bcf095d8b85108365f6af890f9761222c1729701ec032cf1753c26499d03e2c` |
| `src/controllers/api/v1/AdminLegacyProductReadController.ts` | `5b3e94cae8d3ac9b058feb99cf28c89ebae00ac30b47d85da147678aea1478f1` |
| `src/routes/adminapi.ts` | `d8882a1782a22c3b144a662ef8239b6d88a7c68671f44827e89bf69acaf43a1b` |
| `src/utils/legacy-php-json.ts` | `b9dc7e6e39442de62677817c9c1f17be9bbd711dcbbf2b3ed97d157b600ace77` |
| `test/helpers/adminLegacyProductRead.ts` | `c294a523f5223975aff4b27f96deddd920b25b3512d8a15576ce560a604d0238` |
| `test/admin-legacy-product-read.test.ts` | `3650db59ba5802a3d2ec041c47744698750fecca0c23436a9ab8b324ef824225` |
| `test/admin-legacy-product-read-http.test.ts` | `d84eacbc4510efb145b758de8264b898ea2070210db37139ac064d358d3e97cb` |
| `test/admin-legacy-product-read-native.test.ts` | `8b10e0261e1de31f6ebfbf539b1b892cc37e8dd1e3706498d07b7c77c541ea72` |
| `scripts/run-local-finance-postgres.mjs` | `1a1dac43b243422e920d424042cb6a2add65da75f28b51215a700de692c2026b` |

The HTTP test hash intentionally differs from the earlier addendum: the fixture now explicitly has status1, and native-confirmed exercises that corrected current source. The freeze covers workers-ts source/tests/scripts/migrations and its listed package/TypeScript/Vitest/generated binding inputs. It does not make documentation, external PHP/Vue source, browser behavior or a whole-repository deployment immutable; preserve their separate source references and scope statements.

## Final static boundaries retained

- SQL phase-one preflight precedes full main/collection materialization; phase two budgets selection-dependent rows with the remaining same-snapshot budget. Aggregates transport no raw text, and inventory card credentials are not scanned or returned. The SQL helper was authored by this reviewer earlier; this final check is not an additional independent implementation review of that helper.
- JSON/form/dimension expansion guards remain before their potentially large expansions. The actual UTF-8 768 KiB productInfo check is at service lines226-227, before editor metadata, HTML preview and signing. Stored form, retired rows and preview remain siblings under editor. Fixed delivery content remains present for authorized editing.
- The physical owner1 supplier echo and pending cart branch remain covered. Literal get_rule/rule routes precede the dynamic resource GET, and the existing real rule HTTP regression passed in this four-file run.
- The release is allowed to refuse a complete GET when it exceeds its documented capacity. A valid POST, a later large live template or incompatible historical values can still be unavailable for unchanged old-editor resubmission; 768 KiB is not a universal roundtrip proof.
- PHP description persistence escapes while the model accessor and description service each decode on the real read path. Current TS stores raw editable markup and the generic text-to-text import has no corresponding source normalization. The exact path/line/SHA correction remains in the addendum. This is an explicit source-import acceptance gap, not a reason to blindly decode mixed raw TS/PHP rows in this batch.
- generate_attr, mounted full Vue edit/copy, trusted copy handling, production ACL/provider acceptance and full source-data commissioning remain unfinished migration work. This publish review does not close the overall migration objective.

The ordinary 12-file run and both tsc checks were not counted as passed here. The parent must attach their own completed receipts and reverify frozen inputs after them before claiming the complete release gate.
