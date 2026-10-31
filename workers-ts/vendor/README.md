# Drizzle 0.31.10 manifest-only package

`drizzle-kit-0.31.10-no-esm-loader.tgz` is the public `drizzle-kit@0.31.10`
package with exactly one manifest line removed:

```diff
-		"@esbuild-kit/esm-loader": "^2.5.5",
```

The official upstream tarball is
`https://registry.npmjs.org/drizzle-kit/-/drizzle-kit-0.31.10.tgz` with npm
integrity `sha512-7OZcmQUrdGI+DUNNsKBn1aW8qSoKuTH7d0mYgSP8bAzdFzKoovxEFnoGQp2dVs82EOJeYycqRtciopszwUf8bw==`.
The vendored tarball's integrity is
`sha512-bGrd3q24AtatJ3yUlpdK3glvuXqKTaxgfY2FqxyzwKoy9lQe4TyCEqmZwLOs8+czQB/BB7bJcobv+o/4B2owwg==`.
`package-lock.json` pins that exact local tarball. No JavaScript, type
declaration, README, CLI command, or Drizzle version changed. The package is
MIT licensed as declared in its manifest.

To rebuild from the public source in `workers-ts`:

```sh
npm pack drizzle-kit@0.31.10 --pack-destination . --json
node scripts/build-drizzle-kit-no-loader.cjs drizzle-kit-0.31.10.tgz
```

The builder checks the upstream integrity, requires the exact 13-file set and
dependency line, and compares every repacked file byte for byte. Its output
must match the vendored integrity above and the lockfile. The original public
tarball is only an input to this rebuild and should not be committed. A clean
`npm ci` then verifies the local tarball integrity and runs the existing
checksum-pinned Drizzle postinstall patch on `bin.cjs`, `api.js`, and `api.mjs`.

This fork only removes an unused development dependency. Re-audit the seven
Drizzle bundles and all affected ORM/DDL paths before changing the Drizzle
version or another manifest entry. `db:push`, `db:migrate`, and `db:studio`
remain outside this package validation because they can access a database.


# Postgres.js 3.4.9 Cloudflare socket-close backport

`postgres-3.4.9-cf-close.tgz` derives from the official `postgres@3.4.9`
[archive](https://registry.npmjs.org/postgres/-/postgres-3.4.9.tgz). It preserves the package version, exports,
manifest, README, type declarations and every Node/CommonJS implementation byte.
Exactly one of the 37 regular files changes: `cf/polyfills.js`, with the four
socket lifecycle edits and one local Promise-rejection supplement described below.
The upstream edits come from [upstream PR #1251](https://github.com/porsager/postgres/pull/1251) at
head `b0922e4130bfd3b743ae813d3a435d1fc09ca46b`. Before the local supplement, the file is
byte-identical to that PR head's file (Git blob
`0594d263ef9b8bf0995d3a0274cf8458ca2cddfe`). The package retains
its unchanged upstream `Unlicense` manifest declaration.

The four changes send Terminate before closing only the writable side, close
once the read loop reaches EOF, route `readFirst()` rejection through the error
handler, and replace the final direct close event with the idempotent close
helper. The sole local supplement changes the half-close callback from
`() => tcp.writer.close()` to `() => tcp.writer.close().catch(error)`.
Its rejected Promise therefore enters the existing active error channel instead
of becoming an unobserved rejection from the write callback. It does not replace
SQL, alter crypto/protocol bytes, or change the upstream closed-state guard.
 **The upstream error handler also returns for every error after
`readyState === 'closed'`; it does not distinguish expected cancellation from
an unknown late error.** This backport deliberately preserves that exact guard,
without claiming late unknown errors remain observable. It adds no global
unhandled-error filter. Active errors before close still enter the existing
error event path. Normal shutdown, timeout/destroy, read failure and unknown-error
behavior require separate regression execution; archive equality is not that
runtime proof.

The maintainer incorporated the fix in the v4 rewrite at
[`06cf284705294a2c5da041d0fbe209462283da6b`](https://github.com/porsager/postgres/commit/06cf284705294a2c5da041d0fbe209462283da6b)
on 2026-10-29 and closed PR #1251 without merging it separately. The official npm
registry published 4.0.0 at `2026-10-29T18:02:56.730Z`; as checked on 2026-10-30,
its newest published 3.x remained 3.4.9 (`2026-04-05T15:18:33.078Z`). This is a
local source backport, not an upstream 3.x release or a v4 upgrade. If installed,
it changes the actual Cloudflare driver used by production bundles as well as
tests; it is not merely a test-host adapter.

Pinned provenance:

- Official archive SHA256: `4964056ae6b672361557f738532a20ad29d54cff0b146cb66d67d7155d66761e`.
- Official archive SRI: `sha512-GD3qdB0x1z9xgFI6cdRD6xu2Sp2WCOEoe3mtnyB5Ee0XrrL5Pe+e4CCnJrRMnL1zYtRDZmQQVbvOttLnKDLnaw==`.
- Original `cf/polyfills.js` SHA256: `c9bfd7d57f1402676a42c8b6a49386ca18f95ccc687fdaad625f3a3fc7ba3f81`.
- Upstream-only `cf/polyfills.js` SHA256: `4652f1163ff4282dd4fb29f057aea5841e5b1c5ce6a99c75c5d404e22111e8ce`.
- Derived `cf/polyfills.js` SHA256: `d81e886fa473be14d964f6d89b0ca835a166e8759a8dc74c8507d18c95a8c93d`.
- [Exact patch](./postgres-3.4.9-cf-close.patch) SHA256: `f724b5888d530fa395572e4f65b918a660e7fe93bd692c1a29f5f4916fb5876d`.
- Derived archive SHA256: `c59893d3a0a839b07c2dcbd666adbdd43850b9a288eadbdf04554139c7f4d3d9`.
- Derived archive SRI: `sha512-MHLprJJkwfkOAqCzEOfguKVmLMG0zZJeh0c39Sb2DUKFMRXid7uZTqDIjgJCvy5Dp51WPiuLV18D4kmdbij4bA==`.

To rebuild from an already downloaded official archive in `workers-ts`:

```sh
node scripts/build-postgres-cf-close-backport.mjs /absolute/path/postgres-3.4.9.tgz
# Optional second absolute argument writes to another output for comparison.
```

The review patch uses zero context (`git apply --unidiff-zero` if applying it
separately), so blank context lines do not appear as trailing whitespace when
the patch artifact itself is added to Git. The builder applies its exact checked
source replacements rather than executing the patch file.

The builder performs no download, installation or `node_modules` edit. It checks
both official archive hashes, all 37 paths/sizes/file SHA256 values, regular-file
modes, the one exact source patch target per edit (four upstream plus one local), and the complete resulting
archive file set. Every other file must remain byte-identical. It emits sorted
USTAR entries with mode 0644, uid/gid/mtime zero and empty owner names. Canonical
gzip uses fixed stored DEFLATE blocks with no filename or timestamp, avoiding
compression-version differences; the larger archive is intentional. The output
must match the pinned SRI and SHA256 above. Invalid paths, duplicates, symlinks,
other file types, checksums, nonzero padding and incomplete archives fail closed.
No original PHP or historical proof file is changed by this builder.
