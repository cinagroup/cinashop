/**
 * Workers 环境绑定类型
 *
 * 对应 wrangler.toml 中的 binding, 运行时由 Cloudflare 注入。
 * 这是整个应用唯一的"外部依赖入口", 所有 service 通过此类型访问基础设施。
 */
export interface Env extends WorkerBindings {
  // ─── 密钥 (wrangler secret) ───────────────────────────
  /** JWT 签名密钥, 对应 PHP 的 app.app_key (默认 'crmeb_app_key') */
  APP_KEY: string;
  /** Upstash Redis REST URL */
  UPSTASH_REDIS_URL: string;
  /** Upstash Redis REST Token */
  UPSTASH_REDIS_TOKEN: string;
  /** 微信商户私钥 PEM (M6: Workers 不能读文件, 从环境变量读) */
  WECHAT_MCH_PRIVATE_KEY: string;
  /** 微信支付 APIv3 32 字节密钥；只允许通过 Worker secret 注入。 */
  WECHAT_API_V3_KEY?: string;
  /** 旧配置别名；内容也必须是 SPKI 公钥 PEM，不再允许跳过验签。 */
  WECHAT_PLATFORM_CERT?: string;
  /** 微信支付平台 SPKI 公钥 PEM；支付/退款成功响应与回调均强制验签。 */
  WECHAT_PLATFORM_PUBLIC_KEY?: string;
  /** 与平台公钥对应的 PUB_KEY_ID_*；配置后同时校验 Wechatpay-Serial。 */
  WECHAT_PLATFORM_PUBLIC_KEY_ID?: string;
  /** 微信退款结果通知地址；必须是无查询参数的外网 HTTPS URL。 */
  WECHAT_REFUND_NOTIFY_URL?: string;
  /** 支付宝 AppID (M23: 支付宝 H5 支付, 可选) */
  ALIPAY_APP_ID?: string;
  /** 支付宝应用 PKCS#8 私钥 PEM (RSA2 签名) */
  ALIPAY_PRIVATE_KEY?: string;
  /** 支付宝 SPKI 公钥 PEM (异步回调验签) */
  ALIPAY_PUBLIC_KEY?: string;
  /** 可选: 支付宝卖家 ID, 回调时二次校验 */
  ALIPAY_SELLER_ID?: string;
  /** 支付宝异步回调地址 (非密钥) */
  ALIPAY_NOTIFY_URL?: string;
  /** 支付宝 H5 返回地址 (非密钥) */
  ALIPAY_RETURN_URL?: string;
  /** 阿里云物流市场 AppCode；优先于旧 system_config 中的同名配置。 */
  ALIYUN_EXPRESS_APP_CODE?: string;
  /** Aliyun SMS RPC credentials; secrets must only be injected as Worker secrets. */
  ALIYUN_SMS_ACCESS_KEY_ID?: string;
  ALIYUN_SMS_ACCESS_KEY_SECRET?: string;
  /** SMS signature and verification template identifiers are deployment settings. */
  ALIYUN_SMS_SIGN_NAME?: string;
  ALIYUN_SMS_VERIFICATION_TEMPLATE_CODE?: string;
  ALIYUN_SMS_REGION_ID?: string;
  /** Cloudflare Turnstile server secret; inject only with `wrangler secret put`. */
  TURNSTILE_SECRET_KEY?: string;
  /** CRMEB 一号通电子面单凭据；只允许通过 Worker Secret 注入。 */
  CRMEB_ONEPASS_ACCESS_KEY?: string;
  CRMEB_ONEPASS_SECRET_KEY?: string;
  /** Public Turnstile widget site key. */
  TURNSTILE_SITE_KEY?: string;
  /** Comma-separated hostnames accepted from Siteverify (no schemes or paths). */
  TURNSTILE_EXPECTED_HOSTNAMES?: string;
  /** Comma-separated Sign in with Apple client IDs (Service ID / bundle ID audiences). */
  APPLE_SIGN_IN_CLIENT_IDS?: string;
  /** Browser origins allowed to read CORS responses. Exact origins, comma-separated. */
  ALLOWED_ORIGINS?: string;
  /** Legacy PC-only fallback for QR/OAuth bootstrap; prefer PC_AUTH_ALLOWED_ORIGINS. */
  AUTH_ALLOWED_ORIGINS?: string;
  /** Exact browser origins allowed to bootstrap PC-user QR/OAuth login. */
  PC_AUTH_ALLOWED_ORIGINS?: string;
  /** Exact browser origins allowed to bootstrap Kefu QR/OAuth login. No PC fallback. */
  KEFU_AUTH_ALLOWED_ORIGINS?: string;
  /** WeChat Open Platform AppSecret. Never store this in system_config. */
  WECHAT_OPEN_APP_SECRET?: string;
  /** Enterprise-level JS-SDK credential. Inject only with `wrangler secret put`. */
  WECHAT_WORK_CORP_SECRET?: string;
  /** Self-built application JS-SDK credential. Inject only with `wrangler secret put`. */
  WECHAT_WORK_AGENT_SECRET?: string;
  /** Exact HTTPS origins whose page URLs may be signed for Enterprise WeChat JS-SDK. */
  WORK_WECHAT_ALLOWED_ORIGINS?: string;
  /** 开发运维接口专用 token; 通过 wrangler secret put 设置 */
  OPERATIONS_TOKEN?: string;
  /** 首次迁移时创建管理员所用账号；默认 admin，仅在账号不存在时创建 */
  INITIAL_ADMIN_ACCOUNT?: string;
  /** 首次迁移管理员密码；必须至少 12 位，只从 Worker secret 读取 */
  INITIAL_ADMIN_PASSWORD?: string;
  /** Worker 自身可访问的 API 根地址，例如 https://api.example.com */
  /** 仅在本地或显式调试环境启用运维路由 */
  DEBUG?: string;

  // ─── Queues ───────────────────────────────────────────
  /** 订单领域队列；支付 outbox 消息有可重试消费者，历史消息仍只兼容告警。 */
  ORDER_QUEUE: Queue<OrderMessage>;

}

export interface OrderPaidOutboxMessage {
  action: "processOrderPaidOutbox";
  outboxId: number;
  eventKey: string;
}

/** Delivery/refund notices share the durable order outbox but have a distinct consumer contract. */
export interface OrderNotificationOutboxMessage {
  action: "processOrderNotificationOutbox";
  outboxId: number;
  eventKey: string;
}

/** One durable provider side effect; target and payload never leave PostgreSQL. */
export interface OrderNotificationDeliveryMessage {
  action: "processOrderNotificationDelivery";
  deliveryId: number;
  eventKey: string;
  channel: "sms" | "wechat_official" | "wechat_routine" | "wechat_shipping";
}

/** One durable receipt-printer side effect; content and credentials stay in PostgreSQL. */
export interface OrderPrintJobMessage {
  action: "processOrderPrintJob";
  printJobId: number;
  eventKey: string;
}

/** One durable electronic-waybill allocation; all PII and provider fields stay in PostgreSQL. */
export interface OrderWaybillJobMessage {
  action: "processOrderWaybillJob";
  waybillJobId: number;
  eventKey: string;
}

export type ScheduledMaintenanceJob =
  | "payment_outbox_dispatch"
  | "notification_delivery_dispatch"
  | "print_job_dispatch"
  | "waybill_job_dispatch"
  | "unpaid_order_cancel"
  | "pink_timeout"
  | "auto_receipt"
  | "auto_comment"
  | "live_room_sync"
  | "live_goods_sync"
  | "refund_reconciliation";

/** Cron only writes root jobs; cursor and threshold make every page replayable. */
export interface ScheduledMaintenanceMessage {
  action: "runScheduledMaintenance";
  job: ScheduledMaintenanceJob;
  runId: string;
  scheduledAt: number;
  cursor: number;
  threshold: number | null;
}

/** Candidate order work is separate from scanning and remains idempotent on redelivery. */
export interface ScheduledOrderMessage {
  action: "processScheduledOrder";
  job: "auto_receipt" | "auto_comment" | "unpaid_order_cancel";
  runId: string;
  scheduledAt: number;
  orderId: number;
  threshold: number;
}

/** One expired group is processed independently so refunds can be retried safely. */
export interface PinkTimeoutMessage {
  action: "processPinkTimeout";
  job: "pink_timeout";
  runId: string;
  scheduledAt: number;
  pinkId: number;
}

/** 尚未迁移消费者的 PHP 历史消息，仅用于识别并显式告警。 */
export interface LegacyOrderMessage {
  action:
    | "compute" // OrderCreateAfterJob: 佣金/拆分价计算
    | "delCart" // 清购物车
    | "sendNotice" // 10 分钟未支付短信
    | "cancelOrder"; // 自动取消
  orderId: string;
  uid: number;
  payload?: unknown;
}

/** SMS verification is retryable and therefore delivered through Cloudflare Queues. */
export interface SmsVerificationMessage {
  action: "sendSmsVerification";
  recordId: number;
  uid: number;
  phone: string;
  code: string;
  expiresIn: number;
  purpose:
    | "supplier_application"
    | "user_register"
    | "user_login"
    | "user_password_reset"
    | "user_phone_binding"
    | "user_social_binding"
    | "user_phone_update";
  templateCode: string;
}

/** Idempotent R2 cleanup after attachment metadata has been removed. */
export interface AttachmentObjectCleanupMessage {
  action: "deleteAttachmentObjects";
  keys: string[];
}

/** Permanent official-account QR codes are provisioned outside HTTP requests. */
export interface OfficialAccountQrcodeMessage {
  action: "provisionOfficialAccountQrcode";
  thirdType: "reply" | "wechatqrcode";
  thirdId: number;
}

export type OrderMessage =
  | OrderPaidOutboxMessage
  | OrderNotificationOutboxMessage
  | OrderNotificationDeliveryMessage
  | OrderPrintJobMessage
  | OrderWaybillJobMessage
  | ScheduledMaintenanceMessage
  | ScheduledOrderMessage
  | PinkTimeoutMessage
  | SmsVerificationMessage
  | AttachmentObjectCleanupMessage
  | OfficialAccountQrcodeMessage
  | LegacyOrderMessage;

/**
 * 应用全局变量 (Hono c.var)
 * 由 auth 中间件注入, 业务代码通过 c.get('uid') 读取。
 *
 * 对应 PHP Request macro: $request->uid() / $request->user()
 */
export interface AppVariables {
  /** 当前登录用户 ID, 0 表示未登录; 对应 $request->uid() */
  uid: number;
  /** 当前登录用户对象; 对应 $request->user() */
  user?: AuthUser;
  /** 是否已登录; 对应 $request->isLogin() */
  isLogin: boolean;
  /** Verified token metadata forwarded to a per-principal chat DO without the raw token. */
  socketTokenKey?: string;
  socketTokenExp?: number;
  socketAuthId?: number;
  socketAuthVersion?: string;
  /** Worker-owned anonymous customer-service session; never contains the raw token. */
  visitorSession?: import("@/services/kefu/KefuVisitorSessionService").KefuVisitorIdentity;
  /** DI 容器 (container 中间件注入, 对应 PHP app()->make) */
  container: import("@/lib/di").Container;
  /** 当前登录管理员 ID (adminAuthMiddleware 注入) */
  adminId?: number;
  /** 当前登录管理员信息 (adminAuthMiddleware 注入) */
  adminInfo?: {
    id: number;
    account: string;
    level: number;
    roles: string;
    realName: string;
    divisionId: number;
  };
  /** 当前供应商后台管理员 ID。 */
  supplierAdminId?: number;
  /** 当前供应商 ID，只能由 supplierAuthMiddleware 从 token 关系中注入。 */
  supplierId?: number;
  supplierInfo?: {
    id: number;
    adminId: number;
    supplierName: string;
    name: string;
    isShow: number;
  };
  /** Dedicated customer-service identity derived only from a verified kefu token. */
  kefuId?: number;
  /** Legacy store_service.uid used as the chat participant identifier. */
  kefuUid?: number;
  kefuInfo?: {
    id: number;
    uid: number;
    account: string;
    avatar: string;
    nickname: string;
    phone: string;
    online: number;
  };
  /** Third-party API identity derived only from a verified type=out token. */
  outId?: number;
  outInfo?: import("@/services/out/OutApiService").AuthenticatedOutAccount;
}

/**
 * 鉴权用户精简结构 (对应 PHP authInfo['user'] 的常用字段)
 * 完整字段见 UserDao, 这里只放中间件需要的。
 */
export interface AuthUser {
  uid: number;
  account: string;
  pwd: string; // md5, 用于校验 auth claim
  status: number;
  nickname: string;
  avatar: string;
  phone: string;
  now_money: string;
  integral: number;
  level: number;
}
