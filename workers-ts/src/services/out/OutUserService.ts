import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import {
  communityUser,
  outUserWriteReplay,
  systemUserLevel,
  user,
  userBill,
  userFriends,
  userGroup,
  userLabel,
  userLabelRelation,
  userLevel,
  userMoney,
  userSpread,
  wechatUser,
} from "@/models/schema";
import {
  applyRegistrationGifts,
  loadRegistrationState,
} from "@/services/activity/StoreNewcomerService";
import { normalizeOutRequestKey, outRequestHash } from "@/services/out/OutIdempotency";
import type { AuthenticatedOutAccount } from "@/services/out/OutApiService";
import {
  SystemConfigService,
  type SystemConfigEnv,
} from "@/services/system/SystemConfigService";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { md5 } from "@/utils/jwt";

type UnknownRecord = Record<string, unknown>;
type UserWriteOperation = "user_create" | "user_update" | "user_give";
type UserInsert = typeof user.$inferInsert;
type UserRow = typeof user.$inferSelect;

export interface OutUserEnv extends SystemConfigEnv {
  APP_KEY: string;
}

interface FinanceInput {
  moneyStatus: 0 | 1 | 2;
  moneyCents: number;
  integralStatus: 0 | 1 | 2;
  integral: number;
}

interface NormalizedProfile {
  values: Partial<UserInsert>;
  labels?: number[];
  level?: number;
  spreadUid?: number;
  password?: string;
  canonical: UnknownRecord;
}

interface FinanceResult {
  moneyLedgerId: number;
  integralLedgerId: number;
  moneyApplied: string;
  integralApplied: number;
}

const REPLAY_LOCK_NAMESPACE = 744_240_001;
const PHONE_LOCK_NAMESPACE = 744_240_002;
const SPREAD_LOCK_NAMESPACE = 744_240_003;
const LABEL_LOCK_NAMESPACE = 744_240_004;
const MAX_LABELS = 100;
const MAX_EXTEND_INFO_BYTES = 64 * 1024;
const MAX_MONEY_CENTS = 999_999_999_999;
const MAX_INTEGER = 2_147_483_647;

const PROFILE_FIELDS = new Set([
  "is_promoter",
  "real_name",
  "card_id",
  "birthday",
  "mark",
  "status",
  "level",
  "phone",
  "addres",
  "label_id",
  "group_id",
  "pwd",
  "true_pwd",
  "spread_open",
  "sex",
  "provincials",
  "province",
  "city",
  "area",
  "street",
  "extend_info",
]);
const UPDATE_FIELDS = new Set([
  ...PROFILE_FIELDS,
  "spread_uid",
  "money_status",
  "money",
  "integration_status",
  "integration",
]);
const GIVE_FIELDS = new Set([
  "money_status",
  "money",
  "integration_status",
  "integration",
]);

function has(input: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function assertAllowed(input: UnknownRecord, allowed: Set<string>, subject: string): void {
  const unsupported = Object.keys(input).filter((key) => !allowed.has(key)).sort();
  if (unsupported.length) {
    throw new ValidateException(`${subject}字段 ${unsupported.join(",")} 尚未迁移，不能静默丢弃`);
  }
}

function integer(
  value: unknown,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ValidateException(`${label}参数错误`);
  }
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) throw new ValidateException(`${label}参数错误`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidateException(`${label}参数错误`);
  }
  return parsed;
}

function binary(value: unknown, label: string, fallback: 0 | 1): 0 | 1 {
  return integer(value, label, fallback, 0, 1) as 0 | 1;
}

function textValue(value: unknown, label: string, maxLength: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ValidateException(`${label}格式错误`);
  }
  const normalized = String(value).trim().normalize("NFC");
  if ([...normalized].length > maxLength) {
    throw new ValidateException(`${label}长度不能超过${maxLength}个字符`);
  }
  return normalized;
}

function phoneValue(value: unknown): string {
  const phone = textValue(value, "手机号", 15);
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new ValidateException("手机号码格式不正确");
  return phone;
}

function validIdentityCard(value: string): boolean {
  if (!value) return true;
  if (/^\d{15}$/.test(value)) return true;
  if (!/^\d{17}[0-9X]$/.test(value)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = "10X98765432";
  const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0);
  return checks[sum % 11] === value[17];
}

function cardValue(value: unknown): string {
  const card = textValue(value, "身份证", 20).toUpperCase();
  if (!validIdentityCard(card)) throw new ValidateException("请输入正确的身份证");
  return card;
}

function birthdayValue(value: unknown): number {
  if (value === undefined || value === null || value === "" || value === 0 || value === "0") return 0;
  let seconds = 0;
  if (typeof value === "number" || (typeof value === "string" && /^\d{10}$/.test(value.trim()))) {
    seconds = integer(value, "生日", 0, 1, MAX_INTEGER);
  } else if (typeof value === "string") {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw new ValidateException("生日格式必须为 YYYY-MM-DD");
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const monthDays = month >= 1 && month <= 12
      ? new Date(Date.UTC(year, month, 0)).getUTCDate()
      : 0;
    if (year < 1900 || day < 1 || day > monthDays) throw new ValidateException("生日格式错误");
    // CRMEB/PHP production timezone and this deployment are UTC+8.
    seconds = Math.floor((Date.UTC(year, month - 1, day) - 8 * 3_600_000) / 1_000);
  } else {
    throw new ValidateException("生日格式错误");
  }
  if (seconds > Math.floor(Date.now() / 1_000)) throw new ValidateException("生日请选择今天之前日期");
  return seconds;
}

function labelIds(value: unknown): number[] {
  if (value === undefined || value === null || value === "") return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  if (raw.length > MAX_LABELS) throw new ValidateException("用户标签数量超限");
  return [...new Set(raw
    .filter((item) => item !== "" && item !== 0 && item !== "0")
    .map((item) => integer(item, "用户标签", 0, 1, MAX_INTEGER)))]
    .sort((left, right) => left - right);
}

function extendInfoValue(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  let serialized: string;
  if (typeof value === "string") {
    try {
      serialized = JSON.stringify(JSON.parse(value));
    } catch {
      throw new ValidateException("扩展信息必须是有效 JSON");
    }
  } else if (typeof value === "object") {
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new ValidateException("扩展信息无法序列化");
    }
  } else {
    throw new ValidateException("扩展信息格式错误");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_EXTEND_INFO_BYTES) {
    throw new ValidateException("扩展信息过大");
  }
  return serialized;
}

function passwordValue(input: UnknownRecord, create: boolean): string | undefined {
  if (!has(input, "pwd") && !has(input, "true_pwd")) return undefined;
  const password = typeof input.pwd === "string" ? input.pwd : "";
  const confirmation = typeof input.true_pwd === "string" ? input.true_pwd : undefined;
  if (!password) {
    if (confirmation) throw new ValidateException("确认密码不能单独提交");
    return undefined;
  }
  if (password.length < 6 || password.length > 128) {
    throw new ValidateException("密码长度必须为6至128位");
  }
  if (password === "123456") throw new ValidateException("您设置的密码太过简单");
  if (confirmation !== undefined && confirmation !== password) {
    throw new ValidateException("两次输入的密码不一致");
  }
  if (!create && !has(input, "pwd")) return undefined;
  return password;
}

function normalizeProfile(input: UnknownRecord, create: boolean): NormalizedProfile {
  const values: Partial<UserInsert> = {};
  const canonical: UnknownRecord = {};
  const put = <K extends keyof UserInsert>(key: K, value: UserInsert[K], requestName: string) => {
    values[key] = value;
    canonical[requestName] = value;
  };

  const maybe = (key: string) => create || has(input, key);
  if (maybe("is_promoter")) put("isPromoter", binary(input.is_promoter, "推广员状态", 0), "is_promoter");
  if (maybe("real_name")) put("realName", textValue(input.real_name, "真实姓名", 25), "real_name");
  if (maybe("card_id")) put("cardId", cardValue(input.card_id), "card_id");
  if (maybe("birthday")) put("birthday", birthdayValue(input.birthday), "birthday");
  if (maybe("mark")) put("mark", textValue(input.mark, "备注", 255), "mark");
  if (maybe("status")) put("status", binary(input.status, "用户状态", 0), "status");
  if (maybe("phone")) put("phone", phoneValue(input.phone), "phone");
  if (maybe("addres")) put("addres", textValue(input.addres, "详细地址", 255), "addres");
  if (maybe("group_id")) put("groupId", integer(input.group_id, "用户分组", 0, 0, MAX_INTEGER), "group_id");
  if (maybe("spread_open")) put("spreadOpen", binary(input.spread_open, "推广权限", 1), "spread_open");
  if (maybe("sex")) put("sex", integer(input.sex, "性别", 0, 0, 2), "sex");
  if (maybe("provincials")) put("provincials", textValue(input.provincials, "省市区", 255), "provincials");
  for (const [requestName, column] of [
    ["province", "province"],
    ["city", "city"],
    ["area", "area"],
    ["street", "street"],
  ] as const) {
    if (maybe(requestName)) put(column, integer(input[requestName], requestName, 0, 0, MAX_INTEGER), requestName);
  }
  if (maybe("extend_info")) put("extendInfo", extendInfoValue(input.extend_info), "extend_info");

  const labels = create || has(input, "label_id") ? labelIds(input.label_id) : undefined;
  if (labels !== undefined) canonical.label_id = labels;
  const level = create || has(input, "level")
    ? integer(input.level, "会员等级", 0, 0, MAX_INTEGER)
    : undefined;
  if (level !== undefined) canonical.level = level;
  const spreadUid = !create && has(input, "spread_uid")
    ? integer(input.spread_uid, "上级推广人", -1, -1, MAX_INTEGER)
    : undefined;
  if (spreadUid !== undefined) canonical.spread_uid = spreadUid;

  const password = passwordValue(input, create);
  if (password !== undefined) canonical.password = password;
  return { values, labels, level, spreadUid, password, canonical };
}

export function normalizeOutUserCreateInput(input: UnknownRecord): NormalizedProfile {
  assertAllowed(input, PROFILE_FIELDS, "用户");
  if (!has(input, "phone")) throw new ValidateException("手机号不能为空");
  return normalizeProfile(input, true);
}

export function normalizeOutUserUpdateInput(input: UnknownRecord): {
  profile: NormalizedProfile;
  finance: FinanceInput;
} {
  assertAllowed(input, UPDATE_FIELDS, "用户");
  if (!Object.keys(input).length) throw new ValidateException("请至少提交一个修改字段");
  const hasFinance = ["money_status", "money", "integration_status", "integration"]
    .some((key) => has(input, key));
  return {
    profile: normalizeProfile(input, false),
    finance: hasFinance ? normalizeFinance(input, false) : emptyFinance(),
  };
}

export function normalizeOutUserGiveInput(input: UnknownRecord): FinanceInput {
  assertAllowed(input, GIVE_FIELDS, "赠送");
  return normalizeFinance(input, true);
}

function moneyCents(value: unknown, label: string): number {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ValidateException(`${label}格式错误`);
  }
  const text = String(value).trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) throw new ValidateException(`${label}格式错误`);
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > MAX_MONEY_CENTS) {
    throw new ValidateException(`${label}超出范围`);
  }
  return cents;
}

function normalizeFinance(input: UnknownRecord, requireAll: boolean): FinanceInput {
  const keys = ["money_status", "money", "integration_status", "integration"];
  if (requireAll && keys.some((key) => !has(input, key))) {
    throw new ValidateException("赠送接口必须同时提交 money_status、money、integration_status、integration");
  }
  const hasMoney = has(input, "money_status") || has(input, "money");
  const hasIntegral = has(input, "integration_status") || has(input, "integration");
  if (hasMoney && (!has(input, "money_status") || !has(input, "money"))) {
    throw new ValidateException("余额修改类型和金额必须同时提交");
  }
  if (hasIntegral && (!has(input, "integration_status") || !has(input, "integration"))) {
    throw new ValidateException("积分修改类型和数量必须同时提交");
  }
  const moneyStatus = integer(input.money_status, "余额修改类型", 0, 0, 2) as 0 | 1 | 2;
  const amount = moneyCents(input.money, "余额");
  const integralStatus = integer(input.integration_status, "积分修改类型", 0, 0, 2) as 0 | 1 | 2;
  const integral = integer(input.integration, "积分", 0, 0, MAX_INTEGER);
  if ((moneyStatus === 0) !== (amount === 0)) {
    throw new ValidateException("余额为0时修改类型必须为0，非0时修改类型必须为1或2");
  }
  if ((integralStatus === 0) !== (integral === 0)) {
    throw new ValidateException("积分为0时修改类型必须为0，非0时修改类型必须为1或2");
  }
  if (requireAll && moneyStatus === 0 && integralStatus === 0) {
    throw new ValidateException("余额和积分至少修改一项");
  }
  return { moneyStatus, moneyCents: amount, integralStatus, integral };
}

function emptyFinance(): FinanceInput {
  return { moneyStatus: 0, moneyCents: 0, integralStatus: 0, integral: 0 };
}

function centsFromStored(value: string): number {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) {
    throw new ValidateException("用户当前余额异常，请先修复账户数据");
  }
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_MONEY_CENTS) {
    throw new ValidateException("用户当前余额异常，请先修复账户数据");
  }
  return cents;
}

function formatMoney(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

async function passwordFingerprint(password: string, secret: string): Promise<string> {
  if (!secret) throw new Error("APP_KEY is required for user-write request hashing");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(password));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function profileRequestHash(
  operation: UserWriteOperation,
  profile: NormalizedProfile,
  finance: FinanceInput,
  secret: string,
  uid?: number,
): Promise<string> {
  const canonical = { ...profile.canonical };
  if (typeof canonical.password === "string") {
    canonical.password_hmac = await passwordFingerprint(canonical.password, secret);
    delete canonical.password;
  }
  return outRequestHash({ operation, uid: uid ?? 0, profile: canonical, finance });
}

async function replayResult(
  tx: DbClient,
  accountId: number,
  operation: UserWriteOperation,
  key: string,
  hash: string,
) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${REPLAY_LOCK_NAMESPACE}, ${accountId})`);
  const rows = await tx.select().from(outUserWriteReplay).where(and(
    eq(outUserWriteReplay.outAccountId, accountId),
    eq(outUserWriteReplay.operation, operation),
    eq(outUserWriteReplay.requestKey, key),
  )).limit(1);
  const replay = rows[0];
  if (!replay) return undefined;
  if (replay.requestHash !== hash) throw new ValidateException("Idempotency-Key 已用于不同请求");
  return replay;
}

async function recordReplay(
  tx: DbClient,
  accountId: number,
  operation: UserWriteOperation,
  key: string,
  hash: string,
  userId: number,
  finance: FinanceResult,
): Promise<void> {
  await tx.insert(outUserWriteReplay).values({
    outAccountId: accountId,
    operation,
    requestKey: key,
    requestHash: hash,
    userId,
    moneyLedgerId: finance.moneyLedgerId,
    integralLedgerId: finance.integralLedgerId,
    addTime: Math.floor(Date.now() / 1_000),
  });
}

async function lockPhoneDirectory(tx: DbClient): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${PHONE_LOCK_NAMESPACE}, 0)`);
}

async function assertPhoneAvailable(tx: DbClient, phone: string, exceptUid = 0): Promise<void> {
  const rows = await tx.select({ uid: user.uid }).from(user).where(and(
    eq(user.phone, phone),
    eq(user.isDel, 0),
    isNull(user.deleteTime),
    ...(exceptUid > 0 ? [ne(user.uid, exceptUid)] : []),
  )).limit(1).for("share");
  if (rows[0]) throw new ValidateException("该手机号码已被注册");
}

async function assertProfileReferences(tx: DbClient, profile: NormalizedProfile): Promise<void> {
  const groupId = Number(profile.values.groupId ?? 0);
  if (groupId > 0) {
    const groups = await tx.select({ id: userGroup.id }).from(userGroup)
      .where(eq(userGroup.id, groupId)).limit(1).for("share");
    if (!groups[0]) throw new ValidateException("用户分组不存在");
  }
  if (profile.labels?.length) {
    const rows = await tx.select({ id: userLabel.id }).from(userLabel).where(and(
      inArray(userLabel.id, profile.labels),
      eq(userLabel.type, 0),
      eq(userLabel.relationId, 0),
      eq(userLabel.status, 1),
    )).orderBy(userLabel.id).for("share");
    if (rows.length !== profile.labels.length) {
      throw new ValidateException("部分用户标签不存在、已停用或不属于平台");
    }
  }
  if (profile.level && profile.level > 0) {
    const levels = await tx.select({ id: systemUserLevel.id }).from(systemUserLevel).where(and(
      eq(systemUserLevel.id, profile.level),
      eq(systemUserLevel.isDel, 0),
    )).limit(1).for("share");
    if (!levels[0]) throw new ValidateException("会员等级不存在或已删除");
  }
}

async function replaceLabels(tx: DbClient, uid: number, labels: number[]): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${LABEL_LOCK_NAMESPACE}, ${uid})`);
  await tx.delete(userLabelRelation).where(and(
    eq(userLabelRelation.uid, uid),
    eq(userLabelRelation.type, 0),
    eq(userLabelRelation.relationId, 0),
  ));
  if (labels.length) {
    await tx.insert(userLabelRelation).values(labels.map((labelId) => ({
      uid,
      type: 0,
      relationId: 0,
      labelId,
    })));
  }
}

async function setLevel(tx: DbClient, account: UserRow, levelId: number, now: number): Promise<void> {
  if (account.level === levelId) return;
  await tx.update(userLevel).set({ status: 0, isDel: 1 }).where(eq(userLevel.uid, account.uid));
  if (levelId === 0) {
    await tx.update(user).set({ level: 0, exp: "0.00", levelStatus: 0 })
      .where(eq(user.uid, account.uid));
    return;
  }
  const levels = await tx.select().from(systemUserLevel).where(and(
    eq(systemUserLevel.id, levelId),
    eq(systemUserLevel.isDel, 0),
  )).limit(1).for("share");
  const level = levels[0];
  if (!level) throw new ValidateException("会员等级不存在或已删除");
  const existing = await tx.select({ id: userLevel.id }).from(userLevel).where(and(
    eq(userLevel.uid, account.uid),
    eq(userLevel.levelId, levelId),
  )).orderBy(userLevel.id).limit(1).for("update");
  const data = {
    grade: level.grade,
    validTime: 0,
    isForever: level.isForever,
    merId: level.merId,
    status: 1,
    mark: `Out API设置会员等级：${level.name}`.slice(0, 255),
    remind: 0,
    isDel: 0,
    addTime: now,
    discount: Math.round(Number(level.discount)),
  };
  if (existing[0]) {
    await tx.update(userLevel).set(data).where(eq(userLevel.id, existing[0].id));
  } else {
    await tx.insert(userLevel).values({ uid: account.uid, levelId, ...data });
  }
  await tx.update(user).set({
    level: levelId,
    exp: level.expNum.toFixed(2),
    levelStatus: 1,
  }).where(eq(user.uid, account.uid));
}

async function assertNoSpreadCycle(tx: DbClient, uid: number, parentUid: number): Promise<void> {
  let cursor = parentUid;
  const visited = new Set<number>();
  for (let depth = 0; depth < 100; depth++) {
    if (cursor === uid) throw new ValidateException("上级推广人不能为自己或自己的下级");
    if (cursor === 0) return;
    if (visited.has(cursor)) throw new ValidateException("推广关系已有循环，请先修复历史数据");
    visited.add(cursor);
    const rows = await tx.select({ spreadUid: user.spreadUid }).from(user).where(and(
      eq(user.uid, cursor),
      eq(user.isDel, 0),
      isNull(user.deleteTime),
    )).limit(1).for("share");
    if (!rows[0]) throw new ValidateException("上级用户不存在或已删除");
    cursor = rows[0].spreadUid;
  }
  throw new ValidateException("推广关系层级超过安全上限，请先修复历史数据");
}

async function setSpread(
  tx: DbClient,
  account: UserRow,
  parentUid: number,
  now: number,
): Promise<void> {
  if (parentUid === -1 || parentUid === account.spreadUid) return;
  if (parentUid === account.uid) throw new ValidateException("上级推广人不能为自己");
  let parent: UserRow | undefined;
  if (parentUid > 0) {
    await assertNoSpreadCycle(tx, account.uid, parentUid);
    const rows = await tx.select().from(user).where(and(
      eq(user.uid, parentUid),
      eq(user.isDel, 0),
      isNull(user.deleteTime),
    )).limit(1).for("update");
    parent = rows[0];
    if (!parent) throw new ValidateException("上级用户不存在或已删除");
  }
  if (account.spreadUid > 0) {
    await tx.update(user).set({
      spreadCount: sql`GREATEST(${user.spreadCount} - 1, 0)`,
    }).where(eq(user.uid, account.spreadUid));
  }
  if (parent) {
    await tx.update(user).set({ spreadCount: sql`${user.spreadCount} + 1` })
      .where(eq(user.uid, parent.uid));
  }
  await tx.update(user).set({
    spreadUid: parentUid,
    spreadTime: parentUid > 0 ? now : 0,
    divisionId: parent?.divisionId ?? 0,
    agentId: parent?.agentId ?? 0,
    staffId: parent?.staffId ?? 0,
  }).where(eq(user.uid, account.uid));
  if (parent) {
    await tx.insert(userSpread).values({
      uid: account.uid,
      spreadUid: parent.uid,
      spreadTime: now,
      adminId: 0,
    });
    const friendship = await tx.select({ id: userFriends.id }).from(userFriends).where(and(
      eq(userFriends.uid, account.uid),
      eq(userFriends.friendsUid, parent.uid),
    )).limit(1).for("share");
    if (!friendship[0]) {
      await tx.insert(userFriends).values({ uid: account.uid, friendsUid: parent.uid, addTime: now });
    }
  }
}

async function applyFinance(
  tx: DbClient,
  account: UserRow,
  finance: FinanceInput,
  requestKey: string,
  now: number,
): Promise<FinanceResult> {
  const result: FinanceResult = {
    moneyLedgerId: 0,
    integralLedgerId: 0,
    moneyApplied: "0.00",
    integralApplied: 0,
  };
  const linkId = requestKey.replaceAll("-", "");
  let currentMoney = centsFromStored(account.nowMoney);
  let currentIntegral = account.integral;
  if (!Number.isSafeInteger(currentIntegral) || currentIntegral < 0) {
    throw new ValidateException("用户当前积分异常，请先修复账户数据");
  }

  if (finance.moneyStatus !== 0) {
    const applied = finance.moneyStatus === 1
      ? finance.moneyCents
      : Math.min(finance.moneyCents, currentMoney);
    const next = finance.moneyStatus === 1 ? currentMoney + applied : currentMoney - applied;
    if (!Number.isSafeInteger(next) || next < 0 || next > MAX_MONEY_CENTS) {
      throw new ValidateException("余额变更后超出数据库范围");
    }
    if (applied > 0) {
      await tx.update(user).set({ nowMoney: formatMoney(next) }).where(eq(user.uid, account.uid));
      const added = await tx.insert(userMoney).values({
        uid: account.uid,
        linkId,
        type: finance.moneyStatus === 1 ? "system_add" : "system_sub",
        title: finance.moneyStatus === 1 ? "系统增加余额" : "系统减少余额",
        number: formatMoney(applied),
        balance: formatMoney(next),
        pm: finance.moneyStatus === 1 ? 1 : 0,
        mark: `${finance.moneyStatus === 1 ? "系统增加" : "系统减少"}${formatMoney(applied)}余额`,
        status: 1,
        addTime: now,
      }).returning({ id: userMoney.id });
      result.moneyLedgerId = added[0]?.id ?? 0;
      result.moneyApplied = `${finance.moneyStatus === 1 ? "" : "-"}${formatMoney(applied)}`;
      currentMoney = next;
    }
  }

  if (finance.integralStatus !== 0) {
    const applied = finance.integralStatus === 1
      ? finance.integral
      : Math.min(finance.integral, currentIntegral);
    const next = finance.integralStatus === 1 ? currentIntegral + applied : currentIntegral - applied;
    if (!Number.isSafeInteger(next) || next < 0 || next > MAX_INTEGER) {
      throw new ValidateException("积分变更后超出数据库范围");
    }
    if (applied > 0) {
      await tx.update(user).set({ integral: next }).where(eq(user.uid, account.uid));
      const added = await tx.insert(userBill).values({
        uid: account.uid,
        linkId,
        pm: finance.integralStatus === 1 ? 1 : 0,
        title: finance.integralStatus === 1 ? "系统增加积分" : "系统减少积分",
        category: "integral",
        type: finance.integralStatus === 1 ? "system_add" : "system_sub",
        eventKey: finance.integralStatus === 1
          ? "out_system_add_integral"
          : "out_system_sub_integral",
        number: applied.toFixed(2),
        balance: next.toFixed(2),
        mark: `${finance.integralStatus === 1 ? "系统增加" : "系统减少"}${applied}积分`,
        addTime: now,
        status: 1,
      }).returning({ id: userBill.id });
      result.integralLedgerId = added[0]?.id ?? 0;
      result.integralApplied = finance.integralStatus === 1 ? applied : -applied;
      currentIntegral = next;
    }
  }
  return result;
}

function noFinanceResult(): FinanceResult {
  return { moneyLedgerId: 0, integralLedgerId: 0, moneyApplied: "0.00", integralApplied: 0 };
}

function replayResponse(replay: typeof outUserWriteReplay.$inferSelect) {
  return {
    uid: replay.userId,
    money_ledger_id: replay.moneyLedgerId,
    integral_ledger_id: replay.integralLedgerId,
    idempotent: true,
  };
}

function isActivePhoneViolation(error: unknown): boolean {
  const record = error as { code?: string; constraint_name?: string; constraint?: string };
  return record?.code === "23505"
    && [record.constraint_name, record.constraint].includes("user_active_phone_uq");
}

export class OutUserService {
  constructor(
    private readonly container: Container,
    private readonly env: OutUserEnv,
  ) {}

  async create(
    account: AuthenticatedOutAccount,
    input: UnknownRecord,
    requestKeyValue: unknown,
  ) {
    const profile = normalizeOutUserCreateInput(input);
    const phone = String(profile.values.phone ?? "");
    const key = normalizeOutRequestKey(requestKeyValue);
    const operation: UserWriteOperation = "user_create";
    const hash = await profileRequestHash(operation, profile, emptyFinance(), this.env.APP_KEY);
    const [registration, configuredAvatar] = await Promise.all([
      loadRegistrationState(this.container, this.env),
      new SystemConfigService(this.container, this.env).get("h5_avatar"),
    ]);
    const avatar = [...configuredAvatar].length <= 256 ? configuredAvatar : "";
    try {
      return await withTx(this.container, async (tx) => {
        const replay = await replayResult(tx, account.id, operation, key, hash);
        if (replay) return replayResponse(replay);
        await lockPhoneDirectory(tx);
        await assertPhoneAvailable(tx, phone);
        await assertProfileReferences(tx, profile);
        const now = Math.floor(Date.now() / 1_000);
        const inserted = await tx.insert(user).values({
          ...profile.values,
          account: phone,
          pwd: profile.password
            ? md5(profile.password)
            : md5(`${crypto.randomUUID()}${crypto.randomUUID()}`),
          nickname: `${phone.slice(0, 3)}****${phone.slice(7)}`,
          avatar,
          userType: "h5",
          addTime: now,
          isFirstOrder: registration.flags.isFirstOrder,
          isNewcomer: registration.flags.isNewcomer,
          level: 0,
        }).returning();
        const created = inserted[0];
        if (!created) throw new Error("新增用户失败");
        if (profile.labels !== undefined) await replaceLabels(tx, created.uid, profile.labels);
        if (profile.level !== undefined) await setLevel(tx, created, profile.level, now);
        const gifts = await applyRegistrationGifts(tx, created.uid, registration.gifts, now);
        await tx.insert(communityUser).values({
          type: 2,
          relationId: created.uid,
          nickname: created.nickname,
          avatar: created.avatar,
          status: 1,
          isDel: 0,
          addTime: now,
        });
        const finance = noFinanceResult();
        await recordReplay(tx, account.id, operation, key, hash, created.uid, finance);
        return { uid: created.uid, gifts, idempotent: false };
      });
    } catch (error) {
      if (isActivePhoneViolation(error)) throw new ValidateException("该手机号码已被注册");
      throw error;
    }
  }

  async update(
    account: AuthenticatedOutAccount,
    uidValue: unknown,
    input: UnknownRecord,
    requestKeyValue: unknown,
  ) {
    const uid = integer(uidValue, "用户ID", 0, 1, MAX_INTEGER);
    const { profile, finance } = normalizeOutUserUpdateInput(input);
    const key = normalizeOutRequestKey(requestKeyValue);
    const operation: UserWriteOperation = "user_update";
    const hash = await profileRequestHash(operation, profile, finance, this.env.APP_KEY, uid);
    try {
      return await withTx(this.container, async (tx) => {
        const replay = await replayResult(tx, account.id, operation, key, hash);
        if (replay) return replayResponse(replay);
        if (profile.spreadUid !== undefined && profile.spreadUid !== -1) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${SPREAD_LOCK_NAMESPACE}, 0)`);
        }
        if (profile.values.phone !== undefined) await lockPhoneDirectory(tx);
        const rows = await tx.select().from(user).where(and(
          eq(user.uid, uid),
          eq(user.isDel, 0),
          isNull(user.deleteTime),
        )).limit(1).for("update");
        const current = rows[0];
        if (!current) throw new NotFoundException("用户不存在");
        if (profile.values.phone !== undefined) {
          await assertPhoneAvailable(tx, String(profile.values.phone), uid);
        }
        await assertProfileReferences(tx, profile);
        const now = Math.floor(Date.now() / 1_000);
        const patch: Partial<UserInsert> = { ...profile.values };
        if (profile.password) patch.pwd = md5(profile.password);
        if (profile.values.phone !== undefined
          && (current.account === current.phone || current.account === "")) {
          patch.account = String(profile.values.phone);
        }
        if (Object.keys(patch).length) {
          await tx.update(user).set(patch).where(eq(user.uid, uid));
        }
        if (profile.labels !== undefined) await replaceLabels(tx, uid, profile.labels);
        if (profile.level !== undefined) await setLevel(tx, current, profile.level, now);
        if (profile.spreadUid !== undefined) await setSpread(tx, current, profile.spreadUid, now);
        if (profile.values.sex !== undefined) {
          await tx.update(wechatUser).set({ sex: Number(profile.values.sex) })
            .where(eq(wechatUser.uid, uid));
        }
        const applied = await applyFinance(tx, current, finance, key, now);
        await recordReplay(tx, account.id, operation, key, hash, uid, applied);
        return {
          uid,
          money_ledger_id: applied.moneyLedgerId,
          integral_ledger_id: applied.integralLedgerId,
          money_applied: applied.moneyApplied,
          integral_applied: applied.integralApplied,
          idempotent: false,
        };
      });
    } catch (error) {
      if (isActivePhoneViolation(error)) throw new ValidateException("该手机号码已被注册");
      throw error;
    }
  }

  async give(
    account: AuthenticatedOutAccount,
    uidValue: unknown,
    input: UnknownRecord,
    requestKeyValue: unknown,
  ) {
    const uid = integer(uidValue, "用户ID", 0, 1, MAX_INTEGER);
    const finance = normalizeOutUserGiveInput(input);
    const key = normalizeOutRequestKey(requestKeyValue);
    const operation: UserWriteOperation = "user_give";
    const hash = await outRequestHash({ operation, uid, finance });
    return withTx(this.container, async (tx) => {
      const replay = await replayResult(tx, account.id, operation, key, hash);
      if (replay) return replayResponse(replay);
      const rows = await tx.select().from(user).where(and(
        eq(user.uid, uid),
        eq(user.isDel, 0),
        isNull(user.deleteTime),
      )).limit(1).for("update");
      const current = rows[0];
      if (!current) throw new NotFoundException("用户不存在");
      const now = Math.floor(Date.now() / 1_000);
      const applied = await applyFinance(tx, current, finance, key, now);
      await recordReplay(tx, account.id, operation, key, hash, uid, applied);
      return {
        uid,
        money_ledger_id: applied.moneyLedgerId,
        integral_ledger_id: applied.integralLedgerId,
        money_applied: applied.moneyApplied,
        integral_applied: applied.integralApplied,
        idempotent: false,
      };
    });
  }
}
