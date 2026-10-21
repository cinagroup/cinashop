# Community state route: CI source proof, 2026-10-21

Parent PR144 (`7d3c06f3`) run [39544987435](https://github.com/cinagroup/cinashop/actions/runs/39544987435) failed five assertions: four stale whole-route-source bindings and one settings report case exceeding its default 5-second timeout (5,148.966 ms). The downloaded shard artifact digest matches GitHub metadata. This patch changes audit evidence and tests only.

The real Admin API generator now reproduces exactly 717 changed fields: the v1 source hash and 716 later registration line numbers, each increased by one. All 732 consumer paths remain executable; paths, handlers, availability and consumer records are unchanged. `community-state-root-source-increment-20261021.json` records the exact state registration and both source/report hashes. Tests reverse only that unique line at 972, then independently reverse the historical video line at 928. The dated merged report, video proof and statistics restoration manifest retain their original bytes. Reconstructing the intermediate video report preserves its original SHA without copying a second large report.

The user's restored PHP `/api/get_script` behavior remains authoritative. Its handler, registration, shared loader and three frontend entry sources retain full source bindings. Only the later community state line may be reversed from the route file. Duplicate registration, changed authentication/handler, extra source text, changed statistics registration/handler and an incorrect predecessor hash are rejected.

Settings tests still invoke the real generator separately for all eight modes and compare complete dated report bytes. They register the installed tsx loader directly in Node, compile pure gate functions once, and verify the entire current 137-page host chain in one dedicated case. Mutation inputs/results are never cached. The default 5-second test timeout, all ten-key and source-mutation assertions, native budgets and CI workflow remain unchanged.

Local validation (Node 24.19.0; CI separately pins Node 24.14.1/npm 11.11.0):

- Real strict Admin API generator: byte-identical to the independently constructed expected increment.
- Four complete test files: **70 passed, 0 failed/skipped/todo**, including 9 new cases. Ten-key settings case: **2,931 ms** locally within the existing 5,000 ms budget; this is not a CI timing guarantee.
- Both complete Worker TypeScript configurations passed through the shared serial wrapper.
- Runtime/frontend sources, dependencies and workflow remain byte-identical to base PR145. Its prior real 26-stage background browser acceptance is retained; no new browser run is claimed for this audit-only patch.

Machine-readable commands, source hashes, exact diff and logs are in `../audit/community-state-ci-validation-20261021.json`. New commit CI must be evaluated independently after publication; local success does not change the parent run's failed result.
