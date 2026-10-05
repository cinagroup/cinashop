import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainerFromDb } from '../src/lib/di';
import { legacyCategory } from '../src/models/schema';
import { AdminIntegralCategoryService } from '../src/services/admin/AdminIntegralCategoryService';
import { categoryInput, integralCategoryFixture } from './helpers/integralCategoryFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('integral category write serialization on owned PostgreSQL 16', () => {
  let f: Awaited<ReturnType<typeof integralCategoryFixture>>;
  const actor = { id: 2 };
  beforeEach(async () => { f = await integralCategoryFixture(); }, 30_000);
  afterEach(async () => { await f?.close(); }, 30_000);

  it.each(['overlap', 'case-name', 'same-request'] as const)('serializes simultaneous create requests: %s', async mode => {
    const firstBody = { ...categoryInput, name: 'ABC', request_id: crypto.randomUUID() };
    const secondBody = mode === 'same-request' ? firstBody : { ...categoryInput, request_id: crypto.randomUUID(),
      name: mode === 'case-name' ? 'abc' : '另一分类', integral_min: mode === 'case-name' ? 301 : 250, integral_max: 400 };
    await withFinancePeers(f.db, async ([blocker, firstPeer, secondPeer]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731641,5)');
      try {
        const first = outcome(new AdminIntegralCategoryService(createContainerFromDb(firstPeer.db)).mutate('create', 0, firstBody, actor));
        await waitForFinanceBlock(f.db, firstPeer.pid, blocker.pid);
        const second = outcome(new AdminIntegralCategoryService(createContainerFromDb(secondPeer.db)).mutate('create', 0, secondBody, actor));
        await waitForFinanceBlock(f.db, secondPeer.pid, firstPeer.pid);
        await blocker.exec('COMMIT');
        const a = await first, b = await second;
        expect(a.ok).toBe(true); expect(b.ok).toBe(mode === 'same-request');
        if (a.ok && b.ok) expect(b.value).toEqual(a.value);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    const state = await f.snapshot();
    expect(state.categories.filter(row => row.group === 5)).toHaveLength(3); expect(state.logs).toHaveLength(1);
  });

  it('prevents two different category updates from introducing intersecting ranges', async () => {
    const firstBody = { ...categoryInput, request_id: crypto.randomUUID(), revision: await f.revision(101), name: '第一个迁移区间' };
    const secondBody = { ...categoryInput, request_id: crypto.randomUUID(), revision: await f.revision(102), name: '第二个迁移区间', integral_min: 250, integral_max: 400 };
    await withFinancePeers(f.db, async ([blocker, firstPeer, secondPeer]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731641,5)');
      try {
        const first = outcome(new AdminIntegralCategoryService(createContainerFromDb(firstPeer.db)).mutate('update', 101, firstBody, actor));
        await waitForFinanceBlock(f.db, firstPeer.pid, blocker.pid);
        const second = outcome(new AdminIntegralCategoryService(createContainerFromDb(secondPeer.db)).mutate('update', 102, secondBody, actor));
        await waitForFinanceBlock(f.db, secondPeer.pid, firstPeer.pid);
        await blocker.exec('COMMIT');
        expect((await first).ok).toBe(true); expect((await second).ok).toBe(false);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    const state = await f.snapshot();
    expect(state.categories[0]).toMatchObject({ integralMin: 201, integralMax: 300 });
    expect(state.categories[1]).toMatchObject({ integralMin: 101, integralMax: 200 }); expect(state.logs).toHaveLength(1);
  });

  it.each(['update-first', 'delete-first'] as const)('%s leaves only the first valid versioned decision committed', async order => {
    const revision = await f.revision();
    const update = { ...categoryInput, name: '修订低积分', integral_min: 0, integral_max: 99, request_id: crypto.randomUUID(), revision };
    const remove = { request_id: crypto.randomUUID(), revision };
    await withFinancePeers(f.db, async ([blocker, firstPeer, secondPeer]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731641,5)');
      try {
        const firstService = new AdminIntegralCategoryService(createContainerFromDb(firstPeer.db));
        const secondService = new AdminIntegralCategoryService(createContainerFromDb(secondPeer.db));
        const first = outcome(firstService.mutate(order === 'update-first' ? 'update' : 'delete', 101, order === 'update-first' ? update : remove, actor));
        await waitForFinanceBlock(f.db, firstPeer.pid, blocker.pid);
        const second = outcome(secondService.mutate(order === 'update-first' ? 'delete' : 'update', 101, order === 'update-first' ? remove : update, actor));
        await waitForFinanceBlock(f.db, secondPeer.pid, firstPeer.pid);
        await blocker.exec('COMMIT');
        expect((await first).ok).toBe(true); expect((await second).ok).toBe(false);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    const state = await f.snapshot();
    expect(state.categories.some(row => row.id === 101)).toBe(order === 'update-first'); expect(state.logs).toHaveLength(1);
  });

  it('serializes simultaneous show requests at the public consumer capacity boundary', async () => {
    await f.db.insert(legacyCategory).values([
      { id: 104, group: 5, name: '第三隐藏分类', integralMin: 201, integralMax: 300, isShow: 0 },
      ...Array.from({ length: 998 }, (_, n) => ({ id: 1000 + n, group: 5, name: `容量${n}`,
        integralMin: 1000 + n * 20, integralMax: 1010 + n * 20, isShow: 1 })),
    ]);
    const firstBody = { request_id: crypto.randomUUID(), revision: await f.revision(102), is_show: 1 };
    const secondBody = { request_id: crypto.randomUUID(), revision: await f.revision(104), is_show: 1 };
    expect(await f.publicCategories()).toHaveLength(999);
    await withFinancePeers(f.db, async ([blocker, firstPeer, secondPeer]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731641,5)');
      try {
        const first = outcome(new AdminIntegralCategoryService(createContainerFromDb(firstPeer.db)).mutate('status', 102, firstBody, actor));
        await waitForFinanceBlock(f.db, firstPeer.pid, blocker.pid);
        const second = outcome(new AdminIntegralCategoryService(createContainerFromDb(secondPeer.db)).mutate('status', 104, secondBody, actor));
        await waitForFinanceBlock(f.db, secondPeer.pid, firstPeer.pid);
        await blocker.exec('COMMIT');
        expect((await first).ok).toBe(true); expect((await second).ok).toBe(false);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    expect(await f.publicCategories()).toHaveLength(1000);
    expect((await f.snapshot()).logs).toHaveLength(1);
  });
});
