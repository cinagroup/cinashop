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
