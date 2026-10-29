# Ordinary distribution center: PHP layout and existing entry points

This slice is stacked on PR203 / `cc01ce33c7e06a8c9d9d8c8cf607568d884cf401`.
It restores the ordinary promoter center in `pages/user/finance.vue`: original
amount-card background, available commission, two cumulative/frozen columns,
centered withdrawal action, and the eight PHP menu cells in source order. The
invitation cell now opens the already registered spread/poster page.

No route, business API, level task or completed destination is counted as newly
migrated. `/api/get_script`, dated audits, route counts, lockfiles, dependency
advisory baseline and Gitleaks configuration are unchanged. Other parallel
work owns `spread.vue`, `SpreadPoster` and `useSpreadPoster`; none is edited here.

## Source contract and deliberate scope

The immutable source is the separate `cinashop-php` repository at
`8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`,
`view/uniapp/pages/users/user_spread_user/index.vue`.
The template renders the monetary card and menu; its task popup is never opened,
and the script's extra `moneyList` read has no rendered list. This slice does not
reproduce those unused reads. The TS preview tabs, manual spread-UID binding,
withdrawal history, promoter count and pending-withdrawal recovery are retained.

The level ribbon says **查看分销等级**, because `/commission` has no assigned
level-name projection. It does not fabricate an unlocked level, invite code,
task count or progress. Entering the center still requests only `/commission`
and `/user/commission/list/{type}`. Opening the existing level destination can
perform its existing PHP evaluation writes; the center adds no evaluator GET.

Still outstanding: division/agent menu variants, effective role and apply-open
configuration, assigned-level title, division invite-code copy and employee
invitation affordances. These need a separately reviewed read projection and
role-aware source contract. This PR does not claim all-role center parity.
System numeric fonts replace the PHP font-family references; no original font
binary was recovered or copied.

## Amounts, actions and lifecycle

The card displays `withdrawable`, not the distinct income-minus-expense
`commissionCount`; all values retain decimal strings. The amount opens the
existing commission ledger, and both the available label and withdrawal button
open the existing withdrawal application. The center never submits a withdrawal.
The owner-scoped pending intent remains in storage until that application resolves
it. The public explanation remains reachable by guests without private reads.

Existing page visibility, disposal, request generations, auth session version and
persisted token/UID fences remain in place. Binding remains one explicit POST,
with backend permanent binding, history and referral effects preserved. Overview
errors survive successful preview-tab reads. Long monetary strings grow the card
without obscuring withdrawal. Failed menu icons retain text, show a placeholder
and have an explicit local retry, independent of financial reads.

## Assets

`src/static/php-finance-center/provenance.json` records Git blob IDs, SHA256,
byte lengths and dimensions for the background and seven new icons. All eight
new PNGs are tracked bytes extracted with `git show <immutable-ref>:<path>` from
`public/statics/images`. The eighth menu icon reuses the previously verified
`php-agent-explanation/spread_sm.png`. No ignored uploads or remote media are
used. Existing platform-owned dynamic assets retain their existing authority.

## Validation boundary

The dedicated runtime suite executes the actual compiled finance page with real
Vue/Pinia and the existing request adapter. Native acceptance uses actual
registered Worker APIs, real synthetic JWTs and a separately authenticated PG16
App LOGIN, with the production runtime privilege audit. Every business read
compares all 283 public tables and 229 sequence states. Explicit binding uses an
independent expected change to the two users, one `user_spread`, one
`user_friends` row and their exact two serial allocations. Repeats and denied
self-binding must conserve the entire database.

The hidden-CUA harness serves the actual built H5 and forwards API requests to
that Worker/App connection. New-document sessions and finite transport faults
are synthetic controls, recorded separately from business evidence. It checks
actual menu navigation, commission display, explicit binding, real JSON/PNG
truncation recovery and cross-document old-owner response delivery. It does not
claim real provider/share/send, physical device, natural token expiry or
same-instance ABA browser coverage. JWTs, full snapshots, private receipts and
screenshots remain under `/tmp` rather than Git.

## Executed local acceptance (2026-10-28)

- Actual Vue/Pinia focused regression: 223/223; Vue strict, H5, Weixin and App
  builds: exit 0. App/Weixin results certify compilation, not physical devices.
- Shared runner admission: 637/637; the complete-schema native end-to-end case
  passes with real JWTs, the audited independent App LOGIN, self-binding denial,
  exact permanent-binding delta, repeat/overwrite idempotence and UID isolation.
- Hidden IAB/CUA at 375 and 1000 pixels: 26 ordered stages, 142 actual API
  traces. Of these, 140 are reads (136 GET and four read-only POST); the other
  two are one accepted binding and its zero-delta repeat. The complete database
  has exactly its baseline state and the independently derived post-binding
  state throughout. The independent verifier checks every raw request/response,
  JWT, snapshot, ACK and source/build byte inventory: 2408 source files,
  529 H5 files and all nine tracked original PNG sources, including the reused
  explanation icon.
- Actual center controls open commission records, withdrawal, orders, people,
  both rankings, invitation, levels, explanation and withdrawal history. The
  ledger destination was exercised through the monetary amount control; the
  equivalent menu handler is covered by the compiled-page runtime test. The
  withdrawal page's real return control restores the center and current amount.
- A real Worker JSON response and original menu PNG are truncated at delivery,
  then recovered through the page's explicit retries. The held old-document
  response is released after a different owner loads; this proves document
  replacement isolation and records the abandoned socket's release attempt.
- No uncaught console errors or framework overlay. The existing vue-router
  deep-import deprecation warning remains. The existing invitation destination
  reports its unconfigured share limiter; only its navigation is certified here.
- HTTP/PG cleanup and actual refused-port probes pass; no per-case fixture databases or
  roles remain, the owned PG clusters are stopped, the temporary tab is closed
  and the viewport override is reset. Earlier failed setup/acceptance attempts
  remain separately preserved in private local evidence.
- Final complete Worker unit and runtime strict checks both exit 0, with all
  checked source/test/script/configuration bytes unchanged during validation.
