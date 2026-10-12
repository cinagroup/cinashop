import { expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { systemRole } from '@/models/schema';
import { financeMemoryPostgres } from './helpers/financePostgres';

const { nativeClient } = vi.hoisted(() => ({
  nativeClient: vi.fn(() => { throw Error('Explicit memory must not construct a native client'); }),
}));
vi.mock('postgres', () => ({ default: nativeClient }));

it('uses actual owned PGlite with native configuration, preserves the environment and never constructs a native client', async () => {
  const previous = process.env.TEST_FINANCE_POSTGRES_URL;
  const previouslyPresent = Object.hasOwn(process.env, 'TEST_FINANCE_POSTGRES_URL');
  const configured = 'postgresql://finance_test:owned-memory-boundary@127.0.0.1:5432/cinashop_finance_test';
  let fixture: Awaited<ReturnType<typeof financeMemoryPostgres>> | undefined;
  process.env.TEST_FINANCE_POSTGRES_URL = configured;
  try {
    fixture = await financeMemoryPostgres([systemRole], { namespace: 'public' });
    expect(fixture.isMemory).toBe(true);
    expect(fixture.db.$client).toBeInstanceOf(PGlite);
    expect(process.env.TEST_FINANCE_POSTGRES_URL).toBe(configured);
    const value = "actual parameterized ' owned memory";
    const rows = await fixture.db.execute<{ value: string }>(sql`SELECT ${value}::text AS value`);
    expect(rows.map(row => row.value)).toEqual([value]); expect(rows.count).toBe(1);
    await expect(fixture.db.transaction(async tx => {
      const saved = await tx.insert(systemRole).values({ id: 1, roleName: 'must roll back', level: 1 }).returning();
      expect(saved[0].roleName).toBe('must roll back');
      const changed = await tx.execute(sql`UPDATE system_role SET role_name='changed' WHERE id=1`);
      expect(changed.count).toBe(1);
      throw Error('actual memory rollback');
    })).rejects.toThrow('actual memory rollback');
    expect(await fixture.db.select().from(systemRole)).toEqual([]);
    expect(nativeClient).not.toHaveBeenCalled();
    expect(process.env.TEST_FINANCE_POSTGRES_URL).toBe(configured);
  } finally {
    try { await fixture?.close(); } finally {
      if (previous === undefined) delete process.env.TEST_FINANCE_POSTGRES_URL;
      else process.env.TEST_FINANCE_POSTGRES_URL = previous;
      expect(process.env.TEST_FINANCE_POSTGRES_URL).toBe(previous);
      expect(Object.hasOwn(process.env, 'TEST_FINANCE_POSTGRES_URL')).toBe(previouslyPresent);
    }
  }
  expect(nativeClient).not.toHaveBeenCalled();
});
