# Generated Gitleaks probe domain

The [47b8d6d2 secret-scan job](https://github.com/cinagroup/cinashop/actions/runs/42797977172/job/129767927131) failed its generated `generic-api-key` probe check before the full-history scan. Probe values were withheld and deleted, so the exact value that failed is unavailable.

The pinned [8.29.0 rule](https://github.com/gitleaks/gitleaks/blob/v8.29.0/cmd/generate/config/rules/generic.go) requires entropy above 3.5 and deliberately excludes alphabet-only values and default stopwords. An arbitrary random base64url value can enter either excluded class. This is a probe-generation defect; the job log does not prove a historical fingerprint suppressed a fresh secret.

`gitleaks-canary-value.mjs` generates two independently shuffled blocks of 26 letters and 26 digits. The 104-character result alternates letters and digits, retains the same character counts under every permutation, and has entropy above 4.5. It cannot be alphabet-only or contain a consecutive-letter dictionary word. The pinned default stopword set has no alternating alphanumeric entry. Cryptographic permutations supply fresh values; deterministic boundary choices exercise the same format without retries.

All seven real-scanner canaries remain mandatory at their original paths and line addresses. RSA and JWT generation, the four immutable recharge source-blob checks, all 280 historical fingerprints, scanner version, detection configuration and workflow remain unchanged. A missing canary now reports its public file/line address; generated material and scanner output stay private. There is one scanner invocation, and every expected finding must belong to a fresh commit.

Validation includes the generator's deterministic lower/middle/upper choices, invalid permutation indices, the actual pinned scanner on deliberately excluded old-format specimens and new-format boundary specimens, and the complete seven-canary command. This only establishes those generated detection cases. It neither certifies every secret format nor completes migration-wide CI or the separate legacy PHP source supply.
