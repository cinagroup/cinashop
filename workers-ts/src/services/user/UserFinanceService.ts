/**
 * 分销 + 发票 Service
 *
 * 对应原版端点:
 *   - 分销: user/spread, spread/people, spread/order, commission, spread/commission/:type
 *   - 发票: invoice, invoice/save, invoice/del/:id, invoice/detail/:id, invoice/set_default/:id, invoice/get_default/:type
 */
import { asc, desc, eq, and, inArray, sql } from "drizzle-orm";
import {
  systemGroup,
  systemGroupData,
  user as userTable,
  userInvoice,
  userBrokerage,
  userExtract,
  userFriends,
  userMoney,
  userRecharge,
  userSpread,
} from "@/models/schema";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import { ValidateException, NotFoundException } from "@/utils/errors";
import { centsToDecimal, decimalToCents } from "@/services/order/OrderBrokerageService";
import { grantReferralLotteryChance } from "@/services/activity/LotteryService";
import { SystemConfigService } from "@/services/system/SystemConfigService";

export interface RechargeQuota {
  id: number;
  price: string;
  give_money: string;
}

export interface RechargeIndexData {
  recharge_quota: RechargeQuota[];
  recharge_attention: string[];
  user_extract_balance_status: number;
}

function legacyGroupField(value: unknown): unknown {
  if (value && typeof value === "object" && "value" in value) {
    return (value as { value?: unknown }).value;
  }
  return value;
}

/** Decode PHP system_group_data's nested `{ type, value }` field shape. */
export function parseRechargeQuota(id: number, value: string | null): RechargeQuota | null {
  if (!Number.isSafeInteger(id) || id <= 0 || !value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const priceCents = decimalToCents(String(legacyGroupField(parsed.price) ?? ""));
    const giveCents = decimalToCents(String(legacyGroupField(parsed.give_money) ?? "0"));
    if (priceCents <= 0 || giveCents < 0) return null;
    return {
      id,
      price: centsToDecimal(priceCents),
      give_money: centsToDecimal(giveCents),
    };
  } catch {
    return null;
  }
}

export interface BrokerageToBalanceInput {
  uid: number;
  amountCents: number;
  orderId: string;
  now?: number;
}

export interface BrokerageToBalanceResult {
  orderId: string;
  order_id: string;
  nowMoney: string;
  brokeragePrice: string;
}

/** Transfer withdrawable commission into balance with all PHP ledgers atomically. */
export async function applyBrokerageToBalance(
  container: Container,
  params: BrokerageToBalanceInput,
): Promise<BrokerageToBalanceResult> {
  if (!Number.isSafeInteger(params.uid) || params.uid <= 0) {
    throw new ValidateException("用户参数错误");
  }
  if (!Number.isSafeInteger(params.amountCents) || params.amountCents <= 0) {
    throw new ValidateException("转入金额必须大于 0");
  }
  if (params.amountCents > 10_000_000) {
    throw new ValidateException("单次转入金额不能超过 100000 元");
  }
  if (!/^wx[A-Za-z0-9_-]{1,30}$/.test(params.orderId)) {
    throw new Error("佣金转余额订单号无效");
  }
  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("佣金转余额时间无效");
  const amount = centsToDecimal(params.amountCents);

  return withTx(container, async (tx) => {
    const accounts = await tx
      .select({
        uid: userTable.uid,
        nickname: userTable.nickname,
        userType: userTable.userType,
        nowMoney: userTable.nowMoney,
        brokeragePrice: userTable.brokeragePrice,
      })
      .from(userTable)
      .where(and(
        eq(userTable.uid, params.uid),
        eq(userTable.isDel, 0),
        eq(userTable.status, 1),
      ))
      .limit(1)
      .for("update");
    const account = accounts[0];
    if (!account) throw new NotFoundException("用户不存在或已被禁用");

    const frozenRows = await tx
      .select({ total: sql<string>`COALESCE(SUM(${userBrokerage.number}), 0)::numeric(12,2)` })
      .from(userBrokerage)
      .where(and(
        eq(userBrokerage.uid, params.uid),
        eq(userBrokerage.pm, 1),
        eq(userBrokerage.status, 1),
        sql`${userBrokerage.frozenTime} > ${now}`,
      ));
    const brokerageCents = decimalToCents(account.brokeragePrice);
    const frozenCents = Math.min(decimalToCents(frozenRows[0]?.total ?? "0"), brokerageCents);
    if (params.amountCents > brokerageCents - frozenCents) {
      throw new ValidateException("转入金额不能大于可提现佣金");
    }

    const nowMoney = centsToDecimal(decimalToCents(account.nowMoney) + params.amountCents);
    const brokeragePrice = centsToDecimal(brokerageCents - params.amountCents);
    const rechargeRows = await tx
      .insert(userRecharge)
      .values({
        uid: params.uid,
        orderId: params.orderId,
        price: amount,
        givePrice: "0.00",
        rechargeType: "balance",
        paid: 1,
        payTime: now,
        addTime: now,
        channelType: account.userType,
      })
      .returning({ id: userRecharge.id });
    const recharge = rechargeRows[0];
    if (!recharge) throw new Error("佣金转余额记录创建失败");
    const linkId = String(recharge.id);

    await tx.insert(userMoney).values({
      uid: params.uid,
      linkId,
      type: "extract",
      title: "佣金提现到余额",
      number: amount,
      balance: nowMoney,
      pm: 1,
      mark: `佣金提现到余额${amount}元`,
      status: 1,
      addTime: now,
    });
    await tx.insert(userExtract).values({
      uid: params.uid,
      extractType: "balance",
      realName: account.nickname,
      extractPrice: amount,
      balance: brokeragePrice,
      status: 1,
      addTime: now,
    });
    await tx.insert(userBrokerage).values({
      uid: params.uid,
      linkId,
      pm: 0,
      title: "佣金提现到余额",
      category: "extract",
      type: "extract_money",
      number: amount,
      balance: brokeragePrice,
      mark: `佣金提现到余额${amount}元`,
      status: 1,
      addTime: now,
    });
    await tx
      .update(userTable)
      .set({ nowMoney, brokeragePrice })
      .where(eq(userTable.uid, params.uid));

    return {
      orderId: params.orderId,
      order_id: params.orderId,
      nowMoney,
      brokeragePrice,
    };
  });
}

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
    const now = Math.floor(Date.now() / 1000);
    const frozenRows = await c.db
      .select({ total: sql<string>`COALESCE(SUM(${userBrokerage.number}), 0)::numeric(12,2)` })
      .from(userBrokerage)
      .where(
        and(
          eq(userBrokerage.uid, uid),
          eq(userBrokerage.pm, 1),
          eq(userBrokerage.status, 1),
          sql`${userBrokerage.frozenTime} > ${now}`,
        ),
      );
    const balanceCents = decimalToCents(user.brokeragePrice);
    const frozenCents = Math.min(decimalToCents(frozenRows[0]?.total ?? "0"), balanceCents);

    return {
      yesterdayCommission: yesterday.toFixed(2),
      totalCommission: total.toFixed(2),
      frozenCommission: centsToDecimal(frozenCents),
      withdrawable: centsToDecimal(balanceCents - frozenCents),
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
      bankCode?: string;
      bankAddress?: string;
      alipayCode?: string;
      wechat?: string;
      qrcodeUrl?: string;
    },
  ): Promise<{ id: number }> {
    const priceCents = decimalToCents(params.extractPrice);
    if (priceCents <= 0) throw new ValidateException("提现金额必须大于 0");
    return withTx(this.container, async (tx) => {
      const users = await tx
        .select()
        .from(userTable)
        .where(eq(userTable.uid, uid))
        .limit(1)
        .for("update");
      const account = users[0];
      if (!account) throw new NotFoundException("用户不存在");
      const now = Math.floor(Date.now() / 1000);
      const frozenRows = await tx
        .select({ total: sql<string>`COALESCE(SUM(${userBrokerage.number}), 0)::numeric(12,2)` })
        .from(userBrokerage)
        .where(
          and(
            eq(userBrokerage.uid, uid),
            eq(userBrokerage.pm, 1),
            eq(userBrokerage.status, 1),
            sql`${userBrokerage.frozenTime} > ${now}`,
          ),
        );
      const balanceCents = decimalToCents(account.brokeragePrice);
      const frozenCents = Math.min(decimalToCents(frozenRows[0]?.total ?? "0"), balanceCents);
      if (priceCents > balanceCents - frozenCents) throw new ValidateException("可提现佣金不足");
      const balance = centsToDecimal(balanceCents - priceCents);
      const extractType = params.extractType === "wx" ? "weixin" : params.extractType;
      const bankCode = params.bankCode ?? (extractType === "bank" ? params.extractNumber : "");
      const bankAddress = params.bankAddress ?? (extractType === "bank" ? params.bankName ?? "" : "");
      const alipayCode = params.alipayCode ?? (extractType === "alipay" ? params.extractNumber : "");
      const wechat = params.wechat ?? (extractType === "weixin" ? params.extractNumber : "");
      const rows = await tx
        .insert(userExtract)
        .values({
          uid,
          extractType,
          bankName: params.bankName ?? "",
          bankCode,
          bankAddress,
          realName: params.realName,
          extractNumber: params.extractNumber,
          alipayCode,
          extractPrice: centsToDecimal(priceCents),
          extractFee: "0.00",
          mark: `提现方式: ${extractType}`,
          balance: account.brokeragePrice,
          status: 0,
          failTime: 0,
          wechat,
          qrcodeUrl: params.qrcodeUrl ?? "",
          addTime: now,
        })
        .returning({ id: userExtract.id });
      const row = rows[0];
      if (!row) throw new Error("提现记录创建失败");
      await tx.update(userTable).set({ brokeragePrice: balance }).where(eq(userTable.uid, uid));
      await tx.insert(userBrokerage).values({
        uid,
        linkId: String(row.id),
        pm: 0,
        title: "佣金提现",
        category: "extract",
        type: "extract",
        number: centsToDecimal(priceCents),
        balance,
        mark: `提现申请 #${row.id}`,
        status: 0,
        addTime: now,
      });
      return { id: row.id };
    });
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

  /** 绑定推广关系 (user/spread, 永久绑定并写入历史审计) */
  async bindSpread(uid: number, spreadUid: number): Promise<void> {
    if (!spreadUid) return;
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(spreadUid) || spreadUid <= 0) {
      throw new ValidateException("推广关系参数错误");
    }
    if (spreadUid === uid) throw new ValidateException("不能绑定自己为推广人");

    await withTx(this.container, async (tx) => {
      // Relationship mutations are rare. A single transaction-scoped namespace
      // makes cycle checks deterministic while row locks protect direct writes.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(505602, 0)`);
      const pair = await tx
        .select()
        .from(userTable)
        .where(inArray(userTable.uid, [uid, spreadUid]))
        .orderBy(asc(userTable.uid))
        .for("update");
      const current = pair.find((row) => row.uid === uid);
      const parent = pair.find((row) => row.uid === spreadUid);
      if (!current || current.isDel !== 0) throw new NotFoundException("用户不存在");
      if (current.status !== 1) throw new ValidateException("当前用户已被禁用");
      if (!parent || parent.isDel !== 0 || parent.status !== 1) {
        throw new ValidateException("推广人不存在或已被禁用");
      }
      // 已有推广人则不覆盖 (对应 PHP: 永久绑定)
      if (current.spreadUid) return;

      const visited = new Set<number>();
      let cursor = spreadUid;
      for (let depth = 0; cursor !== 0; depth += 1) {
        if (cursor === uid) throw new ValidateException("推广关系不能形成循环");
        if (visited.has(cursor)) throw new ValidateException("现有推广关系包含循环");
        if (depth >= 100) throw new ValidateException("推广关系层级过深");
        visited.add(cursor);
        const rows = await tx
          .select({ uid: userTable.uid, spreadUid: userTable.spreadUid })
          .from(userTable)
          .where(eq(userTable.uid, cursor))
          .for("update")
          .limit(1);
        if (!rows[0]) break;
        cursor = rows[0].spreadUid;
      }

      const now = Math.floor(Date.now() / 1000);
      await tx
        .update(userTable)
        .set({ spreadUid, spreadTime: now })
        .where(and(eq(userTable.uid, uid), eq(userTable.spreadUid, 0)));
      await tx
        .update(userTable)
        .set({ spreadCount: sql`${userTable.spreadCount} + 1` })
        .where(eq(userTable.uid, spreadUid));
      await tx.insert(userSpread).values({
        storeId: 0,
        uid,
        staffId: 0,
        spreadUid,
        spreadTime: now,
        adminId: 0,
      });
      const existingFriend = await tx
        .select({ id: userFriends.id })
        .from(userFriends)
        .where(and(eq(userFriends.uid, uid), eq(userFriends.friendsUid, spreadUid)))
        .limit(1);
      if (!existingFriend[0]) {
        await tx.insert(userFriends).values({ uid, friendsUid: spreadUid, addTime: now });
      }
      await grantReferralLotteryChance(tx, spreadUid, now);
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 充值
  // ═══════════════════════════════════════════════════════════

  /** PHP type=1: transfer withdrawable commission into account balance. */
  async brokerageToBalance(uid: number, price: number): Promise<BrokerageToBalanceResult> {
    let amountCents: number;
    try {
      amountCents = decimalToCents(price);
    } catch {
      throw new ValidateException("转入金额格式错误");
    }
    const enabled = this.seqEnv
      ? await new SystemConfigService(this.container, this.seqEnv).get("user_extract_balance_status")
      : "1";
    if (enabled && enabled !== "1") throw new ValidateException("佣金转余额已关闭");
    const orderId = await this.createRechargeOrderId("wx");
    return applyBrokerageToBalance(this.container, { uid, amountCents, orderId });
  }

  /** 创建充值订单 (recharge/recharge) */
  async recharge(
    uid: number,
    price: number,
    channel: string,
    rechargeId = 0,
  ): Promise<{ orderId: string; order_id: string; price: string }> {
    const c = this.container;
    let priceCents: number;
    try {
      priceCents = decimalToCents(price);
    } catch {
      throw new ValidateException("充值金额格式错误");
    }
    let givePriceCents = 0;
    if (rechargeId !== 0) {
      if (!Number.isSafeInteger(rechargeId) || rechargeId <= 0) {
        throw new ValidateException("充值套餐参数错误");
      }
      const quota = (await this.rechargeQuotas()).find((item) => item.id === rechargeId);
      if (!quota) throw new ValidateException("您选择的充值方式已下架");
      priceCents = decimalToCents(quota.price);
      givePriceCents = decimalToCents(quota.give_money);
    }
    if (priceCents <= 0) throw new ValidateException("充值金额必须大于 0");
    if (priceCents > 10_000_000) throw new ValidateException("单次充值金额不能超过 100000 元");
    const normalizedChannel = channel.trim().toLowerCase() === "h5"
      ? "weixinh5"
      : channel.trim().toLowerCase();
    if (!["weixin", "weixinh5", "routine"].includes(normalizedChannel)) {
      throw new ValidateException("充值方式不支持");
    }
    const user = await c.userDao.findForAuth(uid);
    if (!user) throw new NotFoundException("用户不存在");
    const minRechargeValue = this.seqEnv
      ? await new SystemConfigService(c, this.seqEnv).get("store_user_min_recharge")
      : "";
    // PHP install seed and validator both define 0.01 as the minimum.
    let minRechargeCents = 1;
    if (minRechargeValue) {
      try {
        minRechargeCents = decimalToCents(minRechargeValue);
      } catch {
        minRechargeCents = 1;
      }
    }
    if (priceCents < minRechargeCents) {
      throw new ValidateException(`充值金额不能低于 ${centsToDecimal(minRechargeCents)} 元`);
    }

    // 雪花订单号 (cz 前缀, 对应 PHP getNewOrderId('cz'))
    const orderId = await this.createRechargeOrderId("cz");

    await c.userRechargeDao.save({
      uid,
      orderId,
      price: centsToDecimal(priceCents),
      givePrice: centsToDecimal(givePriceCents),
      rechargeType: normalizedChannel,
      channelType: user.userType,
      paid: 0,
      addTime: Math.floor(Date.now() / 1000),
    });
    return {
      orderId,
      order_id: orderId,
      price: centsToDecimal(priceCents),
    };
  }

  private async createRechargeOrderId(prefix: "cz" | "wx"): Promise<string> {
    const seqId = this.seqEnv?.SEQUENCE
      ? this.seqEnv.SEQUENCE.idFromName("seq")
      : null;
    let orderId = `${prefix}${Date.now()}${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    if (seqId) {
      const stub = this.seqEnv!.SEQUENCE.get(seqId);
      const resp = await stub.fetch(`https://internal/next-order-id?prefix=${prefix}`);
      orderId = (await resp.text()).trim();
    }
    if (!(prefix === "cz" ? /^cz[A-Za-z0-9_-]{1,30}$/ : /^wx[A-Za-z0-9_-]{1,30}$/).test(orderId)) {
      throw new Error("充值订单号生成失败");
    }
    return orderId;
  }

  /** PHP-compatible recharge landing-page payload. */
  async rechargeIndex(): Promise<RechargeIndexData> {
    const [quotas, config] = await Promise.all([
      this.rechargeQuotas(),
      this.seqEnv
        ? new SystemConfigService(this.container, this.seqEnv).getMany([
            "recharge_attention",
            "user_extract_balance_status",
          ])
        : Promise.resolve({} as Record<string, string>),
    ]);
    const extractStatus = Number.parseInt(config.user_extract_balance_status ?? "1", 10);
    return {
      recharge_quota: quotas,
      recharge_attention: (config.recharge_attention ?? "").split(/\r?\n/),
      user_extract_balance_status: Number.isFinite(extractStatus) ? extractStatus : 1,
    };
  }

  private async rechargeQuotas(): Promise<RechargeQuota[]> {
    const rows = await this.container.db
      .select({ id: systemGroupData.id, value: systemGroupData.value })
      .from(systemGroupData)
      .innerJoin(systemGroup, eq(systemGroupData.gid, systemGroup.id))
      .where(and(
        eq(systemGroup.configName, "user_recharge_quota"),
        eq(systemGroupData.status, 1),
      ))
      .orderBy(desc(systemGroupData.sort), asc(systemGroupData.id));
    return rows
      .map((row) => parseRechargeQuota(row.id, row.value))
      .filter((quota): quota is RechargeQuota => quota !== null);
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
