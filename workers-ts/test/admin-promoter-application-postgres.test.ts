import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { promoterApply, systemLog, user } from '../src/models/schema';
import { PromoterApplicationService } from '../src/services/agent/PromoterApplicationService';
import { SmsVerificationService } from '../src/services/message/SmsVerificationService';
import { promoterApplicationFixture } from './helpers/promoterApplicationFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const actor = { id: 2, method: 'POST' as const }, deleter = { id: 2, method: 'DELETE' as const };
const input = { nickname: '申请昵称', real_name: '申请实名', phone: '13800138000', code: 'isolated-code' };

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('promoter review races on owned PostgreSQL 16 connections', () => {
  let f: Awaited<ReturnType<typeof promoterApplicationFixture>>;
  beforeEach(async () => {
    f = await promoterApplicationFixture();
    // Only the already-tested external SMS boundary is substituted. Every
    // application, user, advisory/row lock and audit write is real PostgreSQL.
    vi.spyOn(SmsVerificationService.prototype, 'consumeUserCode').mockResolvedValue('13800138000');
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 30_000);

  it.each([1, 2] as const)('serializes approval against decision %s and only logs the first transition', async secondStatus => {
    const revision = await f.revision();
    await withFinancePeers(f.db, async ([blocker, firstPeer, secondPeer]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(505601,11)');
      try {
        const first = outcome(new PromoterApplicationService(createContainerFromDb(firstPeer.db), f.env)
          .examine(101, 11, 1, undefined, actor, revision));
        await waitForFinanceBlock(f.db, firstPeer.pid, blocker.pid);
        const second = outcome(new PromoterApplicationService(createContainerFromDb(secondPeer.db), f.env)
          .examine(101, 11, secondStatus, secondStatus === 2 ? '不同审核结论' : undefined, actor, revision));
        await waitForFinanceBlock(f.db, secondPeer.pid, firstPeer.pid);
        await blocker.exec('COMMIT');
        expect((await first).ok).toBe(true);
        expect((await second).ok).toBe(secondStatus === 1);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    const state = await f.snapshot();
    expect(state.applications[0].status).toBe(1); expect(state.users[0].isPromoter).toBe(1); expect(state.logs).toHaveLength(1);
  });

  it.each(['submit-first', 'review-first'] as const)('%s serializes same-ID same-material resubmission without stale approval', async order => {
    const revision = await f.revision();
    await withFinancePeers(f.db, async ([blocker, firstPeer, secondPeer]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(505601,11)');
      try {
        const firstService = new PromoterApplicationService(createContainerFromDb(firstPeer.db), f.env);
        const secondService = new PromoterApplicationService(createContainerFromDb(secondPeer.db), f.env);
        const first = outcome<unknown>(order === 'submit-first' ? firstService.submit(11, 101, input)
          : firstService.examine(101, 11, 1, undefined, actor, revision));
        await waitForFinanceBlock(f.db, firstPeer.pid, blocker.pid);
        const second = outcome<unknown>(order === 'submit-first' ? secondService.examine(101, 11, 1, undefined, actor, revision)
          : secondService.submit(11, 101, input));
        await waitForFinanceBlock(f.db, secondPeer.pid, firstPeer.pid);
        await blocker.exec('COMMIT');
        const a = await first, b = await second;
        expect(a.ok, a.ok ? '' : String(a.error)).toBe(true);
        expect(b.ok).toBe(false);
        if (!b.ok) expect(String(b.error)).toContain(order === 'submit-first' ? '申请已更新' : '已经是推广员');
      } finally { await blocker.exec('ROLLBACK'); }
    });
    const state = await f.snapshot();
    expect(state.applications[0].status).toBe(order === 'submit-first' ? 0 : 1);
    expect(state.users[0].isPromoter).toBe(order === 'submit-first' ? 0 : 1);
    expect(state.logs).toHaveLength(order === 'submit-first' ? 0 : 1);
  });

  it.each(['delete-first', 'submit-first'] as const)('%s serializes deletion and a fresh application under the applicant key', async order => {
    const revision = await f.revision();
    await withFinancePeers(f.db, async ([blocker, firstPeer, secondPeer]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(505601,11)');
      try {
        const firstService = new PromoterApplicationService(createContainerFromDb(firstPeer.db), f.env);
        const secondService = new PromoterApplicationService(createContainerFromDb(secondPeer.db), f.env);
        const first = outcome<unknown>(order === 'delete-first' ? firstService.delete(101, deleter, revision) : firstService.submit(11, 0, input));
        await waitForFinanceBlock(f.db, firstPeer.pid, blocker.pid);
        const second = outcome<unknown>(order === 'delete-first' ? secondService.submit(11, 0, input) : secondService.delete(101, deleter, revision));
        await waitForFinanceBlock(f.db, secondPeer.pid, firstPeer.pid);
        await blocker.exec('COMMIT');
        expect((await first).ok).toBe(true);
        expect((await second).ok).toBe(order === 'delete-first');
      } finally { await blocker.exec('ROLLBACK'); }
    });
    const state = await f.snapshot();
    expect(state.applications).toHaveLength(2);
    expect(state.applications[0].isDel).toBe(1);
    expect(state.applications[1]).toMatchObject({ isDel: 0, status: 0, uid: 11 });
    expect(state.users[0].isPromoter).toBe(0);
    expect(state.logs).toHaveLength(order === 'delete-first' ? 1 : 0);
  });

  it.each(['review-first', 'delete-first'] as const)('%s prevents the second stale review/delete from changing the first result', async order => {
    const revision = await f.revision();
    await withFinancePeers(f.db, async ([blocker, firstPeer, secondPeer]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(505601,11)');
      try {
        const firstService = new PromoterApplicationService(createContainerFromDb(firstPeer.db), f.env);
        const secondService = new PromoterApplicationService(createContainerFromDb(secondPeer.db), f.env);
        const first = outcome(order === 'review-first' ? firstService.examine(101, 11, 1, undefined, actor, revision)
          : firstService.delete(101, deleter, revision));
        await waitForFinanceBlock(f.db, firstPeer.pid, blocker.pid);
        const second = outcome(order === 'review-first' ? secondService.delete(101, deleter, revision)
          : secondService.examine(101, 11, 1, undefined, actor, revision));
        await waitForFinanceBlock(f.db, secondPeer.pid, firstPeer.pid);
        await blocker.exec('COMMIT');
        expect((await first).ok).toBe(true); expect((await second).ok).toBe(false);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    const state = await f.snapshot();
    expect(state.applications[0]).toMatchObject({ status: order === 'review-first' ? 1 : 0, isDel: order === 'review-first' ? 0 : 1 });
    expect(state.users[0].isPromoter).toBe(order === 'review-first' ? 1 : 0); expect(state.logs).toHaveLength(1);
  });

  it('rechecks the delete_time predicate after waiting for an applicant row update', async () => {
    const revision = await f.revision();
    await withFinancePeers(f.db, async ([blocker, reviewer]) => {
      await blocker.exec('BEGIN; UPDATE "user" SET delete_time=now() WHERE uid=11');
      try {
        const result = outcome(new PromoterApplicationService(createContainerFromDb(reviewer.db), f.env)
          .examine(101, 11, 1, undefined, actor, revision));
        await waitForFinanceBlock(f.db, reviewer.pid, blocker.pid);
        await blocker.exec('COMMIT');
        expect((await result).ok).toBe(false);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    expect((await f.application()).status).toBe(0);
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].isPromoter).toBe(0);
    expect(await f.db.select().from(systemLog)).toHaveLength(0);
    expect(await f.db.select().from(promoterApply)).toHaveLength(1);
  });
});
