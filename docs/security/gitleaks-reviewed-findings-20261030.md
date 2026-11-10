# Exact historical Gitleaks findings reviewed on 2026-10-30

The [repository secret scan from run 41068214196](https://github.com/cinagroup/cinashop/actions/runs/41068214196/job/124105140878) scanned 866 commits with Gitleaks 8.29.0 and reported 277 findings. The redacted log was checked against the full Git bytes at each reported commit and line. Every finding belongs to immutable commit `d715da71abf6ce6f3dba6f2ee1b57e143744ebe3`.

`.gitleaksignore` records only the scanner's exact `commit:path:rule:line` fingerprints. There are **276 unique fingerprints for 277 findings**: the two reviewed source digests on `exception-page-runtime.test.cjs:47` share one fingerprint. It contains no file, directory or rule pattern. Neither PHP installation data nor frozen source/proof JSON was rewritten.

Gitleaks documents `.gitleaksignore` as ignoring a specific reported fingerprint. This mechanism is experimental, so the workflow keeps version 8.29.0 and its existing Linux x64 archive checksum pinned. See the [official versioned documentation](https://github.com/gitleaks/gitleaks/blob/v8.29.0/README.md#gitleaksignore).

## Reviewed evidence

| Rule | Findings | Exact evidence and classification |
| --- | ---: | --- |
| `generic-api-key` | 256 | JSON scalar values consisting of exactly 64 lowercase hexadecimal characters: 89 in `frozen_predecessor_evidence`, 167 in `observed_unchanged`. The keys identify frozen evidence or source paths. These are recorded SHA256 digests, not credential values. Each reported line and containing JSON object was checked. |
| `generic-api-key` | 2 | `view/admin-ts/scripts/exception-page-runtime.test.cjs:47`: expected SHA256 values for `utils/auth.ts` and `stores/auth.ts`, consumed by source-integrity assertions. Both occupy the same immutable line/fingerprint. |
| `generic-api-key` | 1 | `workers-ts/src/services/customer-work/CustomerCashierCapabilities.ts:103`: explanatory comment only, without a credential assignment. |
| `generic-api-key` | 1 | `view/admin-ts/scripts/wechat-base-runtime.test.cjs:96`: a controlled replacement literal in a local UI/HTTP fixture, subsequently asserted against the captured save body. No provider is called. |
| `generic-api-key` | 1 | `view/uniapp-ts/scripts/native-wechat-auth-runtime.test.cjs:89`: UUID-shaped mock login key supplied by `loginHost.override` in a synthetic `need_phone` response and submitted back to the local fake login handler. |
| `private-key` | 2 | `workers-ts/audit/wechat-app-author-source-binding-20261028.json:671–672`: frozen before/after source containing `.replace` regular expressions that remove PEM boundary markers. They contain parsing code, not private-key material. |
| `private-key` | 2 | `workers-ts/audit/wechat-base-author-source-binding-20261027.json:699–700`: frozen before/after test environment with an invalid PEM placeholder whose body is the literal word `local`. It cannot be parsed as an RSA private key. |
| `jwt` | 12 | Copies of the same token from PHP installation SQL `eb_out_interface.return_example`, a documented API return example. Eleven copies are nested in `PHP_sources` entries for `public/install/crmeb.sql`; the twelfth is inside the frozen `fixed_PHP_manifest`. Its expiry is 2022-06-23 03:24:33 UTC. The SQL table column order and quoted VALUES fields were parsed to establish the exact `return_example` field. |

The twelve JWT findings occur in the bargain-records, PC-base, product-ensure, product-parameter, product-rule, product-unit, user-group, WeChat-menu, WeChat-base and WeChat-open author proof files, plus two copies in the WeChat-app author proof. Their exact commit, file, rule and line are listed in `.gitleaksignore`.

The JWT classification does **not** claim the token was never issued or used historically. It establishes its location as a frozen installation API example and its elapsed expiry. Current TS `OutApiService.authenticateToken` verifies the caller's token with the deployment signing key through `jose.jwtVerify` (including expiry), requires the `out` token type, loads the current active account, and checks the current credential digest. When Redis is configured it also requires the matching token bucket. It does not accept the installation example as an authentication source. `adminInterfaceInfo` exposes `return_example` only as interface documentation. Adjacent historical example credentials are not certified as safe by this review or by these fingerprints.

## Regression check and limits

The secret-scan job first runs `workers-ts/scripts/verify-gitleaks-reviewed-findings.mjs --binary <pinned-gitleaks-path>`. It creates an independent owned temporary Git repository, copies the current `.gitleaks.toml` and `.gitleaksignore`, and writes newly generated API-key, JWT and RSA private-key canaries into the same frozen JSON path used by historical findings. The real Gitleaks binary must detect all three corresponding rules at their respective generated field lines despite the historical fingerprints. Raw generated values and scanner output are never printed; only the owned temporary directory is removed.

The canary pins the reviewed ignore file's SHA256 (`748d24df34557a5a66f244c6fc2dcebecc79d309254b6001f702ba7ecf11f531`), its 276 unique entries and their immutable commit format. Changes require a deliberate evidence review and update. It does not replace the existing full-history scan, which remains unchanged and runs afterward. A canary pass is evidence for detection of these generated cases, not a claim that every possible secret format is detectable.

No entire snapshot, directory or rule is allowed by this change. A new commit at the same path does not reuse an old commit fingerprint. Future findings need their own investigation; this record does not authorize ignoring them.

## Four recharge-refund findings reviewed on 2026-11-10 UTC

The [scan at `6fe08e7a`](https://github.com/cinagroup/cinashop/actions/runs/42765769342/job/129661775637) scanned 921 commits and reported four additional findings, all introduced by the immutable commit `353ec0ed03a860eafbc850e9983da505a7ade748`. Static review classified each as `not_actionable` for the specific literal-as-credential claim. The three source blobs still match that commit byte for byte; the canary now checks their SHA256 digests from the actual Git objects before scanning.

| Exact finding location in `353ec0ed` | Rule | Static evidence |
| --- | --- | --- |
| `workers-ts/test/recharge-refund-account-approval-native.test.ts:13` | `private-key` | The PEM body is the literal `fixture-not-provider-key`, which cannot encode a DER private key. The value is constructed in the test's merchant registry. The production Worker enters through `src/index.ts`; production sources contain no occurrence of this fixture literal. |
| `workers-ts/test/recharge-refund-ledger.test.ts:10` | `generic-api-key` | A fixed v4 request UUID in a unit-test receipt. The complete receipt is signed using the test-local key; runtime reads scope the request identifier to the administrator and verify a separate record signature. |
| `workers-ts/test/recharge-refund-ledger.test.ts:26` | `generic-api-key` | A different v4 request UUID used to mutate a signed receipt in a negative case that must reject authentication. |
| `workers-ts/test/recharge-refund-contract.test.ts:10` | `generic-api-key` | A fixed idempotency UUID supplied to request-identity tests. `rechargeRefundIdentity` binds an independently supplied administrator id and the full request; the UUID is not an authentication key. |

This is a static classification of those four literals. It does not certify adjacent values, external reuse, production credentials or all secret formats. No applicable root or scoped `SECURITY.md` was returned; the boundary assessment uses the deployment entrypoint and the cited source paths, including `RechargeRefundRequest.ts:37–44` and `RechargeRefundLedger.ts:83–87,120–127`.

The original 276-line set retains SHA256 `748d24df34557a5a66f244c6fc2dcebecc79d309254b6001f702ba7ecf11f531`. Exactly four `commit:path:rule:line` fingerprints are appended; the 280-line file is pinned to `1f6204fa08c92058b8a8f3e9b99dfbcb90c4537da28de17fc782e3f8a4c988bb`. `.gitleaks.toml`, scanner version, workflow and existing full-history scan are unchanged.

The original three generated canaries remain. Four additional generated canaries occupy the newly reviewed paths at the exact reported line numbers, in a fresh owned temporary Git commit: a real generated RSA key at approval line 13, and new random API-key values at ledger lines 10/26 and contract line 10. The real scanner must detect all seven cases, and none may reuse a reviewed historical fingerprint. Temporary values and scanner output remain withheld and the owned directory is removed. These checks establish detection for these generated cases only.
