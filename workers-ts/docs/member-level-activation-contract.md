# Ordinary membership activation: PHP form and once-only grants

This slice restores the ordinary free level-card activation flow from immutable
PHP `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`, specifically
`view/uniapp/pages/annex/vip_grade_active/index.vue`, its member-header entries
and `UserLevelServices.php::activate` consumption. The registered page is
`/pages/user/levelActivation`; application navigation resolves the legacy
`/pages/annex/vip_grade_active/index` to it. A direct H5 initialization into an
unregistered legacy URL is not claimed. SVIP card redemption and paid purchase
remain separate existing flows.

## Page and original assets

The page retains PHP's black background, gold card, curved white form heading,
required markers and gold confirmation button. Text, positive number, email,
date, identity number, telephone, radio and region fields follow actual server
configuration. Standard sex offers the established three choices; custom radio
keeps its complete configured choices. Empty configuration still permits an
explicit activation. Dates use the native picker and a complete real calendar
value before today. The region picker reads actual `/api/city_list`, displays
province/city/district and submits the selected city `v` string as PHP did.

All six PNGs in `view/uniapp-ts/src/static/php-level-activation` are original
PHP bytes, without re-encoding. Four come from embedded CSS; two come from
`public/statics/images` used by the PHP gift overlay:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| card-art.png | 32919 | 40c68619f0991c85b1346b215d68b6480f1c07a508be7d1dc65dbe5e503529ae |
| card-face.png | 5038 | 4b5586bc90f0131a3e6ee77e6c059bd357f6d6ac9702516a8099fe44f43bcd81 |
| required.png | 418 | 811d30eeac570ed403388ab22b3a2448a8ff302c702c7114bad79f194c95f3cc |
| form-heading.png | 7364 | 4979cf5d260e9b130c3509f10d9e2f102684bb4c1009d82f718aab9704193734 |
| gift-header.png | 11280 | 89efb231f267dd797097fda5cc8613cab7aec6403e08dde2f2feecbdd8b50ab9 |
| gift-row.png | 490 | 88c44235231b0e38484bd4487c8337e1e45a78ca4df5548f21612365f8aaa055 |

Personal-center header styles1/2 explicitly read current authenticated
activation state before choosing the activation page or level overview.
Current level ID/name is not activation authority. Existing menu DTOs remain
unchanged; canonical and legacy activation destinations follow the ordinary
membership capability independently of paid membership.

## Additive HTTP contract

Legacy `GET /api/user/level/activate_info` still returns its configured array,
and legacy activation POST keeps its six-key gift result. Only literal `view=1`
opts into the modern projections; duplicate, mixed or unknown opted-in query
keys reject. All modern responses are private/no-store.

`GET /api/user/level/activate_info?view=1` returns exactly
`{owner_uid,member_enabled,activation_required,level_status,activated,revision,fields}`.
The status comes from the actual authenticated account, with
`activated === (level_status === 1)`. Disabled/already-active state stays
readable. A single REPEATABLE READ READ ONLY transaction reads the account and
complete nine-key global configuration candidates. The owner-bound revision
hash includes candidate IDs, sort, raw value and xmin. Field definitions are
strict, complete and unambiguous, at most64, and carry empty values except
radio's initial index0. No previous private profile values are projected.

`POST /api/user/level/activate?view=1` accepts exactly
`{revision,fields:[{info,value}]}` under the existing16KiB UTF8 bound. Duplicate
JSON keys at any nesting level, client metadata, duplicate/unknown/missing
field names and unsupported definitions reject. Field values are strings up
to1024 Unicode code points; ordinary profile mappings and their tighter
existing limits still apply. The client also checks the complete serialized
body before storing an attempt marker or dispatching.

The modern path starts REPEATABLE READ READ WRITE before policy lookup and
compares revision inside that same transaction. It reuses the established
trusted field normalization, user row lock, once-only activation and reward
engine. Integral, whole-yuan balance, ledgers, finite inventory, unlimited
issues and actual owned coupons commit together. No schema, grant, Admin
writer or advisory fence is added. An overlapping Admin commit may occur
after the transaction snapshot; the activation uses its observed snapshot
policy. A configuration committed before the snapshot changes revision and
rejects an older form. Serialization conflicts return business409 for a
factual reread, without an automatic write retry.

Success is exactly
`{owner_uid,activated:true,level_status:1,rewards,integral_bill_id,money_bill_id,owned_coupons}`.
`rewards` is the unchanged legacy six-key result. Ledger IDs and all owned
coupon IDs are captured with actual RETURNING inside that transaction. Each
owned coupon carries `{id,issue_id,status,start_time,end_time,is_fail,type,
coupon_title,coupon_price,use_min_price}`. A legacy gift's issue ID is not an
owned coupon ID. The UI displays actual granted points, money and coupon type
(80.00 means8折) and uses only actual usable owned IDs for coupon-product
navigation. Its wallet button opens the existing owned-coupon page. No-gift
success follows PHP to the existing level overview.

## Private lifecycle and unknown results

Only explicit confirmation dispatches activation. A synchronous pending guard
fences repeated taps. Every form/picker callback is bound to the document
revision, UID/token/session version, persisted owner and visibility. Hide,
unload, logout, owner replacement and reread clear private drafts and revoke
old callbacks. Same-account window focus preserves unsent edits.

Before dispatch, a separate local marker is stored for each attempt under
`member_level_activation_pending:<UID>:<nonce>`. It contains only
`{version,owner_uid,started_at}`. It contains no token, form values, identity
number, email, telephone, address or gift receipt. A storage failure prevents
dispatch. A definite refusal removes only its own attempt key, then checks
whether another unresolved attempt still exists. Other accounts' keys remain
untouched. Actual success or a factual active-state read clears this account's
pending keys.

Timeout, interruption, malformed success or lost response remains uncertain.
There is no automatic POST replay. An explicit state read can prove that the
account is now active, but cannot recover this particular lost gift receipt.
An inactive read does not prove an earlier dispatched transaction cannot
still commit. Explicit refill is available after that read, with a notice that
the first completed activation controls the saved profile and rewards are
once-only. Unresolved markers remain until activation is actually known.

## Evidence scope

The targeted native PostgreSQL suite exercises33 cases; existing registration
and configuration-authority suites add91 executions. Separate runner/legacy
unit suites pass573 cases, the frontend runtime passes60 and the complete
historical bridge suites pass335. The ordinary/paid menu regression covers26
cases, including canonical/legacy/query activation routes in all modules.
The new source bridge preserves33 earlier fixture/source files byte for byte
and records exact four-file production and two-file harness patches,145
registered routes and the live activation alias.

Browser acceptance uses built H5, the actual Worker, JWT middleware, owned
native PostgreSQL and local R2. Fourteen ordered captures cover guest/legacy
entry, all fields, invalid submission, one confirmed activation and wallet,
a second account's committed-but-lost response, factual read recovery and
late account replacement. Exactly two actual business POSTs are expected,
with actual grants and whole SQL/sequence/resource accounting. Synthetic
sessions, lost/held response controls and explicit backup/isolation/restoration
of only the two synthetic accounts' local markers are QA controls. An
independent verifier binds complete candidate/source/build bytes, actual
request/response bytes, whole snapshots, partial delivery and actual runner
exit/cleanup. Three platform builds are separate compile evidence; this does
not assert production login, live provider transactions or playback on a device.
