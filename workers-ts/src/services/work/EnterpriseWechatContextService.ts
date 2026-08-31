import { SignJWT, jwtVerify } from "jose";
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Env } from "@/env";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderRefund,
  storeProduct,
  storeVisit,
  user,
  userGroup,
  userLabel,
  userLabelRelation,
  workClient,
  workClientCurrent,
  workClientFollow,
  workClientFollowCurrent,
  workClientFollowProjectionFence,
  workClientFollowTagCurrent,
  workClientFollowTags,
  workClientProjectionFence,
  workCallbackEvent,
  workGroupChat,
  workGroupChatMember,
  workMember,
  workMemberCurrent,
  workMemberIdentityAlias,
} from "@/models/schema";
import { parseKefuPageLimit } from "@/services/kefu/KefuCoreService";
import {
  orderProjection,
  parseKefuOrderPage,
  parseKefuOrderStatus,
  refundProjection,
} from "@/services/kefu/KefuOrderService";
import { signAttachmentReferences } from "@/services/system/AttachmentService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import {
  EnterpriseWechatJsSdkService,
  normalizeEnterpriseWechatSignedUrl,
} from "@/services/work/EnterpriseWechatJsSdkService";
import { isEnterpriseWechatCorpId } from "@/services/work/EnterpriseWechatProviderClient";
import { cacheSetIfAbsent, cacheTake } from "@/utils/cache";
import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  ValidateException,
} from "@/utils/errors";

const STATE_TTL_SECONDS = 5 * 60;
const TOKEN_TTL_SECONDS = 5 * 60;
const TOKEN_ISSUER = "cinashop-work-context";
const MAX_QUERY_TEXT = 100;
const MAX_PAGE = 1_000_000;
const MAX_CURRENT_FOLLOW_TAGS = 256;
const CUSTOMER_ORDER_REFUND_TYPES = [0, 1, 3, 6] as const;
const ACTIVE_REFUND_TYPES = [0, 1, 2, 4, 5] as const;

export type WorkContextAudience = "work-client" | "work-group";
export type WorkContextTarget =
  | { type: "client"; externalUserid: string }
  | { type: "group"; chatId: string };

export interface WorkContextState {
  verifierHash: string;
  origin: string;
  expiresAt: number;
}

export interface WorkContextStateStore {
  putOnce(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
  take<T>(key: string): Promise<T | null>;
}

interface EmployeeIdentityProvider {
  employeeIdentity(code: string): Promise<{ corpId: string; agentId: number; userid: string }>;
}

export interface WorkContextDependencies {
  stateStore?: WorkContextStateStore;
  identityProvider?: EmployeeIdentityProvider;
  now?: () => number;
}

type ClientProjectionSource = "legacy" | "current";

interface ScopedClient {
  id: number;
  externalUserid: string;
  uid: number;
  name: string;
  avatar: string;
  type: number;
  gender: number;
  position: string;
  corpName: string;
  remark: string;
}

interface ScopedFollow {
  id: number | null;
  clientId: number;
  userid: string;
  remark: string;
}

interface ClientScope {
  actorUserid: string;
  corpId: string;
  source: ClientProjectionSource;
  client: ScopedClient;
  follow: ScopedFollow;
  tags: Array<{ group_name: string | null; tag_name: string }>;
}

interface GroupClientProjection {
  client: ScopedClient;
  tags: string[];
}

interface GroupScope {
  actorUserid: string;
  corpId: string;
  group: typeof workGroupChat.$inferSelect;
}

interface WorkContextClaims {
  kind: "client" | "group";
  corpId: string;
  actorUserid: string;
  targetId: number;
  uid: number;
  clientProjectionSource?: ClientProjectionSource;
}

function randomHex(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(value, (part) => part.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("");
}

function validOpaqueIdentifier(value: unknown, label: string, maximum = 128): string {
  if (typeof value !== "string") throw new ValidateException(`${label}无效`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\s\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ValidateException(`${label}无效`);
  }
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new ValidateException(`${label}错误`);
  }
  return parsed;
}

function page(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  const parsed = positiveInteger(value, "页码");
  if (parsed > MAX_PAGE) throw new ValidateException("页码错误");
  return parsed;
}

function queryText(value: unknown, label = "搜索词"): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new ValidateException(`${label}错误`);
  const normalized = value.trim();
  if (normalized.length > MAX_QUERY_TEXT || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ValidateException(`${label}不能超过${MAX_QUERY_TEXT}个可见字符`);
  }
  return normalized;
}

function epoch(value: number): string {
  if (!value) return "";
  const date = new Date((value + 8 * 60 * 60) * 1_000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function orderStatusConditions(status: number | null): SQL[] {
  if (status === null) return [];
  switch (status) {
    case 0: return [eq(storeOrder.paid, 0), eq(storeOrder.status, 0), eq(storeOrder.refundStatus, 0)];
    case 1: return [eq(storeOrder.paid, 1), inArray(storeOrder.status, [0, 4]), inArray(storeOrder.refundStatus, [0, 3]), inArray(storeOrder.shippingType, [1, 3])];
    case 2: return [eq(storeOrder.paid, 1), or(
      and(inArray(storeOrder.status, [1, 5]), eq(storeOrder.shippingType, 1)),
      and(inArray(storeOrder.status, [0, 5]), eq(storeOrder.shippingType, 2)),
    )!, inArray(storeOrder.refundStatus, [0, 3])];
    case 3: return [eq(storeOrder.paid, 1), eq(storeOrder.status, 2), inArray(storeOrder.refundStatus, [0, 3])];
    case 4: return [eq(storeOrder.paid, 1), eq(storeOrder.status, 3), inArray(storeOrder.refundStatus, [0, 3])];
    case -1: return [eq(storeOrder.paid, 1), inArray(storeOrder.refundStatus, [1, 4])];
    case -2: return [eq(storeOrder.paid, 1), eq(storeOrder.refundStatus, 2)];
    case -3: return [eq(storeOrder.paid, 1), inArray(storeOrder.refundStatus, [1, 2, 4])];
    default: return [];
  }
}

function redisStateStore(env: Env): WorkContextStateStore {
  const available = () => {
    if (!env.UPSTASH_REDIS_URL || !env.UPSTASH_REDIS_TOKEN) {
      throw new ServiceUnavailableException("企业微信上下文状态存储尚未配置");
    }
  };
  return {
    async putOnce(key, value, ttlSeconds) {
      available();
      try {
        return await cacheSetIfAbsent(key, value, env, ttlSeconds);
      } catch {
        throw new ServiceUnavailableException("企业微信上下文状态存储暂时不可用");
      }
    },
    async take<T>(key: string) {
      available();
      try {
        return await cacheTake<T>(key, env);
      } catch {
        throw new ServiceUnavailableException("企业微信上下文状态存储暂时不可用");
      }
    },
  };
}

/** Work-browser origins are exact HTTPS origins and never fall back to ALLOWED_ORIGINS. */
export function requireEnterpriseWechatOrigin(
  rawOrigin: string,
  allowedOrigins: string | undefined,
): string {
  const value = rawOrigin.trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ForbiddenException("请求来源未进入企业微信白名单");
  }
  if (value !== parsed.origin) throw new ForbiddenException("请求来源未进入企业微信白名单");
  normalizeEnterpriseWechatSignedUrl(`${parsed.origin}/`, allowedOrigins);
  return parsed.origin;
}

export class EnterpriseWechatContextService {
  private readonly stateStore: WorkContextStateStore;
  private readonly identityProvider: EmployeeIdentityProvider;
  private readonly now: () => number;

  constructor(
    private readonly container: Container,
    private readonly env: Env,
    dependencies: WorkContextDependencies = {},
  ) {
    this.stateStore = dependencies.stateStore ?? redisStateStore(env);
    this.identityProvider = dependencies.identityProvider
      ?? new EnterpriseWechatJsSdkService(container, env);
    this.now = dependencies.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  async challenge(rawOrigin: string, rawRedirectUri: string) {
    const origin = requireEnterpriseWechatOrigin(rawOrigin, this.env.WORK_WECHAT_ALLOWED_ORIGINS);
    const redirectUri = normalizeEnterpriseWechatSignedUrl(
      rawRedirectUri,
      this.env.WORK_WECHAT_ALLOWED_ORIGINS,
    );
    if (new URL(redirectUri).origin !== origin) {
      throw new ForbiddenException("OAuth 回调地址与请求来源不一致");
    }
    const { corpId, agentId } = await this.enterpriseConfig();
    const state = randomHex(32);
    const verifier = randomHex(32);
    const pending: WorkContextState = {
      verifierHash: await sha256Hex(verifier),
      origin,
      expiresAt: this.now() + STATE_TTL_SECONDS,
    };
    if (!(await this.stateStore.putOnce(`work_context:state:${state}`, pending, STATE_TTL_SECONDS))) {
      throw new ServiceUnavailableException("企业微信上下文挑战创建失败，请重试");
    }
    const authorization = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
    authorization.searchParams.set("appid", corpId);
    authorization.searchParams.set("redirect_uri", redirectUri);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", "snsapi_base");
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("agentid", String(agentId));
    authorization.hash = "wechat_redirect";
    return {
      authorization_url: authorization.href,
      state,
      cookie_value: `${state}.${verifier}`,
      expires_in: STATE_TTL_SECONDS,
    };
  }

  async exchange(input: {
    origin: string;
    state: unknown;
    code: unknown;
    cookieValue: string;
    target: WorkContextTarget;
  }) {
    const origin = requireEnterpriseWechatOrigin(input.origin, this.env.WORK_WECHAT_ALLOWED_ORIGINS);
    const state = validOpaqueIdentifier(input.state, "OAuth state", 128);
    const code = validOpaqueIdentifier(input.code, "OAuth code", 512);
    const cookie = input.cookieValue.match(/^([a-f0-9]{64})\.([a-f0-9]{64})$/i);
    if (!cookie || cookie[1] !== state) throw new ForbiddenException("企业微信上下文挑战无效");
    const pending = await this.stateStore.take<WorkContextState>(`work_context:state:${state}`);
    if (!pending || pending.expiresAt < this.now() || pending.origin !== origin) {
      throw new ForbiddenException("企业微信上下文挑战已过期或已使用");
    }
    if (await sha256Hex(cookie[2]) !== pending.verifierHash) {
      throw new ForbiddenException("企业微信上下文挑战校验失败");
    }
    const codeHash = await sha256Hex(code);
    if (!(await this.stateStore.putOnce(`work_context:code:${codeHash}`, 1, STATE_TTL_SECONDS))) {
      throw new ForbiddenException("企业微信 OAuth code 已使用");
    }
    const employee = await this.identityProvider.employeeIdentity(code);
    let claims: WorkContextClaims;
    if (input.target.type === "client") {
      const externalUserid = validOpaqueIdentifier(input.target.externalUserid, "客户身份");
      const scope = await this.requireClientScope(employee.corpId, employee.userid, externalUserid);
      claims = {
        kind: "client",
        corpId: scope.corpId,
        actorUserid: scope.actorUserid,
        targetId: scope.client.id,
        uid: scope.client.uid,
        clientProjectionSource: scope.source,
      };
    } else {
      const chatId = validOpaqueIdentifier(input.target.chatId, "群聊身份");
      const scope = await this.requireGroupScope(employee.corpId, employee.userid, chatId);
      claims = {
        kind: "group",
        corpId: scope.corpId,
        actorUserid: scope.actorUserid,
        targetId: scope.group.id,
        uid: 0,
      };
    }
    return {
      token: await this.signClaims(claims),
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
      target: { type: claims.kind, id: claims.targetId },
    };
  }

  async clientInfo(token: string) {
    const scope = await this.clientScopeFromToken(token);
    const client = scope.client;
    const rows = client.uid > 0
      ? await this.container.db.select({
          uid: user.uid,
          real_name: user.realName,
          nickname: user.nickname,
          avatar: user.avatar,
          phone: user.phone,
          birthday: user.birthday,
          group_id: user.groupId,
          level: user.level,
          user_type: user.userType,
          now_money: user.nowMoney,
          integral: user.integral,
          spread_open: user.spreadOpen,
          spread_uid: user.spreadUid,
          pay_count: user.payCount,
        }).from(user).where(and(
          eq(user.uid, client.uid),
          eq(user.status, 1),
          eq(user.isDel, 0),
          isNull(user.deleteTime),
        )).limit(1)
      : [];
    const account = rows[0];
    const [groups, labels, spreaders, followTags, signed] = await Promise.all([
      account?.group_id
        ? this.container.db.select({ group_name: userGroup.groupName }).from(userGroup)
            .where(eq(userGroup.id, account.group_id)).limit(1)
        : Promise.resolve([]),
      account
        ? this.container.db.select({ id: userLabel.id, label_name: userLabel.name })
            .from(userLabelRelation)
            .innerJoin(userLabel, eq(userLabel.id, userLabelRelation.labelId))
            .where(and(
              eq(userLabelRelation.uid, account.uid),
              eq(userLabelRelation.type, 0),
              eq(userLabelRelation.relationId, 0),
              eq(userLabel.type, 0),
              eq(userLabel.relationId, 0),
              eq(userLabel.status, 1),
            ))
            .orderBy(desc(userLabelRelation.id)).limit(100)
        : Promise.resolve([]),
      account?.spread_uid
        ? this.container.db.select({ nickname: user.nickname }).from(user)
            .where(eq(user.uid, account.spread_uid)).limit(1)
        : Promise.resolve([]),
      Promise.resolve(scope.tags),
      signAttachmentReferences(this.env.APP_KEY, [client.avatar, account?.avatar ?? ""]),
    ]);
    return {
      id: client.id,
      external_userid: client.externalUserid,
      uid: client.uid,
      name: client.name,
      avatar: signed[0],
      type: client.type,
      gender: client.gender,
      position: client.position,
      corp_name: client.corpName,
      remark: scope.follow.remark || client.remark,
      tags: followTags,
      userInfo: account ? {
        ...account,
        avatar: signed[1],
        userGroup: groups[0] ?? null,
        label: labels,
        spreadUser: spreaders[0] ?? null,
      } : null,
    };
  }

  async groupInfo(token: string) {
    const scope = await this.groupScopeFromToken(token);
    const today = Math.floor((this.now() + 8 * 60 * 60) / 86_400) * 86_400 - 8 * 60 * 60;
    const stats = await this.container.db.select({
      today_sum: count(sql`CASE WHEN ${workGroupChatMember.joinTime} >= ${today} AND ${workGroupChatMember.status} = 1 THEN 1 END`),
      today_return_sum: count(sql`CASE WHEN ${workGroupChatMember.joinTime} >= ${today} AND ${workGroupChatMember.status} = 0 THEN 1 END`),
      current_members: count(sql`CASE WHEN ${workGroupChatMember.status} = 1 THEN 1 END`),
    }).from(workGroupChatMember).where(eq(workGroupChatMember.groupId, scope.group.id));
    return {
      id: scope.group.id,
      chat_id: scope.group.chatId,
      name: scope.group.name,
      owner: scope.group.owner,
      group_create_time: epoch(scope.group.groupCreateTime),
      notice: scope.group.notice,
      member_num: Number(stats[0]?.current_members ?? scope.group.memberNum),
      retreat_group_num: scope.group.retreatGroupNum,
      todaySum: Number(stats[0]?.today_sum ?? 0),
      todayReturnSum: Number(stats[0]?.today_return_sum ?? 0),
    };
  }

  async groupMembers(token: string, rawGroupId: unknown, query: Record<string, string>) {
    const scope = await this.groupScopeFromToken(token);
    const groupId = positiveInteger(rawGroupId, "群聊ID");
    if (groupId !== scope.group.id) throw new ForbiddenException("群聊上下文与路径不匹配");
    const currentPage = page(query.page);
    const limit = parseKefuPageLimit(query.limit);
    const name = queryText(query.name, "客户名称");
    const filters: SQL[] = [eq(workGroupChatMember.groupId, groupId), eq(workGroupChatMember.status, 1)];
    if (name) {
      const pattern = `%${name}%`;
      filters.push(or(
        ilike(workGroupChatMember.name, pattern),
        ilike(workGroupChatMember.groupNickname, pattern),
      )!);
    }
    const where = and(...filters);
    const [relations, totals] = await Promise.all([
      this.container.db.select().from(workGroupChatMember).where(where)
        .orderBy(desc(workGroupChatMember.joinTime), desc(workGroupChatMember.id))
        .limit(limit).offset((currentPage - 1) * limit),
      this.container.db.select({ count: count() }).from(workGroupChatMember).where(where),
    ]);
    const employeeIds = [...new Set(relations.filter((item) => item.type === 1).map((item) => item.userid))];
    const externalIds = [...new Set(relations.filter((item) => item.type === 2).map((item) => item.userid))];
    const [employees, clientProjections, groupCounts] = await Promise.all([
      employeeIds.length
        ? this.container.db.select({
            userid: workMember.userid,
            name: workMember.name,
            avatar: workMember.avatar,
            gender: workMember.gender,
          }).from(workMember).where(and(
            eq(workMember.corpId, scope.corpId),
            inArray(workMember.userid, employeeIds),
          ))
        : Promise.resolve([]),
      this.loadGroupClientProjections(scope.corpId, scope.actorUserid, externalIds),
      externalIds.length
        ? this.container.db.select({
            userid: workGroupChatMember.userid,
            count: countDistinct(workGroupChatMember.groupId),
          }).from(workGroupChatMember)
          .innerJoin(workGroupChat, eq(workGroupChat.id, workGroupChatMember.groupId))
          .where(and(
            inArray(workGroupChatMember.userid, externalIds),
            eq(workGroupChatMember.type, 2),
            eq(workGroupChatMember.status, 1),
            eq(workGroupChat.corpId, scope.corpId),
            eq(workGroupChat.status, 1),
          )).groupBy(workGroupChatMember.userid)
        : Promise.resolve([]),
    ]);
    const employeeMap = new Map(employees.map((item) => [item.userid, item]));
    if (employeeMap.size !== employees.length) {
      throw new ServiceUnavailableException("群成员关联身份存在重复，请先清理数据");
    }
    const signed = await signAttachmentReferences(
      this.env.APP_KEY,
      relations.map((item) => item.type === 1
        ? employeeMap.get(item.userid)?.avatar ?? ""
        : clientProjections.get(item.userid)?.client.avatar ?? ""),
    );
    const counts = new Map(groupCounts.map((item) => [item.userid, Number(item.count)]));
    return {
      list: relations.map((item, index) => {
        const employee = employeeMap.get(item.userid);
        const clientProjection = clientProjections.get(item.userid);
        const client = clientProjection?.client;
        return {
          id: item.id,
          userid: item.userid,
          type: item.type,
          join_time: epoch(item.joinTime),
          group_nickname: item.groupNickname,
          member: employee ? { ...employee, avatar: signed[index] } : null,
          client: client ? {
            id: client.id,
            name: client.name,
            avatar: signed[index],
            gender: client.gender,
          } : null,
          group_chat_num: Math.max(0, (counts.get(item.userid) ?? 1) - 1),
          tags: clientProjection?.tags ?? [],
        };
      }),
      count: Number(totals[0]?.count ?? 0),
    };
  }

  async orderList(token: string, query: Record<string, string>) {
    const scope = await this.clientScopeFromToken(token);
    if (scope.client.uid <= 0) return [];
    const status = parseKefuOrderStatus(query.type);
    const currentPage = parseKefuOrderPage(query.page);
    const limit = parseKefuPageLimit(query.limit);
    const search = queryText(query.search);
    if (status === -1) return this.refundList(scope.client.uid, currentPage, limit, search);
    const filters: SQL[] = [
      eq(storeOrder.uid, scope.client.uid),
      eq(storeOrder.isSystemDel, 0),
      eq(storeOrder.isDel, 0),
      eq(storeOrder.storeId, 0),
      eq(storeOrder.pid, 0),
      inArray(storeOrder.refundType, [...CUSTOMER_ORDER_REFUND_TYPES]),
      ...orderStatusConditions(status),
    ];
    if (search) filters.push(or(
      ilike(storeOrder.orderId, `%${search}%`),
      ilike(storeOrder.realName, `%${search}%`),
    )!);
    const rows = await this.container.db.select().from(storeOrder).where(and(...filters))
      .orderBy(desc(storeOrder.id)).limit(limit).offset((currentPage - 1) * limit);
    const orders = await this.projectOrders(rows);
    await this.signOrderImages(orders);
    return orders;
  }

  async orderInfo(token: string, rawId: unknown) {
    const scope = await this.clientScopeFromToken(token);
    if (scope.client.uid <= 0) throw new NotFoundException("订单不存在或不属于当前客户");
    const id = positiveInteger(rawId, "订单ID");
    const rows = await this.container.db.select().from(storeOrder).where(and(
      eq(storeOrder.id, id),
      eq(storeOrder.uid, scope.client.uid),
      eq(storeOrder.isSystemDel, 0),
      eq(storeOrder.isDel, 0),
      eq(storeOrder.storeId, 0),
      eq(storeOrder.pid, 0),
      inArray(storeOrder.refundType, [...CUSTOMER_ORDER_REFUND_TYPES]),
    )).limit(1);
    if (!rows[0]) throw new NotFoundException("订单不存在或不属于当前客户");
    const [projected] = await this.projectOrders(rows);
    await this.signOrderImages([projected]);
    const users = await this.container.db.select({
      uid: user.uid,
      real_name: user.realName,
      nickname: user.nickname,
      avatar: user.avatar,
      phone: user.phone,
      group_id: user.groupId,
      now_money: user.nowMoney,
      integral: user.integral,
      spread_uid: user.spreadUid,
      status: user.status,
    }).from(user).where(and(
      eq(user.uid, scope.client.uid),
      eq(user.status, 1),
      eq(user.isDel, 0),
      isNull(user.deleteTime),
    )).limit(1);
    if (!users[0]) throw new NotFoundException("用户信息不存在");
    const [avatar] = await signAttachmentReferences(this.env.APP_KEY, [users[0].avatar]);
    return { orderInfo: projected, userInfo: { ...users[0], avatar } };
  }

  async purchasedProducts(token: string, query: Record<string, string>) {
    const scope = await this.clientScopeFromToken(token);
    if (scope.client.uid <= 0) return [];
    const currentPage = page(query.page);
    const limit = parseKefuPageLimit(query.limit);
    const search = queryText(query.store_name, "商品名称");
    const productFields = {
      id: storeProduct.id,
      store_name: storeProduct.storeName,
      image: storeProduct.image,
      stock: storeProduct.stock,
      price: storeProduct.price,
      sales: sql<number>`(${storeProduct.sales} + ${storeProduct.ficti})::int`,
      sort: storeProduct.sort,
    };
    const base = [
      eq(storeProduct.pid, 0),
      eq(storeProduct.isShow, 1),
      eq(storeProduct.isDel, 0),
      eq(storeProduct.isVerify, 1),
    ];
    const rows = search
      ? await this.container.db.select(productFields).from(storeProduct)
          .where(and(...base, ilike(storeProduct.storeName, `%${search}%`)))
          .orderBy(desc(storeProduct.sort), desc(storeProduct.id))
          .limit(limit).offset((currentPage - 1) * limit)
      : await this.container.db.selectDistinct(productFields).from(storeProduct)
          .innerJoin(storeOrderCartInfo, and(
            eq(storeOrderCartInfo.productId, storeProduct.id),
            eq(storeOrderCartInfo.uid, scope.client.uid),
          ))
          .where(and(...base))
          .orderBy(desc(storeProduct.sort), desc(storeProduct.id))
          .limit(limit).offset((currentPage - 1) * limit);
    const images = await signAttachmentReferences(this.env.APP_KEY, rows.map((item) => item.image));
    return rows.map(({ sort: _sort, ...item }, index) => ({ ...item, image: images[index] }));
  }

  async visitedProducts(token: string, query: Record<string, string>) {
    const scope = await this.clientScopeFromToken(token);
    if (scope.client.uid <= 0) return [];
    const currentPage = page(query.page);
    const limit = parseKefuPageLimit(query.limit);
    const search = queryText(query.store_name, "商品名称");
    const filters: SQL[] = [
      eq(storeVisit.uid, scope.client.uid),
      eq(storeVisit.productType, "product"),
      eq(storeProduct.pid, 0),
      eq(storeProduct.isShow, 1),
      eq(storeProduct.isDel, 0),
      eq(storeProduct.isVerify, 1),
    ];
    if (search) filters.push(ilike(storeProduct.storeName, `%${search}%`));
    const latest = sql<number>`MAX(${storeVisit.addTime})::int`;
    const rows = await this.container.db.select({
      id: storeProduct.id,
      store_name: storeProduct.storeName,
      image: storeProduct.image,
      stock: storeProduct.stock,
      price: storeProduct.price,
      sales: sql<number>`(${storeProduct.sales} + ${storeProduct.ficti})::int`,
      visit_time: latest,
    }).from(storeVisit).innerJoin(storeProduct, eq(storeProduct.id, storeVisit.productId))
      .where(and(...filters))
      .groupBy(
        storeProduct.id,
        storeProduct.storeName,
        storeProduct.image,
        storeProduct.stock,
        storeProduct.price,
        storeProduct.sales,
        storeProduct.ficti,
        storeProduct.sort,
      )
      .orderBy(desc(latest), desc(storeProduct.sort), desc(storeProduct.id))
      .limit(limit).offset((currentPage - 1) * limit);
    const images = await signAttachmentReferences(this.env.APP_KEY, rows.map((item) => item.image));
    return rows.map((item, index) => ({ ...item, image: images[index] }));
  }

  private async enterpriseConfig(): Promise<{ corpId: string; agentId: number }> {
    const values = await new SystemConfigService(this.container, this.env).getMany([
      "wechat_work_corpid",
      "wechat_work_build_agent_id",
    ]);
    const corpId = values.wechat_work_corpid?.trim() ?? "";
    const rawAgentId = values.wechat_work_build_agent_id?.trim() ?? "";
    const agentId = Number(rawAgentId);
    if (!isEnterpriseWechatCorpId(corpId)) {
      throw new ServiceUnavailableException("企业微信 CorpID 尚未配置");
    }
    if (
      !/^\d{1,10}$/.test(rawAgentId)
      || !Number.isSafeInteger(agentId)
      || agentId <= 0
      || agentId > 2_147_483_647
    ) {
      throw new ServiceUnavailableException("企业微信 AgentID 尚未配置");
    }
    return { corpId, agentId };
  }

  private async requireActor(
    corpId: string,
    actorUserid: string,
    transaction?: DbClient,
  ) {
    const normalizedUserid = actorUserid.trim().toLowerCase();
    if (!normalizedUserid) throw new ForbiddenException("当前企业成员已停用或尚未同步");
    const currentAuthorityEnabled = this.env.WECHAT_WORK_MEMBER_CURRENT_AUTHORITY?.trim()
      === "verified";

    const validate = async (tx: DbClient) => {
      // Use the same identity lock as callback claim/finalize. This prevents a
      // new unresolved/deleted current identity from racing a stale legacy
      // fallback between separate READ COMMITTED statements.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        hashtextextended(${`work-member:${corpId}:${normalizedUserid}`}, 0)
      )`);
      const aliases = await tx.select({
        aliasUserid: workMemberIdentityAlias.userid,
        aliasMemberId: workMemberIdentityAlias.memberId,
        aliasCanonicalUserid: workMemberIdentityAlias.canonicalUserid,
        aliasLifecycleState: workMemberIdentityAlias.lifecycleState,
        aliasLastEventId: workMemberIdentityAlias.lastEventId,
        aliasLastEventKey: workMemberIdentityAlias.lastEventKey,
        aliasLastEventSubjectKeyHash: workMemberIdentityAlias.lastEventSubjectKeyHash,
        aliasLastEventTime: workMemberIdentityAlias.lastEventTime,
        aliasLastSequenceRank: workMemberIdentityAlias.lastSequenceRank,
        currentId: workMemberCurrent.id,
        currentUserid: workMemberCurrent.userid,
        currentCanonicalUserid: workMemberCurrent.canonicalUserid,
        currentLifecycleState: workMemberCurrent.lifecycleState,
        currentStatus: workMemberCurrent.status,
        currentEnable: workMemberCurrent.enable,
        currentLastEventId: workMemberCurrent.lastEventId,
        currentLastEventKey: workMemberCurrent.lastEventKey,
        currentLastEventSubjectKeyHash: workMemberCurrent.lastEventSubjectKeyHash,
        currentLastEventTime: workMemberCurrent.lastEventTime,
        currentLastSequenceRank: workMemberCurrent.lastSequenceRank,
      }).from(workMemberIdentityAlias).leftJoin(workMemberCurrent, and(
        eq(workMemberCurrent.corpId, workMemberIdentityAlias.corpId),
        eq(workMemberCurrent.id, workMemberIdentityAlias.memberId),
      )).where(and(
        eq(workMemberIdentityAlias.corpId, corpId),
        eq(workMemberIdentityAlias.userid, normalizedUserid),
      )).limit(2);
      const currentMembers = await tx.select({ id: workMemberCurrent.id }).from(workMemberCurrent).where(and(
        eq(workMemberCurrent.corpId, corpId),
        eq(workMemberCurrent.userid, normalizedUserid),
      )).limit(2);
      if (aliases.length > 1 || currentMembers.length > 1) {
        throw new ServiceUnavailableException("企业成员当前身份存在重复，请先清理数据");
      }
      if (aliases.length || currentMembers.length) {
        if (!currentAuthorityEnabled) {
          throw new ForbiddenException("企业成员当前投影尚未通过启用验收");
        }
        const alias = aliases[0];
        const current = currentMembers[0];
        if (
          !alias
          || !current
          || alias.aliasUserid !== normalizedUserid
          || alias.aliasCanonicalUserid !== normalizedUserid
          || alias.aliasLifecycleState !== "ACTIVE"
          || alias.aliasMemberId === null
          || alias.aliasMemberId !== current.id
          || alias.currentId !== current.id
          || alias.currentUserid !== normalizedUserid
          || alias.currentCanonicalUserid !== normalizedUserid
          || alias.currentLifecycleState !== "ACTIVE"
          || alias.currentStatus !== 1
          || alias.currentEnable !== 1
          || alias.aliasLastEventId !== alias.currentLastEventId
          || alias.aliasLastEventKey !== alias.currentLastEventKey
          || alias.aliasLastEventSubjectKeyHash !== alias.currentLastEventSubjectKeyHash
          || alias.aliasLastEventTime !== alias.currentLastEventTime
          || alias.aliasLastSequenceRank !== alias.currentLastSequenceRank
        ) {
          throw new ForbiddenException("当前企业成员已停用或尚未同步");
        }
        return;
      }

      const rows = await tx.select({ id: workMember.id }).from(workMember).where(and(
        eq(workMember.corpId, corpId),
        sql`lower(${workMember.userid}) = ${normalizedUserid}`,
        eq(workMember.enable, 1),
        eq(workMember.status, 1),
      )).limit(2);
      if (!rows.length) throw new ForbiddenException("当前企业成员已停用或尚未同步");
      if (rows.length !== 1) {
        throw new ServiceUnavailableException("企业成员身份存在重复，请先清理数据");
      }
    };
    if (transaction) return validate(transaction);
    await withTx(this.container, validate);
  }

  private async requireClientScope(
    corpId: string,
    actorUserid: string,
    externalUserid: string,
  ): Promise<ClientScope> {
    const normalizedActor = actorUserid.trim().toLowerCase();
    return withTx(this.container, async (tx) => {
      // Keep the member identity lock until the client authorization snapshot
      // is complete, so a member tombstone cannot race token issuance.
      await this.requireActor(corpId, normalizedActor, tx);
      await this.lockClientScope(tx, corpId, externalUserid);
      const currentRows = await tx.select().from(workClientCurrent).where(and(
        eq(workClientCurrent.corpId, corpId),
        eq(workClientCurrent.externalUserid, externalUserid),
      )).limit(2);
      if (currentRows.length > 1) {
        throw new ServiceUnavailableException("客户当前身份存在重复，请先清理数据");
      }
      if (currentRows[0]) {
        return this.requireCurrentClientScope(tx, currentRows[0], normalizedActor);
      }
      return this.requireLegacyClientScopeByExternal(
        tx,
        corpId,
        normalizedActor,
        externalUserid,
      );
    });
  }

  private async requireClientScopeById(claims: WorkContextClaims): Promise<ClientScope> {
    const normalizedActor = claims.actorUserid.trim().toLowerCase();
    if (!claims.clientProjectionSource) {
      throw new ForbiddenException("客户投影来源已升级，请重新授权");
    }
    if (claims.clientProjectionSource === "current") {
      return withTx(this.container, async (tx) => {
        await this.requireActor(claims.corpId, normalizedActor, tx);
        const seed = (await tx.select({
          externalUserid: workClientCurrent.externalUserid,
        }).from(workClientCurrent).where(and(
          eq(workClientCurrent.corpId, claims.corpId),
          eq(workClientCurrent.id, claims.targetId),
        )).limit(1))[0];
        if (!seed) throw new ForbiddenException("客户上下文已发生变化，请重新授权");
        await this.lockClientScope(tx, claims.corpId, seed.externalUserid);
        const current = (await tx.select().from(workClientCurrent).where(and(
          eq(workClientCurrent.corpId, claims.corpId),
          eq(workClientCurrent.id, claims.targetId),
          eq(workClientCurrent.externalUserid, seed.externalUserid),
        )).limit(1))[0];
        if (!current || Number(current.uid ?? 0) !== claims.uid) {
          throw new ForbiddenException("客户上下文已发生变化，请重新授权");
        }
        return this.requireCurrentClientScope(tx, current, normalizedActor);
      });
    }

    return withTx(this.container, async (tx) => {
      await this.requireActor(claims.corpId, normalizedActor, tx);
      const seed = (await tx.select({
        externalUserid: workClient.externalUserid,
      }).from(workClient).where(and(
        eq(workClient.corpId, claims.corpId),
        eq(workClient.id, claims.targetId),
      )).limit(1))[0];
      if (!seed) throw new ForbiddenException("客户上下文已发生变化，请重新授权");
      await this.lockClientScope(tx, claims.corpId, seed.externalUserid);
      const currentSentinel = await tx.select({ id: workClientCurrent.id })
        .from(workClientCurrent).where(and(
          eq(workClientCurrent.corpId, claims.corpId),
          eq(workClientCurrent.externalUserid, seed.externalUserid),
        )).limit(1);
      if (currentSentinel.length) {
        throw new ForbiddenException("客户投影来源已发生变化，请重新授权");
      }
      const scope = await this.requireLegacyClientScopeById(
        tx,
        claims.corpId,
        normalizedActor,
        claims.targetId,
      );
      if (scope.client.uid !== claims.uid) {
        throw new ForbiddenException("客户上下文已发生变化，请重新授权");
      }
      return scope;
    });
  }

  private async lockClientScope(
    tx: DbClient,
    corpId: string,
    externalUserid: string,
  ): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(
      hashtextextended(${`work-client:${corpId}:${externalUserid}`}, 0)
    )`);
  }

  private currentAuthorityEnabled(): boolean {
    return this.env.WECHAT_WORK_CLIENT_CURRENT_AUTHORITY?.trim() === "verified";
  }

  private async requireCurrentClientScope(
    tx: DbClient,
    current: typeof workClientCurrent.$inferSelect,
    actorUserid: string,
  ): Promise<ClientScope> {
    if (!this.currentAuthorityEnabled()) {
      throw new ForbiddenException("客户当前投影尚未通过启用验收");
    }
    if (
      current.lifecycleState !== "ACTIVE"
      || !current.profileComplete
      || !current.providerSnapshotComplete
      || current.lastEventId === null
    ) {
      throw new ForbiddenException("客户当前投影尚未完整同步");
    }
    const profile = (await tx.select().from(workClientProjectionFence).where(and(
      eq(workClientProjectionFence.corpId, current.corpId),
      eq(workClientProjectionFence.externalUserid, current.externalUserid),
    )).limit(1))[0];
    if (!profile || !this.sameProjectionTuple(current, profile)) {
      throw new ForbiddenException("客户当前资料与最新事件不一致");
    }
    const profileEvent = (await tx.select().from(workCallbackEvent).where(and(
      eq(workCallbackEvent.id, current.lastEventId),
      eq(workCallbackEvent.corpId, current.corpId),
      eq(workCallbackEvent.eventKey, current.lastEventKey!),
      eq(workCallbackEvent.subjectKeyHash, current.lastEventSubjectKeyHash!),
      eq(workCallbackEvent.eventTime, current.lastEventTime),
      eq(workCallbackEvent.sequenceRank, current.lastSequenceRank),
    )).limit(1))[0];
    if (!this.appliedClientSnapshotEvent(profileEvent)) {
      throw new ForbiddenException("客户当前资料尚未完成事件确认");
    }

    const follow = (await tx.select().from(workClientFollowCurrent).where(and(
      eq(workClientFollowCurrent.corpId, current.corpId),
      eq(workClientFollowCurrent.clientId, current.id),
      eq(workClientFollowCurrent.userid, actorUserid),
    )).limit(1))[0];
    if (
      !follow
      || follow.lifecycleState !== "ACTIVE"
      || !follow.profileComplete
      || !follow.tagsComplete
    ) {
      throw new ForbiddenException("当前成员无权查看该客户");
    }
    const followEvent = (await tx.select().from(workCallbackEvent).where(and(
      eq(workCallbackEvent.id, follow.lastEventId),
      eq(workCallbackEvent.corpId, current.corpId),
      eq(workCallbackEvent.eventKey, follow.lastEventKey),
      eq(workCallbackEvent.subjectKeyHash, follow.lastEventSubjectKeyHash),
      eq(workCallbackEvent.eventTime, follow.lastEventTime),
      eq(workCallbackEvent.sequenceRank, follow.lastSequenceRank),
    )).limit(1))[0];
    if (!this.appliedClientSnapshotEvent(followEvent)) {
      throw new ForbiddenException("客户跟进关系尚未完成事件确认");
    }
    const direct = (await tx.select().from(workClientFollowProjectionFence).where(and(
      eq(workClientFollowProjectionFence.corpId, current.corpId),
      eq(workClientFollowProjectionFence.clientId, current.id),
      eq(workClientFollowProjectionFence.userid, actorUserid),
    )).limit(1))[0];
    if (follow.sourceKind === "DIRECT") {
      if (!direct || !this.sameProjectionTuple(follow, direct)) {
        throw new ForbiddenException("客户跟进关系与最新事件不一致");
      }
    } else if (follow.sourceKind === "SNAPSHOT") {
      if (direct) throw new ForbiddenException("客户跟进关系正在等待直接事件确认");
    } else {
      throw new ForbiddenException("客户跟进关系来源无效");
    }
    const tags = await tx.select({
      group_name: workClientFollowTagCurrent.groupName,
      tag_name: workClientFollowTagCurrent.tagName,
    }).from(workClientFollowTagCurrent).where(and(
      eq(workClientFollowTagCurrent.corpId, current.corpId),
      eq(workClientFollowTagCurrent.clientId, current.id),
      eq(workClientFollowTagCurrent.userid, actorUserid),
    )).orderBy(workClientFollowTagCurrent.sortOrder).limit(MAX_CURRENT_FOLLOW_TAGS);
    return {
      actorUserid,
      corpId: current.corpId,
      source: "current",
      client: {
        id: current.id,
        externalUserid: current.externalUserid,
        uid: Number(current.uid ?? 0),
        name: current.name ?? "",
        avatar: current.avatar ?? "",
        type: Number(current.type ?? 0),
        gender: Number(current.gender ?? 0),
        position: current.position ?? "",
        corpName: current.corpName ?? "",
        remark: "",
      },
      follow: {
        id: null,
        clientId: current.id,
        userid: actorUserid,
        remark: follow.remark ?? "",
      },
      tags,
    };
  }

  private sameProjectionTuple(
    left: {
      lastEventId: number | null;
      lastEventKey: string | null;
      lastEventSubjectKeyHash: string | null;
      lastEventTime: number;
      lastSequenceRank: number;
    },
    right: {
      lastEventId: number | null;
      lastEventKey: string | null;
      lastEventSubjectKeyHash: string | null;
      lastEventTime: number;
      lastSequenceRank: number;
    },
  ): boolean {
    return left.lastEventId === right.lastEventId
      && left.lastEventKey === right.lastEventKey
      && left.lastEventSubjectKeyHash === right.lastEventSubjectKeyHash
      && left.lastEventTime === right.lastEventTime
      && left.lastSequenceRank === right.lastSequenceRank;
  }

  private appliedClientSnapshotEvent(
    event: typeof workCallbackEvent.$inferSelect | undefined,
  ): boolean {
    return !!event
      && event.status === "ORDERED"
      && (event.projectionStatus === "APPLIED" || event.projectionStatus === "APPLIED_NOOP")
      && (event.changeType === "add_external_contact" || event.changeType === "edit_external_contact");
  }

  private async requireLegacyClientScopeByExternal(
    tx: DbClient,
    corpId: string,
    actorUserid: string,
    externalUserid: string,
  ): Promise<ClientScope> {
    const clients = await tx.select().from(workClient).where(and(
      eq(workClient.corpId, corpId),
      eq(workClient.externalUserid, externalUserid),
      isNull(workClient.deleteTime),
    )).limit(2);
    if (!clients.length) throw new NotFoundException("客户尚未同步到本地");
    if (clients.length !== 1) throw new ServiceUnavailableException("客户身份存在重复，请先清理数据");
    return this.requireLegacyClientFollow(tx, corpId, actorUserid, clients[0]);
  }

  private async requireLegacyClientScopeById(
    tx: DbClient,
    corpId: string,
    actorUserid: string,
    clientId: number,
  ): Promise<ClientScope> {
    const client = (await tx.select().from(workClient).where(and(
      eq(workClient.id, clientId),
      eq(workClient.corpId, corpId),
      isNull(workClient.deleteTime),
    )).limit(1))[0];
    if (!client) throw new ForbiddenException("客户上下文已发生变化，请重新授权");
    return this.requireLegacyClientFollow(tx, corpId, actorUserid, client);
  }

  private async requireLegacyClientFollow(
    tx: DbClient,
    corpId: string,
    actorUserid: string,
    client: typeof workClient.$inferSelect,
  ): Promise<ClientScope> {
    const follows = await tx.select().from(workClientFollow).where(and(
      eq(workClientFollow.clientId, client.id),
      sql`lower(${workClientFollow.userid}) = ${actorUserid}`,
      eq(workClientFollow.isDelUser, 0),
    )).limit(2);
    if (!follows.length) throw new ForbiddenException("当前成员无权查看该客户");
    if (follows.length !== 1) throw new ServiceUnavailableException("客户跟进关系存在重复，请先清理数据");
    const tags = await tx.select({
      group_name: workClientFollowTags.groupName,
      tag_name: workClientFollowTags.tagName,
    }).from(workClientFollowTags).where(eq(
      workClientFollowTags.followId,
      follows[0].id,
    )).orderBy(workClientFollowTags.createTime).limit(100);
    return {
      actorUserid,
      corpId,
      source: "legacy",
      client: {
        id: client.id,
        externalUserid: client.externalUserid,
        uid: client.uid,
        name: client.name,
        avatar: client.avatar,
        type: client.type,
        gender: client.gender,
        position: client.position,
        corpName: client.corpName,
        remark: client.remark,
      },
      follow: {
        id: follows[0].id,
        clientId: client.id,
        userid: actorUserid,
        remark: follows[0].remark,
      },
      tags,
    };
  }

  private async loadGroupClientProjections(
    corpId: string,
    actorUserid: string,
    externalUserids: string[],
  ): Promise<Map<string, GroupClientProjection>> {
    if (!externalUserids.length) return new Map();
    const identities = [...new Set(externalUserids)].sort();
    return withTx(this.container, async (tx) => {
      // Callback projection writers take the same locks. Sorting makes this
      // bounded multi-client read compatible with concurrent callback batches.
      for (const externalUserid of identities) {
        await this.lockClientScope(tx, corpId, externalUserid);
      }
      const currentRows = await tx.select().from(workClientCurrent).where(and(
        eq(workClientCurrent.corpId, corpId),
        inArray(workClientCurrent.externalUserid, identities),
      ));
      const currentIdentitySet = new Set(currentRows.map((row) => row.externalUserid));
      if (currentIdentitySet.size !== currentRows.length) {
        throw new ServiceUnavailableException("群客户当前身份存在重复，请先清理数据");
      }
      const output = new Map<string, GroupClientProjection>();
      if (currentRows.length && this.currentAuthorityEnabled()) {
        const eligible = await tx.select({ client: workClientCurrent })
          .from(workClientCurrent)
          .innerJoin(workClientProjectionFence, and(
            eq(workClientProjectionFence.corpId, workClientCurrent.corpId),
            eq(workClientProjectionFence.externalUserid, workClientCurrent.externalUserid),
            eq(workClientProjectionFence.lastEventId, workClientCurrent.lastEventId),
            eq(workClientProjectionFence.lastEventKey, workClientCurrent.lastEventKey),
            eq(
              workClientProjectionFence.lastEventSubjectKeyHash,
              workClientCurrent.lastEventSubjectKeyHash,
            ),
            eq(workClientProjectionFence.lastEventTime, workClientCurrent.lastEventTime),
            eq(workClientProjectionFence.lastSequenceRank, workClientCurrent.lastSequenceRank),
          ))
          .innerJoin(workCallbackEvent, and(
            eq(workCallbackEvent.id, workClientCurrent.lastEventId),
            eq(workCallbackEvent.corpId, workClientCurrent.corpId),
            eq(workCallbackEvent.eventKey, workClientCurrent.lastEventKey),
            eq(workCallbackEvent.subjectKeyHash, workClientCurrent.lastEventSubjectKeyHash),
            eq(workCallbackEvent.eventTime, workClientCurrent.lastEventTime),
            eq(workCallbackEvent.sequenceRank, workClientCurrent.lastSequenceRank),
          ))
          .where(and(
            eq(workClientCurrent.corpId, corpId),
            inArray(workClientCurrent.externalUserid, identities),
            eq(workClientCurrent.lifecycleState, "ACTIVE"),
            eq(workClientCurrent.profileComplete, true),
            eq(workClientCurrent.providerSnapshotComplete, true),
            eq(workCallbackEvent.status, "ORDERED"),
            inArray(workCallbackEvent.projectionStatus, ["APPLIED", "APPLIED_NOOP"]),
            inArray(workCallbackEvent.changeType, ["add_external_contact", "edit_external_contact"]),
          ));
        const eligibleIds = eligible.map(({ client }) => client.id);
        const follows = eligibleIds.length
          ? await tx.select({
              follow: workClientFollowCurrent,
              direct: workClientFollowProjectionFence,
            }).from(workClientFollowCurrent)
              .innerJoin(workCallbackEvent, and(
                eq(workCallbackEvent.id, workClientFollowCurrent.lastEventId),
                eq(workCallbackEvent.corpId, workClientFollowCurrent.corpId),
                eq(workCallbackEvent.eventKey, workClientFollowCurrent.lastEventKey),
                eq(
                  workCallbackEvent.subjectKeyHash,
                  workClientFollowCurrent.lastEventSubjectKeyHash,
                ),
                eq(workCallbackEvent.eventTime, workClientFollowCurrent.lastEventTime),
                eq(workCallbackEvent.sequenceRank, workClientFollowCurrent.lastSequenceRank),
              ))
              .leftJoin(workClientFollowProjectionFence, and(
                eq(
                  workClientFollowProjectionFence.corpId,
                  workClientFollowCurrent.corpId,
                ),
                eq(
                  workClientFollowProjectionFence.clientId,
                  workClientFollowCurrent.clientId,
                ),
                eq(workClientFollowProjectionFence.userid, workClientFollowCurrent.userid),
              ))
              .where(and(
                eq(workClientFollowCurrent.corpId, corpId),
                inArray(workClientFollowCurrent.clientId, eligibleIds),
                eq(workClientFollowCurrent.userid, actorUserid),
                eq(workClientFollowCurrent.lifecycleState, "ACTIVE"),
                eq(workClientFollowCurrent.profileComplete, true),
                eq(workClientFollowCurrent.tagsComplete, true),
                eq(workCallbackEvent.status, "ORDERED"),
                inArray(workCallbackEvent.projectionStatus, ["APPLIED", "APPLIED_NOOP"]),
                inArray(workCallbackEvent.changeType, ["add_external_contact", "edit_external_contact"]),
                or(
                  and(
                    eq(workClientFollowCurrent.sourceKind, "DIRECT"),
                    eq(
                      workClientFollowProjectionFence.lastEventId,
                      workClientFollowCurrent.lastEventId,
                    ),
                    eq(
                      workClientFollowProjectionFence.lastEventKey,
                      workClientFollowCurrent.lastEventKey,
                    ),
                    eq(
                      workClientFollowProjectionFence.lastEventSubjectKeyHash,
                      workClientFollowCurrent.lastEventSubjectKeyHash,
                    ),
                    eq(
                      workClientFollowProjectionFence.lastEventTime,
                      workClientFollowCurrent.lastEventTime,
                    ),
                    eq(
                      workClientFollowProjectionFence.lastSequenceRank,
                      workClientFollowCurrent.lastSequenceRank,
                    ),
                  ),
                  and(
                    eq(workClientFollowCurrent.sourceKind, "SNAPSHOT"),
                    isNull(workClientFollowProjectionFence.clientId),
                  ),
                ),
              ))
          : [];
        const followClientIds = follows.map(({ follow }) => follow.clientId);
        const tags = followClientIds.length
          ? await tx.select().from(workClientFollowTagCurrent).where(and(
              eq(workClientFollowTagCurrent.corpId, corpId),
              inArray(workClientFollowTagCurrent.clientId, followClientIds),
              eq(workClientFollowTagCurrent.userid, actorUserid),
            )).orderBy(
              workClientFollowTagCurrent.clientId,
              workClientFollowTagCurrent.sortOrder,
            )
          : [];
        const tagsByClient = new Map<number, string[]>();
        for (const tag of tags) {
          tagsByClient.set(tag.clientId, [
            ...(tagsByClient.get(tag.clientId) ?? []),
            tag.tagName,
          ]);
        }
        const followIds = new Set(followClientIds);
        for (const { client } of eligible) {
          output.set(client.externalUserid, {
            client: {
              id: client.id,
              externalUserid: client.externalUserid,
              uid: Number(client.uid ?? 0),
              name: client.name ?? "",
              avatar: client.avatar ?? "",
              type: Number(client.type ?? 0),
              gender: Number(client.gender ?? 0),
              position: client.position ?? "",
              corpName: client.corpName ?? "",
              remark: "",
            },
            tags: followIds.has(client.id) ? tagsByClient.get(client.id) ?? [] : [],
          });
        }
      }

      const legacyIdentities = identities.filter((identity) => !currentIdentitySet.has(identity));
      if (!legacyIdentities.length) return output;
      const legacyClients = await tx.select().from(workClient).where(and(
        eq(workClient.corpId, corpId),
        inArray(workClient.externalUserid, legacyIdentities),
        isNull(workClient.deleteTime),
      ));
      const legacyByIdentity = new Map(legacyClients.map((client) => [client.externalUserid, client]));
      if (legacyByIdentity.size !== legacyClients.length) {
        throw new ServiceUnavailableException("群客户身份存在重复，请先清理数据");
      }
      const legacyFollows = legacyClients.length
        ? await tx.select().from(workClientFollow).where(and(
            inArray(workClientFollow.clientId, legacyClients.map((client) => client.id)),
            sql`lower(${workClientFollow.userid}) = ${actorUserid}`,
            eq(workClientFollow.isDelUser, 0),
          ))
        : [];
      const followByClient = new Map(legacyFollows.map((follow) => [follow.clientId, follow]));
      if (followByClient.size !== legacyFollows.length) {
        throw new ServiceUnavailableException("群客户跟进关系存在重复，请先清理数据");
      }
      const legacyTags = legacyFollows.length
        ? await tx.select().from(workClientFollowTags).where(inArray(
            workClientFollowTags.followId,
            legacyFollows.map((follow) => follow.id),
          )).orderBy(workClientFollowTags.createTime)
        : [];
      const tagsByFollow = new Map<number, string[]>();
      for (const tag of legacyTags) {
        tagsByFollow.set(tag.followId, [
          ...(tagsByFollow.get(tag.followId) ?? []),
          tag.tagName,
        ]);
      }
      for (const client of legacyClients) {
        const follow = followByClient.get(client.id);
        output.set(client.externalUserid, {
          client: {
            id: client.id,
            externalUserid: client.externalUserid,
            uid: client.uid,
            name: client.name,
            avatar: client.avatar,
            type: client.type,
            gender: client.gender,
            position: client.position,
            corpName: client.corpName,
            remark: client.remark,
          },
          tags: follow ? tagsByFollow.get(follow.id) ?? [] : [],
        });
      }
      return output;
    });
  }

  private async requireGroupScope(
    corpId: string,
    actorUserid: string,
    chatId: string,
  ): Promise<GroupScope> {
    await this.requireActor(corpId, actorUserid);
    const groups = await this.container.db.select().from(workGroupChat).where(and(
      eq(workGroupChat.corpId, corpId),
      eq(workGroupChat.chatId, chatId),
      eq(workGroupChat.status, 1),
    )).limit(2);
    if (!groups.length) throw new NotFoundException("群聊尚未同步到本地");
    if (groups.length !== 1) throw new ServiceUnavailableException("群聊身份存在重复，请先清理数据");
    await this.requireGroupVisibility(groups[0], actorUserid);
    return { actorUserid, corpId, group: groups[0] };
  }

  private async requireGroupScopeById(claims: WorkContextClaims): Promise<GroupScope> {
    await this.requireActor(claims.corpId, claims.actorUserid);
    const groups = await this.container.db.select().from(workGroupChat).where(and(
      eq(workGroupChat.id, claims.targetId),
      eq(workGroupChat.corpId, claims.corpId),
      eq(workGroupChat.status, 1),
    )).limit(1);
    if (!groups[0]) throw new ForbiddenException("群聊上下文已发生变化，请重新授权");
    await this.requireGroupVisibility(groups[0], claims.actorUserid);
    return { actorUserid: claims.actorUserid, corpId: claims.corpId, group: groups[0] };
  }

  private async requireGroupVisibility(group: typeof workGroupChat.$inferSelect, actorUserid: string) {
    if (group.owner === actorUserid) return;
    const memberships = await this.container.db.select({ id: workGroupChatMember.id })
      .from(workGroupChatMember).where(and(
        eq(workGroupChatMember.groupId, group.id),
        eq(workGroupChatMember.userid, actorUserid),
        eq(workGroupChatMember.type, 1),
        eq(workGroupChatMember.status, 1),
      )).limit(2);
    if (!memberships.length) throw new ForbiddenException("当前成员无权查看该群聊");
    if (memberships.length !== 1) throw new ServiceUnavailableException("群成员关系存在重复，请先清理数据");
  }

  private secret(): Uint8Array {
    const bytes = new TextEncoder().encode(this.env.APP_KEY ?? "");
    if (bytes.byteLength < 32) throw new ServiceUnavailableException("企业微信上下文签名密钥尚未安全配置");
    return bytes;
  }

  private async signClaims(claims: WorkContextClaims): Promise<string> {
    const now = this.now();
    const audience: WorkContextAudience = claims.kind === "client" ? "work-client" : "work-group";
    return new SignJWT({
      kind: claims.kind,
      corp_id: claims.corpId,
      actor_userid: claims.actorUserid,
      target_id: claims.targetId,
      uid: claims.uid,
      client_projection_source: claims.clientProjectionSource,
    }).setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(audience)
      .setSubject(claims.actorUserid)
      .setJti(randomHex(16))
      .setIssuedAt(now)
      .setExpirationTime(now + TOKEN_TTL_SECONDS)
      .sign(this.secret());
  }

  private async verifyClaims(token: string, audience: WorkContextAudience): Promise<WorkContextClaims> {
    if (!token || token.length > 4_096) throw new ForbiddenException("企业微信上下文令牌无效");
    try {
      const { payload } = await jwtVerify(token, this.secret(), {
        algorithms: ["HS256"],
        issuer: TOKEN_ISSUER,
        audience,
        clockTolerance: 5,
      });
      const kind = payload.kind;
      const corpId = payload.corp_id;
      const actorUserid = payload.actor_userid;
      const targetId = Number(payload.target_id);
      const uid = Number(payload.uid ?? 0);
      const clientProjectionSource = payload.client_projection_source;
      const expectedKind: "client" | "group" = audience === "work-client" ? "client" : "group";
      if (
        kind !== expectedKind
        || typeof corpId !== "string"
        || typeof actorUserid !== "string"
        || !Number.isSafeInteger(targetId)
        || targetId <= 0
        || !Number.isSafeInteger(uid)
        || uid < 0
        || (expectedKind === "client"
          && clientProjectionSource !== "legacy"
          && clientProjectionSource !== "current")
      ) throw new Error("invalid claims");
      return {
        kind: expectedKind,
        corpId,
        actorUserid,
        targetId,
        uid,
        clientProjectionSource: expectedKind === "client"
          ? clientProjectionSource as ClientProjectionSource
          : undefined,
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ForbiddenException("企业微信上下文令牌无效或已过期");
    }
  }

  private async clientScopeFromToken(token: string) {
    return this.requireClientScopeById(await this.verifyClaims(token, "work-client"));
  }

  private async groupScopeFromToken(token: string) {
    return this.requireGroupScopeById(await this.verifyClaims(token, "work-group"));
  }

  private async projectOrders(rows: Array<typeof storeOrder.$inferSelect>) {
    if (!rows.length) return [];
    const ids = rows.map((item) => item.id);
    const [carts, refunds] = await Promise.all([
      this.container.db.select().from(storeOrderCartInfo)
        .where(inArray(storeOrderCartInfo.oid, ids))
        .orderBy(storeOrderCartInfo.oid, storeOrderCartInfo.id),
      this.container.db.select().from(storeOrderRefund).where(and(
        inArray(storeOrderRefund.storeOrderId, ids),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      )).orderBy(storeOrderRefund.storeOrderId, storeOrderRefund.id),
    ]);
    const cartsByOrder = new Map<number, Array<typeof storeOrderCartInfo.$inferSelect>>();
    const refundsByOrder = new Map<number, Array<typeof storeOrderRefund.$inferSelect>>();
    for (const item of carts) cartsByOrder.set(item.oid, [...(cartsByOrder.get(item.oid) ?? []), item]);
    for (const item of refunds) refundsByOrder.set(item.storeOrderId, [...(refundsByOrder.get(item.storeOrderId) ?? []), item]);
    return rows.map((item) => orderProjection(
      item,
      cartsByOrder.get(item.id) ?? [],
      refundsByOrder.get(item.id) ?? [],
    ));
  }

  private async refundList(uid: number, currentPage: number, limit: number, search: string) {
    const filters: SQL[] = [
      eq(storeOrderRefund.uid, uid),
      eq(storeOrderRefund.isCancel, 0),
      eq(storeOrderRefund.isDel, 0),
      inArray(storeOrderRefund.refundType, [...ACTIVE_REFUND_TYPES]),
    ];
    if (search) filters.push(ilike(storeOrderRefund.orderId, `%${search}%`));
    const rows = await this.container.db.select().from(storeOrderRefund).where(and(...filters))
      .orderBy(desc(storeOrderRefund.addTime), desc(storeOrderRefund.id))
      .limit(limit).offset((currentPage - 1) * limit);
    if (!rows.length) return [];
    const carts = await this.container.db.select().from(storeOrderCartInfo)
      .where(inArray(storeOrderCartInfo.oid, rows.map((item) => item.storeOrderId)))
      .orderBy(storeOrderCartInfo.oid, storeOrderCartInfo.id);
    const byOrder = new Map<number, Array<typeof storeOrderCartInfo.$inferSelect>>();
    for (const item of carts) byOrder.set(item.oid, [...(byOrder.get(item.oid) ?? []), item]);
    const projected = rows.map((item) => refundProjection(item, byOrder.get(item.storeOrderId) ?? [], true));
    await this.signOrderImages(projected);
    return projected;
  }

  private async signOrderImages(projected: Array<Record<string, unknown>>) {
    const targets: Array<{ owner: Record<string, unknown>; key: string; value: string }> = [];
    for (const order of projected) {
      const carts = Array.isArray(order.cartInfo) ? order.cartInfo : [];
      for (const rawCart of carts) {
        if (!rawCart || typeof rawCart !== "object") continue;
        const cart = rawCart as Record<string, unknown>;
        const product = cart.productInfo;
        if (!product || typeof product !== "object") continue;
        const productInfo = product as Record<string, unknown>;
        if (typeof productInfo.image === "string") targets.push({ owner: productInfo, key: "image", value: productInfo.image });
        const attr = productInfo.attrInfo;
        if (attr && typeof attr === "object" && typeof (attr as Record<string, unknown>).image === "string") {
          targets.push({ owner: attr as Record<string, unknown>, key: "image", value: String((attr as Record<string, unknown>).image) });
        }
      }
    }
    if (!targets.length) return;
    const signed = await signAttachmentReferences(this.env.APP_KEY, targets.map((item) => item.value));
    targets.forEach((item, index) => { item.owner[item.key] = signed[index]; });
  }
}
