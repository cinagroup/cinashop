# Registration level activation audit (2026-09-14, local candidate)

## Source rule and missing behavior

PHP `app/listener/user/Register.php:61` dispatches `UserJob::setUserLevel`
**only for a new user**. `StoreNewcomerServices::setUserLevel` (near 529) writes
`level_status = 1` when `member_func_status` is enabled and
`level_activate_status` is disabled. This job is independent of newcomer gifts.
The adjacent PHP checkout was inspected as source; its framework, database and
queue were not executed for this increment.

The TypeScript application had four user INSERT sites, all omitting activation:

| Creation site | Entry paths covered by the shared core |
| --- | --- |
| `LoginService.register` | Password registration |
| `LoginService.loginByMobile` | First verified SMS/mobile login |
| `WechatAuthService.reconcileVerifiedIdentity` | WeChat, Mini Program, Apple, PC social identity and verified-phone reconciliation |
| `OutUserService.create` | Authorized Out API user creation |

The initial 66-case real PostgreSQL run produced **30 failed / 36 passed**.
All eight tested entry variants left automatically eligible accounts inactive.
The old implementation also created a user while the SQL policy table was
unavailable, despite a stale membership configuration being present in test KV.

## Local repair

`RegistrationLevelActivation.readRegistrationLevelStatus` reads only the two
switches, with one SQL statement and two scalar `LIMIT 1` subqueries. Selection
matches the existing global configuration authority: `is_store = 0`, then
`sort DESC, id DESC`. Configuration `status` controls field visibility, not its
switch value. There is no membership-switch KV read, write, or fallback.

Flag parsing deliberately reuses the **existing TypeScript manual-activation**
`configFlag` convention, including JSON-quoted scalars and missing/empty defaults.
This is not a claim that all malformed PHP truthiness cases are identical, nor
a change to the separate strict pricing-switch parser. A missing member switch
is off; a missing manual-activation switch does not require activation.

Each caller invokes the helper **after its identity lock and duplicate/replay
checks, immediately before inserting a genuinely new user**. The flag is part of
the INSERT, not a post-response task or a second activation update. Account,
newcomer balances/ledgers/coupons, and any identity/community/replay rows already
inside that transaction commit or roll back together.

No level is assigned by this helper, no paid membership is enabled, no manual
activation reward is issued, and no historical account is backfilled. Existing
login, verified-UID login, phone binding and replay leave activation unchanged.
Out API's explicit level assignment still takes precedence through its existing
`setLevel` behavior. New users created without a level may correctly have
`level = 0, level_status = 1`; activation alone does not create a level discount.

The Workers skill informed keeping this durable state out of background promises
and caches. The Postgres skill informed reusing the current identity lock order
and keeping the transaction bounded, without adding table/row locks or provider
I/O. References: [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
and [PostgreSQL lock lifetime](https://www.postgresql.org/docs/16/explicit-locking.html).

### Exact consistency boundary

The decision uses the SQL snapshot **at the policy SELECT**, after normal
READ COMMITTED identity-lock waits. It does not freeze configuration until commit.
A later configuration edit can coexist with this already-decided registration;
this is not a commit-time policy fence or a whole-request snapshot. Existing
newcomer gift flags are still loaded through their prior KV-backed path before
the transaction. Neither those gift settings nor the manual-activation workflow
were silently redesigned here.

Bearer-store writes and referral binding remain outside the account-creation
transaction as before. A post-commit external failure can therefore leave a
committed new account while login delivery fails. These external boundaries are
not claimed to be atomic with PostgreSQL.

## Verification

After repair, the original **66 cases all passed**. The suite was expanded to
**71 cases**, including one SQL read for both switches, manual-reward isolation,
newcomer rewards while manual activation is required, and failures in final
social identity / Out API replay writes.

Coverage includes:

- The four 0/1 switch combinations across eight entry variants, with deliberately
  contrary stale KV values and no newcomer rewards.
- Missing/quoted switches, global duplicate precedence, invisible fields and
  store-specific overrides; SQL failure propagates instead of creating a user.
- Activation with balances, integral and coupons exactly once; late coupon
  evidence failure rolls back the account, both ledgers and coupon inventory.
- Existing disabled users stay disabled after login, phone reconciliation and
  idempotent replay; explicit Out level assignment retains its existing behavior.
- Eight independently observed lock waits (both policy transitions across four
  creation sites), followed by a committed policy edit before releasing the lock.
- Four two-connection duplicate-creation races, with one account and one gift set.

Fixtures use actual services and DAOs with ORM-derived tables in owned, disposable
PostgreSQL 16 databases. The helper validates the loopback coordinator, dedicated
role, database/schema ownership and distinct peer backend PIDs; wait tests require
the exact `pg_blocking_pids` edge. Cleanup verifies removal of only the databases
created by the fixture. This is not production history or source-end row matching.

Only the external bearer store is mocked. KV is an explicit in-memory subset;
social/SMS identities are supplied at the already-verified service boundary.
Provider verification, complete HTTP routing/ACL, real KV, browser interactions,
Hyperdrive freshness, full migration DDL/roles and runtime acceptance are separate
gates, not inferred from these service tests. The broader run also includes the
existing complete-ORM checkout pricing authority suite.

Broader regression: **24 files / 359 passed / zero failed or skipped**, 168.44s.
This includes the 71 new cases and the earlier membership/checkout regressions;
the totals overlap and must not be added together. The original 66-case run and
the broad regression are also overlapping evidence.

The first type check found an unused test import and an incomplete test-KV method
shape; the next found the remaining KV method-signature mismatch. The test adapter
was corrected to accept actual key/value arguments, without double casts, changing
production binding types or weakening assertions. Final unit and runtime
TypeScript checks both completed with exit zero. No test timeout was relaxed.
After the final test-adapter correction, the standalone 71-case suite passed
again with zero failures/skips (13.17s). Final `git diff --check` passed, and an
exact checkbox count reconfirmed 240 checked / 164 open.

```text
npm run test:unit -- test/registration-level-activation.test.ts --maxWorkers=2
npm run typecheck
```

## Remaining gates

- Current-candidate production roles, Hyperdrive, capacity, browser/provider and
  Linux/workerd acceptance remain open. Known Windows workerd startup failures
  were not retried unchanged or converted into passes.
- Switching activation mode for existing users and PHP's profile-display override
  remain separate policy/lifecycle questions. This patch does not reactivate them.
- A subsequent unpublished [selected-SKU price increment](sku-membership-price.md)
  adds ordinary-SKU current-user quotes and PC/UniApp presentation with local SQL
  and browser coverage. Its lifecycle/other-client limits remain explicit.
  Zero-discount policy, nested raw cart VIP fields and full membership migration
  remain open.
- No production data/cache mutation, commit, push or deployment occurred. The
  production-image rollback artifact's push permission remains pending.

Checklist: **240 checked / 164 open / 404**. A3k13 and SUP-004 remain open.
