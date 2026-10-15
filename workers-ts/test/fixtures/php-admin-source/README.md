# PHP-era Admin compatibility inputs

These 11 files are byte-for-byte copies from `cinashop-php` commit
`8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`. Each selected working-tree file was
clean and identical to `git show` for that commit when copied. `manifest.json`
records the original paths, Git blob IDs, byte lengths and SHA256 digests.

Compatibility tests bundle and execute these actual request/API/component
sources against the TypeScript App, JWT authority and owned SQL fixtures.
Their existing transport, authentication and framework construction boundaries
remain explicit in each test. The same inputs run locally and in CI; a sibling
PHP checkout is no longer required by these consumers.

The helper pins the whole manifest and verifies every source byte and the exact
inventory before use. Updating the reference requires a reviewed PHP revision,
byte-for-byte source copies, regenerated provenance, and an explicit manifest
pin update in `test/helpers/legacyAdminReference.ts`. Run the integrity tests
and all affected compatibility consumers after an update. Keep the original
copyright notices and source content intact.
