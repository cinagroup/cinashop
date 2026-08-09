# cinashop-workers

CRMEB PRO → Cloudflare Workers 全栈重构 (M1 阶段)

将 PHP (ThinkPHP 8 + Swoole) 的 `E:\cinagroup\cinashop\` 商城系统, 渐进式迁移到 Cloudflare Workers + Hyperdrive + Upstash Redis 架构。

## 当前状态: M1 (基础设施 + 认证)

✅ 已完成:
- Hono 入口 + 全局错误处理 + JSON 响应封装 (`{status,msg,data}`)
- Env 类型绑定 (Hyperdrive / Upstash / KV / Queue / Durable Objects)
- Drizzle schema: `user` / `system_config` 2 张表
- BaseDao + searcher 注册表 (对应 PHP `search<Key>Attr` 反射机制)
- JWT 工具 (jose, 与 PHP `crmeb/utils/JwtAuth.php` 兼容)
- Auth 中间件 (4 层验证: token bucket → JWT 签名 → 用户查询 → auth claim)
- TokenBucketDO / OrderLockDO (Durable Objects 骨架)
- 登录接口 `POST /api/login` (账号密码, md5 校验)
- 只读接口 `GET /api/site_config`

⏳ 后续里程碑:
- **M2**: 商品域只读链路 (8 张表, 首页/分类/详情/搜索)
- **M3**: 购物车 + 订单创建 (⚠️ 最高风险, 事务 + DO + 库存守卫)
- **M4**: 支付 + 售后
- **M5**: 用户中心 + 营销活动
- **M6**: 微信生态迁移
- **M7**: admin/PC/其他端

完整方案见对话中的"CRMEB PRO → Cloudflare Workers 全栈重构方案"。

---

## 目录结构

```
workers-ts/
├── src/
│   ├── index.ts                 # Worker 入口 (fetch + queue + scheduled + DO)
│   ├── app.ts                   # Hono 装配
│   ├── env.ts                   # Env 类型绑定
│   ├── routes/                  # 路由 (对应 route/api.php)
│   ├── controllers/api/v1/      # 控制器 (对应 app/controller/api/v1)
│   ├── services/                # 业务逻辑 (对应 app/services)
│   ├── dao/                     # 数据访问 (对应 app/dao)
│   │   └── BaseDao.ts           # search() + searcher 注册表
│   ├── models/
│   │   ├── schema/              # Drizzle pgTable (对应 app/model)
│   │   └── searchers/           # searcher 函数注册表
│   ├── do/                      # Durable Objects (强一致)
│   ├── middleware/              # auth / cors / container / error
│   ├── utils/                   # jwt / cache / json / errors
│   └── lib/di.ts                # DI 容器 (对应 app()->make)
├── migrations/                  # SQL 迁移
├── test/                        # vitest
└── wrangler.toml                # Workers 配置
```

## 架构关键点

### 1. Searcher 注册表 (替代 PHP 反射)
PHP 的 `BaseDao::search()` 用反射自动调用 `search<Key>Attr`。TS 改为显式注册表 (`src/models/searchers/types.ts`),类型安全且无运行时反射开销。详见 `src/dao/user/UserDao.ts`。

### 2. 鉴权双层验证 (与 PHP 兼容)
```
header token
  → md5(token) → Upstash token bucket (快失败)
  → jose.jwtVerify (签名 + exp)
  → DB 查 user (status 校验)
  → auth claim = md5(pwd) 校验 (改密后失效)
  → c.set('uid', ...) c.set('user', ...)
```
JWT 用 HS256 + `APP_KEY`, 与 PHP 互通。Token bucket 存 Upstash Redis。

### 3. 事务与强一致
- 普通读写: Hyperdrive (PostgreSQL) + Drizzle 事务
- 库存/余额原子扣减: `BaseDao.dec()` 带 `WHERE field >= n` 守卫 (修复 PHP 现有超卖 bug)
- 订单创建互斥: `OrderLockDO` (M3 启用)
- 秒杀库存: `StockDO` (M3 启用)

---

## 本地开发

### 前置依赖
- Node.js 18+
- Cloudflare 账号 + `wrangler login`
- 一个 PostgreSQL 实例 (本地或云)
- Upstash Redis 账号 (免费版即可)

### 1. 安装依赖
```bash
cd workers-ts
npm install
```

### 2. 配置环境变量
```bash
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars 填入:
#   APP_KEY          (与 PHP .env 的 app.app_key 一致, 否则旧 token 不互通)
#   UPSTASH_REDIS_URL
#   UPSTASH_REDIS_TOKEN
#   DATABASE_URL     (本地 PG, 如 postgresql://user:pwd@localhost:5432/crmeb)
```

### 3. 初始化数据库
```bash
# 建库 (用 psql 或其他工具)
createdb crmeb

# 跑迁移
psql $DATABASE_URL -f migrations/0000_init.sql

# 或用 Drizzle (会基于 schema 自动生成迁移)
npm run db:generate
npm run db:migrate
```

### 4. 启动本地 dev
```bash
npm run dev
# → http://localhost:8787
```

### 5. 测试接口
```bash
# 健康检查
curl http://localhost:8787/health
# → {"ok":true,"ts":...}

# 站点配置
curl http://localhost:8787/api/site_config
# → {"status":200,"msg":"ok","data":{"record_No":"京ICP备..."}}

# 登录 (需先在 user 表插入一条记录, pwd 字段是 md5(password))
curl -X POST http://localhost:8787/api/login \
  -H "Content-Type: application/json" \
  -d '{"account":"13800138000","password":"yourpassword"}'
# → {"status":200,"msg":"登录成功","data":{"token":"...","expires_time":...}}
```

### 6. 运行测试
```bash
npm test
```

---

## 部署到 Cloudflare

### 1. 创建 Hyperdrive (连你的 PG)
```bash
wrangler hyperdrive create cinashop-db \
  --connection-string="postgresql://user:pwd@host:5432/db"
# 把返回的 ID 填入 wrangler.toml 的 [[hyperdrive]] id
```

### 2. 创建 KV namespace
```bash
wrangler kv namespace create CONFIG_KV
# 把返回的 ID 填入 wrangler.toml 的 [[kv_namespaces]] id
```

### 3. 创建 Queue
```bash
wrangler queues create cinashop-order
wrangler queues create cinashop-order-dlq
```

### 4. 设置 secrets
```bash
wrangler secret put APP_KEY
wrangler secret put UPSTASH_REDIS_URL
wrangler secret put UPSTASH_REDIS_TOKEN
```

### 5. 部署
```bash
npm run deploy          # 生产
npm run deploy --env staging   # 预发
```

---

## 与 PHP 共存策略 (双跑过渡)

本项目放在 `cinashop/workers-ts/`, 不影响 PHP 主项目 (`cinashop/` 根目录)。过渡期:

1. **PHP 后端继续运行** (域名: `api.example.com`)
2. **Workers 后端独立部署** (域名: `api-ts.example.com` 或路由前缀 `/ts/`)
3. **前端按配置切换 baseURL** (灰度切量)
4. **M3 订单上线前** 启用影子流量比对 (5% → 20% → 50% → 100%)

---

## 关键约定

| 约定 | 说明 |
|------|------|
| 密码哈希 | `md5(password)` (与 PHP 兼容, 不要改 bcrypt) |
| JWT 密钥 | `APP_KEY` 必须与 PHP `.env` 的 `app.app_key` 一致 |
| 响应信封 | `{status, msg, data}`, HTTP 恒 200 (与前端契约一致) |
| token header | 优先 `Authori-zation`, 兜底 `Authorization` (与 PHP 一致) |
| 错误码 | `410000` 未登录 / `410001` 过期 / `410002` 封禁 (与 PHP 一致) |
| 表名 | 无前缀 (PHP 是 `eb_user`, 这里是 `user`); 共库时需调整 |
| 时间戳 | `add_time`/`last_time` 用 int 秒; `delete_time` 用 timestamp |

---

## 已知 TODO (M1 范围外)

- [ ] `UserDao.dec()` 的 `stock>=n` 守卫已实现, M3 在库存场景验证
- [ ] body 解析中间件 (POST body 注入 c.var.body, 配合 getMore)
- [ ] InstallMiddleware / StationOpenMiddleware (站点开关)
- [ ] BlockerMiddleware (限流, M2 用 KV 计数器实现)
- [ ] 影子流量比对框架 (M3 前置)
- [ ] DI 容器性能优化 (isolate 内缓存)
