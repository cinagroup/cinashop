/**
 * 订单物流查询。
 *
 * 对应 PHP `ExpressServices::query()`：当 `logistics_type=2` 时查询阿里云
 * 物流市场，并对未签收结果缓存 30 分钟。这里绝不根据订单时间生成物流节点；
 * 第三方未配置或暂时不可用时，只返回商家填写的运单及明确的降级状态。
 */
import { and, asc, eq, or, sql } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { storeOrder, storeOrderRefund } from "@/models/schema";
import { normalizeConfigScalar } from "@/utils/config";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

const ALIYUN_EXPRESS_ENDPOINT = "https://wuliu.market.alicloudapi.com/kdi";
const ACTIVE_CACHE_TTL_SECONDS = 30 * 60;
const DELIVERED_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const PROVIDER_TIMEOUT_MS = 6_000;
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const MAX_SPLIT_PACKAGES = 50;

const LEGACY_EXPRESS_CODE_MAP: Readonly<Record<string, string>> = {
  yunda: "yunda",
  yundakuaiyun: "yunda56",
  ems: "EMS",
  youzhengguonei: "chinapost",
  huitongkuaidi: "HTKY",
  baishiwuliu: "BSKY",
  shentong: "STO",
  jd: "JD",
  zhongtong: "ZTO",
  zhongtongkuaiyun: "ZTO56",
};

export type TrackingState =
  | "pending"
  | "in_transit"
  | "delivered"
  | "exception"
  | "not_configured"
  | "temporarily_unavailable";

export type TrackingSource = "merchant" | "carrier" | "cache";

export interface TraceItem {
  time: string;
  content: string;
  status: string;
}

export interface TrackingPackage {
  orderId: string;
  deliveryStatus: string;
  expressName: string;
  expressCode: string;
  expressNo: string;
  trackingState: TrackingState;
  trackingSource: TrackingSource;
  message: string;
  lastUpdatedAt: number;
  traces: TraceItem[];
}

export interface ExpressQueryResult extends TrackingPackage {
  packages: TrackingPackage[];
  /** PHP 兼容字段；旧客户端读取 `data.express[].status` 作为轨迹正文。 */
  express: Array<{ time: string; status: string }>;
  /** PHP 兼容字段；只返回展示物流所需的最小订单信息。 */
  order: {
    order_id: string;
    delivery_id: string;
    delivery_name: string;
    delivery_code: string;
    delivery_type: string;
  };
}

interface ShipmentInput {
  orderPk: number;
  orderId: string;
  orderStatus: number;
  deliveryType: string;
  expressName: string;
  expressCode: string;
  expressNo: string;
  userPhone: string;
}

export interface ParsedCarrierTracking {
  accepted: boolean;
  delivered: boolean;
  state: TrackingState;
  statusText: string;
  traces: TraceItem[];
}

interface TrackingCacheEntry {
  version: 1;
  fetchedAt: number;
  result: ParsedCarrierTracking;
}

interface LogisticsProviderConfig {
  enabled: boolean;
  appCode: string;
}

type Fetcher = typeof fetch;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integerValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) ? number : null;
}

function traceLabel(content: string): string {
  if (/签收|妥投/.test(content)) return "已签收";
  if (/派送|派件/.test(content)) return "派送中";
  if (/揽收|收件|已收入/.test(content)) return "已揽收";
  if (/异常|拒签|退回|退签|失败/.test(content)) return "运输异常";
  return "运输中";
}

export function normalizeExpressCode(code: string): string {
  const normalized = code.trim();
  if (!normalized) return "";
  return LEGACY_EXPRESS_CODE_MAP[normalized.toLowerCase()] ?? normalized;
}

export function buildAliyunTrackingUrl(expressNo: string, expressCode = ""): string {
  const url = new URL(ALIYUN_EXPRESS_ENDPOINT);
  url.searchParams.set("no", expressNo);
  const type = normalizeExpressCode(expressCode);
  if (type) url.searchParams.set("type", type);
  return url.toString();
}

/**
 * 解析阿里云物流市场旧 PHP 所使用的响应结构。
 * 轨迹文字完全来自承运商响应，不添加任何推测地点或时间。
 */
export function parseAliyunTrackingPayload(payload: unknown): ParsedCarrierTracking {
  const root = record(payload);
  const result = record(root?.result);
  if (!root || !result) {
    return {
      accepted: false,
      delivered: false,
      state: "temporarily_unavailable",
      statusText: "物流服务暂不可用",
      traces: [],
    };
  }

  const rawList = Array.isArray(result.list) ? result.list : [];
  const traces: TraceItem[] = [];
  for (const raw of rawList.slice(0, 200)) {
    const item = record(raw);
    if (!item) continue;
    const content =
      stringValue(item.status) ||
      stringValue(item.context) ||
      stringValue(item.remark);
    if (!content) continue;
    traces.push({
      time: stringValue(item.time) || stringValue(item.ftime),
      content,
      status: traceLabel(content),
    });
  }

  const deliveryStatus = integerValue(result.deliverystatus);
  const signed = result.issign === 1 || result.issign === "1" || deliveryStatus === 3;
  const exception = deliveryStatus === 4 || traces.some((item) => item.status === "运输异常");
  const dispatching = deliveryStatus === 2 || deliveryStatus === 5;
  return {
    accepted: true,
    delivered: signed,
    state: signed ? "delivered" : exception ? "exception" : traces.length ? "in_transit" : "pending",
    statusText: signed
      ? "已签收"
      : exception
        ? "运输异常"
        : dispatching
          ? "派送中"
          : traces.length
            ? "运输中"
            : "等待承运商更新",
    traces,
  };
}

export async function readBoundedJson(
  response: Response,
  maxBytes = MAX_PROVIDER_RESPONSE_BYTES,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("物流服务响应超过大小限制");
  }
  if (!response.body) throw new Error("物流服务响应为空");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("response too large");
      throw new Error("物流服务响应超过大小限制");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function isTrackingCacheEntry(value: unknown): value is TrackingCacheEntry {
  const item = record(value);
  const result = record(item?.result);
  return (
    item?.version === 1 &&
    Number.isInteger(item.fetchedAt) &&
    result !== null &&
    typeof result.accepted === "boolean" &&
    typeof result.delivered === "boolean" &&
    typeof result.statusText === "string" &&
    Array.isArray(result.traces)
  );
}

function providerNumber(shipment: ShipmentInput): string {
  if (
    shipment.expressCode.toLowerCase() === "shunfengkuaiyun" &&
    shipment.userPhone &&
    !shipment.expressNo.includes(":")
  ) {
    return `${shipment.expressNo}:${shipment.userPhone.slice(0, -4)}`;
  }
  return shipment.expressNo;
}

async function cacheKey(shipment: ShipmentInput): Promise<string> {
  const material = `${shipment.orderPk}\u0000${shipment.expressCode}\u0000${shipment.expressNo}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `tracking_v1_${hex}`;
}

function fallbackPackage(
  shipment: ShipmentInput,
  state: TrackingState,
  message: string,
): TrackingPackage {
  const received = shipment.orderStatus >= 2;
  return {
    orderId: shipment.orderId,
    deliveryStatus: received ? "已收货" : shipment.expressNo ? "已发货" : "未发货",
    expressName: shipment.expressName,
    expressCode: shipment.expressCode,
    expressNo: shipment.expressNo,
    trackingState: state,
    trackingSource: "merchant",
    message,
    lastUpdatedAt: 0,
    traces: [],
  };
}

export class ExpressService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  /** 查询订单或 PHP 兼容的退款物流。 */
  async query(uid: number, orderId: string, type = ""): Promise<ExpressQueryResult> {
    const normalizedOrderId = orderId.trim();
    if (!normalizedOrderId) throw new ValidateException("参数错误");
    if (type && type !== "refund") throw new ValidateException("不支持的物流类型");
    if (type === "refund") return this.queryRefund(uid, normalizedOrderId);

    const rows = await this.container.db
      .select()
      .from(storeOrder)
      .where(
        and(
          eq(storeOrder.orderId, normalizedOrderId),
          eq(storeOrder.uid, uid),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
        ),
      )
      .limit(1);
    const order = rows[0];
    if (!order) throw new NotFoundException("订单不存在或不属于当前用户");

    if (order.pid === -1 || order.deliveryType === "split") {
      const children = await this.container.db
        .select()
        .from(storeOrder)
        .where(
          and(
            eq(storeOrder.pid, order.id),
            eq(storeOrder.uid, uid),
            eq(storeOrder.isDel, 0),
            eq(storeOrder.isSystemDel, 0),
          ),
        )
        .orderBy(asc(storeOrder.id))
        .limit(MAX_SPLIT_PACKAGES);
      const shippable = children.filter(
        (child) => child.deliveryType === "express" && child.deliveryId.trim(),
      );
      const provider = await this.providerConfig();
      const packages = await this.trackMany(
        shippable.map((child) => this.fromOrder(child)),
        provider,
      );
      const first = packages[0] ?? fallbackPackage(this.fromOrder(order), "pending", "暂无已发货包裹");
      return this.response(
        {
          ...first,
          orderId: order.orderId,
          deliveryStatus: packages.length ? "分包发货" : first.deliveryStatus,
          message: packages.length ? `共 ${packages.length} 个已发货包裹` : first.message,
        },
        packages,
      );
    }

    if (order.deliveryType !== "express") {
      throw new ValidateException("该订单不是快递发货，无法查询物流信息");
    }
    const tracked = await this.track(this.fromOrder(order));
    return this.response(tracked, [tracked]);
  }

  private async queryRefund(uid: number, reference: string): Promise<ExpressQueryResult> {
    const numericId = /^\d+$/.test(reference) ? Number(reference) : -1;
    const rows = await this.container.db
      .select()
      .from(storeOrderRefund)
      .where(
        and(
          eq(storeOrderRefund.uid, uid),
          eq(storeOrderRefund.isDel, 0),
          or(
            eq(storeOrderRefund.orderId, reference),
            numericId > 0 ? eq(storeOrderRefund.id, numericId) : sql`FALSE`,
          ),
        ),
      )
      .limit(1);
    const refund = rows[0];
    if (!refund) throw new NotFoundException("退款单不存在或不属于当前用户");
    if (!refund.refundExpress.trim()) throw new ValidateException("该退款单尚未填写退货运单");

    const orders = await this.container.db
      .select({ userPhone: storeOrder.userPhone })
      .from(storeOrder)
      .where(and(eq(storeOrder.id, refund.storeOrderId), eq(storeOrder.uid, uid)))
      .limit(1);
    const shipment: ShipmentInput = {
      orderPk: -refund.id,
      orderId: refund.orderId,
      orderStatus: refund.refundType >= 5 ? 2 : 1,
      deliveryType: "express",
      expressName: refund.refundExpressName || "用户退回",
      expressCode: "",
      expressNo: refund.refundExpress,
      userPhone: refund.refundPhone || orders[0]?.userPhone || "",
    };
    const tracked = await this.track(shipment);
    return this.response(tracked, [tracked]);
  }

  private fromOrder(order: typeof storeOrder.$inferSelect): ShipmentInput {
    return {
      orderPk: order.id,
      orderId: order.orderId,
      orderStatus: order.status,
      deliveryType: order.deliveryType,
      expressName: order.deliveryName,
      expressCode: order.deliveryCode,
      expressNo: order.deliveryId,
      userPhone: order.userPhone,
    };
  }

  private async providerConfig(): Promise<LogisticsProviderConfig> {
    const logisticsType = normalizeConfigScalar(
      await this.container.systemConfigDao.getValue("logistics_type"),
    );
    if (logisticsType !== "2") return { enabled: false, appCode: "" };

    const appCode =
      this.env.ALIYUN_EXPRESS_APP_CODE?.trim() ||
      normalizeConfigScalar(
        await this.container.systemConfigDao.getValue("system_express_app_code"),
      );
    return { enabled: Boolean(appCode), appCode };
  }

  private async trackMany(
    shipments: ShipmentInput[],
    provider: LogisticsProviderConfig,
  ): Promise<TrackingPackage[]> {
    if (shipments.length === 0) return [];
    const results = new Array<TrackingPackage>(shipments.length);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(5, shipments.length) },
      async () => {
        while (cursor < shipments.length) {
          const index = cursor;
          cursor += 1;
          results[index] = await this.track(shipments[index], provider);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  private async track(
    shipment: ShipmentInput,
    provider?: LogisticsProviderConfig,
  ): Promise<TrackingPackage> {
    if (!shipment.expressNo.trim()) {
      return fallbackPackage(shipment, "pending", "商家尚未填写快递单号");
    }

    const resolvedProvider = provider ?? (await this.providerConfig());
    if (!resolvedProvider.enabled) {
      return fallbackPackage(
        shipment,
        "not_configured",
        "物流轨迹服务未配置，当前仅展示商家填写的运单信息",
      );
    }

    const key = await cacheKey(shipment);
    try {
      const cached = await this.env.CONFIG_KV.get<TrackingCacheEntry>(key, "json");
      if (isTrackingCacheEntry(cached)) {
        if (!cached.result.accepted) {
          return fallbackPackage(
            shipment,
            "temporarily_unavailable",
            "物流服务暂不可用，请稍后重试",
          );
        }
        return this.fromCarrier(shipment, cached.result, "cache", cached.fetchedAt);
      }
    } catch (error) {
      emitOperationalEvent("error", {
        event: "logistics_cache_read_failed",
        component: "http",
        operation: "logistics_cache",
        outcome: "failure",
        errorCode: operationalErrorCode(error),
      });
    }

    try {
      const result = await this.queryAliyun(
        providerNumber(shipment),
        shipment.expressCode,
        resolvedProvider.appCode,
      );
      if (!result.accepted) {
        const fetchedAt = Math.floor(Date.now() / 1000);
        const entry: TrackingCacheEntry = { version: 1, fetchedAt, result };
        try {
          await this.env.CONFIG_KV.put(key, JSON.stringify(entry), { expirationTtl: 5 * 60 });
        } catch (error) {
          emitOperationalEvent("error", {
            event: "logistics_cache_write_failed",
            component: "http",
            operation: "logistics_cache",
            outcome: "failure",
            errorCode: operationalErrorCode(error),
          });
        }
        return fallbackPackage(shipment, "temporarily_unavailable", "物流服务暂不可用，请稍后重试");
      }
      const fetchedAt = Math.floor(Date.now() / 1000);
      const ttl = result.delivered ? DELIVERED_CACHE_TTL_SECONDS : ACTIVE_CACHE_TTL_SECONDS;
      try {
        const entry: TrackingCacheEntry = { version: 1, fetchedAt, result };
        await this.env.CONFIG_KV.put(key, JSON.stringify(entry), { expirationTtl: ttl });
      } catch (error) {
        emitOperationalEvent("error", {
          event: "logistics_cache_write_failed",
          component: "http",
          operation: "logistics_cache",
          outcome: "failure",
          errorCode: operationalErrorCode(error),
        });
      }
      return this.fromCarrier(shipment, result, "carrier", fetchedAt);
    } catch (error) {
      emitOperationalEvent("error", {
        event: "logistics_provider_failed",
        component: "http",
        operation: "logistics_provider",
        outcome: "failure",
        errorCode: operationalErrorCode(error),
      });
      return fallbackPackage(
        shipment,
        "temporarily_unavailable",
        "物流服务暂不可用，运单信息以商家填写为准",
      );
    }
  }

  private async queryAliyun(
    expressNo: string,
    expressCode: string,
    appCode: string,
  ): Promise<ParsedCarrierTracking> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("logistics provider timeout"), PROVIDER_TIMEOUT_MS);
    try {
      const response = await this.fetcher(buildAliyunTrackingUrl(expressNo, expressCode), {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `APPCODE ${appCode}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`物流服务返回 HTTP ${response.status}`);
      return parseAliyunTrackingPayload(await readBoundedJson(response));
    } finally {
      clearTimeout(timeout);
    }
  }

  private fromCarrier(
    shipment: ShipmentInput,
    result: ParsedCarrierTracking,
    source: "carrier" | "cache",
    fetchedAt: number,
  ): TrackingPackage {
    const received = shipment.orderStatus >= 2;
    return {
      orderId: shipment.orderId,
      deliveryStatus: received && !result.delivered ? "已收货" : result.statusText,
      expressName: shipment.expressName,
      expressCode: shipment.expressCode,
      expressNo: shipment.expressNo,
      trackingState: result.state,
      trackingSource: source,
      message: result.traces.length ? "" : "承运商尚未返回物流轨迹",
      lastUpdatedAt: fetchedAt,
      traces: result.traces,
    };
  }

  private response(primary: TrackingPackage, packages: TrackingPackage[]): ExpressQueryResult {
    return {
      ...primary,
      packages,
      express: primary.traces.map((trace) => ({ time: trace.time, status: trace.content })),
      order: {
        order_id: primary.orderId,
        delivery_id: primary.expressNo,
        delivery_name: primary.expressName,
        delivery_code: primary.expressCode,
        delivery_type: "express",
      },
    };
  }
}
