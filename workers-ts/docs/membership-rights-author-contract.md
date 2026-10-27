# Paid-membership rights: authoring and customer detail contract

PHP authority is the immutable `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5` tree:
`view/admin/src/pages/user/grade/right/index.vue`,
`app/controller/admin/v1/user/member/MemberCard.php`,
`app/services/user/member/MemberRightServices.php`,
`app/dao/user/member/MemberRightDao.php`, and
`view/uniapp/pages/annex/vip_paid_rights/index.vue`.

The PHP author uses a rights-icon chooser, separate introduction editor, status
switch, eight-character display-name/summary inputs and `sort DESC,id DESC`.
Its metadata and content writes are separate. The existing TS routes, default
DTOs and legacy write semantics remain available; this adds an explicit author
contract and a customer detail projection to those routes.

## Admin author read

`GET /adminapi/member/right?author=1&page=1&limit=30`

Exactly `author`, `page`, `limit` are accepted, each at most once. `author=1`
is required. Page defaults to 1, limit to 30; limit is 1–100, page 1–10000 and
the offset must be at most 100000. SQL order is `sort DESC,id DESC`.

The data envelope is:

```ts
{
  author: 1; actor_id: number; page: number; limit: number; count: number;
  list: Array<{
    id: number; right_type: string; title: string; show_title: string;
    image: string; explain: string; content: string; number: number;
    sort: number; status: number; add_time: number;
    version: string; image_preview: string; content_preview: string;
  }>;
}
```

`actor_id` comes from the actual live persisted Admin identity. `version` is a
SHA-256 over every persisted right column, including raw content null, original
image, hidden fields and creation timestamp. Editing `image`/`content` remove
copied private-asset tickets without changing storage. Imported invalid values
in other fields remain available for exact preservation. Preview fields are
derived output and must never be sent as stored fields.

The author read resolves the live Admin password, account state, role assignment
and `paid_membership.view` in one read-only repeatable-read transaction. It does
not use `attachment.view` to authorize rights catalogue reads: the persisted
platform right authorizes its eligible published image. Opening the generic
library or uploading still uses its independent attachment permissions.

## Three distinct writes on existing routes

All author bodies are bounded to 256 KiB of actual streamed bytes. The recursive
JSON tokenizer rejects duplicate keys, including escaped spellings. Unknown
fields, invalid versions and write query parameters are refused. JSON object
fields are case sensitive. A present `author` never falls back to a legacy
write, even if its value is invalid or a duplicate attempted to replace it.

Metadata edit:

```ts
POST /adminapi/member_right/save/:id
{ author: 1, version: hex64, ...partialMetadata }
```

At least one of the seven metadata keys is required:
`right_type`, `title`, `show_title`, `image`, `explain`, `number`, `sort`.
`content`, `status`, `id`, and preview fields are not accepted in this operation.
The resulting type controls numeric validation whenever type or number changes.

Status edit is the same route with exactly three keys:

```ts
{ author: 1, version: hex64, status: 0 | 1 }
```

Create keeps the existing TS id-0 route with exactly ten keys: `author`,
`version: 'absent'`, all seven metadata fields and `status`. PHP's chooser and
service require a nonempty icon; the new author contract does likewise. Creation
does not include content and starts with SQL's content default null. The old
no-author TS creation entry is preserved.

Introduction edit:

```ts
POST /adminapi/member/save/content/:id
{ author: 1, version: hex64, content: string }
```

Only content changes. A changed introduction must contain nonempty sanitized
HTML and at most 200000 Unicode code points, within the HTTP byte limit. A
matching empty editing projection of an existing null/empty introduction is a
no-op; it does not convert null to empty text.

Each successful author mutation returns `{id,version}`. The client must reread
the catalogue explicitly before adopting fresh preview state. All writes use
the existing Admin authority barrier and live `paid_membership.manage` check,
then lock the target right and compare the entire row version before DML.
A stale version returns business status 409 in the existing PHP-compatible HTTP
200 envelope. A status/content update also conflicts with a concurrent metadata
change, so an older modal cannot silently replace newer data.

Changed display name and summary have PHP's eight-code-point limit. Changed
title is at most 200 and type at most 100; names must be nonblank. A summary may
contain line breaks. Sort is an explicit int4. Numbers are explicit integers:
integral/sign/express 1–10000, offline 1–100, other types 0–2147483647. The new
author does not coerce numeric strings. Exact unchanged imported values bypass
new field validation and remain byte-identical, including legacy zero numbers,
long names, whitespace, unsafe original images, signed original attributes,
and null content. A metadata edit never sanitizes or rewrites stored content.

## Media and HTML

Changed image references are nonempty stable references within the existing
200-character image column. Public HTTPS and site-relative legacy references
remain usable; private local tickets are canonicalized to `/api/assets/:id`.
No URL is fetched. Eligible private raster media requires the actual
`adminAttachmentScope()` tuple (type 1, relation 0, module 1), file type 1,
R2 image type 8, matching canonical metadata, Admin owner-1 object namespace,
valid raster extension, and a compatible MIME (with legacy blank-MIME semantics
from the existing published catalogue policy). Supplier/user/guest namespaces,
foreign owner folders, missing metadata, SVG and MIME contradictions receive no
signature. Changed private references are checked under attachment row locks
and invalid/foreign references reject the whole write.

Introduction editing retains stable HTML references. Changed content uses the
existing pure DIY presentation allowlist without modifying that shared policy;
safe colors, font sizes, spacing, text formatting, tables, links and image
layout survive. Scripts, event handlers, unsafe protocols and arbitrary CSS do
not reach previews. Existing platform MP4 metadata uses the independently
reviewed DIY video policy; an image tuple cannot authorize a private video.
Unsafe or foreign historical media stays stored but appears without a usable
source. Only approved references are signed, and signatures are output only.

Each complete preview request has a 10000 image/video slot limit and an 8 MiB
combined sanitized HTML bound. Capacity rejection is explicit, never silent
truncation. Metadata validation does not pull unrelated historical HTML into a
new write's media-authorization scope. Media selection, authoring and reads do
not perform R2 reads/writes; only the existing upload/asset routes do so.

## Customer detail

`GET /api/user/member/card/index?rights=1` retains the authenticated membership
home route and adds `rights_owner_uid` from its actual customer UID. Enabled
rights use PHP's `sort DESC,id DESC` and gain `content_preview`, the safe styled
HTML with authorized media tickets. The original `content` string/null stays
unchanged for compatibility. New detail UI must render `content_preview`.
Malformed/duplicate `rights` or additional detail query keys are refused.

The no-query home retains its old key set and order. In both modes canonical
`pic` is resolved only after persisted platform-media authorization; an unsafe
or foreign canonical image becomes blank. A disabled membership feature returns
no rights and does not sign hidden rows. No membership price, payment,
eligibility, coupon, account balance or order state changes in this work.

## Frontend behavior

Admin's existing paid-membership page uses a 30-row rights catalogue with PHP's
36px table icons, 60px chooser preview, separate metadata/introduction dialogs
and independent status switches. The real attachment picker keeps its own
view/upload permissions. The rich editor offers visual/source/preview modes,
text formatting and catalogue images, preserving stable editing references
separately from signed, sanitized previews. An untouched historical source is
never emitted merely because the editor opens.

Each request, picker completion and image callback is bound to the current
persisted Admin session or customer UID/token/session generation. Leaving or
changing owner clears private state. A successful author mutation triggers a
fresh catalogue read. A conflict or unconfirmed write retains the same owner's
copyable draft and blocks repeated POSTs until an explicit read and reopening;
closing during a pending save is disabled. Media expiry changes local previews
without replaying requests or writes.

`/pages/user/vipRights?id=:id` displays enabled rights in PHP's dark brown icon
strip and horizontally swiped cream/white introduction cards. Selecting an icon
or swiping keeps the selected right in sync. Only sanitized `content_preview`
is rendered through the existing sanitized HTML tree as native rich-text nodes.
Attribute entities are decoded once into node attributes: signed `&signature=`
must not become the literal query key `amp;signature` in Uni H5. The shared HTML
serializer and its escaping remain unchanged. Native icons and introduction
media use the existing API-origin projection after capability validation; raw
references remain unchanged for expiry and stale-image identity checks. Local
`/static/` images keep their bundled paths. The existing membership-home rights
rows open the corresponding card, and `/pages/annex/vip_paid_rights/index` resolves to this dedicated page.
Both native and legacy targets honor the existing paid-membership capability
filter in personal menus/posters.

Frontend transport keeps complete historical source up to the shared parser's
4,000,000-byte per-source capacity and accepts up to 10 MiB of signed previews
per response, accommodating the server's 8 MiB sanitized HTML plus ticket
expansion. Neither client silently clips rights or introductions.

## Verification scope

`test/membership-rights-author-postgres.test.ts` uses the real registered
application, Admin/customer JWT middleware, live permissions, controllers,
SQL and multipart upload/asset byte paths on an owned column fixture. Full table
and sequence snapshots distinguish target-right writes, the one attachment
upload, no-op reads and refused requests. It covers the legacy DTO, real PHP
tie ordering, pagination, independent operations, raw historical preservation,
strict bodies, foreign media, full-row conflicts, public owner binding and
safe styled preview. Native PG16 peers observe the actual blocker PID before
the stale writer sees its newly committed conflicting row; PGlite runs the
business counterpart without claiming native lock evidence. It does not prove
independent database LOGIN grants, external payment configuration or production
deployment. Browser acceptance and frontend build evidence are separate.

The separate `test/browser/membership-rights.acceptance.ts` host serves both
actual built frontends and forwards every business request through the real
application. It records whole owned-table/sequence snapshots, resource hashes,
actual upload and signed asset bytes, DOM phases and source/build fingerprints.
Its only controls are synthetic session bootstrap and an explicitly recorded
concurrent title change; it does not launch a browser or replace business DTOs.
