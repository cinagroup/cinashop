# Worker provider request compatibility

The fixed TypeScript predecessor is `353ec0ed03a860eafbc850e9983da505a7ade748`.
Twelve provider files still used `redirect: 'error'` in fifteen fetch calls.
The installed workerd `1.20260910.1`, at compatibility date `2026-08-09` with
`nodejs_compat`, rejects that mode while constructing the request, before any
outbound call. Node transport doubles previously accepted the same options.
The [official Workers Request contract](https://developers.cloudflare.com/workers/runtime-apis/request/)
documents `follow` and `manual` and explicitly rejects `error`.

All fifteen calls now use `manual`. Redirect status codes are refused before
provider JSON, token caching or application acknowledgements can authorize a
later operation. Existing readers that already require HTTP 2xx keep that gate.
Menu publishing, corporate-tag creation, single-use welcome messages, shipping,
subscription messages and waybill allocation preserve their existing unknown
outcome after a possible write. A redirect body containing an invalid-token
code does not authorize refresh and another write. An unconsumed redirect body
is cancelled. Endpoint, body, credential source, admission, money and journal
authority are unchanged.

The affected providers are LegacyShareProviderRead, PublicGeocodingService,
CrmebOnePassWaybillProvider, OfficialAccountMenuProvider, RoutineAccessTokenService,
RoutineShippingAccessToken, RoutineShippingProvider, WechatAppAuthService,
WechatFollowPosterService, WechatNotificationProvider, WithdrawalWecomRobotProvider
and EnterpriseWechatProviderClient. Browser fetch code retains its separate
browser-supported `redirect: 'error'` contract.

`provider-redirect-workerd.test.ts` bundles real production providers into
Miniflare and intercepts every outbound request with a local service. It tests
direct successes, the native unsupported-mode failure, token preflight and
HTTP 300/301/302/303/304/305/306/307/308/399 responses without following or
redispatching. App JSON, follow-image and subscription POST cases explicitly
probe internal network readers; they do not establish OAuth issuance, source
ownership or notification admission. The other cases use public standalone
provider methods. Miniflare recreates a Request in the Node outbound adapter
with a default `follow` property, so the mode assertion observes the actual
native Request inside workerd before it is sent. Forbidden redirect destinations
remain refused by the complete local gateway.

The dated transport proof binds complete current images and exact inverse edits
to Git originals at fixed353 for the twelve providers, fifteen current test
contracts, two historical-reader ports and the CI workflow. The finite read port supplies those
exact images before the unchanged recharge/refund and author history chains.
Native runtime and business tests see current source. Old proof
artifacts, hashes, inventories and historical assertions are preserved; prefix,
suffix, CRLF, same-size and complete-old-image substitutions are refused.

The Worker unit CI step explicitly fetches and verifies both fixed TypeScript
commits, 78240 and 353, before the existing legacy-input step. A shallow default
checkout cannot otherwise supply the new proof's genuine Git353 blobs. The
fetch uses only the TypeScript repository and supplies no legacy PHP source.

This document records the implementation and test scope. Frozen run artifacts
determine acceptance. It does not claim completion of the PHP migration or the
remaining remote CI gates. The legacy PHP repository remains local; no real
provider credentials, production database, remote deployment or merchant I/O is
used by this transport validation.
