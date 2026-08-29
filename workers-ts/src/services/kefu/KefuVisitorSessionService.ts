import { SignJWT, jwtVerify } from "jose";
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Env } from "@/env";
import { withTx, type Container } from "@/lib/di";
import {
  kefuVisitorSession,
  storeService,
  storeServiceLog,
} from "@/models/schema";
import {
  parseCanonicalAttachmentId,
  signAttachmentReferences,
} from "@/services/system/AttachmentService";
import {
  AuthException,
  NotFoundException,
  RateLimitException,
  ValidateException,
} from "@/utils/errors";

const VISITOR_ISSUER = "cinashop-kefu-visitor";
const VISITOR_AUDIENCE = "cinashop-kefu";
const VISITOR_TTL_SECONDS = 24 * 60 * 60;
const VISITOR_CREATE_LIMIT_PER_HOUR = 10;
const VISITOR_CREATE_GLOBAL_LIMIT_PER_HOUR = 1_000;
const VISITOR_ASSIGNMENT_LOCK = 91310004;
const MAX_HISTORY_LIMIT = 100;

export interface KefuVisitorIdentity {
  sessionId: string;
  visitorUid: number;
  serviceId: number;
  kefuUid: number;
  tokenHash: string;
  nickname: string;
  avatar: string;
  expiresAt: number;
  serviceNickname: string;
  serviceAvatar: string;
  serviceOnline: number;
}

interface VisitorClaims {
  sub?: string;
  jti?: string;
  exp?: number;
  visitor_uid?: number;
}

function integer(
  value: unknown,
  label: string,
  options: { fallback?: number; min?: number; max?: number } = {},
): number {
  if ((value === undefined || value === null || value === "") && options.fallback !== undefined) {
    return options.fallback;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < (options.min ?? 0)
    || parsed > (options.max ?? 2_147_483_647)
  ) throw new ValidateException(`${label}无效`);
  return parsed;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSource(appKey: string, ip: string): Promise<string> {
  if (!appKey) throw new Error("Visitor session HMAC key unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`kefu-visitor-session\u0000${ip.trim().slice(0, 128) || "unknown"}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signVisitorToken(
  secret: string,
  sessionId: string,
  visitorUid: number,
  expiresAt: number,
): Promise<string> {
  return new SignJWT({ visitor_uid: visitorUid })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(VISITOR_ISSUER)
    .setAudience(VISITOR_AUDIENCE)
    .setSubject(sessionId)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setNotBefore(Math.floor(Date.now() / 1_000))
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(secret));
}

export async function verifyVisitorToken(token: string, secret: string): Promise<Required<Pick<VisitorClaims, "sub" | "exp" | "visitor_uid">>> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
    issuer: VISITOR_ISSUER,
    audience: VISITOR_AUDIENCE,
    clockTolerance: 30,
  });
  const claims = payload as VisitorClaims;
  if (
    typeof claims.sub !== "string"
    || !/^[0-9a-f-]{36}$/.test(claims.sub)
    || !Number.isSafeInteger(claims.exp)
    || !Number.isSafeInteger(claims.visitor_uid)
    || Number(claims.visitor_uid) < 1_000_000_000
  ) throw new Error("invalid visitor token claims");
  return {
    sub: claims.sub,
    exp: Number(claims.exp),
    visitor_uid: Number(claims.visitor_uid),
  };
}

function mapMessage(row: typeof storeServiceLog.$inferSelect) {
  return {
    id: row.id,
    mer_id: row.merId,
    msn: row.msn,
    uid: row.uid,
    to_uid: row.toUid,
    is_tourist: row.isTourist,
    time_node: row.timeNode,
    add_time: row.addTime,
    type: row.type,
    remind: row.remind,
    msn_type: row.msnType,
  };
}

export class KefuVisitorSessionService {
  constructor(
    private readonly container: Container,
    private readonly env: Pick<Env, "APP_KEY" | "TOKEN_BUCKET">,
  ) {}

  private async enforceCreateRateLimit(ip: string): Promise<void> {
    const source = await hmacSource(this.env.APP_KEY, ip);
    const local = await this.env.TOKEN_BUCKET
      .getByName(`kefu-visitor-create:${source.slice(0, 32)}`)
      .consumeRateLimit([{ key: "ip", limit: VISITOR_CREATE_LIMIT_PER_HOUR }], 60 * 60);
    if (!local.allowed) {
      throw new RateLimitException(
        "游客会话创建过于频繁，请稍后重试",
        Math.max(1, Math.ceil((local.resetAt - Date.now()) / 1_000)),
        false,
      );
    }
    const global = await this.env.TOKEN_BUCKET
      .getByName("kefu-visitor-create:global")
      .consumeRateLimit([{ key: "global", limit: VISITOR_CREATE_GLOBAL_LIMIT_PER_HOUR }], 60 * 60);
    if (!global.allowed) {
      throw new RateLimitException(
        "游客客服繁忙，请稍后重试",
        Math.max(1, Math.ceil((global.resetAt - Date.now()) / 1_000)),
        false,
      );
    }
  }

  async authenticate(token: string): Promise<KefuVisitorIdentity> {
    if (!token || token.length > 2_048) throw new AuthException("游客会话无效");
    let claims: Awaited<ReturnType<typeof verifyVisitorToken>>;
    try {
      claims = await verifyVisitorToken(token, this.env.APP_KEY);
    } catch {
      throw new AuthException("游客会话已过期，请重新连接");
    }
    const tokenHash = await sha256Hex(token);
    const now = Math.floor(Date.now() / 1_000);
    const session = (
      await this.container.db
        .select()
        .from(kefuVisitorSession)
        .where(and(
          eq(kefuVisitorSession.sessionId, claims.sub),
          eq(kefuVisitorSession.visitorUid, claims.visitor_uid),
          eq(kefuVisitorSession.tokenHash, tokenHash),
          eq(kefuVisitorSession.expiresAt, claims.exp),
          eq(kefuVisitorSession.revokedAt, 0),
          sql`${kefuVisitorSession.expiresAt} > ${now}`,
        ))
        .limit(1)
    )[0];
    if (!session) throw new AuthException("游客会话已失效，请重新连接");
    const services = await this.container.db
      .select({
        id: storeService.id,
        uid: storeService.uid,
        nickname: storeService.nickname,
        avatar: storeService.avatar,
        online: storeService.online,
      })
      .from(storeService)
      .where(and(
        eq(storeService.id, session.serviceId),
        eq(storeService.uid, session.kefuUid),
        eq(storeService.isDel, 0),
        eq(storeService.status, 1),
        eq(storeService.accountStatus, 1),
      ))
      .limit(2);
    if (services.length !== 1) throw new AuthException("分配客服已失效，请重新连接");
    if (now - session.lastSeenAt >= 300) {
      await this.container.db.update(kefuVisitorSession)
        .set({ lastSeenAt: now })
        .where(and(
          eq(kefuVisitorSession.sessionId, session.sessionId),
          eq(kefuVisitorSession.tokenHash, tokenHash),
          eq(kefuVisitorSession.revokedAt, 0),
        ));
    }
    return {
      sessionId: session.sessionId,
      visitorUid: session.visitorUid,
      serviceId: session.serviceId,
      kefuUid: session.kefuUid,
      tokenHash,
      nickname: session.nickname,
      avatar: session.avatar,
      expiresAt: session.expiresAt,
      serviceNickname: services[0].nickname,
      serviceAvatar: services[0].avatar,
      serviceOnline: services[0].online,
    };
  }

  async bootstrap(existingToken: string | null, ip: string) {
    if (existingToken) {
      const identity = await this.authenticate(existingToken);
      return this.bootstrapResponse(identity, existingToken);
    }
    await this.enforceCreateRateLimit(ip);
    const now = Math.floor(Date.now() / 1_000);
    const expiresAt = now + VISITOR_TTL_SECONDS;
    const created = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${VISITOR_ASSIGNMENT_LOCK})`);
      const candidates = await tx
        .select({
          id: storeService.id,
          uid: storeService.uid,
          nickname: storeService.nickname,
          avatar: storeService.avatar,
          online: storeService.online,
        })
        .from(storeService)
        .where(and(
          eq(storeService.isDel, 0),
          eq(storeService.status, 1),
          eq(storeService.accountStatus, 1),
          eq(storeService.online, 1),
          sql`${storeService.uid} > 0`,
        ))
        .orderBy(asc(storeService.id))
        .limit(100);
      const uidCounts = new Map<number, number>();
      for (const candidate of candidates) uidCounts.set(candidate.uid, (uidCounts.get(candidate.uid) ?? 0) + 1);
      const unique = candidates.filter((candidate) => uidCounts.get(candidate.uid) === 1);
      if (!unique.length) throw new NotFoundException("暂无客服人员在线，请稍后联系");
      const activeCounts = await tx
        .select({ kefuUid: kefuVisitorSession.kefuUid, count: sql<number>`count(*)::int` })
        .from(kefuVisitorSession)
        .where(and(
          inArray(kefuVisitorSession.kefuUid, unique.map((candidate) => candidate.uid)),
          eq(kefuVisitorSession.revokedAt, 0),
          sql`${kefuVisitorSession.expiresAt} > ${now}`,
        ))
        .groupBy(kefuVisitorSession.kefuUid);
      const countByUid = new Map(activeCounts.map((item) => [item.kefuUid, item.count]));
      unique.sort((left, right) =>
        (countByUid.get(left.uid) ?? 0) - (countByUid.get(right.uid) ?? 0) || left.id - right.id
      );
      const selected = unique[0];
      const sessionId = crypto.randomUUID();
      const provisionalHash = await sha256Hex(`${sessionId}:${crypto.randomUUID()}`);
      const inserted = (
        await tx.insert(kefuVisitorSession).values({
          sessionId,
          serviceId: selected.id,
          kefuUid: selected.uid,
          tokenHash: provisionalHash,
          nickname: "",
          avatar: "",
          createdAt: now,
          expiresAt,
          lastSeenAt: now,
          revokedAt: 0,
        }).returning({ visitorUid: kefuVisitorSession.visitorUid })
      )[0];
      const token = await signVisitorToken(this.env.APP_KEY, sessionId, inserted.visitorUid, expiresAt);
      const tokenHash = await sha256Hex(token);
      const nickname = `游客${inserted.visitorUid}`;
      await tx.update(kefuVisitorSession)
        .set({ tokenHash, nickname })
        .where(and(
          eq(kefuVisitorSession.sessionId, sessionId),
          eq(kefuVisitorSession.tokenHash, provisionalHash),
        ));
      return {
        identity: {
          sessionId,
          visitorUid: inserted.visitorUid,
          serviceId: selected.id,
          kefuUid: selected.uid,
          tokenHash,
          nickname,
          avatar: "",
          expiresAt,
          serviceNickname: selected.nickname,
          serviceAvatar: selected.avatar,
          serviceOnline: selected.online,
        } satisfies KefuVisitorIdentity,
        token,
      };
    });
    return this.bootstrapResponse(created.identity, created.token);
  }

  private bootstrapResponse(identity: KefuVisitorIdentity, token: string) {
    return {
      uid: identity.kefuUid,
      nickname: identity.serviceNickname,
      avatar: identity.serviceAvatar,
      online: identity.serviceOnline,
      tourist_uid: identity.visitorUid,
      tourist_avatar: identity.avatar,
      is_tourist: true,
      visitor_token: token,
      expires_in: Math.max(0, identity.expiresAt - Math.floor(Date.now() / 1_000)),
    };
  }

  async history(identity: KefuVisitorIdentity, upperIdValue: unknown, limitValue: unknown) {
    const upperId = integer(upperIdValue, "消息游标", { fallback: 0, min: 0 });
    const limit = integer(limitValue, "每页数量", { fallback: 20, min: 1, max: MAX_HISTORY_LIMIT });
    const conversation = or(
      and(eq(storeServiceLog.uid, identity.visitorUid), eq(storeServiceLog.toUid, identity.kefuUid)),
      and(eq(storeServiceLog.uid, identity.kefuUid), eq(storeServiceLog.toUid, identity.visitorUid)),
    );
    const rows = await this.container.db
      .select()
      .from(storeServiceLog)
      .where(and(
        conversation,
        eq(storeServiceLog.isTourist, 1),
        upperId > 0 ? lt(storeServiceLog.id, upperId) : undefined,
      ))
      .orderBy(sql`${storeServiceLog.id} DESC`)
      .limit(limit);
    const messages = rows.reverse().map(mapMessage);
    const imageIndexes = messages.flatMap((message, index) =>
      message.msn_type === 3 && parseCanonicalAttachmentId(message.msn) ? [index] : []
    );
    const signed = imageIndexes.length
      ? await signAttachmentReferences(
          this.env.APP_KEY,
          imageIndexes.map((index) => messages[index].msn),
          60 * 60,
        )
      : [];
    const signedByIndex = new Map(imageIndexes.map((index, offset) => [index, signed[offset]]));
    return messages.map((message, index) => ({
      ...message,
      msn: signedByIndex.get(index) ?? message.msn,
    }));
  }
}
