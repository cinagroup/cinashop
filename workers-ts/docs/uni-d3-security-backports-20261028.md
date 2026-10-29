# UniApp dependency source backports, 2026-10-28

The locked UniApp graph now uses official Express 4.22.3 and one official qs
6.16.2 for both Express and body-parser 1.20.9. It removes the unused root
vue-i18n 9.14.5 family and replaces the external deepmerge dependency of
Jest-config 27.5.1 with an exact, locally maintained source helper. DCloud's
native 9.1.9 Intlify identity and runtime symbols remain supported.

The complete review and actual public npm receipt are in
`workers-ts/audit/uni-d3-security-backports-20261028.json` and its adjacent
`.npm-audit.json`. The previous 50-entry baseline remains byte-for-byte in
`view/uniapp-ts/scripts/d3-advisory-gate.pre-security-backports-20261028.baseline.json`.

## Exact audit transition

The fresh receipt has 48 affected package entries, 25 direct source objects,
24 distinct advisory URLs, eight retained chain definitions and six active
chains. These are different measures, not independent vulnerability counts.
All 24 common direct package/URL/severity/range tuples match the preceding
reviewed baseline. Only core-base source 1243629 is added; qs sources 1158506,
1158507 and 1243452 leave the active set after the official update. The two
removed package entries are Express and qs. Core-base and Jest-config become
direct because their local packages are explicit; three reverse `effects` lists
also change. The machine review includes the complete node and raw audit deltas,
including informational range/effect changes that the unchanged gate excludes
from its fingerprint.

Source 1243629 / GHSA-8rc2-428q-7ww3 still appears by version. Its acceptance is
bound to a real mixed list/named-argument escaping backport, not an official
fixed 9.x release. The official fix d657ce8f4b3b6b198a8f6e3d09e2b57a5d019fb8 is
adapted directly to all seven published 9.1.9 JavaScript formats. It keeps the
existing named-value type and helpers, copies named arguments without mutating
caller state, and preserves package metadata, dependencies, entry, types and
license. No TypeScript rebuild is claimed. Original unpatched controls, both
argument orders, frozen/repeated/non-string values and escape-disabled behavior
remain tested. Older sources 1106453, 1146054 and 1146058 are not repaired by this
mixed-escaping patch; their prior scope remains explicit.

The separate srcdoc advisories on the removed 9.14.5 copies are return guards,
not a claimed srcdoc repair to retained 9.1.9. The deepmerge return guard means
the external package is removed and both actual local merge copies reject the
poison key; it does not claim that upstream deepmerge 4.x has an official fix.
The original resolved records remain historical; the current shared-root qs
layout supersedes the old nested body-parser qs note.

## Reproducible package sources

The two `build-*-safety-backport.cjs` programs accept only the official source
archives identified by their committed source contracts. They reverse the exact
allowed file edits and pin all other package files, license, identity and modes.
They reject changed source/SRI, extra or missing files, unsafe paths, links,
metadata/mode drift, noncanonical archives and patch reapplication. Outputs use
canonical tar/gzip bytes and require a new output filename.

From `view/uniapp-ts`, with the official archives from the contracts available:

```sh
node scripts/build-jest-deepmerge-safety-backport.cjs official-jest-config-27.5.1.tgz official-deepmerge-4.3.1.tgz rebuilt-jest-config.tgz
node scripts/build-intlify-core-safety-backport.cjs official-core-base-9.1.9.tgz rebuilt-core-base.tgz
npm run test:security-backports
npm run test:express-qs
npm run test:runtime-i18n
npm run test:d3-advisories
```

Use the repository's shared serial validation wrapper on constrained local hosts.
The committed archive digests are Jest
`6baf951142521c91b421f3ed56f79b37dcd3270ca90691a29d12aa810d455114`
and Intlify
`ad1f2afe8f76ec37e2e6124a1b0ce6c20035600b35d3796ed6c56f06487c3951`.

## Actual local validation and limits

A fresh physical installation passed with Node 24.22.1/npm 11.11.0. Official
Express/qs files and modes, all five vendor SRIs and 47 installed Jest/Intlify
file bytes were verified. The 29 source/archive/backport tests, 21 Express/SSR
checks and 13 actual DCloud runtime/graph checks passed. The full toolchain
passed 3,385 tests across 21 reports, including the same 29 backport tests; they
are not counted twice. Strict types, ZIP and Jest/jsdom boundaries, H5/Weixin/App
builds, build-artifact checks, automator QR and common toolchain security passed.
Original source, lock, vendor and installation bindings remained unchanged.

The first full audit timed out at its original 180-second limit without a report.
The second retained that limit, reused only genuine HTTP metadata from this
private attempt and tombstoned its 63 derived calculation keys before starting
a new npm process. All 99 content values and 36 HTTP entries were preserved.
A new official bulk POST returned 200; the full report completed in 137,111 ms.
Its npm exit 1 records retained advisories and is not a gate pass. The unchanged
strict gate is checked separately by selftests, exact fixture replay and live
inventory; exact-head CI uses Node 24.14.1 and remains the authoritative CI
record. The earlier rejected Jest-only raw report also remains identified: it
contained a duplicate via-package edge and was never adopted as a baseline.

Ordinary configured scripts still leave optional H5 SSR off; real bounded HTTP
and compression regressions are retained. This work does not establish optional
SSR deployment, native-device, provider or production acceptance.
