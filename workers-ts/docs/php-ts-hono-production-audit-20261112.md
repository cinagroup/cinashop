# Worker Hono production dependency audit repair — 2026-11-12

## Trigger and scope

The product-code batch was already merged at `582b6e12bed72d33632e233e2859e488131430ff`. Its [CI run 43344207610](https://github.com/cinagroup/cinashop/actions/runs/43344207610), workerd job `131619485134`, failed before runtime tests at the existing `audit:prod` gate. The production audit named one direct dependency, Hono 4.13.13, with three advisories. The install summary's development-tree count is separate from this production report.

Pin Hono to 4.13.18 and update its locked tarball/integrity. The only changed lockfile entries are the root dependency declaration and `node_modules/hono`; every other package record remains identical. Application routes, privilege envelopes, PHP reference, audit severity threshold, and retry policy are unchanged.

## Primary references

- [GHSA-4m76-xfj5-7975](https://github.com/honojs/hono/security/advisories/GHSA-4m76-xfj5-7975): mount prefix forwarding; affected <4.13.16, patched 4.13.16.
- [GHSA-h7mg-cq63-vhpq](https://github.com/honojs/hono/security/advisories/GHSA-h7mg-cq63-vhpq): wildcard middleware coverage; affected >=4.1.4 <=4.13.15, patched 4.13.16.
- [GHSA-3gg2-335m-rxc6](https://github.com/honojs/hono/security/advisories/GHSA-3gg2-335m-rxc6): CSS interpolation boundary; affected >=3.12.0 <=4.13.15, patched 4.13.16.
- [Hono 4.13.18 release](https://github.com/honojs/hono/releases/tag/v4.13.18): chosen because the maintainer documents additional fixes after 4.13.16, including custom-getPath mount forwarding.

Official pages were retrieved live through Firecrawl on 2026-11-13 UTC. These are dependency and library-boundary findings, not a claim of a demonstrated exploit against this deployment. Production source uses wildcard middleware; no production use of `mount`, `hono/css`, `validator`, `bodyLimit` or `serveStatic` was found by the bounded source search for those APIs.

## Regression boundary and validation

`hono-routing-patch.test.ts` exercises explicit default parameter coverage, overlapping wildcard routes, four encoded line terminators before not-found handling, dynamic mount prefix removal, and encoded-backslash parent preservation. Each case also tests an authorized or ordinary positive control. Bounded inputs only; no resource-exhaustion experiment.

| Check | Result |
| --- | --- |
| Exact installed 4.13.13 contrast, final eight test cases | 0 passed / 8 expected failures / 0 skipped |
| Frozen-lock clean `npm ci`, actual Hono 4.13.18 | Passed |
| Existing `npm run audit:prod`, low severity threshold unchanged | 0 production findings |
| Exact 11 complete auth/routing files, no case filters | 199 passed / 0 failed / 0 skipped |
| Original Worker compiler roots and options | All 4,370 roots covered by two serial 8 GiB shards; both passed |
| Original runtime TypeScript configuration | Passed |
| Complete unfiltered workerd graph with owned native PostgreSQL 16 | 30 files, 410 passed / 0 failed / 0 skipped |
| Native cleanup | 0 remaining fixture databases/roles; cluster stopped |
| Gitleaks source/full-file/exact-commit scans | Source zero findings; full-file and exact-commit zero findings required before delivery, recorded in external `completion.json` |

Every heavy command ran under the shared serial validation wrapper. Unit and runtime execution used one worker and no file parallelism. Source bytes were checked before and after every formal command. Both compiler partitions preserve the original compiler options and their union equals the original root set. Raw logs and the archived generated configurations are retained.


## Preserved attempts and limits

The first new-test preflight contained two incorrect mount expectations: it supplied `/*` to `app.mount()` and expected 400 where safe preservation produces 404. Those new tests were corrected against the installed implementation and official API contract; no existing test was edited. The initial 12-file attempt is retained as `preflight-unit.json`: 197 passed, 2 failed, 549 native shipping cases skipped because that attempt supplied no PostgreSQL URL. Those skipped cases receive no credit; the final targeted list omits that unrelated native shipping file.

An initial old-version contrast was started before the temporary old install finished. Its strict expected-failure check rejected the run because all eight corrected cases passed on the still-installed patch version. The output remains `preflight-version-guard.log` / `preflight-patched-routing.json`; it receives no old-version credit. The formal contrast requires the exact installed version before execution, followed by a clean `npm ci` of the frozen final lockfile.

The retained PHP source-binding and refund literal debts remain as recorded in the product-code batch; they were not changed or rerun in this dependency repair. Both Worker CI unit shards previously failed at checkout of fixed PHP ref `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5` before tests. No PHP source upload, replacement ref, deployment, live provider call or audit suppression is part of this batch.

Evidence: `/tmp/php-ts-hono-production-audit-20261112/` (raw logs, immutable source hashes, lockfile delta, installed-version guards, exact test list and compiler partitions). The earlier product-code UI acceptance remains attached to its own batch: installed Codex In-app Browser, production Supplier bundle with finite local HTTP fixture, desktop/mobile screenshots, nine successful writes and four invalid attempts rejected before POST; database HTTP acceptance was separate.
