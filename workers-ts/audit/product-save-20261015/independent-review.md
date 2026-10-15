# Independent read-only review: complete product save candidate

Date: 2026-10-15. Review performed against the actual uncommitted worktree, not the earlier design alone. No source edit, test invocation, typecheck, build, provider call, or migration execution was performed by this reviewer. Parent validation results are not independently certified here.

## Findings

### P2: New-product baseline checks ID 0 rather than the newly allocated actual ID

`AdminLegacyProductSaveService.ts:148-151` snapshots child groups for `productId=0` on an ordinary create. `ProductAssociationService.ts:763-805` inserts the parent, obtains its actual serial ID, and immediately deletes/replaces selected relation groups and ordinary SKU dimensions/result. The coordinator then also deletes/reinserts the actual ID type-0 description at `AdminLegacyProductSaveService.ts:177-178`. No check first proves that the actual ID has no orphan children. These legacy tables have no product foreign keys in the schema.

Concrete reproduction: leave `store_product` empty, put only a type-0 description at `product_id=1`, and perform the ordinary create whose sequence assigns ID 1. The ID-0 baseline is empty, the old description is deleted, and the final proof sees exactly the expected new description, so the orphan is silently overwritten and the save can commit. The same issue affects orphan ordinary attr/result rows and replaced relation groups. This violates the intended refusal of preexisting unowned child data and makes the claimed complete-before-state proof inaccurate for creates. Reject a nonempty complete actual-ID child set after parent ID assignment and before any child mutation, under the existing real barriers. Add an SQL regression proving no orphan child/audit/outbox mutation after rejection.

### Historical unique-character restriction: source fix observed, final validation pending

Initial `AdminLegacyProductSaveProof.ts` applied `/^[a-zA-Z0-9]{8}$/` to all assigned SKU identities. The stable SKU primitive preserves historical identities and PostgreSQL `char(8)` does not constrain them to alphanumeric, so a valid historical value such as `old-sku1` would be rejected. Parent changed the current source to compare old identities byte-for-byte and apply hex-8 syntax only to newly allocated IDs. This change is visible at current `AdminLegacyProductSaveProof.ts:58`; the parent reports a new SQL case but its final execution is outside this review.

## Reviewed paths with no additional confirmed finding

- PHP `StoreProductServices::saveData` and `CreateSuccess::handle` compared with pending-owner verification behavior. `verifiedState = supplierId ? undefined : 1` deliberately reproduces setting verification before restoring old nonplatform owner; owner-1/pid-0 cart status tests the pending state, not the old stored verification.
- All existing nonplatform ownership remains preserved, and request `type` remains a copy marker rather than owner authority. Supplier assignment on platform/new products is validated.
- Source-link candidate discovery precedes product/bargain business locks; actual `store_product` NOWAIT write barrier plus full candidate reread closes concurrent matching-link inserts/updates from ordinary SQL. Ambiguous active historical matches are refused.
- Full-set barriers include SKU, cards, all parent carts, all relation types, descriptions, coupons, discount rows, four activity tables, audit and outbox; final snapshots retain assigned cards and untargeted SKU/activity types.
- Inventory-backed card stock is initialized from actual current stock, requested new card material is separately deduplicated/imported, assigned rows remain unchanged, and final attr-result stock is synchronized. Current coordinator explicitly refuses preexisting available-card/stock disagreement.
- One authority transaction owns the save. Live platform permission/password identity is reloaded at the final boundary, and PostgreSQL `clock_timestamp()` expiration is checked before returning. Audit/outbox defaults are checked from independent schema defaults rather than adopting INSERT receipt mutations.
- Dedicated `product.save.effects` identity is wired into Queue classification, claim identity/lease checks and completion predicate. Notification scope accepts the dedicated event explicitly. Global tag and six relation invalidations use postcommit providers; provider failure leaves durable retry state.

## Boundaries

This is an implementation-layer review only: route/JWT/old helper wiring and full edit/copy UI are not yet connected, and no statement here establishes full editor migration completion. Real Redis/Lua, socket delivery, remote scraped-image storage, encrypted AutoConfig internals and cloud upload credentials remain unverified external boundaries. Scraped `type=-1` requests are explicitly refused before business mutation. No new defect is asserted merely because those boundaries remain open.
