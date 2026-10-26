# Ordinary membership level definition management

This extends the existing two registered Admin aliases: `/adminapi/level/*` and
`/api/admin/level/*`. It does not manage paid membership plans or distribute
activation rewards. `level.view` permits reads and `level.manage` permits writes;
attachment selection/upload retain their independent permissions. The existing
Admin middleware authenticates JWT, realm, live account/password and route ACL.
The service rechecks the live actor/roles inside its SQL transaction.

## Reads and stable media

`GET level/list` without `paged` retains the legacy nondeleted, grade-ascending
raw array and original camelCase fields. Other legacy query keys remain ignored.
`GET level/list?paged=1&page=1&limit=10` returns `{list,count,page,limit}`. Explicit
paged requests reject unknown/repeated keys and noncanonical integer strings.
`page` is 1..10000, `limit` is 1..100, and `(page-1)*limit` is at most 100000.
Optional `title` is a literal case-insensitive substring (255 Unicode codepoints,
not SQL wildcard syntax); optional `is_show` is `0`, `1`, or empty/unset.
Nondeleted definitions include both shown and hidden rows. Ordering is grade then
ID, and count/page/media metadata use one REPEATABLE READ, READ ONLY snapshot.

Paged rows additionally contain `icon_preview` and `image_preview`. `icon` and
`image` remain persisted stable references. The existing ProductAssetPolicy
resolves exactly two slots per row for the platform tuple `(type=0,relationId=0)`.
Canonical IDs require the existing platform/raster/module/file/R2 namespace
checks; invalid or foreign stored IDs get an empty preview. Stable HTTPS/static
references retain that policy's grammar. Signatures are rendered after the
transaction, with no HTTP/R2/queue/cache read or write. A maximum page has 200
slots, below the unchanged policy budget. No new general attachment policy or
new public route is introduced.

## Save and historical compatibility

`POST level/save` accepts only `id` and the editable fields `name`, `grade`,
`discount`, `exp_num`, `icon`, `image`, `color`, `is_show`, `explain`. Omitted/numeric
zero ID creates; positive safe int4 ID updates. Duplicate JSON keys, including
escaped spellings, are rejected before `JSON.parse` can silently discard them.
The UTF-8 request budget is 64 KiB. At least one editable field is required.
Creation requires the complete editable form. Updates may be partial (including
legacy numeric discount patches and `{id,is_show}`), preserving every latent
column and omitted field. A true no-op issues no DML.

New/changed grade and experience are integers 1..2147483647. This follows PHP's
controller rejection of zero, despite the PHP form's `min(0)`. A persisted zero
can be explicitly resubmitted unchanged while other fields are edited; a
positive value cannot be changed to zero. Only changed values trigger the
uniqueness/neighbour checks, so unrelated patches do not force repair of every
legacy malformed entry. Changed names are trimmed and compared case-insensitively
after trimming; nondeleted names/grades/thresholds are unique. A changed effective
grade/threshold must have strictly greater experience than the previous grade and
strictly lower experience than the next grade. Deleted definitions are excluded.
Discount is 0..100, at most two decimal places, stored as a canonical two-decimal
string. `is_show` is numeric 0 or 1. Name and media are at most 255 codepoints;
color reuses the existing safe HEX/RGB parser. Explain is at most 10000 codepoints,
permits newline/tab/CR and rejects other control characters and lone surrogates.
Unchanged imported blank media/color/explain are retained. An imported null
explain must be omitted to preserve null; sending empty text is not a null patch.
Changed/new media must be nonempty stable values, with canonical IDs checked under
metadata row locks against the same platform policy. Temporary signed URLs are
never persisted. New records use `validDate=0,isForever=1,isPay=0,money='0.00',
merId=0,isDel=0`; updates do not reset latent pricing/lifetime fields.

Save returns `{id}`. List/save/delete responses use private no-store headers.
There is no server idempotency key for creates: after an unknown network outcome,
clients must reread and require a new explicit user action, rather than retrying
an INSERT automatically.

## Serialization, occupied deletion, and grants

Every Admin create/update/toggle/delete takes the existing Admin authority write
barrier and one `system_user_level` SHARE ROW EXCLUSIVE relation fence. This
serializes the complete Admin catalogue, including an initially empty catalogue,
without locking the user table or requiring a new database migration. Existing
2-second lock/5-second statement bounds return an explicit conflict/timeout.

`DELETE level/del/:id` returns null for missing/already-deleted IDs. It locks the
target definition FOR UPDATE before checking any user's persisted `user.level`,
including disabled users and regardless of pricing flags. Any reference refuses
the deletion. Otherwise it marks all matching user_level historical rows and the
definition `isDel=1`, atomically; it does not reset users or issue rewards.
This intentionally replaces the old TS unconditional deletion, matching PHP's
occupied guard. Existing cache-authority tests now prove both the refusal and a
separate unoccupied removal instead of treating an occupied removal as valid.

The common `detectUserLevel` helper is the narrowly changed grant writer. Its
callers already lock the account first. It reads eligible persisted definitions
in ID order with FOR SHARE and retains those row locks through grant and user
updates; a JS grade/ID sort preserves the original business ordering. Delete
first causes a waiting READ COMMITTED grant SELECT to recheck `isDel=0` and skip
the deleted definition; grant first makes delete wait and then observe the
committed occupied account. The ordinary runtime already has the reviewed
`UPDATE(id)` lock-only grant and semantic-update blocking trigger for
system_user_level, so this does not add catalogue editing authority. Existing
manual user/OutAPI assignment paths also hold definition shared locks (customer
work uses its installed security-definer catalogue capability).

The new registered HTTP/SQL suite checks both aliases, full state/sequence/resource
read invariance, media scopes, validation, save/delete deltas and live ACL. Four
native-PG-only cases exercise same-snapshot reads, both exact grant/delete blocker
orders and conflicting creates. PGlite results must not be claimed as lock proof.
Fixture DI is an owned connection selection, not independent production LOGIN ACL
commissioning, Redis/login-form proof, payment acceptance or activation testing.

## PHP presentation and client ownership

The reference is `view/admin/src/pages/user/level/index.vue` at PHP commit
`8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`: two white cards, status/name
filters, page size 10, 36px icons, and the original table meanings. The author
form retains separate icon (656×300) and background (750×990) slots. It reuses
the existing actual attachment picker twice; it does not import PHP global CSS
or turn a temporary signed preview into a stored image reference. Dynamic
level pictures come from existing stored references or the attachment library.

The client fences callbacks and editable forms by persisted token, account,
grants and editor generation. Reads/writes have 12-second deadlines. Unknown
write outcomes preserve drafts and require an explicit reread before another
user action; they never replay a mutation automatically. Known business
rejections retain the valid list and its pagination. Installed Element Plus
pagination watchers are exercised in the frontend suite, including a pending
page change while the prior total is cleared. Media renewal is read-only and
failed renewal leaves unsaved stable references intact with an expiry barrier.

The dedicated browser host serves the built Admin and registered Worker routes
on owned PG16. It uses two explicitly synthetic PNG uploads for separate slot
identity, records raw HTTP bodies and complete table/sequence/resource states,
and binds 19 DOM phases to actual completed responses. Its four business writes
and one refused occupied delete are distinct from one test-only role revocation.
The `ready`, `progress`, `evidence` and `cleanup` files are local runtime output
under `/tmp/cinashop-admin-level-definitions-browser-`, not repository artifacts.
