// Same actual adapter/RSA contracts in workerd; transport/config remain local.
import { describe, expect, inject, it, vi } from 'vitest';
import { financeNativePostgres } from '../helpers/financePostgres';

declare module 'vitest' {
  export interface ProvidedContext { financePostgresUrl: string }
}

// Only the test-host database adapter changes. The imported suite retains its
// real SQL configuration, RSA, provider-I/O boundaries and fixture close hook.
vi.mock('../helpers/financePostgres', async importOriginal => {
  const original = await importOriginal<typeof import('../helpers/financePostgres')>();
  return {
    ...original,
    financeMemoryPostgres: (tables: Parameters<typeof original.financeMemoryPostgres>[0],
      options: Parameters<typeof original.financeMemoryPostgres>[1] = {}) =>
      original.financeNativePostgres(tables, inject('financePostgresUrl'), options),
  };
});

import '../offline-payment-provider.test';

// Exercise the installed Cloudflare driver against an owned real database.
// Vitest must also finish without unhandled errors; no rejection filters apply.
describe('native Cloudflare PostgreSQL connection lifecycle', () => {
  it.each(['default', 'bounded'] as const)('ends gracefully (%s) and remains idempotent', async mode => {
    const fixture = await financeNativePostgres([], inject('financePostgresUrl'));
    try {
      const client = fixture.db.$client;
      expect((await client`select 17 as value`)[0].value).toBe(17);
      if (mode === 'default') await client.end();
      else await client.end({ timeout: 5 });
      await client.end({ timeout: 5 });
    } finally { await fixture.close(); }
  });

  it.each(['force-end', 'backend-termination'] as const)('rejects an active query on %s', async mode => {
    const fixture = await financeNativePostgres([], inject('financePostgresUrl'));
    const client = fixture.db.$client;
    let session: Awaited<ReturnType<typeof client.reserve>> | undefined;
    let observer: Awaited<ReturnType<typeof financeNativePostgres>> | undefined;
    try {
      session = await client.reserve();
      // A separate owned database keeps physical-close observation available
      // after the tested pool has logically ended.
      observer = await financeNativePostgres([], inject('financePostgresUrl'));
      const [identity] = await session`select pg_backend_pid() as pid, current_database() as database`;
      expect(identity.database).toMatch(/^finance_fixture_[a-f0-9]{32}$/);
      // Attach rejection observation before sending the deliberately pending query.
      const pending = session`select pg_sleep(1) /* cf_close_regression */`.execute()
        .then(() => ({ succeeded: true as const }), (error: unknown) => ({ succeeded: false as const, error }));
      let active = false;
      for (let attempt = 0; attempt < 20 && !active; attempt++) {
        const [activity] = await client`select state, query from pg_stat_activity
          where pid=${identity.pid} and datname=current_database() and usename=current_user`;
        active = activity?.state === 'active' && activity.query.includes('cf_close_regression');
      }
      expect(active).toBe(true);
      if (mode === 'force-end') await client.end({ timeout: 0 });
      else {
        const [result] = await client`select pg_terminate_backend(${identity.pid}) as terminated`;
        expect(result.terminated).toBe(true);
      }
      const result = await pending;
      expect(result.succeeded).toBe(false);
      if (!result.succeeded) expect(result.error).toMatchObject({
        // A FATAL response has no ReadyForQuery. The 3.x driver may reject
        // through EOF with CONNECTION_CLOSED instead of its buffered 57P01.
        code: mode === 'force-end' ? 'CONNECTION_DESTROYED' : expect.stringMatching(/^(57P01|CONNECTION_CLOSED)$/),
      });
      // end(timeout:0) rejects pending work before its physical socket is
      // necessarily gone. Do not mistake that logical result for cleanup.
      const deadline = Date.now() + 2000;
      let gone = false;
      do {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const [activity] = await observer.db.$client.begin(async tx => {
          await tx`select set_config('statement_timeout', ${`${remaining}ms`}, true)`;
          return tx`select count(*)::int as connections from pg_stat_activity
            where pid=${identity.pid} and datname=${identity.database} and usename=current_user`;
        });
        gone = activity.connections === 0;
        if (gone) expect(Date.now()).toBeLessThanOrEqual(deadline);
        if (!gone) await new Promise(resolve => setTimeout(resolve, 20));
      } while (!gone && Date.now() < deadline);
      expect(gone).toBe(true);
      if (!result.succeeded && result.error && typeof result.error === 'object' && 'code' in result.error) {
        console.info(`CF_NATIVE_LIFECYCLE mode=${mode} code=${String(result.error.code)} physicalBackendGone=true`);
      }
    } finally {
      try { session?.release(); }
      finally {
        // After a FATAL/EOF the 3.x connection can retain its query slot. End
        // that already rejected session before the fixture's graceful close;
        // its default five-second wait must not hide the original assertions.
        try { await client.end({ timeout: 0 }); }
        finally {
          try { await fixture.close(); }
          finally { await observer?.close(); }
        }
      }
    }
  });
});
