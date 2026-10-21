# 2026-10-21 frontend dependency security increment

PR #141's parent-head CI exposed newly published launch-editor and
follow-redirects advisories in the existing lockfiles. This increment fixes
those concrete package/source boundaries and retains the other dependency
gates. It does not close the PHP-to-TypeScript migration or TEST-004D3.

## Official fixes and compatible installation

| Boundary | Official primary evidence | Installed treatment |
| --- | --- | --- |
| Windows editor argument expansion | [GHSA-698v-4r3x-3vcv](https://github.com/vitejs/launch-editor/security/advisories/GHSA-698v-4r3x-3vcv), [commit 3c2f9bf](https://github.com/vitejs/launch-editor/commit/3c2f9bf2ff8fe63d056a8f9cc52d825b66ca79fc) | Official Vite 6.4.4 in Kefu/PC; reject `%`, CR and LF before editor execution or termination in the UniApp bundled editor. |
| Option-like editor filenames | [GHSA-r825-w8mm-5pxw](https://github.com/vitejs/launch-editor/security/advisories/GHSA-r825-w8mm-5pxw), [commit f6e6701](https://github.com/vitejs/launch-editor/commit/f6e6701bb1f16f2dd242b321374f1b6cca6eb6d4) | Resolve filenames before launch; add the official explicit `./` prefix to WSL relative filenames. |
| Filename normalization after position stripping | [GHSA-587h-7wmj-h5pm](https://github.com/vitejs/launch-editor/security/advisories/GHSA-587h-7wmj-h5pm), [commit f13cd83](https://github.com/vitejs/launch-editor/commit/f13cd835d4b8e860b1d4d080ad8a490cc2463679) | Resolve after stripping position suffixes and before filesystem probing; preserve the empty filename and existing UNC guard/callback overload. |
| Array-form redirect headers | [GHSA-q3jh-wrc6-jgq8](https://github.com/follow-redirects/follow-redirects/security/advisories/GHSA-q3jh-wrc6-jgq8), [commit 9865ca4](https://github.com/follow-redirects/follow-redirects/commit/9865ca45490e4d0f7b6944870318408344570aff) | Official follow-redirects 1.16.1 override in PC/UniApp. |
| Custom sensitive-header regex escaping | [GHSA-8r9p-f939-6h3c](https://github.com/follow-redirects/follow-redirects/security/advisories/GHSA-8r9p-f939-6h3c), [commit 080a76d](https://github.com/follow-redirects/follow-redirects/commit/080a76d0e125b37bf81717368a61d5dc37aa56c8) | The same official follow-redirects 1.16.1 release. |

The launch-editor advisories identify 2.14.2 and Vite 6.4.4 as fixed releases
for these branches. The registry [Vite 6.4.4 manifest](https://registry.npmjs.org/vite/6.4.4)
and [follow-redirects 1.16.1 manifest](https://registry.npmjs.org/follow-redirects/1.16.1)
provide the exact archives and SRI values used by the lockfiles:

| Archive | SHA-512 SRI |
| --- | --- |
| Official Vite 6.4.4 | `sha512-xGjU/SyjeNyb0E4KxXBvYz/1C+3JXuujvf2hXNOtnlcE+58o5ajd9N2/n2VhkiJvpCP2qQasnUpx5PXNeI+p1Q==` |
| Official follow-redirects 1.16.1 | `sha512-FNvFGzoMLWmE6Yj9spb/zjd7yiNCHiAW9/Tg9CXrQ8wuu32HtlJOwWO11OJafl5FfY3DxTdQ0vj42zU1kvv5jg==` |
| Derived UniApp Vite 5.4.21 | `sha512-L7iUZlQFqFVDBsGsIh0Rsopt+AY+6LqEYkP4kUy20t6Gp4TjVFsqaRLWrbw1zQtjBrVnFYQQQMpRG0fBbQdGSg==` |

UniApp keeps its DCloud suite and `vite: ^5.2.8` peer contract. Its deterministic
constructor adds the three official launch-editor source fixes to the existing
three security and two compatibility fragments. It still reverses every exact
fragment and checks all 31 original files against the unchanged official source
contract. Only the bundled chunk and package manifest change. No standalone
launch-editor override could replace this bundled code. This remains a
project-maintained Vite 5 backport with the [documented support and platform limits](../uniapp-ts/vendor/README.md).

## Gates and current inventory

The existing CI `node --test ../common/toolchain-security.test.mjs` entry now
also verifies Kefu/PC's installed official Vite release. Its PC/UniApp import
runs the new redirect regressions: actual loopback HTTP requests cover object
and array headers, same-origin credential preservation, cross-origin stripping
of built-in and regex-metacharacter custom sensitive headers, and preservation
of an ordinary public header. The editor regression executes the real bundled
functions with inert filesystem/process sinks and valid local/positioned file
controls. Its Windows/WSL fixtures prove portable policy boundaries; they do not
run CMD, a native Windows editor or a network share.

The official lock-only audit reports zero affected entries for Kefu and PC.
UniApp remains at **82 affected package entries**: 3 low, 17 moderate, 62 high,
0 critical. These are npm graph counts, not independent vulnerabilities. Its
26 direct source objects reference 25 distinct GHSA URLs; the same eight scoped
chains remain open. Six Vite version alerts remain because the derived archive
retains version 5.4.21. Each is required to match one exact reversible security
patch. The two follow-redirects source IDs 1242604/1242605 join the forbidden
resolved list (11 total); they are not allowlisted. The gate implementation and
its unknown-source/path/edge rejection rules are unchanged.

Current UniApp semantic lock SHA-256:
`33f137aab5dd51a78c25ce5be5c73f4920ab9a166bb0c9c964ddf87d5f953609`.
The older dated D3 inventories remain historical receipts and are not rewritten
as evidence for this lock.

## Local verification and pending integration

All three actual `npm ci --no-audit --no-fund` installations completed. Narrow
checks run one command at a time through the shared validation wrapper with
Node test-file concurrency one:

| Check | Result |
| --- | --- |
| UniApp editor, archive, D3 and common security entry | 27/27 pass, zero skips |
| UniApp existing Vite path/Windows-policy/esbuild server and compatibility | 35/35 pass, zero skips |
| Kefu existing common security entry | 15/15 pass, zero skips |
| PC existing common security entry | 10/10 pass, zero skips |
| Official-registry UniApp live D3 gate | Pass: 82 entries, 26 direct objects, 25 URLs, 8 chains |

The first UniApp check attempt was stopped before launching tests because the
restricted sandbox could not write the shared validation lock. It is retained
as a failed setup candidate; the authorized wrapper retry above completed.
Raw official metadata, source archives/patches, installation and test logs,
including that failed attempt, are retained locally under
`/tmp/cinashop-dependency-ci105/`. This temporary receipt directory is not a
published CI artifact and can be removed by OS cleanup.

Full UniApp typecheck, all three resource builds and graph audit, Kefu tests/
build, PC build and the final social-page browser acceptance belong to the
coordinated integration run. An immutable-head GitHub CI result is still
required. Neither these focused tests nor a clean Kefu/PC audit establishes
that all optional DCloud modes or native Windows behavior are verified.
