import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Env, ScheduledMaintenanceMessage } from "@/env";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  liveAnchor,
  liveGoods,
  liveRoom,
  liveRoomGoods,
} from "@/models/schema";
import { systemLog } from "@/models/schema/admin";
import { normalizePublishedArticleMediaReference } from "@/services/content/ArticleContentPolicy";
import { getRoutineAccessToken, invalidateRoutineAccessToken } from "./RoutineAccessTokenService";
import { readRoutineCredentialsIfConfigured, withRoutineCredentials, type RoutineCredentials } from "./RoutineRuntimeConfig";
import { ValidateException } from "@/utils/errors";
import { renderProductPictures } from "@/services/activity/ProductAssetPolicy";
import { MAX_WECHAT_LIVE_MEDIA_REFERENCES, publicWechatLivePictures, type WechatLivePicture } from "./WechatLiveMediaPolicy";

const INVALID_TOKEN_CODES = new Set([40001, 40014, 42001]);
const MAX_WECHAT_JSON_BYTES = 512 * 1024;
const ROOM_SYNC_PAGE_SIZE = 50;
const GOODS_SYNC_PAGE_SIZE = 50;
const ANCHOR_SYNC_PAGE_SIZE = 30;
const LIVE_SYNC_LOCK = 7_404_001;
const LIVE_ADMIN_LOCK = 7_404_002;
const WECHAT_FETCH_TIMEOUT_MS = 8_000;

type JsonRecord = Record<string, unknown>;

export type WechatLiveSyncJob = "live_room_sync" | "live_goods_sync" | "live_anchor_sync";

export interface AdminLiveActor {
  id: number;
  name: string;
  ip: string;
}

export interface AdminLiveAnchorInput {
  id: number;
  name: string;
  wechat: string;
  phone: string;
  coverImg: string;
}

export interface RemoteLiveRoom {
  roomId: number;
  name: string;
  coverImg: string;
  shareImg: string;
  liveStatus: number;
  startTime: number;
  endTime: number;
  anchorName: string;
}

interface RemoteLiveRoomPage {
  rooms: RemoteLiveRoom[];
  rawCount: number;
  total: number | null;
}

interface RemoteLiveAnchor {
  username: string;
  nickname: string;
  headingImg: string;
  updatedAt: number;
}

interface RemoteLiveAnchorPage {
  anchors: RemoteLiveAnchor[];
  rawCount: number;
}

export interface RemoteLiveGoodsStatus {
  goodsId: number;
  auditStatus: number;
}

export class WechatLiveApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "WechatLiveApiError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeInteger(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function strictText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const normalized = value.trim();
  if (!normalized) throw new ValidateException(`${label}不能为空`);
  if ([...normalized].length > maximum) throw new ValidateException(`${label}不能超过${maximum}个字符`);
  return normalized;
}

function positiveId(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

function binaryValue(value: unknown, label: string): 0 | 1 {
  const parsed = Number(value);
  if (parsed !== 0 && parsed !== 1) throw new ValidateException(`${label}只能为0或1`);
  return parsed;
}

function rejectUnknown(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const permitted = new Set(allowed);
  const unknown = Object.keys(input).filter((key) => !permitted.has(key));
  if (unknown.length) throw new ValidateException(`${label}包含未知字段: ${unknown.join(", ")}`);
}

export function normalizeAdminLiveAnchorInput(input: Record<string, unknown>): AdminLiveAnchorInput {
  rejectUnknown(input, ["id", "name", "wechat", "phone", "cover_img", "coverImg"], "主播请求");
  if (Object.hasOwn(input, "cover_img") && Object.hasOwn(input, "coverImg")) {
    throw new ValidateException("主播图像字段重复");
  }
  const phone = strictText(input.phone, "手机号", 20);
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new ValidateException("请输入正确手机号");
  const coverImg = normalizePublishedArticleMediaReference(
    Object.hasOwn(input, "cover_img") ? input.cover_img : input.coverImg,
    "主播图像",
  );
  if (!coverImg) throw new ValidateException("请选择主播图像");
  return {
    id: input.id === undefined || input.id === null || input.id === "" ? 0 : positiveId(input.id, "主播ID"),
    name: strictText(input.name, "主播名称", 20),
    wechat: strictText(input.wechat, "主播微信号", 32),
    phone,
    coverImg,
  };
}

async function configureAdminWriteTx(tx: DbClient): Promise<void> {
  await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
  await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
}

async function auditAdminLive(
  tx: DbClient,
  actor: AdminLiveActor,
  path: string,
  method: string,
  action: string,
): Promise<void> {
  await tx.insert(systemLog).values({
    adminId: actor.id,
    adminName: actor.name.slice(0, 64),
    path: path.slice(0, 128),
    page: "/marketing/live",
    method,
    action: action.slice(0, 255),
    ip: actor.ip.slice(0, 45),
    type: "wechat_live",
    addTime: Math.floor(Date.now() / 1_000),
  });
}

function intParam(
  value: string | undefined,
  label: string,
  options: { fallback: number; min: number; max: number },
): number {
  if (value === undefined || value === "") return options.fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < options.min || parsed > options.max) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

function formatMonthDayTime(epochSeconds: number): string {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds <= 0) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochSeconds * 1_000));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("month")}/${value("day")} ${value("hour")}:${value("minute")}`;
}

function publicLiveStatus(status: number): number {
  if (status === 105 || status === 106) return 101;
  if (status === 104 || status === 107) return 103;
  return status;
}

function adminRoomRow(row: typeof liveRoom.$inferSelect) {
  return {
    ...row,
    room_id: row.roomId,
    cover_img: row.coverImg,
    share_img: row.shareImg,
    start_time: row.startTime,
    end_time: row.endTime,
    anchor_name: row.anchorName,
    anchor_wechat: row.anchorWechat,
    screen_type: row.screenType,
    live_status: row.liveStatus,
    replay_status: row.replayStatus,
    is_show: row.isShow,
    is_del: row.isDel,
    add_time: row.addTime,
  };
}

function adminGoodsRow(row: typeof liveGoods.$inferSelect) {
  return {
    ...row,
    goods_id: row.goodsId,
    audit_id: row.auditId,
    product_id: row.productId,
    cover_img: row.coverImg,
    price_type: row.priceType,
    cost_price: row.costPrice,
    price2: row.price2,
    audit_status: row.auditStatus,
    third_part_tag: row.thirdPartTag,
    is_show: row.isShow,
    is_del: row.isDel,
    add_time: row.addTime,
  };
}

function adminAnchorRow(row: typeof liveAnchor.$inferSelect) {
  return {
    ...row,
    cover_img: row.coverImg,
    is_show: row.isShow,
    is_del: row.isDel,
    add_time: row.addTime,
  };
}

async function readBoundedJson(response: Response): Promise<JsonRecord> {
  const declared = Number(response.headers.get("Content-Length") ?? 0);
  if (declared > MAX_WECHAT_JSON_BYTES) {
    throw new WechatLiveApiError(response.status, "微信直播响应超过大小限制");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new WechatLiveApiError(response.status, "微信直播响应为空");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_WECHAT_JSON_BYTES) {
        await reader.cancel();
        throw new WechatLiveApiError(response.status, "微信直播响应超过大小限制");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WechatLiveApiError(response.status, "微信直播响应不是有效 JSON");
  }
  if (!isRecord(parsed)) throw new WechatLiveApiError(response.status, "微信直播响应格式无效");
  return parsed;
}

class WechatLiveApiClient {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
    private readonly fetcher: typeof fetch,
  ) {}

  async credentials(): Promise<RoutineCredentials | null> {
    const credentials = await readRoutineCredentialsIfConfigured(this.container, this.env);
    return credentials ? Object.freeze(credentials) : null;
  }

  async assertCurrent(credentials: RoutineCredentials): Promise<void> {
    await withRoutineCredentials(this.container, this.env, credentials.stamp, async (_bound, current) => {
      if (current.appId !== credentials.appId || current.secret !== credentials.secret)
        throw new ValidateException('小程序微信配置已变化，请重新授权');
    });
  }

  async rooms(start: number, limit: number, credentials: RoutineCredentials): Promise<RemoteLiveRoomPage> {
    const data = await this.request("wxa/business/getliveinfo", {
      method: "POST",
      body: { start, limit },
    }, credentials);
    const raw = Array.isArray(data.room_info) ? data.room_info : [];
    const rooms = raw.flatMap((value): RemoteLiveRoom[] => {
      if (!isRecord(value)) return [];
      const roomId = safeInteger(value.roomid);
      if (roomId <= 0) return [];
      return [{
        roomId,
        name: boundedString(value.name, 32),
        coverImg: boundedString(value.cover_img, 255),
        shareImg: boundedString(value.share_img, 255),
        liveStatus: safeInteger(value.live_status, 102),
        startTime: safeInteger(value.start_time),
        endTime: safeInteger(value.end_time),
        anchorName: boundedString(value.anchor_name, 50),
      }];
    });
    const total = safeInteger(data.total, -1);
    return { rooms, rawCount: raw.length, total: total >= 0 ? total : null };
  }

  async playbacks(roomId: number, start: number, limit: number, credentials: RoutineCredentials): Promise<JsonRecord> {
    return this.request("wxa/business/getliveinfo", {
      method: "POST",
      body: { action: "get_replay", room_id: roomId, start, limit },
    }, credentials);
  }

  async goodsStatuses(goodsIds: number[], credentials: RoutineCredentials): Promise<RemoteLiveGoodsStatus[]> {
    if (!goodsIds.length) return [];
    const query = new URLSearchParams();
    for (const goodsId of goodsIds) query.append("goods_ids[]", String(goodsId));
    const data = await this.request("wxa/business/getgoodswarehouse", {
      method: "GET",
      query,
    }, credentials);
    const raw = Array.isArray(data.goods)
      ? data.goods
      : Array.isArray(data.goods_list)
        ? data.goods_list
        : [];
    return raw.flatMap((value): RemoteLiveGoodsStatus[] => {
      if (!isRecord(value)) return [];
      const goodsId = safeInteger(value.goods_id);
      const auditStatus = safeInteger(value.audit_status, -1);
      if (goodsId <= 0 || auditStatus < 0) return [];
      return [{ goodsId, auditStatus }];
    });
  }

  async anchors(offset: number, limit: number, keyword: string, credentials: RoutineCredentials): Promise<RemoteLiveAnchorPage> {
    const query = new URLSearchParams({
      role: "2",
      offset: String(Math.max(0, Math.trunc(offset))),
      limit: String(Math.min(ANCHOR_SYNC_PAGE_SIZE, Math.max(1, Math.trunc(limit)))),
    });
    if (keyword) query.set("keyword", keyword.slice(0, 32));
    const data = await this.request("wxaapi/broadcast/role/getrolelist", {
      method: "GET",
      query,
    }, credentials);
    const raw = Array.isArray(data.list) ? data.list : [];
    const anchors = raw.flatMap((value): RemoteLiveAnchor[] => {
      if (!isRecord(value)) return [];
      const username = boundedString(value.username, 32).trim();
      if (!username) return [];
      return [{
        username,
        nickname: boundedString(value.nickname, 50).trim(),
        headingImg: boundedString(value.headingimg, 255).trim(),
        updatedAt: Math.max(0, safeInteger(value.updateTimestamp)),
      }];
    });
    return { anchors, rawCount: raw.length };
  }

  async hasAnchorRole(wechat: string, credentials: RoutineCredentials): Promise<boolean> {
    const page = await this.anchors(0, ANCHOR_SYNC_PAGE_SIZE, wechat, credentials);
    return page.anchors.some((anchor) => anchor.username === wechat);
  }

  private async request(
    path: string,
    options: { method: "GET" | "POST"; body?: JsonRecord; query?: URLSearchParams },
    credentials: RoutineCredentials,
  ): Promise<JsonRecord> {
    if (!/^[a-z0-9_/-]+$/i.test(path)) throw new Error("Invalid WeChat API path");
    let token = await getRoutineAccessToken(this.container, this.env, credentials, { fetcher: this.fetcher });
    let data: JsonRecord;
    try {
      data = await this.requestWithToken(path, token, options);
    } catch (error) {
      if (!(error instanceof WechatLiveApiError) || !INVALID_TOKEN_CODES.has(error.code)) throw error;
      await this.assertCurrent(credentials);
      await invalidateRoutineAccessToken(this.env, credentials);
      token = await getRoutineAccessToken(this.container, this.env, credentials, { fetcher: this.fetcher, forceRefresh: true });
      data = await this.requestWithToken(path, token, options);
    }
    await this.assertCurrent(credentials);
    return data;
  }

  private async requestWithToken(
    path: string,
    token: string,
    options: { method: "GET" | "POST"; body?: JsonRecord; query?: URLSearchParams },
  ): Promise<JsonRecord> {
    const url = new URL(path, "https://api.weixin.qq.com/");
    url.searchParams.set("access_token", token);
    options.query?.forEach((value, key) => url.searchParams.append(key, value));
    const response = await this.fetcher(url, {
      method: options.method,
      headers: options.method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: options.method === "POST" ? JSON.stringify(options.body ?? {}) : undefined,
      signal: AbortSignal.timeout(WECHAT_FETCH_TIMEOUT_MS),
    });
    const data = await readBoundedJson(response);
    const errorCode = safeInteger(data.errcode);
    if (!response.ok || errorCode !== 0) {
      throw new WechatLiveApiError(
        errorCode || response.status,
        `微信直播接口失败: ${boundedString(data.errmsg, 200) || response.statusText}`,
      );
    }
    return data;
  }
}

export class WechatLiveService {
  private readonly remote: WechatLiveApiClient;

  constructor(
    private readonly container: Container,
    private readonly env: Env,
    fetcher: typeof fetch = fetch,
  ) {
    this.remote = new WechatLiveApiClient(container, env, fetcher);
  }

  async publicRooms(query: Record<string, string>) {
    const page = intParam(query.page, "页码", { fallback: 1, min: 1, max: 1_000_000 });
    const limit = intParam(query.limit, "每页数量", { fallback: 20, min: 1, max: 50 });
    const snapshot = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const rooms = await tx
        .select()
        .from(liveRoom)
        .where(and(eq(liveRoom.isShow, 1), eq(liveRoom.isDel, 0)))
        .orderBy(desc(liveRoom.sort), desc(liveRoom.id), asc(liveRoom.phone))
        .limit(limit)
        .offset((page - 1) * limit);
      if (!rooms.length) return { rooms: [], references: [] as string[] };

      const roomIds = [...new Set(rooms.map((room) => room.id))];
      const anchorIds = [...new Set(rooms.map((room) => room.anchorWechat).filter(Boolean))];
      const relations = await tx
        .select()
        .from(liveRoomGoods)
        .where(inArray(liveRoomGoods.liveRoomId, roomIds)).limit(MAX_WECHAT_LIVE_MEDIA_REFERENCES + 1);
      if (relations.length > MAX_WECHAT_LIVE_MEDIA_REFERENCES) throw new ValidateException("直播关联超过完整预览容量");
      const goodsIds = [...new Set(relations.map((relation) => relation.liveGoodsId))];
      const [goodsRows, anchorRows] = await Promise.all([
        goodsIds.length
          ? tx.select().from(liveGoods).where(inArray(liveGoods.id, goodsIds))
          : Promise.resolve([]),
        anchorIds.length
          ? tx
              .select()
              .from(liveAnchor)
              .where(and(
                inArray(liveAnchor.wechat, anchorIds),
                eq(liveAnchor.isShow, 1),
                eq(liveAnchor.isDel, 0),
              ))
              .orderBy(asc(liveAnchor.id)).limit(MAX_WECHAT_LIVE_MEDIA_REFERENCES + 1)
          : Promise.resolve([]),
      ]);
      if (anchorRows.length > MAX_WECHAT_LIVE_MEDIA_REFERENCES) throw new ValidateException("直播主播超过完整预览容量");
      const goodsById = new Map(goodsRows.map((row) => [row.id, row]));
      const anchorByWechat = new Map<string, typeof liveAnchor.$inferSelect>();
      for (const anchor of anchorRows) {
        if (!anchorByWechat.has(anchor.wechat)) anchorByWechat.set(anchor.wechat, anchor);
      }
      const relationsByRoom = new Map<number, typeof relations>();
      for (const relation of relations) {
        const bucket = relationsByRoom.get(relation.liveRoomId) ?? [];
        bucket.push(relation);
        relationsByRoom.set(relation.liveRoomId, bucket);
      }

      const output = rooms.map((room) => {
        const normalizedStatus = publicLiveStatus(room.liveStatus);
        const anchor = anchorByWechat.get(room.anchorWechat);
        const goods = (relationsByRoom.get(room.id) ?? [])
          .map((relation) => goodsById.get(relation.liveGoodsId))
          .filter((value): value is typeof liveGoods.$inferSelect => Boolean(value))
          .map((good) => ({
            id: good.id,
            goods_id: good.goodsId,
            product_id: good.productId,
            name: good.name,
            cover_img: good.coverImg,
            url: good.url,
            price_type: good.priceType,
            price: good.price,
            price2: good.price2,
          }));
        return {
          id: room.id,
          room_id: room.roomId,
          roomid: room.roomId,
          name: room.name,
          cover_img: room.coverImg,
          share_img: room.shareImg,
          start_time: room.startTime,
          end_time: room.endTime,
          show_time: formatMonthDayTime(room.startTime),
          anchor_name: room.anchorName,
          anchor_img: anchor?.coverImg ?? "",
          type: room.type,
          screen_type: room.screenType,
          live_status: normalizedStatus,
          replay_status: room.replayStatus,
          goods,
        };
      });
      const pictures: WechatLivePicture[] = output.flatMap(room => [
        { image: room.cover_img, scope: 'platform' as const },
        { image: room.share_img, scope: 'platform' as const },
        { image: room.anchor_img, scope: 'platform' as const },
        ...room.goods.map(good => ({ image: good.cover_img, scope: 'product' as const, productId: good.product_id })),
      ]);
      return { rooms: output, references: await publicWechatLivePictures(tx, pictures) };
    });
    const rendered = await renderProductPictures(this.env.APP_KEY, snapshot.references);
    let cursor = 0;
    return snapshot.rooms.map(room => ({ ...room, cover_img: rendered[cursor++], share_img: rendered[cursor++], anchor_img: rendered[cursor++],
      goods: room.goods.map(good => ({ ...good, cover_img: rendered[cursor++] })),
    }));
  }

  async playbacks(idValue: string, query: Record<string, string>) {
    const id = intParam(idValue, "直播间 ID", { fallback: 0, min: 1, max: 2_147_483_647 });
    const page = intParam(query.page, "页码", { fallback: 1, min: 1, max: 1_000_000 });
    const limit = intParam(query.limit, "每页数量", { fallback: 20, min: 1, max: 50 });
    const rows = await this.container.db
      .select({ id: liveRoom.id, phone: liveRoom.phone, roomId: liveRoom.roomId })
      .from(liveRoom)
      .where(and(eq(liveRoom.id, id), eq(liveRoom.isDel, 0)))
      .orderBy(asc(liveRoom.phone))
      .limit(2);
    if (!rows[0]) throw new ValidateException("直播间不存在");
    if (rows.length > 1) throw new ValidateException("直播间 ID 在源复合主键下不唯一");
    if (rows[0].roomId <= 0) throw new ValidateException("直播间尚未关联微信 room_id");
    const credentials = await this.source();
    if (!credentials) throw new ValidateException("小程序 AppID 或 AppSecret 未配置");
    const data = await this.remote.playbacks(rows[0].roomId, (page - 1) * limit, limit, credentials);
    return {
      list: Array.isArray(data.live_replay) ? data.live_replay : [],
      total: safeInteger(data.total),
      room_id: rows[0].roomId,
      runtime_authority: "wechat_read_only",
    };
  }

  async adminRooms(query: Record<string, string>) {
    const { page, limit, keyword } = this.listQuery(query);
    const status = intParam(query.status, "直播状态", { fallback: 0, min: 0, max: 3 });
    const conditions: SQL[] = [eq(liveRoom.isDel, 0)];
    if (keyword) {
      const match = or(
        ilike(liveRoom.name, `%${keyword}%`),
        ilike(liveRoom.anchorName, `%${keyword}%`),
        ilike(liveRoom.anchorWechat, `%${keyword}%`),
      );
      if (match) conditions.push(match);
    }
    if (status === 1) conditions.push(inArray(liveRoom.liveStatus, [101, 105, 106]));
    if (status === 2) conditions.push(eq(liveRoom.liveStatus, 102));
    if (status === 3) conditions.push(inArray(liveRoom.liveStatus, [103, 104, 107]));
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db
        .select()
        .from(liveRoom)
        .where(where)
        .orderBy(desc(liveRoom.sort), desc(liveRoom.id), asc(liveRoom.phone))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(liveRoom).where(where),
    ]);
    return {
      list: rows.map(adminRoomRow),
      count: Number(totals[0]?.value ?? 0),
      remote_writes: "not_migrated_non_idempotent",
    };
  }

  async adminRoomDetail(idValue: unknown) {
    const id = positiveId(idValue, "直播间ID");
    const rows = await this.container.db.select().from(liveRoom).where(and(
      eq(liveRoom.id, id),
      eq(liveRoom.isDel, 0),
    )).orderBy(asc(liveRoom.phone)).limit(2);
    if (!rows[0]) throw new ValidateException("直播间不存在或已删除");
    if (rows.length > 1) throw new ValidateException("直播间 ID 在源复合主键下不唯一");
    return { ...adminRoomRow(rows[0]), remote_writes: "not_migrated_non_idempotent" as const };
  }

  async setRoomVisibility(idValue: unknown, showValue: unknown, actor: AdminLiveActor) {
    const id = positiveId(idValue, "直播间ID");
    const isShow = binaryValue(showValue, "显示状态");
    return withTx(this.container, async (tx) => {
      await configureAdminWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LIVE_ADMIN_LOCK}, 2)`);
      const rows = await tx.select().from(liveRoom).where(and(
        eq(liveRoom.id, id),
        eq(liveRoom.isDel, 0),
      )).orderBy(asc(liveRoom.phone)).limit(2).for("update");
      if (!rows[0]) throw new ValidateException("直播间不存在或已删除");
      if (rows.length > 1) throw new ValidateException("直播间 ID 在源复合主键下不唯一");
      const updated = await tx.update(liveRoom).set({ isShow }).where(and(
        eq(liveRoom.id, id),
        eq(liveRoom.phone, rows[0].phone),
        eq(liveRoom.isDel, 0),
      )).returning();
      if (!updated[0] || updated[0].isShow !== isShow) {
        throw new Error("wechat_live_room_visibility_readback_mismatch");
      }
      await auditAdminLive(
        tx,
        actor,
        `/adminapi/live/room/set_show/${id}/${isShow}`,
        "GET",
        `live.room.visibility;id=${id};show=${isShow}`,
      );
      return { room: adminRoomRow(updated[0]), verified: true as const };
    });
  }

  async removeRoom(idValue: unknown, actor: AdminLiveActor) {
    const id = positiveId(idValue, "直播间ID");
    return withTx(this.container, async (tx) => {
      await configureAdminWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LIVE_ADMIN_LOCK}, 2)`);
      const rows = await tx.select().from(liveRoom).where(and(
        eq(liveRoom.id, id),
        eq(liveRoom.isDel, 0),
      )).orderBy(asc(liveRoom.phone)).limit(2).for("update");
      if (!rows[0]) throw new ValidateException("直播间不存在或已删除");
      if (rows.length > 1) throw new ValidateException("直播间 ID 在源复合主键下不唯一");
      await tx.delete(liveRoomGoods).where(eq(liveRoomGoods.liveRoomId, id));
      const updated = await tx.update(liveRoom).set({ isDel: 1, isShow: 0 }).where(and(
        eq(liveRoom.id, id),
        eq(liveRoom.phone, rows[0].phone),
        eq(liveRoom.isDel, 0),
      )).returning({ id: liveRoom.id, isDel: liveRoom.isDel, isShow: liveRoom.isShow });
      if (!updated[0] || updated[0].isDel !== 1 || updated[0].isShow !== 0) {
        throw new Error("wechat_live_room_delete_readback_mismatch");
      }
      await auditAdminLive(
        tx,
        actor,
        `/adminapi/live/room/del/${id}`,
        "DELETE",
        `live.room.delete;id=${id};relations=removed`,
      );
      return { id, deleted: true as const, relations_removed: true as const, verified: true as const };
    });
  }

  async adminGoods(query: Record<string, string>) {
    const { page, limit, keyword } = this.listQuery(query);
    const status = intParam(query.status, "审核状态", { fallback: 99, min: -1, max: 99 });
    const conditions: SQL[] = [eq(liveGoods.isDel, 0)];
    if (keyword) {
      const match = or(
        ilike(liveGoods.name, `%${keyword}%`),
        sql`CAST(${liveGoods.productId} AS TEXT) ILIKE ${`%${keyword}%`}`,
        sql`CAST(${liveGoods.goodsId} AS TEXT) ILIKE ${`%${keyword}%`}`,
      );
      if (match) conditions.push(match);
    }
    if (status === 1) conditions.push(eq(liveGoods.auditStatus, 2));
    if (status === 0) conditions.push(inArray(liveGoods.auditStatus, [0, 1]));
    if (status === -1) conditions.push(eq(liveGoods.auditStatus, 3));
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db
        .select()
        .from(liveGoods)
        .where(where)
        .orderBy(desc(liveGoods.sort), desc(liveGoods.addTime), desc(liveGoods.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(liveGoods).where(where),
    ]);
    return {
      list: rows.map(adminGoodsRow),
      count: Number(totals[0]?.value ?? 0),
      remote_writes: "not_migrated_non_idempotent",
    };
  }

  async adminGoodsDetail(idValue: unknown) {
    const id = positiveId(idValue, "直播商品ID");
    const row = (await this.container.db.select().from(liveGoods).where(and(
      eq(liveGoods.id, id),
      eq(liveGoods.isDel, 0),
    )).limit(1))[0];
    if (!row) throw new ValidateException("直播商品不存在或已删除");
    return { ...adminGoodsRow(row), remote_writes: "not_migrated_non_idempotent" as const };
  }

  async setGoodsVisibility(idValue: unknown, showValue: unknown, actor: AdminLiveActor) {
    const id = positiveId(idValue, "直播商品ID");
    const isShow = binaryValue(showValue, "显示状态");
    return withTx(this.container, async (tx) => {
      await configureAdminWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LIVE_ADMIN_LOCK}, 3)`);
      const existing = (await tx.select().from(liveGoods).where(and(
        eq(liveGoods.id, id),
        eq(liveGoods.isDel, 0),
      )).limit(1).for("update"))[0];
      if (!existing) throw new ValidateException("直播商品不存在或已删除");
      if (existing.auditStatus !== 2) throw new ValidateException("仅审核通过的直播商品可以切换显示状态");
      const updated = await tx.update(liveGoods).set({ isShow }).where(and(
        eq(liveGoods.id, id),
        eq(liveGoods.isDel, 0),
        eq(liveGoods.auditStatus, 2),
      )).returning();
      if (!updated[0] || updated[0].isShow !== isShow || updated[0].auditStatus !== 2) {
        throw new Error("wechat_live_goods_visibility_readback_mismatch");
      }
      await auditAdminLive(
        tx,
        actor,
        `/adminapi/live/goods/set_show/${id}/${isShow}`,
        "GET",
        `live.goods.visibility;id=${id};show=${isShow}`,
      );
      return { goods: adminGoodsRow(updated[0]), verified: true as const };
    });
  }

  async adminAnchors(query: Record<string, string>) {
    const { page, limit, keyword } = this.listQuery(query);
    const conditions: SQL[] = [eq(liveAnchor.isDel, 0)];
    if (keyword) {
      const match = or(
        ilike(liveAnchor.name, `%${keyword}%`),
        ilike(liveAnchor.wechat, `%${keyword}%`),
        ilike(liveAnchor.phone, `%${keyword}%`),
      );
      if (match) conditions.push(match);
    }
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db
        .select()
        .from(liveAnchor)
        .where(where)
        .orderBy(desc(liveAnchor.addTime), desc(liveAnchor.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(liveAnchor).where(where),
    ]);
    return {
      list: rows.map(adminAnchorRow),
      count: Number(totals[0]?.value ?? 0),
      remote_role_sync: "read_only_queue",
    };
  }

  async adminAnchorForm(idValue: unknown) {
    const numeric = Number(idValue);
    if (numeric === 0) {
      return { id: 0, name: "", wechat: "", phone: "", cover_img: "", is_show: 1 };
    }
    const id = positiveId(idValue, "主播ID");
    const row = (await this.container.db.select().from(liveAnchor).where(and(
      eq(liveAnchor.id, id),
      eq(liveAnchor.isDel, 0),
    )).limit(1))[0];
    if (!row) throw new ValidateException("主播不存在或已删除");
    return adminAnchorRow(row);
  }

  async saveAnchor(rawInput: Record<string, unknown>, actor: AdminLiveActor) {
    const input = normalizeAdminLiveAnchorInput(rawInput);
    const credentials = await this.source();
    if (!credentials) throw new ValidateException("小程序 AppID 或 AppSecret 未配置");
    if (!(await this.remote.hasAnchorRole(input.wechat, credentials))) {
      throw new ValidateException("该微信号尚未通过小程序主播身份认证");
    }
    return withRoutineCredentials(this.container, this.env, credentials.stamp, async ({ db: tx }) => {
      await configureAdminWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LIVE_ADMIN_LOCK}, 1)`);
      let id = input.id;
      let existing: typeof liveAnchor.$inferSelect | undefined;
      if (id > 0) {
        existing = (await tx.select().from(liveAnchor).where(and(
          eq(liveAnchor.id, id),
          eq(liveAnchor.isDel, 0),
        )).limit(1).for("update"))[0];
        if (!existing) throw new ValidateException("主播不存在或已删除");
      }
      const duplicates = await tx.select({ id: liveAnchor.id }).from(liveAnchor).where(and(
        eq(liveAnchor.wechat, input.wechat),
        eq(liveAnchor.isDel, 0),
      )).limit(2).for("update");
      if (duplicates.some((row) => row.id !== id)) throw new ValidateException("该主播已经存在");
      if (existing && existing.wechat !== input.wechat) {
        const referenced = await tx.select({ value: count() }).from(liveRoom).where(and(
          eq(liveRoom.anchorWechat, existing.wechat),
          eq(liveRoom.isDel, 0),
        ));
        if (Number(referenced[0]?.value ?? 0) > 0) {
          throw new ValidateException("该主播仍有关联直播间，不能修改微信号");
        }
      }
      const values = {
        name: input.name,
        wechat: input.wechat,
        phone: input.phone,
        coverImg: input.coverImg,
      };
      if (id > 0) {
        await tx.update(liveAnchor).set(values).where(and(
          eq(liveAnchor.id, id),
          eq(liveAnchor.isDel, 0),
        ));
      } else {
        const inserted = await tx.insert(liveAnchor).values({
          ...values,
          isShow: 1,
          isDel: 0,
          addTime: Math.floor(Date.now() / 1_000),
        }).returning({ id: liveAnchor.id });
        id = inserted[0]?.id ?? 0;
        if (!id) throw new Error("wechat_live_anchor_insert_failed");
      }
      const verified = (await tx.select().from(liveAnchor).where(eq(liveAnchor.id, id)).limit(1))[0];
      if (!verified || verified.isDel !== 0 || verified.name !== input.name
        || verified.wechat !== input.wechat || verified.phone !== input.phone
        || verified.coverImg !== input.coverImg) {
        throw new Error("wechat_live_anchor_save_readback_mismatch");
      }
      await auditAdminLive(
        tx,
        actor,
        "/adminapi/live/anchor/save",
        "POST",
        `live.anchor.${input.id ? "update" : "create"};id=${id};role=verified`,
      );
      return { anchor: adminAnchorRow(verified), role_verified: true as const, verified: true as const };
    });
  }

  async setAnchorVisibility(idValue: unknown, showValue: unknown, actor: AdminLiveActor) {
    const id = positiveId(idValue, "主播ID");
    const isShow = binaryValue(showValue, "显示状态");
    return withTx(this.container, async (tx) => {
      await configureAdminWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LIVE_ADMIN_LOCK}, 1)`);
      const existing = (await tx.select({ id: liveAnchor.id }).from(liveAnchor).where(and(
        eq(liveAnchor.id, id),
        eq(liveAnchor.isDel, 0),
      )).limit(1).for("update"))[0];
      if (!existing) throw new ValidateException("主播不存在或已删除");
      const updated = await tx.update(liveAnchor).set({ isShow }).where(and(
        eq(liveAnchor.id, id),
        eq(liveAnchor.isDel, 0),
      )).returning();
      if (!updated[0] || updated[0].isShow !== isShow) {
        throw new Error("wechat_live_anchor_visibility_readback_mismatch");
      }
      await auditAdminLive(
        tx,
        actor,
        `/adminapi/live/anchor/set_show/${id}/${isShow}`,
        "GET",
        `live.anchor.visibility;id=${id};show=${isShow}`,
      );
      return { anchor: adminAnchorRow(updated[0]), verified: true as const };
    });
  }

  async removeAnchor(idValue: unknown, actor: AdminLiveActor) {
    const id = positiveId(idValue, "主播ID");
    return withTx(this.container, async (tx) => {
      await configureAdminWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LIVE_ADMIN_LOCK}, 1)`);
      const existing = (await tx.select().from(liveAnchor).where(and(
        eq(liveAnchor.id, id),
        eq(liveAnchor.isDel, 0),
      )).limit(1).for("update"))[0];
      if (!existing) throw new ValidateException("主播不存在或已删除");
      const referenced = await tx.select({ value: count() }).from(liveRoom).where(and(
        eq(liveRoom.anchorWechat, existing.wechat),
        eq(liveRoom.isDel, 0),
      ));
      if (Number(referenced[0]?.value ?? 0) > 0) {
        throw new ValidateException("该主播仍有关联直播间，请先处理直播间");
      }
      const updated = await tx.update(liveAnchor).set({ isDel: 1, isShow: 0 }).where(and(
        eq(liveAnchor.id, id),
        eq(liveAnchor.isDel, 0),
      )).returning({ id: liveAnchor.id, isDel: liveAnchor.isDel, isShow: liveAnchor.isShow });
      if (!updated[0] || updated[0].isDel !== 1 || updated[0].isShow !== 0) {
        throw new Error("wechat_live_anchor_delete_readback_mismatch");
      }
      await auditAdminLive(
        tx,
        actor,
        `/adminapi/live/anchor/del/${id}`,
        "DELETE",
        `live.anchor.delete;id=${id};references=0`,
      );
      return { id, deleted: true as const, verified: true as const };
    });
  }

  async enqueueSync(scheduledAt = Date.now()): Promise<{ run_id: string; jobs: WechatLiveSyncJob[] }> {
    const credentials = await this.source();
    if (!credentials) throw new ValidateException("小程序 AppID 或 AppSecret 未配置");
    return this.enqueueFromSource(scheduledAt, credentials);
  }

  /** A dispatch starts a new current-source request; it never adopts an old
   * page's remote result. Cron itself remains entirely off the database. */
  async dispatchSync(message: ScheduledMaintenanceMessage): Promise<Record<string, unknown>> {
    const credentials = await this.source();
    if (!credentials) return { event: 'wechat_live_sync_dispatch_disabled', job: message.job, runId: message.runId };
    const result = await this.enqueueFromSource(message.scheduledAt, credentials);
    return { event: 'wechat_live_sync_dispatched', job: message.job, runId: message.runId, ...result };
  }

  private async enqueueFromSource(scheduledAt: number, credentials: RoutineCredentials): Promise<{ run_id: string; jobs: WechatLiveSyncJob[] }> {
    const normalized = Math.max(1, Math.trunc(scheduledAt));
    const runId = `scheduled:${normalized}`;
    const jobs: WechatLiveSyncJob[] = ["live_room_sync", "live_goods_sync", "live_anchor_sync"];
    const messages: ScheduledMaintenanceMessage[] = jobs.map((job) => ({
      action: "runScheduledMaintenance",
      job,
      runId,
      scheduledAt: normalized,
      cursor: 0,
      threshold: null,
      routineStamp: credentials.stamp,
    }));
    await this.env.ORDER_QUEUE.sendBatch(
      messages.map((body) => ({ body, contentType: "json" as const })),
    );
    await this.remote.assertCurrent(credentials);
    return { run_id: runId, jobs };
  }

  async syncRooms(message: ScheduledMaintenanceMessage): Promise<Record<string, unknown>> {
    return this.runSync(message, 'room', credentials => this.syncRoomsFromSource(message, credentials));
  }

  private async syncRoomsFromSource(message: ScheduledMaintenanceMessage, credentials: RoutineCredentials): Promise<Record<string, unknown>> {
    const remotePage = await this.remote.rooms(message.cursor, ROOM_SYNC_PAGE_SIZE, credentials);
    let inserted = 0;
    let updated = 0;
    await withRoutineCredentials(this.container, this.env, credentials.stamp, async ({ db: tx }) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LIVE_SYNC_LOCK}, 1)`);
      for (const room of remotePage.rooms) {
        const changed = await tx
          .update(liveRoom)
          .set({
            name: room.name,
            coverImg: room.coverImg,
            shareImg: room.shareImg,
            liveStatus: room.liveStatus,
            startTime: room.startTime,
            endTime: room.endTime,
            anchorName: room.anchorName,
          })
          .where(eq(liveRoom.roomId, room.roomId))
          .returning({ id: liveRoom.id });
        if (changed.length) {
          updated += changed.length;
          continue;
        }
        await tx.insert(liveRoom).values({
          roomId: room.roomId,
          name: room.name,
          coverImg: room.coverImg,
          shareImg: room.shareImg,
          liveStatus: room.liveStatus,
          startTime: room.startTime,
          endTime: room.endTime,
          anchorName: room.anchorName,
          addTime: Math.floor(message.scheduledAt / 1_000),
        });
        inserted += 1;
      }
    });
    const nextCursor = message.cursor + remotePage.rawCount;
    const hasMore = remotePage.total === null
      ? remotePage.rawCount === ROOM_SYNC_PAGE_SIZE
      : nextCursor < remotePage.total;
    if (hasMore && remotePage.rawCount > 0) await this.sendContinuation(message, nextCursor, credentials);
    return {
      event: "wechat_live_room_sync",
      job: message.job,
      runId: message.runId,
      cursor: message.cursor,
      fetched: remotePage.rooms.length,
      rawCount: remotePage.rawCount,
      total: remotePage.total,
      nextCursor,
      inserted,
      updated,
      hasMore,
    };
  }

  async syncGoods(message: ScheduledMaintenanceMessage): Promise<Record<string, unknown>> {
    return this.runSync(message, 'goods', credentials => this.syncGoodsFromSource(message, credentials));
  }

  private async syncGoodsFromSource(message: ScheduledMaintenanceMessage, credentials: RoutineCredentials): Promise<Record<string, unknown>> {
    const candidates = await this.container.db
      .select({ id: liveGoods.id, goodsId: liveGoods.goodsId })
      .from(liveGoods)
      .where(and(
        gt(liveGoods.id, message.cursor),
        gt(liveGoods.goodsId, 0),
        inArray(liveGoods.auditStatus, [0, 1]),
      ))
      .orderBy(asc(liveGoods.id))
      .limit(GOODS_SYNC_PAGE_SIZE);
    const statuses = await this.remote.goodsStatuses(candidates.map((row) => row.goodsId), credentials);
    let updated = 0;
    await withRoutineCredentials(this.container, this.env, credentials.stamp, async ({ db: tx }) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LIVE_SYNC_LOCK}, 2)`);
      for (const status of statuses) {
        const changed = await tx
          .update(liveGoods)
          .set({ auditStatus: status.auditStatus })
          .where(eq(liveGoods.goodsId, status.goodsId))
          .returning({ id: liveGoods.id });
        updated += changed.length;
      }
    });
    const nextCursor = candidates.at(-1)?.id ?? message.cursor;
    const hasMore = candidates.length === GOODS_SYNC_PAGE_SIZE;
    if (hasMore) await this.sendContinuation(message, nextCursor, credentials);
    return {
      event: "wechat_live_goods_sync",
      job: message.job,
      runId: message.runId,
      cursor: message.cursor,
      nextCursor,
      candidates: candidates.length,
      remoteStatuses: statuses.length,
      updated,
      hasMore,
    };
  }

  async syncAnchors(message: ScheduledMaintenanceMessage): Promise<Record<string, unknown>> {
    return this.runSync(message, 'anchor', credentials => this.syncAnchorsFromSource(message, credentials));
  }

  private async syncAnchorsFromSource(message: ScheduledMaintenanceMessage, credentials: RoutineCredentials): Promise<Record<string, unknown>> {
    const remotePage = await this.remote.anchors(message.cursor, ANCHOR_SYNC_PAGE_SIZE, "", credentials);
    let inserted = 0;
    let updated = 0;
    await withRoutineCredentials(this.container, this.env, credentials.stamp, async ({ db: tx }) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LIVE_SYNC_LOCK}, 3)`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LIVE_ADMIN_LOCK}, 1)`);
      for (const anchor of remotePage.anchors) {
        const changed = await tx.update(liveAnchor).set({
          name: anchor.nickname || anchor.username,
          coverImg: anchor.headingImg,
        }).where(and(
          eq(liveAnchor.wechat, anchor.username),
          eq(liveAnchor.isDel, 0),
        )).returning({ id: liveAnchor.id });
        if (changed.length) {
          updated += changed.length;
          continue;
        }
        await tx.insert(liveAnchor).values({
          name: anchor.nickname || anchor.username,
          wechat: anchor.username,
          coverImg: anchor.headingImg,
          addTime: anchor.updatedAt || Math.floor(message.scheduledAt / 1_000),
          isShow: 1,
          isDel: 0,
        });
        inserted += 1;
      }
    });
    const nextCursor = message.cursor + remotePage.rawCount;
    const hasMore = remotePage.rawCount === ANCHOR_SYNC_PAGE_SIZE;
    if (hasMore && remotePage.rawCount > 0) await this.sendContinuation(message, nextCursor, credentials);
    return {
      event: "wechat_live_anchor_sync",
      job: message.job,
      runId: message.runId,
      cursor: message.cursor,
      nextCursor,
      fetched: remotePage.anchors.length,
      rawCount: remotePage.rawCount,
      inserted,
      updated,
      hasMore,
    };
  }

  private listQuery(query: Record<string, string>): { page: number; limit: number; keyword: string } {
    return {
      page: intParam(query.page, "页码", { fallback: 1, min: 1, max: 1_000_000 }),
      limit: intParam(query.limit, "每页数量", { fallback: 20, min: 1, max: 100 }),
      keyword: String(query.keyword ?? query.kerword ?? "").trim().slice(0, 50),
    };
  }

  private async sendContinuation(
    message: ScheduledMaintenanceMessage,
    cursor: number,
    credentials: RoutineCredentials,
  ): Promise<void> {
    await this.remote.assertCurrent(credentials);
    const continuation: ScheduledMaintenanceMessage = { ...message, cursor, routineStamp: credentials.stamp };
    await this.env.ORDER_QUEUE.send(
      continuation,
      { contentType: "json" },
    );
    await this.remote.assertCurrent(credentials);
  }

  private source(): Promise<RoutineCredentials | null> {
    return this.remote.credentials();
  }

  private async runSync(message: ScheduledMaintenanceMessage, kind: 'room' | 'goods' | 'anchor',
    apply: (credentials: RoutineCredentials) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const ignored = (reason: 'source_missing' | 'source_changed') => ({ event: `wechat_live_${kind}_sync_ignored`,
      job: message.job, runId: message.runId, ignored: true, reauthorization_required: true, reason });
    // Returning an explicit terminal result lets the existing queue consumer
    // ACK old/rotated work. It must never adopt today's pair on a retry.
    if (typeof message.routineStamp !== 'string' || !/^[a-f0-9]{64}$/u.test(message.routineStamp)) return ignored('source_missing');
    const credentials = await this.source();
    if (!credentials) return { event: `wechat_live_${kind}_sync_disabled`, job: message.job, runId: message.runId };
    if (credentials.stamp !== message.routineStamp) return ignored('source_changed');
    try { return await apply(credentials); }
    catch (error) {
      // A page may have committed before a continuation send. That committed
      // page stays valid for its own source; no retry may switch the next page.
      const current = await this.source();
      if (!current || current.stamp !== credentials.stamp) return ignored('source_changed');
      throw error;
    }
  }
}
