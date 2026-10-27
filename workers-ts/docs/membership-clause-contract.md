# Member clause: PHP document and authenticated read lifecycle

The immutable PHP reference is `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`,
`view/uniapp/pages/annex/vip_clause/index.vue` and its `memberCard()` read.
Application navigation resolves `/pages/annex/vip_clause/index` to registered
`/pages/user/memberClause`. Direct H5 initialization of an unregistered legacy
URL is outside this compatibility contract. The actual homepage configured
legacy menu action is covered by the Browser acceptance host.

The page keeps PHP's white surface, centered configured title at30rpx with60rpx
top spacing and50rpx/30rpx body padding. It preserves supported safe inline
styles and complete text rather than replacing the configured title with a
fixed heading. No new bitmap asset is needed. Existing native rich-node/video
components provide interactive content on H5, Weixin and App; passive content
uses the existing rich-text renderer. Rendering a video node and compiling all
three platforms do not assert playback on a physical device.

## Read contract

Authenticated `GET /api/user/member/card/index?clause=1` returns exactly
`{owner_uid,member_explain}` under `private, no-store`. The document is either
`""` or `{id,type:1,title,content_preview}`. Only one literal `clause=1` query
is accepted; duplicates, unknown keys and mixed home/rights/purchase projections
are rejected through the existing business400 response contract. Without the
clause key, the original member-card behavior is preserved.

Only the persisted `agreement.type=1,status=1` row is visible. Disabled or
missing rows return `""`; there is no type2 fallback. A visible row with null
or empty content retains its actual title and ID with empty preview. Titles
preserve stored bytes, including empty values, and the varchar200 boundary uses
Unicode code points. `member_card_status=0` does not hide the direct authenticated
clause read, matching PHP. The configured paid-member menu gate still applies
to both registered and legacy destinations.

This is separate from the purchase page's public agreement reader. The member
home agreement action remains `/pages/user/legalContent?type=payVip` and public
`/api/agreement/1` retains its original disabled-row and missing-`[]` semantics.
The shared Article, member-rights, public agreement and HTML policies are not
changed by this slice.

The new service uses a REPEATABLE READ READ ONLY transaction and actual
persisted agreement/attachment metadata. Raw and safe preview UTF8 bodies are
bounded to4,000,000 bytes, with the unchanged100,000-token grammar and bounded
media list. Limits reject explicitly; text is never silently truncated.
A dedicated projection avoids the Article editor's smaller text boundary.
Platform images and MP4 references must satisfy the existing canonical
attachment ownership/type/MIME predicates. The existing signer issues900-second
GET capabilities; asset delivery is a separate real read. No client HTML,
attachment reference or UID authorizes a signature.

## Client ownership and lifecycle

The client validates exact DTO keys, owner and limits before parsing the safe
HTML tree. It parses before native API-origin expansion so a valid4MB document
does not exceed the parser bound after URL rewriting. Rejected or expired
media becomes inert text. Loading clears the previous title/body immediately.

Every native media/link callback receives a capability bound to the document
generation, UID/token/session version, persisted session, visibility and media
deadline. A new read, owner change, logout, hide or unload permanently revokes
old callbacks and clears playback positions. Focus/onShow performs a fresh
read. Signed-media expiry makes nodes inert without background business writes;
refresh is an explicit action. Safe links use the existing destination registry
and explicit telephone actions. Guest entry makes no private clause request.

## Verification and boundaries

The native PG16 suite covers43 cases, including full SQL/sequence/resource
conservation, exact enabled/disabled/null contracts, malformed selectors,
4MB UTF8 limits, media authority, public-reader separation and authentication.
The unit runner/public agreement suite is separate from these native cases.
Frontend runtime tests use real Vue/Pinia/API/composable logic with native I/O
replaced and cover H5/Weixin/App URL projection,4MB bodies and stale callbacks.
The paid-menu regression includes canonical, legacy and query clause targets.

The historical route proof preserves32 prior source/fixture files byte for
byte. Its exact additive bridge records full before/after source hashes and
patches,144 registered routes and the live legacy destination. Earlier proof
readers reconstruct their own historical143-route view while unknown mutations
still fail the existing whole-source checks.

Browser acceptance runs the actual built H5, Worker app, JWT middleware, owned
native PG16 and local R2. Ten ordered captures cover guest, real homepage legacy
menu action, visible/disabled/null/restored content, a held real response across
owner replacement, return to the original owner and desktop layout. Five
explicit QA agreement/config changes and synthetic sessions are isolated from
business proof; final SQL is restored to the entire baseline. Every business
request is GET/HEAD and conserves every SQL table/sequence, R2, DO and queue.
An independent verifier binds the reviewed complete candidate tree, actual
source/build bytes, request/response bytes, whole snapshots, signatures,
rendered image/style evidence, actual runner exit and cleanup.

These checks do not claim production login, Admin agreement saving, video
playback on a device, purchase, payment or coupon mutation. Releasing an aborted
held socket does not prove that its callback was delivered. The slice adds no
schema or business write endpoint and does not merge or deploy a release.
