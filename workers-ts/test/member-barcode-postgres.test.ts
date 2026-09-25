import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { user } from '../src/models/schema';
import { memberBarcode } from '../src/controllers/api/v1/UserProfileController';
import { MemberBarcodeService } from '../src/services/user/MemberBarcodeService';
import { MEMBER_BARCODE_INDEX_SQL } from '../src/migrations/memberBarcodeIndex';
import { runMemberBarcodeIndex } from '../src/migrations/runMemberBarcodeIndex';
import { MigrationService } from '../src/services/MigrationService';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

async function waitForEitherBlock(db: DbClient, waiter: number, blockers: readonly number[]) {
  const deadline = performance.now() + 4_000;
  do {
    const [row] = await db.select({ pids: sql<number[]>`pg_blocking_pids(${waiter}::int)` })
      .from(sql`(VALUES (1)) AS blocker_probe(n)`);
    if (row.pids.some(pid => blockers.includes(pid))) return;
    await delay(25);
  } while (performance.now() < deadline);
  throw new Error('Expected PostgreSQL queued row-lock blocker was not observed');
}

it('keeps external 0167 and embedded 0173 member-barcode migrations identical', () => {
  expect(readFileSync('migrations/0167_member_barcode_index.sql', 'utf8').trim())
    .toBe(MEMBER_BARCODE_INDEX_SQL.trim());
  expect(new MigrationService({} as never).memberBarcodeIndexMigrationSqlForVerification())
    .toBe(MEMBER_BARCODE_INDEX_SQL);
  const routes = readFileSync('src/routes/v1/index.ts', 'utf8');
  expect(routes).toContain('post("/user/bar_code", authMiddleware({ force: true }), UserProfileController.memberBarcode)');
  expect(routes).not.toContain('get("/user/bar_code"');
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('member barcode on isolated native PostgreSQL 16 backends', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeEach(async () => { f = await financePostgres([user], { namespace: 'public' }); });
  afterEach(async () => { await f?.close(); });

  const indexRows = async () => Array.from(await f.db.execute(sql`SELECT c.oid::text AS oid, pg_get_indexdef(c.oid) AS definition
    FROM pg_class c WHERE c.oid=to_regclass('public.user_bar_code_uq')`));
  const member = (db: DbClient, candidate?: () => string) =>
    new MemberBarcodeService(createContainerFromDb(db), candidate);

  it('preflights retired-row duplicates and keeps the table and catalog unchanged on rejection', async () => {
    await f.db.insert(user).values([
      { uid: 1, barCode: 'OLD-A', status: 1 },
      { uid: 2, barCode: 'OLD-A', status: 0, isDel: 1 },
    ]);
    const before = await f.db.select().from(user);
    await expect(runMemberBarcodeIndex(f.db)).rejects.toThrow(/Duplicate member barcode/);
    expect(await f.db.select().from(user)).toEqual(before);
    expect(await indexRows()).toEqual([]);
  });

  it('installs one exact partial unique index, rejects legacy duplicate writes, and reruns idempotently', async () => {
    await f.db.insert(user).values([
      { uid: 1, barCode: 'OLD-A', status: 1 },
      { uid: 2, barCode: '', status: 0, isDel: 1 },
    ]);
    await runMemberBarcodeIndex(f.db);
    const installed = await indexRows();
    expect(installed).toHaveLength(1);
    expect(String(installed[0]?.definition)).toContain('UNIQUE INDEX user_bar_code_uq');
    await expect(f.exec(`UPDATE "user" SET bar_code='OLD-A' WHERE uid=2`))
      .rejects.toMatchObject({ code: '23505' });
    await f.db.update(user).set({ barCode: 'OLD-B' }).where(eq(user.uid, 2));
    await runMemberBarcodeIndex(f.db);
    expect(await indexRows()).toEqual(installed);
    expect((await f.db.select().from(user)).map(row => row.barCode)).toEqual(['OLD-A', 'OLD-B']);
  });

  it('rejects a same-name wrong index instead of adopting it', async () => {
    await f.exec('CREATE INDEX user_bar_code_uq ON public."user" (uid)');
    const before = await indexRows();
    await expect(runMemberBarcodeIndex(f.db)).rejects.toThrow(/index drift/i);
    expect(await indexRows()).toEqual(before);
  });

  it('preserves a valid old code; refuses inactive, deleted, twelve-digit or missing-index accounts', async () => {
    await f.db.insert(user).values([
      { uid: 1, barCode: 'OLD-A', status: 1 },
      { uid: 2, barCode: '', status: 0 },
      { uid: 3, barCode: '', status: 1, isDel: 1 },
      { uid: 4, barCode: '123456789012', status: 1 },
    ]);
    await expect(member(f.db).allocateOrRead(1)).rejects.toThrow(/索引未就绪/);
    await runMemberBarcodeIndex(f.db);
    expect(await member(f.db).allocateOrRead(1)).toBe('OLD-A');
    expect(await member(f.db).allocateOrRead(1)).toBe('OLD-A');
    await expect(member(f.db).allocateOrRead(2)).rejects.toThrow(/账号不可使用/);
    await expect(member(f.db).allocateOrRead(3)).rejects.toThrow(/账号不可使用/);
    await expect(member(f.db).allocateOrRead(4)).rejects.toThrow(/历史会员码无效/);
    await expect(member(f.db).allocateOrRead(5)).rejects.toThrow(/用户不存在/);
    expect((await f.db.select().from(user).where(eq(user.uid, 1)))[0]?.barCode).toBe('OLD-A');
  });

  it('serializes two first allocations for one UID on real independent backend row locks', async () => {
    await f.db.insert(user).values({ uid: 1, barCode: '', status: 1 });
    await runMemberBarcodeIndex(f.db);
    await withFinancePeers(f.db, async ([holder, first, second]) => {
      await holder.exec('BEGIN; SELECT uid FROM public."user" WHERE uid=1 FOR UPDATE');
      let held = true;
      try {
        const a = outcome(member(first.db, () => '1'.repeat(16)).allocateOrRead(1));
        await waitForFinanceBlock(f.db, first.pid, holder.pid);
        const b = outcome(member(second.db, () => '2'.repeat(16)).allocateOrRead(1));
        // PostgreSQL may report the earlier queued waiter as the direct blocker.
        await waitForEitherBlock(f.db, second.pid, [holder.pid, first.pid]);
        await holder.exec('COMMIT'); held = false;
        expect(await a).toMatchObject({ ok: true, value: '1'.repeat(16) });
        expect(await b).toMatchObject({ ok: true, value: '1'.repeat(16) });
      } finally { if (held) await holder.exec('ROLLBACK'); }
    });
    expect((await f.db.select().from(user).where(eq(user.uid, 1)))[0]?.barCode).toBe('1'.repeat(16));
  }, 20_000);

  it('retries a real unique-index collision between two UIDs after both prechecked the same empty code', async () => {
    await f.db.insert(user).values([{ uid: 1, status: 1 }, { uid: 2, status: 1 }]);
    await runMemberBarcodeIndex(f.db);
    await withFinancePeers(f.db, async ([holder, first, second]) => {
      await holder.exec('BEGIN; LOCK TABLE public."user" IN SHARE MODE');
      let held = true;
      try {
        const code = '3'.repeat(16);
        const aCodes = [code, '4'.repeat(16)];
        const bCodes = [code, '5'.repeat(16)];
        const a = outcome(member(first.db, () => aCodes.shift()!).allocateOrRead(1));
        const b = outcome(member(second.db, () => bCodes.shift()!).allocateOrRead(2));
        await waitForFinanceBlock(f.db, first.pid, holder.pid);
        await waitForFinanceBlock(f.db, second.pid, holder.pid);
        await holder.exec('COMMIT'); held = false;
        const results = [await a, await b];
        expect(results.every(result => result.ok)).toBe(true);
        const rows = await f.db.select({ uid: user.uid, barCode: user.barCode }).from(user);
        expect(new Set(rows.map(row => row.barCode)).size).toBe(2);
        expect(rows.some(row => row.barCode === code)).toBe(true);
        expect(aCodes.length + bCodes.length).toBe(1);
      } finally { if (held) await holder.exec('ROLLBACK'); }
    });
  }, 20_000);

  it('returns a private no-store/no-referrer code and fails closed without an authenticated UID', async () => {
    await f.db.insert(user).values({ uid: 1, barCode: 'OLD-A', status: 1 });
    await runMemberBarcodeIndex(f.db);
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('container', createContainerFromDb(f.db));
      if (c.req.header('x-fixture-uid') === '1') c.set('uid', 1);
      await next();
    });
    app.post('/api/user/bar_code', memberBarcode);
    const authorized = await app.request('/api/user/bar_code', { method: 'POST', headers: { 'x-fixture-uid': '1' } }, {} as Env);
    expect(authorized.headers.get('cache-control')).toContain('private, no-store');
    expect(authorized.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await authorized.json()).toMatchObject({ status: 200, data: { bar_code: 'OLD-A' } });
    const anonymous = await app.request('/api/user/bar_code', { method: 'POST' }, {} as Env);
    expect(anonymous.headers.get('cache-control')).toContain('private, no-store');
    expect(anonymous.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await anonymous.json()).toMatchObject({ msg: '请先登录' });
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('member barcode schema binding', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeEach(async () => { f = await financePostgres([user]); });
  afterEach(async () => { await f?.close(); });

  it('attests the active schema and refuses a same-named public decoy index', async () => {
    await f.db.insert(user).values({ uid: 1, barCode: 'OLD-A', status: 1 });
    await f.exec('CREATE TABLE public."user" (uid integer PRIMARY KEY, bar_code varchar(32) NOT NULL)');
    await f.exec(`CREATE UNIQUE INDEX user_bar_code_uq ON public."user" (bar_code) WHERE bar_code <> ''`);
    const service = new MemberBarcodeService(createContainerFromDb(f.db));
    await expect(service.allocateOrRead(1)).rejects.toThrow(/索引未就绪/);
    await f.exec(`CREATE UNIQUE INDEX user_bar_code_uq ON "user" (bar_code) WHERE bar_code <> ''`);
    expect(await service.allocateOrRead(1)).toBe('OLD-A');
    const [identity] = await f.db.select({ schema: sql<string>`current_schema()` }).from(sql`(VALUES (1)) AS probe(n)`);
    expect(identity.schema).toMatch(/^finance_test_[a-f0-9]{32}$/);
  });
});
