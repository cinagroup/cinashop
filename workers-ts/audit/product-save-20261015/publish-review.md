# Independent publication review

Reviewed at 2026-10-15T04:12:13.719113+00:00. Read-only inspection of the actual uncommitted worktree. This review did not run Vitest, tsc, Vite, a database migration or provider calls, and did not edit repository source. Earlier review/addendum files remain historical and unchanged.

## Conclusion

No new P0–P2 source defect was identified in the three unused-symbol removals, the two newly added native barrier cases, or the added workerd save-key DO case. The prior historical-unique and actual-new-ID orphan findings remain fixed in the source inspected here. Publication still requires the remaining validation gates and the final evidence ledger; this is not a blanket all-gates-passed certificate.

## Three cleanup changes

- Removed the unused HttpApiException import from AdminLegacyProductSaveService. Its error mapper still throws classified productSaveConflict/ServiceUnavailableException, and the controller retains its independent HttpApiException import for 409/503 translation.
- Removed the unused local Product type alias from the same service. No persisted values, branch or call site changed.
- Removed the unused shippingTemplates import from the root SQL test. This does not remove the actual schema helper table or runtime shipping validation; the helper and coordinator still reference shippingTemplates.

All three are erased unused TypeScript bindings. The prior typecheck failure log contains exactly those three unused-symbol diagnostics; their removal is not, by itself, a passed replacement typecheck.

## Added native tests

The new admin-legacy-product-save-native.test.ts defines two PG16-only cases. It uses the registered legacy fixture and withFinancePeers, whose implementation verifies the observer plus three peer PIDs are distinct and remain connected to the same owned PG16 database/schema.

1. Real independent UPDATE holders on store_cart and store_product_category are observed as granted RowExclusiveLock. The real coordinator must return classified HTTP409/code409, with the entire fixture business/audit/outbox snapshot unchanged before holder release and afterward.
2. pauseModerationExecute awaits the original actual LOCK statement before pausing; it does not synthesize a SQL result. The real ShareRowExclusiveLock on store_cart is checked. An absent target-cart insertion from a separate backend must appear in pg_blocking_pids via waitForFinanceBlock. After finally releasing the coordinator, both outcomes are drained. The complete save must commit, the prior paid/deleted/activity cart status must follow the source plan, the later inserted cart must survive exactly, and product/SKU/description/audit/outbox receipts plus all untouched tables are checked.

Both asynchronous holders use finally releases; the barrier test drains the save and insert outcomes even on assertion failure. The multiline LOCK matcher includes store_cart so it cannot pause on the earlier authority barrier. Both runner allowlists include the new native file in the inspected current state.

These cases do not prove same-source-link concurrent create, metadata absent-row insertion races, least-privileged deployed LOGIN behavior, every SKU/card race, or production execution. No passing native execution result was available to this review at the observation boundary.

## Added DO runtime test

The existing real workerd StaffNotificationDO fixture now has one additional save-key case. It publishes a valid product.save.effects UUID key in product_stock scope, expects the exact STORE_STOCK/id frame and connected receipt, evicts the DO, replays the same key with the same revision and one persisted signal, then proves a distinct save UUID for the same product is a new revision. It also refuses the save key in the withdrawal scope and checks that scope receives no frame. Both sockets are closed in finally.

Only the preexisting database authorization port is mocked. DO SQL storage, RPC publish, WebSocket frames, eviction/hibernation and scope parser are real workerd paths when this test runs. This is isolated runtime proof, not production socket-provider/JWT/SQL end-to-end acceptance. No passing runtime execution result was available to this review at the observation boundary.

## Directly inspected evidence

- Source freeze verification succeeded: 3107 selected files; SHA-256 110ab40ffaef0e77b6da33908b111eeab1e36a1c31fac406e119ed607241dabb.
- git diff --check completed successfully.
- save-expanded-status.json and log show exit0, four files/41 tests passed and one file/five native-only tests skipped. Those five skips are not native passes.
- During this review unit-regressions completed. Its status receipt now shows exit0 and its log shows 12 files / 148 tests passed. The earlier 41 tests overlap this group and must not be added to produce 189 distinct tests.
- The initially failed typecheck-unit status remains exit2 with the three unused-binding diagnostics. A completed successful final replacement typecheck was not inspected.

The selected-input freeze excludes wrangler.test.toml/wrangler.toml, view/common and the external PHP API/request helper files that the HTTP fixture reads. The selected freeze is valid for its declared scope; do not describe it as a complete freeze of every runtime and old-helper input unless the manifest is broadened.

## Documentation publication checks

The current document accurately keeps GET detail/attribute generation, full edit/copy UI, trusted localCopy HTTP entry, unknown-outcome recovery, type2 fulfillment, encrypted AutoConfig, source-link/metadata race gaps, deployed minimum ACL and formal production acceptance open. It does not close the overall migration goal or parent checklist items; no frontend/browser or live-provider proof is asserted.

Before committing, resolve the linked workers-ts/audit/php-ts-admin-product-save-20261015.json: it did not yet exist when inspected. Populate the ledger only from completed receipts. Refresh the validation paragraph to describe the new genuine native coordinator barriers and isolated save-key DO scope once those gates have passed, while keeping source-link/metadata-insert and production-provider limits explicit. A real isolated DO/socket test and an unconfigured production socket provider are distinct evidence scopes.

## Current reviewed hashes

- `workers-ts/src/services/admin/AdminLegacyProductSaveService.ts`: `814db4de846c422152684523c169cec72f71f00806b351dc5446c4e26aaaad41`
- `workers-ts/test/admin-legacy-product-save.test.ts`: `62a2ccc2071b09d73a69fa21363857088c2cd8776ec1be691a44795fad7d44d4`
- `workers-ts/test/admin-legacy-product-save-native.test.ts`: `e52d02aed59456b8cbe8b3875dd24dd69a410fe6dc215f000cac9adcdc4e8c1e`
- `workers-ts/test/runtime/staff-notification-runtime.test.ts`: `048c55c62929a0be8a55cd0eba8058d129db67a236277b83a4f21895d2e643e8`
- `workers-ts/docs/php-ts-admin-product-save-20261015.md`: `bac6439707e4d1e1f7de0d09fef1f7115c522a2a03c6e1775b581bbebfed3f84`
