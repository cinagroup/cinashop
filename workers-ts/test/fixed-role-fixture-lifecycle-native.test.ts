import postgres from 'postgres';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { validateFinanceFixtureUrl } from './helpers/financePostgres';
import { customerOriginalPaymentRuntimeFixture } from './helpers/customerOriginalPaymentRuntimeFixture';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from '@/migrations/customerFinancialRuntimePlan';
import { MANAGER_RUNTIME_ROLE } from '@/migrations/managerRuntimePrivilegePlan';

/** A controlled outer deadline models the non-cancelling wait in Vitest's
 * beforeAll wrapper. It is not an actual failed hook and does not reproduce
 * the first historical CI collision. The real factory, SQL gates and five
 * LOGIN installers run unchanged; every late factory is explicitly drained
 * and closed before this case can complete. No unknown role is adopted. */
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('owned fixed-role fixture lifetime', () => {
  it('observes a real factory continue after its outer deadline and closes its late owned roles before completion', async () => {
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
    const options = { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
      connection: { options: '-c statement_timeout=5000 -c lock_timeout=1000' } };
    const blocker = postgres(base.href, options), observer = postgres(base.href, options);
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external provider in fixture lifecycle proof'));
    type Fixture = Awaited<ReturnType<typeof customerOriginalPaymentRuntimeFixture>>;
    let assigned: Fixture | undefined, pending: Promise<Fixture> | undefined;
    let settled: Promise<{ ok: true; value: Fixture } | { ok: false; error: unknown }> | undefined;
    let completed = false, closed = false;
    try {
      const [identity] = await blocker`SELECT current_database() AS database,current_user AS role,session_user AS session,
        current_setting('server_version_num')::integer/10000 AS version,pg_backend_pid() AS pid`;
      expect(identity).toMatchObject({ database: 'cinashop_finance_test', role: 'finance_test', session: 'finance_test', version: 16 });
      const [observing] = await observer`SELECT pg_backend_pid() AS pid`;
      expect(observing.pid).not.toBe(identity.pid);
      const before = await observer`SELECT rolname,oid::text AS oid FROM pg_roles
        WHERE rolname IN(${CUSTOMER_FINANCIAL_RUNTIME_ROLE},${MANAGER_RUNTIME_ROLE})`;
      expect(before).toHaveLength(0);
      await blocker`SELECT pg_advisory_lock(731626,913),pg_advisory_lock(731626,914)`;

      pending = customerOriginalPaymentRuntimeFixture().then(value => { assigned = value; completed = true; return value; },
        error => { completed = true; throw error; });
      // Attach both handlers immediately: an unexpected setup error is always
      // observed and still follows the factory's actual close-on-error path.
      settled = pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      let waiter: number | undefined;
      const waitUntil = performance.now() + 4000;
      do {
        const rows = await observer`SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
          WHERE a.datname='cinashop_finance_test' AND a.usename='finance_test'
            AND l.locktype='advisory' AND l.classid=731626 AND l.objid=913 AND l.objsubid=2 AND NOT l.granted
            AND ${identity.pid}::integer=ANY(pg_blocking_pids(a.pid))`;
        if (rows.length === 1) { waiter = Number(rows[0].pid); break; }
        await delay(25);
      } while (performance.now() < waitUntil);
      expect(waiter).toBeGreaterThan(0);
      expect(waiter).not.toBe(identity.pid);
      expect(waiter).not.toBe(observing.pid);

      const deadline = new Error('Controlled outer fixture wait expired');
      const timeout = delay(30).then(() => { throw deadline; });
      await expect(Promise.race([pending, timeout])).rejects.toBe(deadline);
      expect(assigned).toBeUndefined();
      expect(completed).toBe(false);
      expect(await observer`SELECT rolname FROM pg_roles
        WHERE rolname IN(${CUSTOMER_FINANCIAL_RUNTIME_ROLE},${MANAGER_RUNTIME_ROLE})`).toHaveLength(0);
      const held = await observer`SELECT objid FROM pg_locks WHERE pid=${identity.pid} AND locktype='advisory'
        AND classid=731626 AND objsubid=2 AND granted ORDER BY objid`;
      expect(held.map(row => Number(row.objid))).toEqual([913, 914]);

      await blocker`SELECT pg_advisory_unlock_all()`;
      const actual = await pending;
      expect(actual).toBe(assigned);
      expect(completed).toBe(true);
      expect(Object.values(actual.audits).every(audit => audit.ready)).toBe(true);
      const roles = await observer`SELECT rolname,oid::text AS oid FROM pg_roles
        WHERE rolname IN(${CUSTOMER_FINANCIAL_RUNTIME_ROLE},${MANAGER_RUNTIME_ROLE}) ORDER BY rolname`;
      expect(roles).toHaveLength(2);
      expect(roles.every(row => /^[1-9][0-9]*$/.test(String(row.oid)))).toBe(true);
      const protectedBy = await observer`SELECT objid FROM pg_locks WHERE pid=${waiter!} AND locktype='advisory'
        AND classid=731626 AND objsubid=2 AND granted ORDER BY objid`;
      expect(protectedBy.map(row => Number(row.objid))).toEqual([913, 914]);
      const logins = await Promise.all([actual.appRuntime, actual.adminRuntime, actual.financialRuntime,
        actual.managerRuntime, actual.cashierRuntime].map(peer => peer.verify()));
      expect(new Set(logins).size).toBe(5);
      await actual.close(); closed = true;
      expect(await observer`SELECT rolname,oid::text AS oid FROM pg_roles
        WHERE rolname IN(${CUSTOMER_FINANCIAL_RUNTIME_ROLE},${MANAGER_RUNTIME_ROLE})`).toHaveLength(0);
      expect(await observer`SELECT objid FROM pg_locks WHERE pid=${waiter!} AND locktype='advisory'
        AND classid=731626 AND objsubid=2 AND granted`).toHaveLength(0);
      expect(network).not.toHaveBeenCalled();
      console.log('FIXED_ROLE_LIFECYCLE_PROOF ' + JSON.stringify({ outerDeadlineRejected: true, assignedAtDeadline: false,
        realBlockedFactoryContinued: true, blockerPid: identity.pid, coordinatorPid: waiter, gates: [913, 914],
        createdRoles: roles.map(row => ({ name: row.rolname, oid: row.oid })), distinctRuntimeLogins: logins.length,
        lateFixtureClosed: true, fixedRolesRemaining: 0, historicalFirstCollisionReproduced: false }));
    } finally {
      // Only this case's blocker is closed. This releases its own two gates
      // even if an assertion fails; then drain the exact pending factory.
      try { await blocker.end({ timeout: 5 }); }
      finally {
        try {
          const late = await settled;
          if (late?.ok && !closed) await late.value.close();
        } finally {
          try { await observer.end({ timeout: 5 }); }
          finally { network.mockRestore(); }
        }
      }
    }
  }, 300000);
});
