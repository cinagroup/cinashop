# 2026-10-22 Vite security increment

This increment responds to newly indexed official Vite advisories. It changes
compiler dependencies and security regressions, without changing the four web
applications' business sources or the DCloud suite/version contract.

| Boundary | Official source | Project treatment |
| --- | --- | --- |
| HTML inline proxy script origin | [GHSA-9jrq-w75r-8gcw](https://github.com/vitejs/vite/security/advisories/GHSA-9jrq-w75r-8gcw), [7dafd8e](https://github.com/vitejs/vite/commit/7dafd8e56f152403a3230608fa4005273c2e9e17) | Strip URL queries before filename resolution and normalize protocol-relative proxy paths in the paired Vite 5 archive; official 6.4.5 elsewhere. |
| Filesystem authorization identity | [GHSA-rq7h-c2jc-7f22](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22), [d73a420](https://github.com/vitejs/vite/commit/d73a4200dfd6df1e73e52df44d1dc438144580dd) | Admit only genuine resolved module IDs to the safe set, never root-relative browser URLs; official 6.4.5 elsewhere. |
| Query-based deny regression in 6.4.4 | [GHSA-8g5g-mxqh-grgj](https://github.com/vitejs/vite/security/advisories/GHSA-8g5g-mxqh-grgj) | The four ordinary Vite frontends advance to official 6.4.5; the narrow Vite 5 port preserves its prior deny checks and tests their actual behavior. |

Before the increment, Admin/Supplier lock Vite 6.4.3 and PC/Kefu lock 6.4.4.
The first two versions match the first two advisory ranges. The 6.4.4 version
matches the separately published October 21 regression. At investigation time,
the npm bulk service reported the first two new objects (1242724/1242730) but
had not yet indexed the 6.4.4-only advisory; these are separate evidence sources.
The official [6.4.5 manifest](https://registry.npmjs.org/vite/6.4.5) preserves the
same dependency ranges. The four manifests now require ^6.4.5, and their locks
change only the root Vite requirement and that Vite node's version, official
registry URL and SRI. The Kefu Vitest patch described below is the only additional dependency version change.

Official Vite 6.4.5 SRI:
`sha512-4enwjFfi4IwtEh0w+jPzpLVOFQiPHmmzPxcHXQOyEur47o6u0jE573DmGpjA+7irXoMLYRZD5ZaFUEneS3abPg==`.

UniApp retains 5.4.21 because the installed DCloud peer requires Vite 5. It adds
four exact, reversible bundled fragments covering the two new advisories, while
retaining all six earlier security fixes and two official esbuild compatibility
fragments. Its manifest/source-contract/license/file-count boundary is unchanged.
The derived SRI is
`sha512-AAX6pC+pbjIgyb202dKiM7i0r1legogbqhP+DsL34/20TgCRTsxyT6huPdyb7RZRx10iuON4+G5tsSDTEdBS1Q==`.

The shared regression resolves Vite from each job's own package root. Real
middleware tests exercise hostile // and /// HTML proxy URLs, absolute-host
path confusion with fresh inert files, unresolved SSR imports, denied query
variants and legitimate local/raw/virtual modules. The original installed Vite
5 reproduces the two broken boundaries; the completed proof records the
same cases passing against the installed final bytes. No existing credential or
production file is used as a test target.

The D3 implementation remains fail-closed. Its exact reviewed contract adds
the two tuple identities only alongside source and actual behavior proofs;
all previously forbidden sources and graph checks remain. Its version-based
Vite alerts remain in the report because a project backport keeps version
5.4.21. This does not declare the entire dependency tree vulnerability-free,
restore upstream Vite 5 support, or close release/device/security parent gates.

Kefu's exact previous lock also produced official npm audit sources 1242767
([GHSA-qxg6-89mg-rqv8](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8))
and 1242769
([GHSA-xp26-3454-mjgp](https://github.com/vitest-dev/vitest/security/advisories/GHSA-xp26-3454-mjgp))
on Vitest/@vitest/mocker 4.1.11. This breaks the actual Kefu CI full-tree audit.
Kefu therefore moves only the paired Vitest patch packages to official 4.1.12.
The published patch serializes manual mock URLs/export names as literals and
normalizes redirect backslashes before filesystem authorization. Tests call the
actual public plugin's registration and load hooks, then import its generated
inert module. The old version executes the inert injected statement, rejects
quoted export names, and admits both backslash traversals; the ordinary manual
mock and deferred live bindings work before and after. The redirect tests prove
Linux-hosted normalization/admission behavior; they do not claim native Windows
filesystem execution. No actual network attacker or credential file is used.

On 2026-10-22, all five locked installations completed. The installed UniApp
boundary/provenance/D3 suite passed 24/24, the six pre-existing Vite regression
files passed 46/46, and live D3 accepted the exact 82 package entries / 28 source
objects / 27 URLs / eight scoped chains. The shared gate passed from each own
cwd: UniApp 14/14, Admin 14/14, Supplier 14/14, PC 16/16, Kefu 26/26. These
repeat the shared Vite logic across versions and are not added together as
independent new tests. This increment adds 13 distinct regression cases.

All four Web builds passed with official Vite 6.4.5; Kefu was rebuilt after
installing Vitest 4.1.12, and its five unit files / 30 cases passed with one worker.
Admin/Supplier ECharts regression commands also passed. PC/Kefu full official
npm audits report zero; Admin/Supplier still report the existing ECharts and
follow-redirects entries, which their actual CI does not suppress or newly
full-audit. The new Vite alerts are absent in both. No blanket advisory allowlist
or gate removal was used.

The local runtime is Node 24.19.0 / npm 11.11.0; CI pins Node 24.14.1, so this is
local gate evidence rather than a claim that the future GitHub jobs ran. The
main UniApp full build/device/browser gates are recorded separately by the DIY
migration handoff. The security source whitelist, command lines, exact logs,
installed lock provenance, old-version counterexamples and source hashes are
in `/tmp/cinashop-diy-editorial-security-handoff.json`. Historical failed
candidates remain preserved and are explicitly excluded from final success.
