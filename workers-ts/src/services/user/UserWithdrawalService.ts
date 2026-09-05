import { and, eq, isNull, sql } from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { user, userBrokerage, userExtract, userMoney, userRecharge } from "@/models/schema";
import { normalizeConfigScalar, parseConfigInteger } from "@/utils/config";
import { ApiException, NotFoundException, ValidateException } from "@/utils/errors";
import { centsToDecimal, decimalToCents } from "@/services/order/OrderBrokerageService";

export const WITHDRAWAL_CONFIG_KEYS = [
  "user_extract_min_price", "user_extract_max_price", "withdraw_fee", "brokerage_type", "user_extract_balance_status",
] as const;

export interface WithdrawalInput {
  extractType: string;
  extractPrice: string;
  realName: string;
  extractNumber: string;
  bankName?: string;
  bankCode?: string;
  bankAddress?: string;
  alipayCode?: string;
  wechat?: string;
  qrcodeUrl?: string;
  requestKey?: string;
}

function textField(value: unknown, maximum: number, label: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number") throw new ValidateException(`${label}格式错误`);
  const valueText = String(value).trim();
  if (/[\u0000-\u001f\u007f]/u.test(valueText) || Array.from(valueText).length > maximum) {
    throw new ValidateException(`${label}格式或长度错误`);
  }
  return valueText;
}

/** Monetary inputs must be exact decimal cents, never rounded, exponent-form or NaN. */
export function withdrawalCents(value: string, label = "提现金额"): number {
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) throw new ValidateException(`${label}格式错误`);
  return decimalToCents(value);
}

export function normalizeWithdrawalBody(raw: Record<string, unknown>, headerKey?: string): WithdrawalInput {
  const alias = (current: string, legacy: string): unknown => {
    if (raw[current] !== undefined && raw[legacy] !== undefined && String(raw[current]) !== String(raw[legacy])) {
      throw new ValidateException(`${current}/${legacy}参数冲突`);
    }
    return raw[current] ?? raw[legacy];
  };
  const key = textField(raw.request_id, 96, "请求标识");
  if (headerKey && key && headerKey !== key) throw new ValidateException("请求标识冲突");
  return {
    extractType: textField(raw.extract_type, 32, "提现方式"),
    extractPrice: textField(alias("extract_price", "money"), 32, "提现金额"),
    realName: textField(alias("real_name", "name"), 64, "姓名"),
    extractNumber: textField(raw.extract_number, 64, "收款账号"),
    bankName: textField(alias("bank_name", "bankname"), 64, "银行名称"),
    bankCode: textField(alias("bank_code", "cardnum"), 64, "银行卡号"),
    bankAddress: textField(raw.bank_address, 256, "开户行"),
    alipayCode: textField(raw.alipay_code, 64, "支付宝账号"),
    wechat: textField(alias("wechat", "weixin"), 64, "微信账号"),
    qrcodeUrl: textField(raw.qrcode_url, 255, "收款码"),
    requestKey: headerKey || key,
  };
}

function normalizedInput(params: WithdrawalInput) {
  const extractType = params.extractType === "wx" ? "weixin" : params.extractType;
  if (!["bank", "alipay", "weixin", "balance"].includes(extractType)) throw new ValidateException("提现方式错误");
  const amountCents = withdrawalCents(params.extractPrice);
  if (amountCents <= 0) throw new ValidateException("提现金额必须大于0");
  const requestKey = textField(params.requestKey, 96, "请求标识");
  if (requestKey && !/^[A-Za-z0-9_-]{16,96}$/.test(requestKey)) throw new ValidateException("请求标识格式错误");
  const bankCode = textField(params.bankCode || (extractType === "bank" ? params.extractNumber : ""), 64, "银行卡号");
  const bankName = textField(params.bankName, 64, "银行名称");
  const bankAddress = textField(params.bankAddress || bankName, 256, "开户行");
  const alipayCode = textField(params.alipayCode || (extractType === "alipay" ? params.extractNumber : ""), 64, "支付宝账号");
  const wechat = textField(params.wechat || (extractType === "weixin" ? params.extractNumber : ""), 64, "微信账号");
  const realName = textField(params.realName, 64, "姓名");
  const qrcodeUrl = textField(params.qrcodeUrl, 255, "收款码");
  if (qrcodeUrl && !/^\/(?!\/)/.test(qrcodeUrl)) {
    try {
      const parsed = new URL(qrcodeUrl);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error();
    } catch { throw new ValidateException("收款码地址不安全"); }
  }
  if (qrcodeUrl.includes("\\")) throw new ValidateException("收款码地址不安全");
  if (extractType === "bank" && (!/^[1-9](?:\d{15}|\d{16}|\d{18})$/.test(bankCode) || !bankAddress)) {
    throw new ValidateException("请填写正确银行卡号及开户行");
  }
  if (extractType === "alipay" && !alipayCode) throw new ValidateException("请填写支付宝账号");
  return { extractType, amountCents, requestKey, realName, bankCode, bankName, bankAddress, alipayCode, wechat, qrcodeUrl };
}

export function withdrawalPolicy(config: Record<string, string>, amountCents: number, extractType: string) {
  const minimum = withdrawalCents(normalizeConfigScalar(config.user_extract_min_price) || "0", "最低提现额");
  const maximum = withdrawalCents(normalizeConfigScalar(config.user_extract_max_price) || "0", "最高提现额");
  if (maximum <= 0 || maximum < minimum) throw new ValidateException("提现限额尚未配置完成");
  if (amountCents < minimum) throw new ValidateException(`提现金额不能小于${centsToDecimal(minimum)}元`);
  if (amountCents > maximum) throw new ValidateException(`提现金额不能大于${centsToDecimal(maximum)}元`);
  if (extractType === "balance" && parseConfigInteger(config.user_extract_balance_status, 1) !== 1) {
    throw new ValidateException("余额提现未开启");
  }
  const rate = normalizeConfigScalar(config.withdraw_fee) || "0";
  if (!/^\d{1,3}(?:\.\d{1,6})?$/.test(rate) || Number(rate) >= 100) throw new ValidateException("提现手续费配置错误");
  const [whole, fraction = ""] = rate.split(".");
  // PHP bcdiv(percent,100,4), then bcmul(gross,ratio,2): truncate, not round.
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
  const feeCents = extractType === "balance" ? 0 : Number(BigInt(amountCents) * BigInt(basisPoints) / 10_000n);
  const netCents = amountCents - feeCents;
  if (netCents <= 0) throw new ValidateException("扣除手续费后金额必须大于0");
  const automaticWechat = parseConfigInteger(config.brokerage_type, 0) === 1;
  if (extractType === "weixin" && automaticWechat && netCents < 100) throw new ValidateException("自动微信提现到账金额不能小于1元");
  return { feeCents, netCents, automaticWechat };
}

async function fingerprint(uid: number, input: ReturnType<typeof normalizedInput>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ uid, ...input, requestKey: undefined }));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (v) => v.toString(16).padStart(2, "0")).join("");
}

async function transactionBounds(tx: DbClient) {
  await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
  await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
}

export class UserWithdrawalService {
  constructor(private readonly container: Container) {}

  async apply(uid: number, params: WithdrawalInput): Promise<{ id: number }> {
    const input = normalizedInput(params);
    const hash = input.requestKey ? await fingerprint(uid, input) : "";
    // Read authoritative DB settings, not potentially stale KV. No provider I/O while holding locks.
    const config = await this.container.systemConfigDao.getValues([...WITHDRAWAL_CONFIG_KEYS]);
    return withTx(this.container, async (tx) => {
      await transactionBounds(tx);
      const [account] = await tx.select().from(user).where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime))).limit(1).for("update");
      if (!account) throw new NotFoundException("用户不存在或已被禁用");
      if (input.requestKey) {
        const [previous] = await tx.select({ id: userExtract.id, hash: userExtract.requestHash }).from(userExtract)
          .where(and(eq(userExtract.uid, uid), eq(userExtract.requestKey, input.requestKey))).limit(1);
        if (previous) {
          // Not an uncommitted validation failure: an earlier intent already exists.
          if (previous.hash !== hash) throw new ApiException("同一请求标识不能修改提现信息，请先查询原申请", 409);
          return { id: previous.id };
        }
      }
      const { feeCents, netCents, automaticWechat } = withdrawalPolicy(config, input.amountCents, input.extractType);
      if (input.extractType === "weixin" && !automaticWechat && !input.wechat) throw new ValidateException("请填写微信账号");
      const [frozen] = await tx.select({ total: sql<string>`greatest(coalesce(sum(${userBrokerage.number}),0),0)::text` })
        .from(userBrokerage).where(and(eq(userBrokerage.uid, uid), eq(userBrokerage.pm, 1), eq(userBrokerage.status, 1), sql`${userBrokerage.frozenTime} > ${Math.floor(Date.now() / 1_000)}`));
      const remaining = decimalToCents(account.brokeragePrice) - input.amountCents;
      if (remaining < decimalToCents(frozen?.total ?? "0")) throw new ValidateException("可提现佣金不足");
      const now = Math.floor(Date.now() / 1_000);
      const isBalance = input.extractType === "balance";
      const [request] = await tx.insert(userExtract).values({
        uid, extractType: input.extractType, realName: input.realName || account.nickname,
        bankName: input.bankName, bankAddress: input.bankAddress, bankCode: input.bankCode,
        alipayCode: input.alipayCode, wechat: input.wechat, qrcodeUrl: input.qrcodeUrl,
        extractNumber: input.extractType === "bank" ? input.bankCode : input.extractType === "alipay" ? input.alipayCode : input.wechat,
        extractPrice: centsToDecimal(netCents), extractFee: centsToDecimal(feeCents),
        balance: account.brokeragePrice, status: isBalance ? 1 : 0, addTime: now,
        mark: `提现方式: ${input.extractType}`, requestKey: input.requestKey, requestHash: hash,
      }).returning({ id: userExtract.id });
      if (!request) throw new Error("提现记录创建失败");
      const brokeragePrice = centsToDecimal(remaining);
      let nowMoney = account.nowMoney;
      if (isBalance) {
        nowMoney = centsToDecimal(decimalToCents(account.nowMoney) + netCents);
        const [recharge] = await tx.insert(userRecharge).values({
          uid, orderId: `wxextract${request.id}`, price: centsToDecimal(netCents), givePrice: "0.00",
          rechargeType: "balance", paid: 1, payTime: now, addTime: now, channelType: account.userType,
        }).returning({ id: userRecharge.id });
        if (!recharge) throw new Error("余额入账记录创建失败");
        await tx.insert(userMoney).values({
          uid, linkId: String(recharge.id), type: "extract", title: "佣金提现到余额", pm: 1,
          number: centsToDecimal(netCents), balance: nowMoney, status: 1, addTime: now,
          mark: `提现申请 #${request.id} 转入余额`,
        });
      }
      await tx.update(user).set({ brokeragePrice, nowMoney }).where(eq(user.uid, uid));
      await tx.insert(userBrokerage).values({
        uid, linkId: String(request.id), pm: 0, type: "extract", category: "extract", title: "佣金提现",
        number: centsToDecimal(input.amountCents), balance: brokeragePrice, status: 1, addTime: now,
        mark: `提现申请 #${request.id}`,
      });
      return { id: request.id };
    });
  }

  /** Manual review, not an external payout. Reject restores gross with a compensating credit. */
  async review(id: number, status: number, message: unknown = "") {
    if (!Number.isSafeInteger(id) || id <= 0 || ![1, 2, -1].includes(status)) throw new ValidateException("审核参数错误");
    const rejected = status === 2 || status === -1;
    const finalStatus = rejected ? -1 : 1;
    const failMsg = textField(message, 255, "拒绝原因") || "审核拒绝";
    const [initial] = await this.container.db.select({ uid: userExtract.uid }).from(userExtract).where(eq(userExtract.id, id)).limit(1);
    if (!initial) throw new NotFoundException("提现记录不存在");
    const config = await this.container.systemConfigDao.getValues(["brokerage_type"]);
    return withTx(this.container, async (tx) => {
      await transactionBounds(tx);
      // Same order as apply: user first, request second. Prevent apply/review deadlocks.
      const [account] = await tx.select().from(user).where(eq(user.uid, initial.uid)).limit(1).for("update");
      if (!account) throw new NotFoundException("提现用户不存在，需人工核对");
      const [request] = await tx.select().from(userExtract).where(and(eq(userExtract.id, id), eq(userExtract.uid, account.uid))).limit(1).for("update");
      if (!request) throw new NotFoundException("提现记录不存在");
      if (request.status === finalStatus) return { id, replayed: true };
      if (request.status !== 0) throw new ValidateException("提现记录已审核，不可改变结果");
      if (!rejected && request.extractType === "weixin" && parseConfigInteger(config.brokerage_type, 0) === 1) {
        throw new ValidateException("自动微信提现渠道尚未完成打款接入，不能标记成功");
      }
      if (!["bank", "alipay", "weixin"].includes(request.extractType)) throw new ValidateException("非标准提现记录需人工核对");
      const debitWhere = and(eq(userBrokerage.uid, account.uid), eq(userBrokerage.linkId, String(id)), eq(userBrokerage.pm, 0), eq(userBrokerage.type, "extract"));
      const debits = await tx.select().from(userBrokerage).where(debitWhere);
      const gross = decimalToCents(request.extractPrice) + decimalToCents(request.extractFee);
      if (gross <= 0 || debits.length !== 1 || decimalToCents(debits[0].number) !== gross || ![0, 1].includes(debits[0].status)) {
        throw new ValidateException("提现账本不一致，需人工核对");
      }
      const now = Math.floor(Date.now() / 1_000);
      // Old candidate requests used status=0; normalize only this proven, ownership-scoped debit.
      await tx.update(userBrokerage).set({ status: 1 }).where(debitWhere);
      if (rejected) {
        const brokeragePrice = centsToDecimal(decimalToCents(account.brokeragePrice) + gross);
        await tx.update(user).set({ brokeragePrice }).where(eq(user.uid, account.uid));
        await tx.insert(userBrokerage).values({
          uid: account.uid, linkId: String(id), pm: 1, category: "extract", type: "extract_fail",
          title: "提现失败退回佣金", number: centsToDecimal(gross), balance: brokeragePrice,
          mark: failMsg, status: 1, addTime: now,
        });
      }
      await tx.update(userExtract).set({ status: finalStatus, failMsg: rejected ? failMsg : "", failTime: rejected ? now : 0 }).where(eq(userExtract.id, id));
      return { id, replayed: false };
    });
  }
}
