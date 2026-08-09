/**
 * Workers 环境绑定类型
 *
 * 对应 wrangler.toml 中的 binding, 运行时由 Cloudflare 注入。
 * 这是整个应用唯一的"外部依赖入口", 所有 service 通过此类型访问基础设施。
 */
export interface Env {
  // ─── 密钥 (wrangler secret) ───────────────────────────
  /** JWT 签名密钥, 对应 PHP 的 app.app_key (默认 'crmeb_app_key') */
  APP_KEY: string;
  /** Upstash Redis REST URL */
  UPSTASH_REDIS_URL: string;
  /** Upstash Redis REST Token */
  UPSTASH_REDIS_TOKEN: string;
  /** 微信商户私钥 PEM (M6: Workers 不能读文件, 从环境变量读) */
  WECHAT_MCH_PRIVATE_KEY: string;
  /** 微信平台证书 PEM (M6: 回调验签用, 可选) */
  WECHAT_PLATFORM_CERT?: string;
  /** 支付宝 AppID (M23: 支付宝 H5 支付, 可选) */
  ALIPAY_APP_ID?: string;

  // ─── Hyperdrive (外部 PostgreSQL) ─────────────────────
  /** Hyperdrive 连接, 通过 .connectWith() 拿到 PG 连接字符串 */
  HYPERDRIVE: Hyperdrive;

  // ─── Upstash / KV ─────────────────────────────────────
  /** 配置字典缓存 (system_config / 导航 / 字典) */
  CONFIG_KV: KVNamespace;

  // ─── Queues ───────────────────────────────────────────
  /** 订单后置任务队列 (M3 启用) */
  ORDER_QUEUE: Queue<OrderMessage>;

  // ─── Durable Objects ──────────────────────────────────
  /** Token 令牌桶 (单设备登录 / 强制下线) */
  TOKEN_BUCKET: DurableObjectNamespace;
  /** 订单创建互斥锁 (M3 启用) */
  ORDER_LOCK: DurableObjectNamespace;
  /** 雪花 ID 序列号 (订单号/商品编号) */
  SEQUENCE: DurableObjectNamespace;
  /** 客服聊天室 (WebSocket Hibernation) */
  CHAT_ROOM: DurableObjectNamespace;
}

/**
 * 订单队列消息体 (M3 扩展, 现在 M1 先占位)
 */
export interface OrderMessage {
  action:
    | "compute" // OrderCreateAfterJob: 佣金/拆分价计算
    | "delCart" // 清购物车
    | "sendNotice" // 10 分钟未支付短信
    | "cancelOrder"; // 自动取消
  orderId: string;
  uid: number;
  payload?: unknown;
}

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
  };
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
