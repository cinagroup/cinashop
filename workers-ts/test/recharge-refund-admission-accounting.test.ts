/** SQL accounting component tests. Authentication and original-payment readers
 * are explicit controlled adapters here, not proof of native LOGIN/provider
 * authority. Wallet, bills, immutable receipts, checks and rollback use real
 * PGlite SQL. Separate PG16 acceptance must verify the actual authorities. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { createContainerFromDb } from '@/lib/di';
import { user, userBill, userRecharge } from '@/models/schema';
import { RECHARGE_REFUND_SCHEMA_SQL } from '@/migrations/rechargeRefundContract';
import { admitAdminRechargeRefund, abandonAdminRechargeRefund, quoteAdminRechargeRefund } from '@/services/admin/AdminRechargeRefundAdmission';
import { captureRechargeRefundBasis } from '@/services/payment/RechargeRefundMoney';
import { financeMemoryPostgres } from './helpers/financePostgres';

const controlled = vi.hoisted(() => ({ deny: false, sourceReads: 0, approvalDenied: false, approvalRevision: 1 }));
vi.mock('@/migrations/rechargeRefund', () => ({ assertRechargeRefundRuntimeTx: async () => scope }));
vi.mock('@/services/admin/AdminRechargeRefundActor', async actual => ({
  ...await actual<typeof import('@/services/admin/AdminRechargeRefundActor')>(),
  authorizeAdminRechargeRefundTx: async () => { if (controlled.deny) throw Error('controlled_authorization_denied'); },
}));
vi.mock('@/services/payment/RechargeRoutineRefundAccount', () => ({
  readRechargeRoutineRefundAccountPolicyTx: async () => {
    if (controlled.approvalDenied) throw Error('controlled_recharge_approval_denied');
    return { record_id: '00000000-0000-4000-8000-00000000000' + controlled.approvalRevision, signature: String(controlled.approvalRevision).repeat(64) };
  },
}));
vi.mock('@/services/payment/RechargeRefundSource', () => ({
  assertRechargeRefundSourceTx: (_tx: DbClient, value: unknown) => value,
  readRechargeRefundSourceTx: async (tx: DbClient, _env: unknown, _role: unknown, id: number) => {
    controlled.sourceReads++;
    const [r] = await tx.select().from(userRecharge).where(eq(userRecharge.id, id));
    if (!r) throw Error('component_recharge_missing');
    const [u] = await tx.select().from(user).where(eq(user.uid, r.uid));
    const [versions] = await tx.execute<{ recharge: string; wallet: string }>(sql`SELECT r.xmin::text AS recharge,u.xmin::text AS wallet
      FROM public.user_recharge r JOIN public."user" u ON u.uid=r.uid WHERE r.id=${id}`);
    return { scope, basis: captureRechargeRefundBasis({ id, uid: r.uid, orderId: r.orderId, price: r.price, givePrice: r.givePrice,
      refundPrice: r.refundPrice, paid: r.paid, nowMoney: u.nowMoney, rechargeType: r.rechargeType }), versions,
      appId: 'controlled_app', merchantId: '123456', provider: 'wechat', profile: 'routine', transactionId: 'component-only-transaction',
      source: { componentOnly: true }, signature: 'c'.repeat(64) };
  },
}));
const scope = { database: 'component_only', databaseOid: '16000', maintenance: 'owner', maintenanceOid: '17000',
  app: 'app', appOid: '17001', admin: 'admin', adminOid: '17002', financial: 'financial', financialOid: '17003', manager: 'manager', managerOid: '17004' };
const env = { APP_KEY: 'component-only-recharge-refund-accounting-key', ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS: '{}' };
const actor = { id: 7, authVersion: 'a'.repeat(32), expiresAt: 2_000_000_000 };
async function fixture(run: (f: Awaited<ReturnType<typeof financeMemoryPostgres>>) => Promise<void>) {
  controlled.deny = false; controlled.sourceReads = 0; controlled.approvalDenied = false; controlled.approvalRevision = 1;
  const f = await financeMemoryPostgres([user, userRecharge, userBill], { namespace: 'public' });
  try {
    await f.exec(RECHARGE_REFUND_SCHEMA_SQL);
    await f.db.insert(user).values({ uid: 51, nowMoney: '125.35', isDel: 0 });
    await f.db.insert(userRecharge).values({ id: 31, uid: 51, orderId: 'czComponentOnly', price: '100.00', givePrice: '20.00',
      paid: 1, rechargeType: 'weixin', tradeNo: 'component-only-transaction' });
    await run(f);
  } finally { await f.close(); }
}
const facts = async (db: DbClient) => ({ wallets: await db.select({ balance: user.nowMoney }).from(user), bills: await db.select().from(userBill),
  operations: Array.from(await db.execute(sql`SELECT * FROM public.recharge_refund_operation ORDER BY operation_id`)),
  states: Array.from(await db.execute(sql`SELECT * FROM public.recharge_refund_state ORDER BY operation_id`)) });
async function body(f: Awaited<ReturnType<typeof financeMemoryPostgres>>, recoverGift: boolean) {
  const quote = await quoteAdminRechargeRefund(createContainerFromDb(f.db), env, actor, 31), option = quote.options.find(o => o.recoverGift === recoverGift)!;
  return { version: quote.version, rechargeId: 31, recoverGift, quoteFingerprint: option.quoteFingerprint };
}

describe('recharge refund admission accounting under controlled authority adapters', () => {
  it.each([[true, '5.35', '120.00'], [false, '25.35', '100.00']] as const)
    ('reserves the selected gift mode %s once while keeping full external principal', async (recoverGift, balance, debit) => fixture(async f => {
      const input = await body(f, recoverGift), key = randomUUID(), container = createContainerFromDb(f.db);
      const first = await admitAdminRechargeRefund(container, env, actor, key, input), before = await facts(f.db);
      expect(first.replayed).toBe(false); expect(first.operation).toMatchObject({ admission: 'reserved', principal_cents: 10000,
        debit_cents: recoverGift ? 12000 : 10000, wallet_after: recoverGift ? 535 : 2535 });
      expect(before.wallets).toEqual([{ balance }]); expect(before.bills).toHaveLength(1);
      expect(before.bills[0]).toMatchObject({ number: debit, balance, pm: 0, type: 'recharge_refund' });
      expect(before.states).toHaveLength(1);
      const replay = await admitAdminRechargeRefund(container, env, actor, key, input);
      expect(replay.replayed).toBe(true); expect(replay.operation).toEqual(first.operation); expect(await facts(f.db)).toEqual(before);
    }));

  it('persists insufficient rejection without a wallet hold, and never retries it after a top-up', async () => fixture(async f => {
    await f.db.update(user).set({ nowMoney: '110.00' }).where(eq(user.uid, 51));
    const input = await body(f, true), key = randomUUID(), container = createContainerFromDb(f.db);
    const first = await admitAdminRechargeRefund(container, env, actor, key, input);
    expect(first.operation).toMatchObject({ admission: 'rejected_insufficient', debit_cents: 12000, wallet_before: 11000, wallet_after: 11000,
      provider: null, payment_source: null, out_refund_no: null });
    expect(await facts(f.db)).toMatchObject({ wallets: [{ balance: '110.00' }], bills: [], states: [] });
    await f.db.update(user).set({ nowMoney: '150.00' }).where(eq(user.uid, 51));
    expect((await admitAdminRechargeRefund(container, env, actor, key, input)).operation).toEqual(first.operation);
    expect(await facts(f.db)).toMatchObject({ wallets: [{ balance: '150.00' }], bills: [], states: [] });
  }));

  it('rolls back the wallet reservation when the bill cannot commit', async () => fixture(async f => {
    const input = await body(f, true), key = randomUUID(), before = await facts(f.db);
    await f.exec("CREATE FUNCTION public.reject_component_bill() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'controlled_bill_failure';END$$;CREATE TRIGGER reject_component_bill BEFORE INSERT ON public.user_bill FOR EACH ROW EXECUTE FUNCTION public.reject_component_bill()");
    await expect(admitAdminRechargeRefund(createContainerFromDb(f.db), env, actor, key, input)).rejects.toThrow();
    expect(await facts(f.db)).toEqual(before);
  }));

  it('fences a late sender using an abandoned key before reading the payment source', async () => fixture(async f => {
    const input = await body(f, true), key = randomUUID(), container = createContainerFromDb(f.db);
    const abandoned = await abandonAdminRechargeRefund(container, env, actor, key, input);
    controlled.sourceReads = 0;
    expect(abandoned).toMatchObject({ admission: 'abandoned', principal_cents: null, buyer_uid: null, payment_source: null });
    expect((await admitAdminRechargeRefund(container, env, actor, key, input)).operation).toEqual(abandoned);
    expect(controlled.sourceReads).toBe(0);
    expect(await facts(f.db)).toMatchObject({ wallets: [{ balance: '125.35' }], bills: [], states: [] });
  }));

  it('rejects a key reused with a changed gift decision before another debit', async () => fixture(async f => {
    const key = randomUUID(), container = createContainerFromDb(f.db), input = await body(f, false);
    await admitAdminRechargeRefund(container, env, actor, key, input); const before = await facts(f.db);
    await expect(admitAdminRechargeRefund(container, env, actor, key, { ...input, recoverGift: true })).rejects.toThrow('不同充值退款');
    expect(await facts(f.db)).toEqual(before);
  }));

  it('rejects a stale quote after a wallet value changed and returned to the old amount', async () => fixture(async f => {
    const input = await body(f, true), before = await facts(f.db);
    await f.db.update(user).set({ nowMoney: '100.00' }).where(eq(user.uid, 51));
    await f.db.update(user).set({ nowMoney: '125.35' }).where(eq(user.uid, 51));
    await expect(admitAdminRechargeRefund(createContainerFromDb(f.db), env, actor, randomUUID(), input)).rejects.toThrow('已变化');
    expect(await facts(f.db)).toEqual(before);
  }));

  it('rejects another new key while the recharge already has a held operation', async () => fixture(async f => {
    const container = createContainerFromDb(f.db), first = await body(f, false);
    await admitAdminRechargeRefund(container, env, actor, randomUUID(), first);
    await f.db.update(user).set({ nowMoney: '200.00' }).where(eq(user.uid, 51));
    const next = await body(f, false), before = await facts(f.db);
    await expect(admitAdminRechargeRefund(container, env, actor, randomUUID(), next)).rejects.toThrow('已有预留');
    expect(await facts(f.db)).toEqual(before);
  }));

  it('leaves all accounting unchanged when fresh authorization refuses', async () => fixture(async f => {
    const input = await body(f, true), before = await facts(f.db); controlled.deny = true;
    await expect(admitAdminRechargeRefund(createContainerFromDb(f.db), env, actor, randomUUID(), input)).rejects.toThrow('controlled_authorization_denied');
    expect(await facts(f.db)).toEqual(before);
  }));
  it('leaves money unchanged when the independent recharge approval is withdrawn after quote', async () => fixture(async f => {
    const input = await body(f, false), before = await facts(f.db); controlled.approvalDenied = true;
    await expect(admitAdminRechargeRefund(createContainerFromDb(f.db), env, actor, randomUUID(), input)).rejects.toThrow('controlled_recharge_approval_denied');
    expect(await facts(f.db)).toEqual(before);
  }));
  it('requires a fresh quote when the account approval revision changes before admission', async () => fixture(async f => {
    const input = await body(f, false), before = await facts(f.db); controlled.approvalRevision = 2;
    await expect(admitAdminRechargeRefund(createContainerFromDb(f.db), env, actor, randomUUID(), input)).rejects.toThrow('已变化');
    expect(await facts(f.db)).toEqual(before);
  }));
  it('recovers the original committed admission even after account approval is unavailable', async () => fixture(async f => {
    const input = await body(f, false), key = randomUUID(), container = createContainerFromDb(f.db);
    const first = await admitAdminRechargeRefund(container, env, actor, key, input), before = await facts(f.db);
    expect(first.operation.payment_source).toMatchObject({ refundApproval: { recordId: '00000000-0000-4000-8000-000000000001', signature: '1'.repeat(64) } });
    controlled.approvalDenied = true;
    expect((await admitAdminRechargeRefund(container, env, actor, key, input)).operation).toEqual(first.operation);
    expect(await facts(f.db)).toEqual(before);
  }));

});
