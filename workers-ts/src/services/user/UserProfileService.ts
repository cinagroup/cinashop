import { and, asc, desc, eq, gt, gte, lt, lte, sql } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  agentLevel,
  storeBargain,
  storeCombination,
  storeProduct,
  systemUserLevel,
  user as userTable,
  userBill,
  userLevel,
} from "@/models/schema";
import { LegacyOrderCompatibilityService } from "@/services/order/LegacyOrderCompatibilityService";
import { PublicCatalogService } from "@/services/product/PublicCatalogService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { UserFinanceService } from "@/services/user/UserFinanceService";
import { WechatMiniProgramCodeService } from "@/services/wechat/WechatMiniProgramCodeService";
import { parseConfigInteger } from "@/utils/config";
import { cacheGet, cacheSetIfAbsent } from "@/utils/cache";
import { NotFoundException, ValidateException } from "@/utils/errors";

const SHARE_COOLDOWN_SECONDS = 5 * 60;
const PAYMENT_CODE_TTL_SECONDS = 10 * 60;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function decimal(value: unknown): string {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "0.00";
}

function parseJson(value: string | null): unknown {
  if (!value) return [];
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return [];
  }
}

function parseStringArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.flatMap((item) => typeof item === "string" && item ? [item] : [])
      : [];
  } catch {
    return [];
  }
}

function generateSixDigitCode(): string {
  // Rejection sampling avoids modulo bias and keeps the contract fixed-width.
  const ceiling = Math.floor(0x1_0000_0000 / 900_000) * 900_000;
  const bytes = new Uint32Array(1);
  do crypto.getRandomValues(bytes); while (bytes[0]! >= ceiling);
  return String(100_000 + bytes[0]! % 900_000);
}

export interface UserActivityFlags {
  is_bargin: boolean;
  is_pink: boolean;
  is_seckill: boolean;
}

export interface PaymentCodeStore {
  get(key: string): Promise<string | null>;
  putIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
}

/** User-centre compatibility contracts that do not belong to an order mutation. */
export class UserProfileService {
  private readonly config: SystemConfigService;
  private readonly paymentCodes: PaymentCodeStore;

  constructor(
    private readonly container: Container,
    private readonly env: Env,
    paymentCodes?: PaymentCodeStore,
  ) {
    this.config = new SystemConfigService(container, env);
    this.paymentCodes = paymentCodes ?? {
      get: async (key) => {
        if (!env.UPSTASH_REDIS_URL || !env.UPSTASH_REDIS_TOKEN) {
          throw new ValidateException("付款码服务未配置");
        }
        return cacheGet<string>(key, env);
      },
      putIfAbsent: async (key, value, ttlSeconds) => {
        if (!env.UPSTASH_REDIS_URL || !env.UPSTASH_REDIS_TOKEN) return false;
        return cacheSetIfAbsent(key, value, env, ttlSeconds);
      },
    };
  }

  async activity(now = new Date()): Promise<UserActivityFlags> {
    const bargainGrace = new Date(now.getTime() - 85_400 * 1_000);
    const nowIso = now.toISOString();
    const [bargains, combinations, seckillRows] = await Promise.all([
      this.container.db
        .select({ id: storeBargain.id })
        .from(storeBargain)
        .where(and(
          eq(storeBargain.isDel, 0),
          eq(storeBargain.status, 1),
          lt(storeBargain.startTime, now),
          gt(storeBargain.stopTime, bargainGrace),
        ))
        .limit(1),
      this.container.db
        .select({ id: storeCombination.id })
        .from(storeCombination)
        .where(and(
          eq(storeCombination.isDel, 0),
          eq(storeCombination.isShow, 1),
          eq(storeCombination.status, 1),
          lte(storeCombination.startTime, now),
          gte(storeCombination.stopTime, now),
        ))
        .limit(1),
      this.container.db.execute(sql`
        SELECT EXISTS (
          SELECT 1
          FROM store_seckill AS seckill
          WHERE seckill.is_del = 0
            AND seckill.is_show = 1
            AND seckill.status = 1
            AND seckill.start_time <= ${nowIso}::timestamptz
            AND seckill.stop_time >= ${nowIso}::timestamptz
            AND EXISTS (
              SELECT 1
              FROM store_seckill_time AS slot
              WHERE slot.status = 1
                AND slot.id::text = ANY(string_to_array(seckill.time_id, ','))
                AND to_char(${nowIso}::timestamptz AT TIME ZONE 'Asia/Shanghai', 'HH24MI') >= replace(slot.start_time, ':', '')
                AND to_char(${nowIso}::timestamptz AT TIME ZONE 'Asia/Shanghai', 'HH24MI') < replace(slot.end_time, ':', '')
            )
        ) AS active
      `),
    ]);
    return {
      is_bargin: bargains.length > 0,
      is_pink: combinations.length > 0,
      is_seckill: Boolean(object(seckillRows[0]).active),
    };
  }

  async userInfo(uid: number): Promise<Record<string, unknown>> {
    const account = await this.safeAccount(uid);
    const commission = await new UserFinanceService(this.container, this.env).commission(uid);
    return {
      ...account,
      broken_commission: commission.frozenCommission,
      commissionCount: commission.withdrawable,
    };
  }

  async personalHome(uid: number): Promise<Record<string, unknown>> {
    const account = await this.safeAccount(uid);
    const now = Math.floor(Date.now() / 1_000);
    const configKeys = [
      "member_card_status", "brokerage_func_status", "store_brokerage_statu",
      "store_brokerage_price", "member_func_status", "recharge_switch", "extract_time",
      "balance_func_status", "invoice_func_status", "special_invoice_status",
      "user_extract_bank_status", "user_extract_wechat_status", "user_extract_alipay_status",
      "user_extract_balance_status", "level_activate_status", "video_func_status",
    ];
    const configs = await this.config.getMany(configKeys);
    const [aggregateRows, orderStatusNum, commission, member, agentRows, statusRows] = await Promise.all([
      this.container.db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM store_coupon_user
            WHERE uid = ${uid} AND status = 0 AND is_fail = 0
              AND (end_time IS NULL OR end_time >= CURRENT_TIMESTAMP)) AS coupon_count,
          (SELECT count(*)::int FROM user_relation
            WHERE uid = ${uid} AND type = 'like') AS like_count,
          (SELECT count(*)::int FROM user_relation
            WHERE uid = ${uid} AND type = 'collect' AND category = 'product') AS collect_product_count,
          (SELECT count(*)::int FROM user_relation
            WHERE uid = ${uid} AND type = 'collect' AND category = 'video') AS collect_video_count,
          (SELECT COALESCE(sum(number), 0)::numeric(14,2) FROM user_money
            WHERE uid = ${uid} AND pm = 1 AND status = 1
              AND type IN ('system_add', 'recharge', 'extract', 'lottery_add', 'newcomer_add', 'level_add')) AS recharge,
          (SELECT COALESCE(sum(number), 0)::numeric(14,2) FROM user_money
            WHERE uid = ${uid} AND pm = 0 AND status = 1) AS order_status_sum,
          (SELECT COALESCE(sum(extract_price + extract_fee), 0)::numeric(14,2) FROM user_extract
            WHERE uid = ${uid} AND status = 1) AS extract_total_price,
          (SELECT COALESCE(sum(pay_price), 0)::numeric(14,2) FROM store_order
            WHERE uid = ${uid} AND pid = 0 AND paid = 1 AND is_del = 0
              AND refund_status IN (0, 3)) AS effective_spend,
          (SELECT count(*)::int FROM "user"
            WHERE spread_uid = ${uid} AND is_del = 0) AS spread_user_count,
          (SELECT count(*)::int FROM store_order
            WHERE spread_uid = ${uid} AND type = 0 AND paid = 1 AND refund_status IN (0, 3)
              AND is_del = 0 AND is_system_del = 0) AS spread_order_count,
          (SELECT id FROM store_service
            WHERE uid = ${uid} AND status = 1 AND account_status = 1 AND customer = 1 AND is_del = 0
            ORDER BY id ASC LIMIT 1) AS service_id,
          (SELECT count(DISTINCT product_id)::int FROM store_product_log
            WHERE uid = ${uid} AND type = 'visit' AND delete_time IS NULL) AS visit_num,
          (SELECT count(DISTINCT message.id)::int
            FROM system_message AS message
            LEFT JOIN user_message AS state
              ON state.message_id = message.id AND state.uid = ${uid} AND state.is_read = 1
            WHERE message.status = 1 AND message.is_del = 0
              AND message.user_id IN (0, ${uid}) AND message.look = 0 AND state.id IS NULL) AS service_num,
          (SELECT count(*)::int FROM agent_level WHERE status = 1 AND is_del = 0) AS agent_level_count,
          (SELECT is_complete FROM wechat_user
            WHERE uid = ${uid} AND user_type = ${String(account.user_type ?? "")}
            ORDER BY id DESC LIMIT 1) AS is_complete
      `),
      new LegacyOrderCompatibilityService(this.container, this.env).orderData(uid),
      new UserFinanceService(this.container, this.env).commission(uid),
      this.membership(uid, parseConfigInteger(configs.member_func_status, 0)),
      integer(account.agent_level) > 0
        ? this.container.db.select({ name: agentLevel.name }).from(agentLevel)
          .where(and(eq(agentLevel.id, integer(account.agent_level)), eq(agentLevel.isDel, 0))).limit(1)
        : Promise.resolve([]),
      this.container.db.execute(sql`
        SELECT
          (SELECT status FROM division_apply WHERE uid = ${uid} AND is_del = 0 ORDER BY id DESC LIMIT 1) AS division_status,
          (SELECT status FROM promoter_apply WHERE uid = ${uid} AND is_del = 0 ORDER BY id DESC LIMIT 1) AS promoter_status
      `),
    ]);
    const aggregate = object(aggregateRows[0]);
    const application = object(statusRows[0]);
    const brokerageStatus = parseConfigInteger(configs.store_brokerage_statu, 0);
    const brokerageEnabled = parseConfigInteger(configs.brokerage_func_status, 1) !== 0;
    const effectiveSpend = Number(aggregate.effective_spend ?? 0);
    const promoterThreshold = Number(configs.store_brokerage_price ?? 0);
    const spreadStatus = brokerageEnabled && integer(account.spread_open) !== 0 && (
      integer(account.is_promoter) !== 0 || brokerageStatus === 2 ||
      (brokerageStatus === 3 && effectiveSpend > promoterThreshold)
    );
    const overdue = integer(account.overdue_time);
    const moneyLevel = integer(account.is_money_level) !== 0;
    const everLevel = integer(account.is_ever_level) !== 0;
    const vipStatus = everLevel ? 1 : !moneyLevel && overdue > 0 && overdue < now
      ? -1
      : !moneyLevel && overdue === 0
        ? 2
        : moneyLevel && overdue > now
          ? 3
          : 0;

    return {
      ...account,
      is_open_member: parseConfigInteger(configs.member_card_status, 0) !== 0,
      svip_open: parseConfigInteger(configs.member_card_status, 0) !== 0,
      agent_level_name: agentRows[0]?.name ?? "",
      is_complete: integer(aggregate.is_complete),
      couponCount: integer(aggregate.coupon_count),
      like: integer(aggregate.like_count),
      collectProductCount: integer(aggregate.collect_product_count),
      collectVideoCount: parseConfigInteger(configs.video_func_status, 1)
        ? integer(aggregate.collect_video_count)
        : 0,
      orderStatusNum,
      notice: 0,
      recharge: decimal(aggregate.recharge),
      orderStatusSum: decimal(aggregate.order_status_sum),
      extractTotalPrice: decimal(aggregate.extract_total_price),
      extractPrice: account.brokerage_price,
      statu: brokerageStatus,
      spread_status: spreadStatus,
      promoter_price: brokerageStatus === 3
        ? decimal(Math.max(0, promoterThreshold - effectiveSpend))
        : "0.00",
      broken_commission: commission.frozenCommission,
      commissionCount: commission.withdrawable,
      spread_user_count: integer(aggregate.spread_user_count),
      spread_order_count: integer(aggregate.spread_order_count),
      ...member,
      yesterDay: commission.yesterdayCommission,
      recharge_switch: parseConfigInteger(configs.recharge_switch, 0),
      adminid: integer(aggregate.service_id),
      broken_day: parseConfigInteger(configs.extract_time, 0),
      balance_func_status: parseConfigInteger(configs.balance_func_status, 0),
      invioce_func: parseConfigInteger(configs.invoice_func_status, 0) !== 0,
      special_invoice: parseConfigInteger(configs.invoice_func_status, 0) !== 0 &&
        parseConfigInteger(configs.special_invoice_status, 0) !== 0,
      pay_vip_status: everLevel || (moneyLevel && overdue > now),
      member_style: 0,
      vip_status: vipStatus,
      service_num: integer(aggregate.service_num),
      is_agent_level: brokerageEnabled && integer(aggregate.agent_level_count) > 0,
      visit_num: integer(aggregate.visit_num),
      user_extract_bank_status: parseConfigInteger(configs.user_extract_bank_status, 1),
      user_extract_wechat_status: parseConfigInteger(configs.user_extract_wechat_status, 1),
      user_extract_alipay_status: parseConfigInteger(configs.user_extract_alipay_status, 1),
      user_extract_balance_status: parseConfigInteger(configs.user_extract_balance_status, 1),
      newcomer_status: integer(account.is_newcomer) !== 0,
      level_activate_status: parseConfigInteger(configs.level_activate_status, 0),
      member_func_status: parseConfigInteger(configs.member_func_status, 0),
      register_extend_info: [],
      division_status: application.division_status === null ? -1 : integer(application.division_status),
      promoter_status: application.promoter_status === null ? -1 : integer(application.promoter_status),
    };
  }

  async paymentCode(uid: number): Promise<string> {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户ID错误");
    const key = `user_rand_code${uid}`;
    const existing = await this.paymentCodes.get(key);
    if (existing && /^\d{6}$/.test(existing)) return existing;
    const code = generateSixDigitCode();
    if (await this.paymentCodes.putIfAbsent(key, code, PAYMENT_CODE_TTL_SECONDS)) return code;
    const winner = await this.paymentCodes.get(key);
    if (winner && /^\d{6}$/.test(winner)) return winner;
    throw new ValidateException("付款码暂时不可用");
  }

  async recordShare(uid: number, now = Math.floor(Date.now() / 1_000)): Promise<boolean> {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户ID错误");
    return withTx(this.container, async (tx) => {
      const accounts = await tx.select({ uid: userTable.uid }).from(userTable)
        .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0))).limit(1).for("update");
      if (!accounts[0]) throw new NotFoundException("用户不存在");
      const latest = await tx.select({ addTime: userBill.addTime }).from(userBill)
        .where(and(
          eq(userBill.uid, uid),
          eq(userBill.category, "share"),
          eq(userBill.type, "share"),
          eq(userBill.status, 1),
        ))
        .orderBy(desc(userBill.addTime), desc(userBill.id)).limit(1);
      if (latest[0] && latest[0].addTime > now - SHARE_COOLDOWN_SECONDS) return false;
      await tx.insert(userBill).values({
        uid,
        linkId: "0",
        pm: 0,
        title: "用户分享记录",
        category: "share",
        type: "share",
        eventKey: "user_share",
        number: "0.00",
        balance: "0.00",
        mark: `${new Date(now * 1_000).toISOString()}:用户分享`,
        addTime: now,
        status: 1,
      });
      return true;
    });
  }

  async shareWords(productId: number): Promise<string> {
    if (!Number.isSafeInteger(productId) || productId <= 0) return "";
    const rows = await this.container.db.select({ storeName: storeProduct.storeName })
      .from(storeProduct).where(eq(storeProduct.id, productId)).limit(1);
    if (!rows[0]) throw new NotFoundException("商品不存在");
    const siteName = await this.config.get("site_name");
    return `crmeb-fu致文本 Http:/ZБ${btoa(String(productId))}Б轉移至☞${siteName}☜【${rows[0].storeName}】`;
  }

  async routineCode(uid: number): Promise<string> {
    return await new WechatMiniProgramCodeService(this.container, this.env)
      .createUserSpreadDataUrl(uid) ?? "";
  }

  async spreadInfo(uid: number): Promise<Record<string, unknown>> {
    const [account, configs, groups] = await Promise.all([
      this.safeAccount(uid),
      this.config.getMany(["spread_banner", "site_name"]),
      new PublicCatalogService(this.container, this.env).groupDataMany(["routine_spread_banner"]),
    ]);
    const configured = parseStringArray(configs.spread_banner);
    const spread = configured.length
      ? configured.map((pic) => ({ pic }))
      : groups.routine_spread_banner.map((item) => ({ pic: String(item.pic ?? "") }));
    return {
      spread,
      // Official-account QR generation is channel-specific. Generic API clients do not
      // prove that they run inside WeChat, so preserve PHP's non-WeChat result.
      qrcode: "",
      nickname: account.nickname,
      avatar: account.avatar,
      site_name: configs.site_name ?? "",
    };
  }

  private async safeAccount(uid: number): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户ID错误");
    const rows = await this.container.db.select({
      uid: userTable.uid,
      real_name: userTable.realName,
      birthday: userTable.birthday,
      card_id: userTable.cardId,
      mark: userTable.mark,
      partner_id: userTable.partnerId,
      group_id: userTable.groupId,
      nickname: userTable.nickname,
      avatar: userTable.avatar,
      phone: userTable.phone,
      add_time: userTable.addTime,
      last_time: userTable.lastTime,
      now_money: userTable.nowMoney,
      brokerage_price: userTable.brokeragePrice,
      integral: userTable.integral,
      exp: userTable.exp,
      sign_num: userTable.signNum,
      sign_remind: userTable.signRemind,
      status: userTable.status,
      level: userTable.level,
      agent_level: userTable.agentLevel,
      spread_open: userTable.spreadOpen,
      spread_uid: userTable.spreadUid,
      spread_time: userTable.spreadTime,
      spread_lottery: userTable.spreadLottery,
      work_uid: userTable.workUid,
      work_userid: userTable.workUserid,
      user_type: userTable.userType,
      is_promoter: userTable.isPromoter,
      pay_count: userTable.payCount,
      spread_count: userTable.spreadCount,
      addres: userTable.addres,
      adminid: userTable.adminid,
      login_type: userTable.loginType,
      login_city: userTable.loginCity,
      record_phone: userTable.recordPhone,
      is_money_level: userTable.isMoneyLevel,
      is_ever_level: userTable.isEverLevel,
      overdue_time: userTable.overdueTime,
      bar_code: userTable.barCode,
      sex: userTable.sex,
      provincials: userTable.provincials,
      province: userTable.province,
      city: userTable.city,
      area: userTable.area,
      street: userTable.street,
      extend_info: userTable.extendInfo,
      level_status: userTable.levelStatus,
      level_extend_info: userTable.levelExtendInfo,
      is_first_order: userTable.isFirstOrder,
      is_newcomer: userTable.isNewcomer,
      division_name: userTable.divisionName,
      division_type: userTable.divisionType,
      division_status: userTable.divisionStatus,
      division_id: userTable.divisionId,
      agent_id: userTable.agentId,
      staff_id: userTable.staffId,
      division_percent: userTable.divisionPercent,
      division_end_time: userTable.divisionEndTime,
      division_change_time: userTable.divisionChangeTime,
      division_invite: userTable.divisionInvite,
    }).from(userTable).where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0))).limit(1);
    const account = rows[0];
    if (!account) throw new NotFoundException("用户不存在");
    return {
      ...account,
      extend_info: parseJson(account.extend_info),
      level_extend_info: parseJson(account.level_extend_info),
    };
  }

  private async membership(uid: number, enabled: number): Promise<Record<string, unknown>> {
    if (!enabled) return { vip: false, vip_id: 0, vip_icon: "", vip_name: "", vip_discount: 100 };
    const active = await this.container.db.select({
      id: userLevel.id,
      icon: systemUserLevel.icon,
      name: systemUserLevel.name,
      discount: systemUserLevel.discount,
    }).from(userLevel).innerJoin(systemUserLevel, eq(systemUserLevel.id, userLevel.levelId))
      .where(and(eq(userLevel.uid, uid), eq(userLevel.status, 1), eq(userLevel.isDel, 0)))
      .orderBy(desc(userLevel.grade), desc(userLevel.id)).limit(1);
    const fallback = active.length ? [] : await this.container.db.select({
      icon: systemUserLevel.icon,
      name: systemUserLevel.name,
      discount: systemUserLevel.discount,
    }).from(systemUserLevel).where(and(eq(systemUserLevel.isDel, 0), eq(systemUserLevel.isShow, 1)))
      .orderBy(asc(systemUserLevel.grade), asc(systemUserLevel.id)).limit(1);
    const level = active[0] ?? fallback[0];
    if (!level) return { vip: false, vip_id: 0, vip_icon: "", vip_name: "", vip_discount: 100 };
    return {
      vip: true,
      vip_id: "id" in level ? level.id : 0,
      vip_icon: level.icon,
      vip_name: level.name,
      vip_discount: Number(level.discount ?? 0) / 10,
    };
  }
}
