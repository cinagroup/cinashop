/** Owned disposable SQL only. No production fallback, payment or provider mocks. */
import { sql } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import type { Env } from '@/env';
import { divisionApply, qrcode, storeOrder, systemAdmin, systemConfig, systemMenus, systemRole, user, userBill, userBrokerage } from '@/models/schema';
import { financePostgres } from './financePostgres';

export async function divisionStaffFixture() {
  const f = await financePostgres([user, storeOrder, qrcode, userBrokerage, userBill, systemConfig,
    systemAdmin, systemRole, systemMenus, divisionApply], { namespace: 'public' });
  // The declared production QR identity constraint is part of this fixture,
  // rather than fabricating ON CONFLICT behavior in a column-only database.
  try { await f.exec('CREATE UNIQUE INDEX qrcode_third_type_third_id_uq ON qrcode(third_type,third_id)'); }
  catch (error) { await f.close(); throw error; }
  const container = createContainerFromDb(f.db), now = Math.floor(Date.now() / 1000);
  const password = 'synthetic-staff-password', writes: unknown[] = [];
  const env = { APP_KEY: 'synthetic-division-staff-http-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
    CONFIG_KV: { get: async () => null, put: async (...args: unknown[]) => { writes.push(args); }, delete: async (...args: unknown[]) => { writes.push(args); } } } as unknown as Env;
  async function seed() {
    await f.reset();
    await f.db.insert(user).values([
      { uid: 10, account: 'owned-division', pwd: password, nickname: '本地区域代理', divisionName: '隔离事业部', divisionType: 1,
        divisionStatus: 1, divisionId: 10, divisionPercent: 60, divisionEndTime: now + 86400 },
      { uid: 22, account: 'owned-agent', pwd: password, nickname: '本地代理商甲', divisionName: '隔离代理甲', divisionType: 2,
        divisionStatus: 1, divisionId: 10, agentId: 22, divisionPercent: 40, divisionEndTime: now + 86400 },
      { uid: 30, account: 'foreign-agent', pwd: password, nickname: '本地代理商乙', divisionType: 2,
        divisionStatus: 1, divisionId: 10, agentId: 30, divisionPercent: 40, divisionEndTime: now + 86400 },
      { uid: 44, account: 'owned-staff', pwd: password, nickname: '员工甲', phone: '13800000044', avatar: '/owned-staff.svg',
        divisionName: '保留前的员工名称', divisionType: 3, divisionStatus: 1, divisionId: 10, agentId: 22, staffId: 44,
        divisionPercent: 10, divisionEndTime: now + 86400, spreadUid: 22, spreadTime: 1700000000, isPromoter: 1, nowMoney: '123.45', integral: 987, brokeragePrice: '67.89' },
      { uid: 45, account: 'legacy-staff-zero', pwd: password, nickname: '员工乙', divisionType: 3, divisionStatus: 1,
        divisionId: 10, agentId: 22, staffId: 0, divisionPercent: 5, divisionEndTime: now + 86400, spreadUid: 22, spreadTime: 1700000100 },
      { uid: 55, account: 'owned-child', pwd: password, nickname: '关联用户', divisionId: 10, agentId: 22, staffId: 44, spreadUid: 44, spreadTime: 1700000200 },
      { uid: 56, account: 'owned-grandchild', pwd: password, nickname: '间接关联用户', divisionId: 10, agentId: 22, staffId: 44, spreadUid: 55, spreadTime: 1700000300 },
      { uid: 65, account: 'foreign-child', pwd: password, nickname: '其他代理用户', divisionId: 10, agentId: 30, staffId: 44, spreadUid: 44 },
      { uid: 77, account: 'owned-applicant', pwd: password, nickname: '本地受邀用户', nowMoney: '99.00', integral: 42 },
    ]);
    await f.db.insert(qrcode).values([
      { id: 901, thirdType: 'division_agent', thirdId: 22, status: 1 },
      { id: 902, thirdType: 'division_agent', thirdId: 30, status: 1 },
      { id: 903, thirdType: 'spread', thirdId: 22, status: 1 },
      { id: 904, thirdType: 'division_agent', thirdId: 99999, status: 0 },
    ]);
    await f.db.insert(storeOrder).values([
      { id: 1, uid: 44, orderId: 'owned-staff-unpaid-history', payPrice: '10.01', paid: 0, divisionId: 10,
        divisionAgentId: 22, divisionAgentBrokerage: '0.10', divisionStaffId: 44, divisionStaffBrokerage: '0.05' },
      { id: 2, uid: 44, orderId: 'owned-staff-refunded-history', payPrice: '30.00', paid: 1, refundStatus: 1,
        divisionAgentId: 22, divisionAgentBrokerage: '1.20', divisionStaffId: 44, divisionStaffBrokerage: '0.15' },
      { id: 3, uid: 44, orderId: 'owned-staff-paid-history', payPrice: '19.99', paid: 1, divisionId: 10,
        divisionAgentId: 22, divisionAgentBrokerage: '0.20', divisionStaffId: 44, divisionStaffBrokerage: '0.10' },
      { id: 4, uid: 65, orderId: 'foreign-history', payPrice: '100.00', paid: 1, divisionAgentId: 30, divisionAgentBrokerage: '8.00' },
    ]);
    await f.db.insert(userBrokerage).values({ id: 1, uid: 44, title: '既有员工佣金', type: 'staff_brokerage', number: '0.10', linkId: '3', pm: 1, status: 1 });
    await f.db.insert(systemAdmin).values({ id: 1, account: 'owned-admin-root', pwd: password, level: 0 });
    writes.length = 0;
  }
  const snapshot = async () => ({ users: await f.db.select().from(user).orderBy(user.uid),
    orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id), brokerage: await f.db.select().from(userBrokerage).orderBy(userBrokerage.id),
    bills: await f.db.select().from(userBill), qr: await f.db.select().from(qrcode).orderBy(qrcode.id) });
  const actor = (uid = 22) => ({ uid, passwordVersion: password, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  try { await seed(); }
  catch (error) { await f.close(); throw error; }
  return { ...f, container, env, password, writes, now, seed, snapshot, actor,
    isNative: () => Boolean(process.env.TEST_FINANCE_POSTGRES_URL),
    readSettings: () => f.db.execute(sql`SELECT current_setting('transaction_read_only') AS mode, current_setting('transaction_isolation') AS level`) };
}
