# Vite 5.4.21 safety backport

This project uses a derived Vite npm archive to preserve the installed DCloud
`3.0.0-4020920240930001` peer contract (`vite: ^5.2.8`). This is a project-maintained
backport. It is not an official Vite release or a claim of ongoing Vite 5 support.
[Vite's supported releases](https://vite.dev/releases) exclude Vite 5.

## Official upgrade boundary checked on 2026-09-27

The [official DCloud stable CLI template](https://github.com/dcloudio/uni-preset-vue/blob/053c9794519215d7f5a38beb1252e11efc7820d5/package.json)
uses suite `3.0.0-5020620260917001` and exact Vite `5.2.8`. The matching
[`vite-plugin-uni` registry manifest](https://registry.npmjs.org/@dcloudio/vite-plugin-uni/3.0.0-5020620260917001)
also declares an exact `5.2.8` peer. The newer Vue 3 alpha tag still declares this
peer. There is no verified supported upgrade to Vite 6.4.3 in this official chain.
The existing DCloud suite is preserved here; a future official supported upgrade
should replace this derived archive and retire its backport tests.

## Source and exact change boundary

- Official archive: <https://registry.npmjs.org/vite/-/vite-5.4.21.tgz>
- Source SRI: `sha512-o5a9xKjbtuhY6Bi5S3+HvbRERmouabWbyUcpXXUA1u+GNUKoROi9byOJ8M0nHbHYHkYICiMlqxkg1KkYmm25Sw==`
- Derived SRI: `sha512-S4r0FWY2V84PjJ/mLvZlKMJGMNdh7X2uHZFIYOARsnJaKtco/eeYywiNTO6wDjxCg9e83hFWt6oXcKQFCZnQNA==`
- `vite-5.4.21-source.json` pins all 31 source files, modes, SHA-256 content and
  canonical tar headers. The archive still contains those same 31 files.
- Only `dist/node/chunks/dep-BK3b2jBa.js` and `package.json` change. Every other file,
  including `LICENSE.md` and the public types/client runtime, retains its original
  bytes. The MIT license, package identity and version `5.4.21` remain unchanged.
- The manifest adds explicit `cinashopSecurityBackport` provenance and fixes its
  esbuild dependency to `0.28.2`. Two consumer-scoped root overrides also pin this
  version for Vite and `@dcloudio/uni-cli-shared`. Other dependencies are unchanged.

| Boundary | Official fix | Backport |
| --- | --- | --- |
| Optimized dependency map | [GHSA-4w7w-66w2-5vf9](https://github.com/vitejs/vite/security/advisories/GHSA-4w7w-66w2-5vf9), [commit ca4da5d](https://github.com/vitejs/vite/commit/ca4da5d1fb45c9cfdce606aa30825095791b164b) | After resolving the map path, require `depsOptimizer.isOptimizedDepFile` before `readFile`. |
| Bundled editor UNC probe | [GHSA-v6wh-96g9-6wx3](https://github.com/vitejs/vite/security/advisories/GHSA-v6wh-96g9-6wx3), [Vite dependency fix 8fed5cf](https://github.com/vitejs/vite/commit/8fed5cf540c0d475266787f52072f258478cd42f) | Inline launch-editor 2.14.1's Windows resolved-UNC rejection before any `existsSync` probe. A standalone dependency override cannot fix this bundled copy. |
| File authorization aliases | [GHSA-fx2h-pf6j-xcff](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff), [commit 96b0c10](https://github.com/vitejs/vite/commit/96b0c10162e9c55485d922db2cfc6b8227cbc176) | With `fs.strict` enabled, reject Windows `~` aliases and colon paths except the Windows drive separator, before deny/allow/safe-module checks. |

The inline UNC guard uses the existing `wrapErrorCallback` with the existing
function-overload convention. This small adaptation preserves optional callbacks
in Vite's default middleware instead of introducing a TypeError on rejection.
Its rejection boundary and diagnostic come from the
[official launch-editor 2.14.1 archive](https://registry.npmjs.org/launch-editor/-/launch-editor-2.14.1.tgz),
SRI `sha512-QWBrQsMpH7gPr965dsKD/3cKWiNoTjpATQf++Xq63N6sKRGMwlVXz41O1IZTMfZQgBctD/K5Zt06+/I6pP6+HA==`.
Normal local paths follow the original editor behavior. As in the official fix,
Windows names containing `~` are rejected under strict mode even if a name is not
an 8.3 alias. Disabling `fs.strict` remains the explicit upstream opt-out.

### Official esbuild compatibility backport

The same bundled chunk also carries Vite's exact
[PR #22346 compatibility fix](https://github.com/vitejs/vite/commit/5ab51c0f76f0896175e02ad797c1f5fe116d02f4).
Its two additional fragments recognize Safari 10 through 14.0 and iOS 10 through
14.4 and enable native destructuring only for those targets. An explicit user
`supported.destructuring` setting still wins. Safari 9 receives no exemption.
The target detector and supported-feature merge match the fixed official source
AST after stripping TypeScript annotations, comments and source positions.

This restores the old compiler behavior. It does not fix the existing Safari
engine bug or raise any browser, App, or signed client target. No Babel lowering
is used. Three native-versus-compiled iterator/default counterexamples, real Vite
builds for the affected targets, Safari 9 rejection and explicit user rejection
are covered by `vite-esbuild-compatibility.test.cjs` (14/14). This known Safari
limitation must remain documented when adopting the candidate.

## esbuild version and compatibility

[Official esbuild 0.28.2](https://github.com/evanw/esbuild/releases/tag/v0.28.2)
is the registry stable version checked on 2026-09-27 (Node >=18).
Its [npm registry manifest](https://registry.npmjs.org/esbuild/0.28.2) supplies SRI
`sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA==`.
It includes the [0.25.0 cross-origin serve fix](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99)
and the [0.28.1 Windows serve traversal fix](https://github.com/evanw/esbuild/releases/tag/v0.28.1)
([GHSA-g7r4-m6w7-qqqr](https://github.com/evanw/esbuild/security/advisories/GHSA-g7r4-m6w7-qqqr)).
The official 0.28.0 npm binary integrity change and 0.28.1
[Deno binary integrity fix GHSA-gv7w-rqvm-qjhr](https://github.com/evanw/esbuild/security/advisories/GHSA-gv7w-rqvm-qjhr)
are also included. This project's actual esbuild entry uses npm's installed
Node API and platform package; it does not download through the Deno installer.

DCloud's installed `dist/esbuild.js` calls `build`; its CSS plugin calls
`transform` and `formatMessages`. Vite's bundled implementation uses the same
public API family. The actual resolution chains and focused API/security tests
pass. The official compatibility backport above handles the existing Safari14
build target without replacing either consumer's fixed esbuild version.
This override is not an upstream DCloud support statement.

## Earlier candidate failure and rejected lowering

This is an uncommitted candidate, not a release-ready dependency set. On
2026-09-27, archive/installation integrity tests passed 6/6, independent security
regressions passed 32/32 with no skips, and `npm run typecheck` exited 0. Actual
`build:h5` and `build:mp-weixin` both exited 1 in `vite:esbuild-transpile`:

```text
Transforming destructuring to the configured target environment
("chrome87", "edge88", "es2020", "firefox78", "safari14" + 2 overrides)
is not supported yet
```

The H5 failure included `articleRichText`'s `.map(([name, value]) => ...)` chunk.
The actual esbuild API independently rejects `const [a,b]=value;` for `safari14`,
while the same input passes for `es2020`, `chrome87` and `safari14.1`. The two Vite
supported-feature overrides are not the cause. An isolated official esbuild
0.28.1 install reproduces the same failure; reverting only to 0.28.1 does not
restore compatibility.

The official [0.27.3 compatibility table](https://raw.githubusercontent.com/evanw/esbuild/v0.27.3/internal/compat/js_table.go)
allows Safari10 destructuring, while [0.28.0](https://raw.githubusercontent.com/evanw/esbuild/v0.28.0/internal/compat/js_table.go),
[0.28.1](https://raw.githubusercontent.com/evanw/esbuild/v0.28.1/internal/compat/js_table.go)
and [0.28.2](https://raw.githubusercontent.com/evanw/esbuild/v0.28.2/internal/compat/js_table.go)
require Safari14.1/iOS14.5 for this feature. In that earlier candidate, no client
target was raised and no `supported.destructuring: true` override was present.

At that stage, App build, artifact checks, `test:automator-qr` and
`test:runtime-i18n` were not run after these failures. Those old output files do
not constitute a successful candidate build. The official compatibility
backport above is the later correction; new gate results are recorded below.

### Rejected Babel lowering experiment

The lock already contains Babel core, `transform-parameters` and
`transform-destructuring` 7.29.7. An in-memory experiment used parameters first,
destructuring second, `loose: false`, disabled external Babel configuration and
false assumptions for `ignoreFunctionLength`, `noNewArrows`, `iterableIsArray`,
`arrayLikeIsIterable`, `objectRestNoSymbols` and `pureGetters`. Three real
native-versus-transformed comparisons failed:

| Input behavior | Native result | Babel result |
| --- | --- | --- |
| A custom iterator yields `undefined`, then `2`; `[a = (events.push('default'), 1), b]` | `next0, default, next1, close`; values `1, 2` | `next0, next1, close, default`; values `1, 2` |
| Array `[1,2]` has its own generator `Symbol.iterator` yielding `9,8,7` with a `finally` close event; destructure its first two values | `custom, close`; values `9, 8` | No iterator events; values `1, 2` |
| The first default initializer logs `throw` and throws `Error('default')` in `[a = throwingDefault(), b]` | `next0, throw, close, default` | `next0, next1, close, throw, default` |

The `slicedToArray` helper collects values before evaluating bindings, and the
`arrayWithHoles` helper can bypass an array's custom iterator. Thus `loose: false`
alone does not establish the required behavior preservation. No Babel shim,
direct Babel dependencies or Vite configuration changes were applied. A future
solution using full Babel lowering must resolve these semantic counterexamples.
The official compatibility backport retains native destructuring instead, and
all three counterexamples now pass through the real Vite build pipeline.

## Current candidate gate

The initial local proof was based on `b5adcef`. The candidate is now rebased
onto main `071eb3f`, preserving the member-code API/page/navigation/runtime test
and Worker route ledger/test additions. Gates must be rerun for this integrated
candidate; its phase receipts are stored in
`.cache/d2-compat-fix-20260927/integration-071`. The earlier passing counts below
refer to the initial baseline and do not substitute for integrated results.

The original 11 WIP files were copied with matching SHA-256 hashes to
`.cache/d2-compat-fix-20260927/before` before the compatibility correction.
The original source contract and the three security fixes remain intact. A new
clean install succeeds; archive/source integrity, actual Windows and loopback
security, and compatibility regressions pass 52/52 with zero skips. H5, Weixin
and App resource builds and typecheck exit 0. All 38 registered toolchain test
files pass 826/826; build artifacts, runtime i18n and QR dependency gates pass
17/17. Both runs have zero skips. App resources do not establish signed APK/IPA
or device behavior. TEST-004D2 stays open pending main integration, independent
candidate review and exact-head Linux CI.

## Rebuild and verification

Download the official archive to a disposable path and verify it with the offline
constructor (the constructor itself does not download or install anything):

```sh
node scripts/build-vite-safety-backport.cjs /path/to/vite-5.4.21.tgz
npm ci
node --test --test-concurrency=1 scripts/vite-safety-package.test.cjs scripts/vite-esbuild-compatibility.test.cjs scripts/vite-path-security.test.cjs scripts/vite-windows-path-security.test.cjs scripts/esbuild-server-security.test.cjs scripts/dev-server-security.test.cjs
```

The constructor first checks source SRI and every file contract, then requires
each exact old chunk fragment once. It verifies the result by reversing only the
three security patches, two official compatibility fragments and manifest
changes, then checking all upstream bytes and headers.
Unsafe tar paths, links, duplicates, malformed archives, extra/missing files,
drift and tampering are rejected. Tar output retains source order and headers
(updating only sizes/checksums); gzip uses fixed stored DEFLATE blocks, zero time
and OS 255 so output bytes do not depend on zlib version or host OS. This makes
the archive larger (3,308,817 bytes) but deterministic. No extraction is needed.

`vite-safety-package.test.cjs` verifies provenance, canonical bytes, tamper
rejection, installed files, lock SRI and both esbuild chains. Independent real
middleware tests cover maps, ordinary allow/deny controls, native NTFS ADS/8.3
aliases and intercepted editor UNC probes; esbuild tests cover build and
loopback serve behavior. The Windows cases require actual Windows execution;
Linux execution does not constitute Windows evidence.

## Current advisory boundary

Before changing the lock, official `npm audit --json` on 2026-09-27 reported Vite
direct advisories `GHSA-4w7w-66w2-5vf9`, `GHSA-v6wh-96g9-6wx3`, and
`GHSA-fx2h-pf6j-xcff`, plus transitive esbuild `GHSA-67mh-4wv8-2f99` on both
installed esbuild copies (0.20.2 and 0.21.5). The newer official esbuild Windows
advisory was not present in that audit response, so the official release was
checked independently before selecting 0.28.2.

After `npm ci`, the official audit still reports exactly those three direct Vite
version-range advisories. It reports no esbuild finding and Vite no longer has an
esbuild `via` finding. The whole dependency report changes from 51 to 50 affected
packages (9 low, 31 moderate, 10 high after installation); these are affected
package counts, not a count of distinct advisories. Both audit invocations exit 1.

The derived Vite manifest intentionally retains version 5.4.21, so its three
version-range advisories remain even though these source boundaries are patched.
Verification must use archive/source proofs and runtime
regressions alongside audit; do not suppress those advisories or describe the
whole frontend audit as clean. Other DCloud/runtime dependency findings remain
outside this Vite/esbuild slice and keep their own checklist gates.
