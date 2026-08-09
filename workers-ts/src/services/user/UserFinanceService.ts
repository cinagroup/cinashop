/**
 * 分销 + 发票 Service
 *
 * 对应原版端点:
 *   - 分销: user/spread, spread/people, spread/order, commission, spread/commission/:type
 *   - 发票: invoice, invoice/save, invoice/del/:id, invoice/detail/:id, invoice/set_default/:id, invoice/get_default/:type
 */
import { eq, and, sql } from "drizzle-orm";
import { user as userTable, userInvoice, userBrokerage, userExtract } from "@/models/schema";
import type { Container } from "@/lib/di";
import { ValidateException, NotFoundException } from "@/utils/errors";

export class UserFinanceService {
  constructor(
    private readonly container: Container,
    private readonly seqEnv?: import("@/env").Env,
  ) {}

  // ═══════════════════════════════════════════════════════════
  // 分销
  // ═══════════════════════════════════════════════════════════

  /** 分销中心首页数据 (commission) */
  async commission(uid: number): Promise<{
    yesterdayCommission: string;
    totalCommission: string;
    frozenCommission: string;
    withdrawable: string;
    spreadCount: number;
  }> {
    const c = this.container;
    const user = await c.userDao.findForAuth(uid);
    if (!user) throw new NotFoundException("用户不存在");

    const total = await c.userBrokerageDao.sumBrokerage(uid);

    // 昨日佣金
    const dayStart = new Date();
    dayStart.setDate(dayStart.getDate() - 1);
    dayStart.setHours(0, 0, 0, 0);
    const yesterdayStart = Math.floor(dayStart.getTime() / 1000);
    const yesterdayEnd = yesterdayStart + 86399;

    const yRows = await c.db
      .select({ total: sql<number>`COALESCE(SUM(${userBrokerage.number}), 0)::numeric(12,2)` })
      .from(userBrokerage)
      .where(
        and(
          eq(userBrokerage.uid, uid),
          eq(userBrokerage.pm, 1),
          eq(userBrokerage.status, 1),
          sql`${userBrokerage.addTime} BETWEEN ${yesterdayStart} AND ${yesterdayEnd}`,
        ),
      );
    const yesterday = Number(yRows[0]?.total ?? 0);

    return {
      yesterdayCommission: yesterday.toFixed(2),
      totalCommission: total.toFixed(2),
      frozenCommission: "0.00",
      withdrawable: user.brokeragePrice,
      spreadCount: user.spreadCount,
    };
  }

  /** 推广人列表 (spread_people) */
  async spreadPeople(uid: number, page = 1, limit = 10) {
    const c = this.container;
    const rows = await c.db
      .select({
        uid: userTable.uid,
        nickname: userTable.nickname,
        avatar: userTable.avatar,
        addTime: userTable.addTime,
      })
      .from(userTable)
      .where(eq(userTable.spreadUid, uid))
      .limit(limit)
      .offset((page - 1) * limit);
    return rows;
  }

  /** 佣金明细 (spread/commission/:type, type: 1=一级 2=二级 3=提现) */
  async commissionList(uid: number, type: number, page = 1, limit = 10) {
    const c = this.container;
    const typeMap: Record<number, string> = {
      1: "one_brokerage",
      2: "two_brokerage",
      3: "extract",
    };
    const category = typeMap[type];
    return c.userBrokerageDao.listByUid(uid, page, limit).then((list) =>
      category ? list.filter((i) => i.category === category) : list,
    );
  }

  /** 提现申请 (extract/cash) */
  async extractCash(
    uid: number,
    params: {
      extractType: string;
      realName: string;
      extractNumber: string;
      extractPrice: string;
      bankName?: string;
    },
  ): Promise<{ id: number }> {
    const c = this.container;
    const user = await c.userDao.findForAuth(uid);
    if (!user) throw new NotFoundException("用户不存在");

    const price = Number(params.extractPrice);
    if (price <= 0) throw new ValidateException("提现金额必须大于 0");
    if (price > Number(user.brokeragePrice)) {
      throw new ValidateException("可提现佣金不足");
    }

    const row = await c.userExtractDao.save({
      uid,
      extractType: params.extractType,
      bankName: params.bankName ?? "",
      bankCode: "",
      bankAddress: "",
      realName: params.realName,
      extractNumber: params.extractNumber,
      extractPrice: price.toFixed(2),
      status: 0,
      addTime: Math.floor(Date.now() / 1000),
    });

    // 扣减可提现佣金
    await c.userDao.update(uid, {
      brokeragePrice: (Number(user.brokeragePrice) - price).toFixed(2),
    });

    // 提现流水 (user_brokerage, status=0 提现中, 对应 PHP 佣金明细 extract 类型)
    await c.userBrokerageDao.save({
      uid,
      linkId: String(row.id),
      pm: 0,
      title: "佣金提现",
      category: "extract",
      type: "extract",
      number: price.toFixed(2),
      balance: (Number(user.brokeragePrice) - price).toFixed(2),
      mark: `提现申请 #${row.id}`,
      status: 0,
      addTime: Math.floor(Date.now() / 1000),
    });

    return { id: row.id };
  }

  /** 我的提现记录 (M17) */
  async extractList(uid: number): Promise<unknown[]> {
    const c = this.container;
    const rows = await c.db
      .select()
      .from(userExtract)
      .where(eq(userExtract.uid, uid))
      .orderBy(sql`${userExtract.addTime} DESC`)
      .limit(50);
    return rows;
  }

  /** 绑定推广关系 (user/spread, 静默绑定) */
  async bindSpread(uid: number, spreadUid: number): Promise<void> {
    if (!spreadUid || spreadUid === uid) return;
    const c = this.container;
    const user = await c.userDao.findForAuth(uid);
    if (!user) throw new NotFoundException("用户不存在");
    // 已有推广人则不覆盖 (对应 PHP: 永久绑定)
    if (user.spreadUid) return;
    await c.userDao.update(uid, {
      spreadUid,
      spreadTime: Math.floor(Date.now() / 1000),
    });
    // 上级推广人数 +1
    await c.userDao.inc({ uid: spreadUid }, "spreadCount", 1);
  }

  // ═══════════════════════════════════════════════════════════
  // 充值
  // ═══════════════════════════════════════════════════════════

  /** 创建充值订单 (recharge/recharge) */
  async recharge(
    uid: number,
    price: number,
    channel: string,
  ): Promise<{ orderId: string; price: string }> {
    const c = this.container;
    if (price <= 0) throw new ValidateException("充值金额必须大于 0");

    // 雪花订单号 (cz 前缀, 对应 PHP getNewOrderId('cz'))
    const seqId = this.seqEnv?.SEQUENCE
      ? this.seqEnv.SEQUENCE.idFromName("seq")
      : null;
    let orderId = `cz${Date.now()}${Math.floor(Math.random() * 1000)}`;
    if (seqId) {
      const stub = this.seqEnv!.SEQUENCE.get(seqId);
      const resp = await stub.fetch("https://internal/next-order-id?prefix=cz");
      orderId = (await resp.text()).trim();
    }

    await c.userRechargeDao.save({
      uid,
      orderId,
      price: price.toFixed(2),
      givePrice: "0.00",
      rechargeType: channel,
      paid: 0,
      addTime: Math.floor(Date.now() / 1000),
    });
    return { orderId, price: price.toFixed(2) };
  }

  /** 充值套餐列表 (recharge/index, 简化: 固定 3 档) */
  async rechargeIndex(): Promise<
    { id: number; price: string; givePrice: string }[]
  > {
    return [
      { id: 1, price: "100.00", givePrice: "0.00" },
      { id: 2, price: "200.00", givePrice: "20.00" },
      { id: 3, price: "500.00", givePrice: "80.00" },
    ];
  }

  // ═══════════════════════════════════════════════════════════
  // 发票
  // ═══════════════════════════════════════════════════════════

  /** 发票列表 (invoice) */
  async invoiceList(uid: number): Promise<(typeof userInvoice.$inferSelect)[]> {
    return this.container.userInvoiceDao.selectList({
      where: { uid, isDel: 0 },
    });
  }

  /** 保存发票 (invoice/save, 含新增/编辑) */
  async invoiceSave(
    uid: number,
    params: {
      id?: number;
      headerType: number;
      type: number;
      name: string;
      dutyNumber: string;
      email?: string;
      isDefault?: number;
    },
  ): Promise<{ id: number }> {
    const c = this.container;
    if (!params.name) throw new ValidateException("发票抬头不能为空");
    if (!params.dutyNumber) throw new ValidateException("税号不能为空");

    const now = Math.floor(Date.now() / 1000);
    if (params.id) {
      const existing = await c.userInvoiceDao.get(params.id);
      if (!existing || existing.uid !== uid) {
        throw new NotFoundException("发票不存在");
      }
      await c.userInvoiceDao.update(params.id, {
        headerType: params.headerType,
        type: params.type,
        name: params.name,
        dutyNumber: params.dutyNumber,
        email: params.email ?? "",
      });
      if (params.isDefault) await this.setDefault(uid, params.id);
      return { id: params.id };
    }

    const row = await c.userInvoiceDao.save({
      uid,
      headerType: params.headerType,
      type: params.type,
      name: params.name,
      dutyNumber: params.dutyNumber,
      email: params.email ?? "",
      isDefault: params.isDefault ?? 0,
      addTime: now,
    });
    if (params.isDefault) await this.setDefault(uid, row.id);
    return { id: row.id };
  }

  /** 删除发票 (invoice/del/:id) */
  async invoiceDel(uid: number, id: number): Promise<void> {
    const c = this.container;
    const invoice = await c.userInvoiceDao.get(id);
    if (!invoice || invoice.uid !== uid) throw new NotFoundException("发票不存在");
    await c.userInvoiceDao.update(id, { isDel: 1 });
  }

  /** 设置默认发票 (invoice/set_default/:id) */
  async setDefault(uid: number, id: number): Promise<void> {
    const c = this.container;
    await c.db
      .update(userInvoice)
      .set({ isDefault: 0 })
      .where(eq(userInvoice.uid, uid));
    await c.db
      .update(userInvoice)
      .set({ isDefault: 1 })
      .where(and(eq(userInvoice.id, id), eq(userInvoice.uid, uid)));
  }

  /** 获取默认发票 (invoice/get_default/:type) */
  async getDefault(uid: number): Promise<(typeof userInvoice.$inferSelect) | null> {
    const rows = await this.container.userInvoiceDao.selectList({
      where: { uid, isDefault: 1, isDel: 0 },
    });
    return rows[0] ?? null;
  }
}
