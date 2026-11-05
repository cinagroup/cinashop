# Membership admission follow-up

Card redemption and paid purchases have different channel contracts. The fixed
PHP card controller and the existing card activation contract reject literal
`from=app`; App card callers use the App header with body `h5`. Paid purchases
already support an explicit App channel. Redemption now rejects its normalized
App body channel before configuration reads or sequence allocation, without
changing the shared paid channel map, card accounting or notification authors.

The original two membership compatibility files produced 90 cases with five
failures and 85 partial passes on both the exact `4e8d6b14` baseline and the
Phase65 candidate. Those historical results remain failed. Three balance cases
lacked the formally required local payment storage. The old App case also
expected a missing AppID before its fixture had commissioned the App catalog;
an assertion hidden behind that failure incorrectly expected the already
supported paid App spelling to be an invalid channel.

The current home suite explicitly opts into the published callback,
reconciliation and immutable payment-attempt storage on its owned PG16 fixture.
It retains the real admission reader and original financial assertions. Its
original mutable restore scope remains separate from the added protocol.
Complete protocol rows, sequence state and structural catalog snapshots must
remain unchanged across requests, restore and close. This owner-session setup
proves storage and accounting behavior; it does not commission an App runtime
role. Shared browser fixtures and the PGlite fallback are unchanged. The latter
does not receive native storage acceptance from this helper.

The owner-session App case now verifies the real catalog-unavailable business
400 for both supported paid spellings, with no provider or accounting writes.
The separate native suite uses the formal App installer and five actual LOGINs
to test missing-AppID and foreign-owner rejection through authenticated HTTP.
It does not replace readiness or initiation with a mock success, and does not
claim a successful provider launch or device SDK payment. Existing service and
SQL App-mode tests retain their explicitly documented replaced boundaries.

The original home file is retained byte for byte as a historical fixture with
its SHA256, Git blob identity and baseline outcome. A separate versioned record
admits only the exact setup and App-case edits; unknown edits and CRLF changes
are rejected. This evidence projection does not wrap current service or route
execution, and does not rewrite the older source-binding fixtures or historical
failed assertions into successful results.

Prepared tests and static review are not execution evidence. Results belong to
the follow-up validation record under `.cache/php-ts-member-compat-followup`;
Phase65 results do not validate these later source bytes. No production DDL,
provider request, legacy PHP upload or deployment is part of this follow-up.
Full migration and cloud CI completion remain separate requirements.
