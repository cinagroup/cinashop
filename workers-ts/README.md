# cinashop-workers

CRMEB PRO → Cloudflare Workers 渐进式迁移。

将 `cinashop-php` 的 PHP（ThinkPHP 8 + Swoole）商城渐进式迁移到 Cloudflare Workers + Hyperdrive + Upstash Redis。当前仓库只覆盖核心商城切片，尚不能替代旧系统；审计基线和后续顺序见 [MIGRATION_AUDIT.md](../MIGRATION_AUDIT.md)。

## 当前状态：核心链路部分可用，业务全量迁移未完成

已迁移的主要切片：

- Hono 入口、认证、配置、商品、购物车、订单、部分支付/售后
- 部分用户中心、营销活动、微信生态和后台管理接口
- Admin、PC、UniApp 三个 TypeScript 前端骨架及核心页面
- 企业微信 callback 的 C0～C8 代码、生产结构与随机 schema 服务验收已完成：可信 inbox/outbox、provider 读取、成员、部门、客户/follow/tags、群/群成员、企业客户标签，以及欢迎语/自动标签/商城用户关联的独立 action outbox、UNKNOWN 人工处置和回调脱敏。生产 PostgreSQL 已扩展到 247 表/214 序列；C8 最新隔离场景 18/18 通过且 Admin 已接入脱敏处置台账。所有 authority gate 仍关闭，主 Worker/Admin 未发布；真实源数据、旧媒体素材、企业微信租户/provider、Linux runtime、预发、影子流量和发布批准仍未完成
- Admin 首页四条 PHP 合同已拆分恢复：四项卡片、30 天/周/月/年订单趋势、30 天新增用户与消费分层、兼容空排行；统计统一按 `Asia/Shanghai` 非重叠区间并排除删除数据。生产 Hyperdrive 随机 schema 的 8 项 PostgreSQL 断言全部通过，`public` 三表行数前后不变（本地完成，主 Worker/Admin 尚未发布；真实 Admin 与旧 PHP 同时刻对账仍待执行）
- Admin 统计页已恢复 21 条 PHP 主合同：订单 4、商品 4（含导出）、用户 7、交易 2、余额 4；旧 TypeScript 的 `overview/trend/rank` 仅保留为兼容别名。统一使用 `Asia/Shanghai`、`[start,end)`、根订单和软删除/有效流水过滤，并修正旧 PHP 的 3 日采样漏日、25 小时轴、余额支付环比、性别首项短路、微信累计恒零及多类重复/删除数据污染。生产 Hyperdrive 两轮随机 schema 共 29 项 PostgreSQL 断言全部通过，最新一轮 `public` 12 表行数前后不变（本地完成，主 Worker/Admin 尚未发布；源 MySQL 历史复制和真实 Admin 对账仍待执行）
- 社区资料、关注/粉丝/推广好友、推荐作者、关注动态与持久浏览已按 PHP 语义恢复；Admin 补齐内容审核、话题目录、平台回复/虚拟评论和级联删除等 30 条方法级兼容合同；客户端进一步补齐配置、完整帖子筛选、作者待审预览、用户编辑重审、商品来源、话题计数、点赞/精选列表、分享、嵌套评论、评论点赞和所有者删除。生产 PostgreSQL 16.14 已应用社交 `0087`/内嵌 `0094`、运营 `0088`/内嵌 `0095` 及客户端 `0089`/内嵌 `0096` 八条查询索引，三个随机 schema 场景验证重放、并发、回滚、计数、越权拒绝和公共表/序列不变；真实 Hyperdrive 还发现并修复作者待审详情误计浏览与数字话题数组绑定问题（生产社区帖子/评论/话题/资料/关系为 `2/2/0/0/0`；主 Worker/前端尚未发布，源数据复制、真实账号与所有旧客户端长尾页面验收仍缺失）
- Supplier 独立后台、结算/提现以及微信/支付宝原路退款状态机（本地完成，尚未发布）
- 支付成功、发货通知和拒绝退款通知共用 transactional outbox、Queue 可重试消费者与定时补偿；发货/拒绝已恢复 PHP 站内信，并以独立 PostgreSQL 投递账本暂存短信、公众号/小程序和微信发货上报。提供商调用在事务外，网络结果不确定进入 `UNKNOWN` 且不盲重发；Admin 可在脱敏台账中确认已发、明确承担重复风险后重发或关闭，并把每个决定写入不含目标/payload 的不可变动作表。生产 Hyperdrive 隔离场景为 17 条投递、`16 SENT + 1 UNKNOWN`，重放没有重复调用，三种人工状态迁移与请求键幂等均通过（生产 `0084`～`0086` schema 已应用，主 Worker 尚未发布；生产模板、openid、渠道配置和外部 secrets 均未就绪）
- 订单/会员/充值统一服务端收银台：同时校验订单归属/状态/超时、数据库开关、HTTPS 回调和当前 Worker secrets；微信身份按登录用户服务端解析，PC/UniApp 在回调确认前不宣告支付成功。已关闭充值订单通过余额入口无凭据增加资金的高危迁移缺陷，充值档位/赠送额改由 PHP `user_recharge_quota` 配置作为服务端权威并恢复旧首页响应契约；生产当前启用档位为 0。佣金转余额恢复 PHP 四账，并增加用户行锁、冻结额门禁、事务回滚和 PC/UniApp 不可逆确认；生产 Hyperdrive 隔离场景已验证并发单赢家、故障回滚和资金守恒。充值回调同样验证并发单次入账、金额/交易号冲突拒绝和重放幂等（本地完成，尚未发布；生产支付开关与商户 secrets 当前均未就绪，佣金转余额开关/说明配置尚未复制）
- 积分商城已按 PHP 语义接入统一 `type=4` 购物车、服务端权威活动 SKU/现金/积分/运费、自定义表单、地址、付款、取消与退款；生产 Hyperdrive 隔离场景已验证三层库存、积分支付并发/回滚和纯积分部分/全额退款，UniApp 桌面与 390×844 统一结算验收通过（本地完成，尚未发布）
- Queue 驱动的自动收货、自动评价、支付 outbox 补投与退款对账分页工作流；游标可重入、候选处理前复核、退款查询先认领（本地完成）
- PHP 语义的用户两级分销佣金快照、收货入账、退款退佣与冻结期提现守卫（本地完成，尚未进入生产数据库）
- PHP 语义的商品赠送积分、实付返积分、付费会员倍率、收货经验/等级升级及累计退款积分冲正（本地完成，尚未进入生产数据库）
- 订单/拆分包裹/退款物流查询：直接读取真实运单、阿里云物流市场查询、KV 缓存和明确降级，不再生成模拟轨迹（本地完成，尚未用真实 AppCode 验证）
- 固定/任选优惠套餐已恢复公开资格、完整选品购物车、服务端权威活动 SKU 计价、`type=5` 统一下单、套餐限额原子占用/取消补偿、免邮和不可退款门禁；PC/UniApp 商品详情可按固定/必选规则选 SKU 后多行结算。Admin 同时恢复 PHP 五条运营路由、商品/标签选择、固定/任选创建编辑、逐 SKU 套餐价、未来定时启用、软删除和 `activity.view/activity.manage` 权限边界；编辑会保留仍存在的关系 ID 与活动 SKU 标识，移除项才精确清理。用户购买与 Admin 运营分别通过生产 Hyperdrive 随机 schema 的并发/回滚/状态/持久化验证（本地完成，尚未发布；生产套餐相关表均为空，源数据复制、`postage/system_form_id` 源结构复核和真实运营/用户支付验收仍缺失）。同城配送第三方快照和用户状态轨迹已恢复读取，配送下单/回调仍未迁移
- 平台外部现金流水、用户余额/积分内部账、供应商账和休眠门店账保持独立；恢复用户 type-9 资金记录及后台平台流水查询/备注（本地完成，尚未做真实金额对账）
- 保留多态分类、商品单位、可复用 SKU 规则、参数模板、虚拟卡密与系统组合配置；恢复 Admin/Supplier 元数据接口并修复跨 Supplier 读取；卡密/共享密钥已接入支付 outbox 原子自动交付。Admin/Supplier 脱敏库存页、1,000 行批量导入、租户隔离风险告警和 60 秒一次性受控敏感导出已实现，并通过生产 Hyperdrive 随机隔离 schema 的并发幂等、缺口/低缓冲分类、游标、租户拒绝、单次消费/重放/过期、精确库存与保密响应 E2E。生产 `system_virtual_inventory_export` 已落地且为 0 行，卡密商品/SKU/库存当前仍均为 0；剩余是源 MySQL 旧卡库存复制、真实运营账号/用户付款/通知验收与发布
- 事业部、代理商、员工的层级差额分佣、推荐关系重叠规则、收货入账与分来源累计退佣（本地完成，尚未进入生产数据库）
- 事业部/代理商/员工层级维护、事业部管理员数据作用域、代理申请审核、员工绑定和经营统计页面/API（本地完成，尚未进入生产数据库）
- 代理商员工邀请小程序码：短时 HMAC 图片 URL、代理状态复核、微信 token/图片缓存和扫码绑定兼容（本地完成，尚未用真实小程序验证）
- 42 个后台权限域、全受保护 Admin 路由服务端 ACL、旧数字菜单兼容和防越权角色委派；Admin 角色权限树同步控制侧栏（本地完成，尚未发布）
- 新人专享目录、活动 SKU 定价/基础库存、创建订单时原子消费资格、注册标记与四条前台接口，以及带过期语义的旧数据库缓存读取。普通订单首单优惠已按 PHP 规则恢复：服务端读取新人/首单/时限/折扣/封顶配置，首单与优惠券互斥，在用户行锁内复核并原子消费资格，取消不恢复；PC/UniApp 结算页通过服务端只读 quote 展示权威金额并同步优惠券互斥。Admin 已恢复 16 项注册/新人配置白名单、协议、商品和逐 SKU 活动价写入；密码/微信注册在用户创建事务中原子赠送积分、PHP 兼容整元余额和优惠券。生产 Hyperdrive 随机 schema 已验证首单计价，以及 Admin 保存/替换/回滚、注册并发 exactly-once 和赠礼故障回滚（本地完成，尚未发布；生产 16 项配置和新人目录均为空，源数据与真实微信/用户验收仍未完成）
- 旧数据库缓存的有效消费者已继续恢复：`kf_adv`、`open_adv`、`uni_app_url` 回退、五类协议、`newcomer_agreement` 和按管理员隔离的商品草稿均使用真实 `cache` 表；Admin 客户端内容页、商品草稿自动保存、UniApp 开屏和客服展示已接通。写入采用 512 KiB 上限、原子 UPSERT 和短事务，读取不触发过期清理。生产当前这些缓存和 `uni_app_link` 均为空；随机 schema 已验证七键整体回滚、68,400 秒草稿 TTL、URL 覆盖及坏 JSON 无副作用。旧公开扫码上传因弱令牌不恢复，由认证私有 R2 替代（本地完成，尚未发布）
- 付费会员批次、会员卡、套餐、权益、协议、订单与状态历史，以及 PHP 6 条用户会员路由和 16/16 条 Admin 路由；服务端权威定价、免费一次领取、原子余额付款、微信/支付宝下单与回调分流、H5/小程序激活码、UniApp 套餐购买/卡密激活均已实现。Admin 运营与购买支付分别通过生产 Hyperdrive 随机隔离 schema E2E，一次性发卡后不再回显密码（仍缺旧会员数据复制、真实商户/真实用户 E2E 与发布）
- 优惠券商品适用关系与领取证据：Admin 商品券保存、普通领券和支付后赠券事务化双写，下单发现模板字段与关系表漂移时安全拒绝（本地完成；两张无主键历史表已接入重复行保真的多重集复制，仍待隔离数据库演练）
- PHP v2 新人券、今日券和可领取列表已恢复原认证边界、迁移列交换后的 snake_case 投影、UID 已领状态、商品/分类/品牌范围、四类计数、排序和 SVIP 今日门禁，并修正旧品牌页签丢失商品派生品牌的问题；生产 Hyperdrive 随机 schema 11/11 断言通过且 `public` 指纹不变（本地完成，主 Worker未发布；生产只有 1 条不可领取模板、4 条历史用户券，范围/领取证据和有效运营模板仍待源数据复制与真实旧端验收）
- PHP v2 用户资料、公众号资料刷新、余额/佣金/提现/资金分类流水、推广用户和分销规则收益五条合同已恢复；资料写入按当前 UID 与微信身份行锁限定，公众号 openid 只能由 OAuth code 服务端解析，资金列表只读且有界，推广已下单筛选改用路径 type，并修正旧时间格式把月份当分钟的问题。生产 Hyperdrive 随机 schema 11/11 断言通过、`public` 指纹不变（本地完成，主 Worker 未发布；生产微信身份/AppID/Secret、余额账和资金流为空，7 条佣金、5 条提现、6 条充值、3 条退款均为用户孤儿，必须先与源 MySQL 对账并完成真实微信/旧端验收）
- PHP v2 促销商品、赠品信息和登录态凑单三条合同已恢复 active 平台父活动、五类商品范围、PHP 两段折扣截断、父子阶梯及积分/券/赠品 SKU 投影；隔离审计同时修复商品 DAO 的显式 `ids` 过去只排序不筛选、会扩散为全目录的问题。生产 Hyperdrive 随机 schema 12/12 断言通过且 `public` 指纹不变（本地完成，主 Worker 未发布；生产促销规则、范围和品牌/标签关系为空，源数据复制、订单促销叠加及真实旧端验收仍缺失）
- PHP v2 紧凑首页和公众号关注两条合同，以及旧 UniApp 实际调用的 v1 关注合同已恢复；首页严格保持六个根字段，快捷分类改回可见子分类，四类推荐使用权威关系，预售恢复四态，用户态响应禁止共享缓存。生产 Hyperdrive 随机 schema 12/12 断言通过且 `public` 指纹不变（本地完成，主 Worker 未发布；生产四个数量配置、推荐关系、微信身份和地图 key 缺失，活动标签、真实微信/媒体/旧端验收仍未完成）
- 门店、店员、平台配送员与门店用户关系完整保留；恢复 PHP/Admin 兼容管理路由和响应式后台页面，店员响应不返回密码哈希/最后登录 IP，订单门店配送只接受服务端唯一有效配送身份（本地完成；尚未执行生产迁移或发布）
- 保留旧 `supplier_ticket_print` 历史配置与现行 `print_document`；收据打印已恢复 Admin/Supplier 严格租户隔离的打印机/内容管理、易联云/飞鹅云异步任务、脱敏账本与 UNKNOWN 人工处置。电子面单另以 `0091` 独立任务账本恢复一号通 HTTPS 签发、整单/拆单发货、并发租约和人工重签/确认/应用已有面单/关闭；生产 Hyperdrive 随机 schema 已验证所有状态且 `public` 指纹不变（两条链路均尚未发布；生产电子面单账本表已存在且为空，配置与 secrets 仍缺失，也未调用真实提供商）
- 保留 `system_user_apply` 供应商入驻历史与 `sms_record` 短信审计；恢复用户提交/重提、Admin 审核/备注和短信激活页面。旧 PHP 的跨用户申请覆盖与手机号后六位默认密码不再兼容：所有用户写入按登录 UID 限定，审批只创建冻结账号，申请人验证原手机号并设置至少 12 位密码后才启用（本地完成；阿里云短信 secret、生产迁移和真实发送尚未配置/执行）
- 用户注册、手机验证码登录、找回密码、手机号绑定/更换及社交账号补绑均使用用途隔离的 6 位短信能力；旧 AJCaptcha 已替换为 Cloudflare Turnstile。挑战绑定手机号、用途、原始客户端网络和 5 分钟时效，服务端强制校验 Siteverify `hostname/action/cdata` 后才可原子消费并进入 PostgreSQL/Queue。PC 使用受控 iframe，UniApp H5/App/小程序使用全屏 WebView 并在返回后复核服务端状态（本地完成并通过生产 Hyperdrive 只读指纹与真实 Worker Siteverify 传输验证；主 Worker未发布，生产 Turnstile/Aliyun 配置和真实短信 E2E 尚未完成）
- 保留小程序直播间、商品、主播及房间商品关系；恢复用户直播列表、回放读取、Admin 只读目录，以及 Cron→Queue 的直播间/商品状态同步。创建/删除直播间、商品提审/删除和导入商品等非幂等微信写接口继续关闭（本地完成；生产迁移和真实小程序验证尚未执行）
- 客服独立 `/kefuapi` 已恢复 60/63 条 PHP 精确合同，其余 `ticket` 与两条不安全退款合同有源证据退役，退役后有效可执行覆盖 100%。游客链路使用 24 小时签名会话、10 亿起步独立 UID、数据库 token 摘要/撤销状态、权威客服分配、`is_tourist` 实时隔离和独立 R2 owner；`tourist/order` 仍只接受正常登录用户并复核订单归属。生产已幂等应用 `0104` 且新表为 0 行；Kefu、UniApp 和 PC `/service` 已接入，旧 `appChat` 的随机 UID/URL bearer 合同不再进入新客户端，但主 Worker/前端未发布；生产客服账号/会话、游客内容配置、面单配置与一号通 Secret 均为空
- PC/Kefu 扫码与开放平台登录已完成本地安全闭环：精确 Origin/CORS 白名单、二维码公钥与私有 poll secret 分离、请求站点/设备人工核对、`pending→scanned→approved→issuing→delivered` 可重试交付、按 state 隔离的浏览器 verifier Cookie、OAuth state/code 重放保护和 Redis/token store 失败关闭；Origin/UA 不被当作客户端证明。用户 JWT `auth` 已恢复 PHP 的 `md5(user.pwd)`，旧 Worker 单层值只在精确活跃 bucket 中短期兼容；Kefu 同时复核客服与绑定用户状态，PC/Kefu bearer 改为 per-tab `sessionStorage`。心跳和三类聊天下行在发送前重验 bucket/期限/数据库身份，注销会主动断开。PC、Kefu 与 UniApp 确认页已通过桌面/390×844 受控浏览器回归（主 Worker/前端尚未发布；生产缺开放平台 AppID、`WECHAT_OPEN_APP_SECRET`、微信身份、客服账号、Kefu 正式 Origin和同源 proxy）

未完成的主要范围包括 Supplier 生产数据/账号迁移、旧后台的大部分功能、客服生产数据与真实端到端、ERP 独立接口、移动端长尾页面、生产数据迁移与真实支付/Cloudflare 远端验收。不要按历史 M1～M24 标签推断迁移完成度。

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

### 2. 鉴权双层验证
```
header token
  → md5(token) → Upstash 精确匹配 token/type/uid
  → jose.jwtVerify (签名 + exp)
  → DB 查身份与启用状态
  → 普通用户 auth = md5(user.pwd) 校验 (改密后失效)
  → 早期 Worker auth=user.pwd 仅凭精确活跃 bucket 限时兼容
  → c.set('uid', ...) c.set('user', ...)
```
生产缺 Redis、读取异常、写入/删除失败时返回 503，不降级为仅验证 JWT。JWT 的
HS256、`APP_KEY`、对象型 `jti` 和普通用户 auth claim 已与 PHP 对齐；但完整会话尚不
跨运行时互通：PHP bucket 是可配置前缀的 `md5(token)` + PHP serialize，Worker 是
`tb_<md5(token)>` + JSON/Upstash。正式切换必须全量鉴权切流并强制重新登录，或先完成
键名、编码、TTL 与撤销语义都经过验证的双读/迁移桥；不得把“JWT 可验”写成“旧 token
无感互通”。

### 3. 事务与一致性
- 普通读写: Hyperdrive (PostgreSQL) + Drizzle 事务
- 库存/余额原子扣减: `BaseDao.dec()` 带 `WHERE field >= n` 守卫 (修复 PHP 现有超卖 bug)
- 订单创建: PostgreSQL 事务内认领购物车并扣减库存；Durable Object 不用于包裹外部数据库事务
- 支付成功: `paid=0→1`、Supplier 待结算流水与 `order.paid` outbox 同事务提交；Queue 至少一次消费，定时任务补投过期租约
- 发货/拒绝退款通知: 订单或售后状态与不可变 `order.delivery.notice` / `order.refund.refused.notice` outbox 同事务提交；消费端按 `system_notification` 开关渲染 PHP 占位符，以 `system_message.event_key` 精确去重，并原子暂存 `order_notification_delivery`。Queue 只携带账本引用；调度使用 `SKIP LOCKED` 和短事务，短信/微信调用不持数据库锁。提供商结果不确定写 `UNKNOWN` 并等待人工对账，不自动重发；Admin 处置要求理由、幂等请求键和风险确认，写入 `order_notification_delivery_action`
- 后置任务: 优惠券核销、支付次数和状态日志在单一数据库事务完成；失败指数退避，8 次后进入 `DEAD`，可由 Admin 页面/API 显式重放
- 定时维护: Cron 只投递九个 Queue 根任务（支付 outbox、订单通知 outbox、外部通知投递、自动收货、自动评价、拼团超时、直播间状态、直播商品状态、退款对账）；订单按主键游标持续推进，逐条 ack/退避且不再固定扫描前 100 单
- 订单佣金: 下单时按商品/SKU、实付或利润口径快照；普通两级推广与事业部/代理商/员工差额分佣共同处理推荐关系重叠和自购规则；用户、Supplier 和定时自动收货共用事务结算路径，收货与退款按订单串行，部分/全额退款按佣金来源累计退佣
- 事业部管理: 管理员身份携带不可由请求覆盖的 `divisionId` 作用域；角色变更按 uid 升序锁行，约束上下级比例/到期时间；申请审核、级联解除、订单查询、趋势与排行均按作用域过滤
- 收货奖励: 下单冻结商品赠送积分快照；确认收货按固定精度计算实付积分、付费会员倍率和经验，幂等写账并同步等级历史；部分/全额退款按累计目标冲正积分，经验按 PHP 语义不回退
- `OrderLockDO` 仅保留为历史兼容绑定，当前订单写链路不依赖它

### 4. 私有 R2 图片变体

附件数据库只保存 canonical `/api/assets/:id`，R2 bucket 保持私有。普通读取生成
15 分钟 HMAC URL；DIY 商品排行在 `image_thumb_status` 存在且启用、
`thumb_mid_width/thumb_mid_height` 都为 `1..2048` 时，生成签名同时绑定
`variant=mid` 与宽高的 URL。变体参数被篡改会在读取数据库前失败；外部历史 URL、
配置缺失/关闭、非图片和 Images 转换异常都返回原引用或原 R2 对象。

`wrangler.toml` 的 `IMAGES` binding 直接读取 R2 字节并以 `scale-down` 保持比例。
变换结果按附件 ID、源 ETag、固定变体、尺寸和格式写入内部 Workers Cache；客户端
响应仍为 `private, no-store`。生产只读审计确认 PHP `getImageConfig()` 的 20 个图片
配置键当前全部缺失，所以现网语义仍是原图且不加水印。正式启用缩略图或水印前，
必须迁移并人工确认配置、完成源附件对象对账，并评估
[Images binding](https://developers.cloudflare.com/images/optimization/binding/) 与
[Images 计费](https://developers.cloudflare.com/images/pricing/)；当前实现没有恢复水印。

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
cp .env.example .dev.vars
# 编辑 .dev.vars 填入:
#   APP_KEY          (与 PHP .env 的 app.app_key 一致；只保证 JWT 签名层可兼容)
#   UPSTASH_REDIS_URL
#   UPSTASH_REDIS_TOKEN
#   ALLOWED_ORIGINS
#   PC_AUTH_ALLOWED_ORIGINS
#   KEFU_AUTH_ALLOWED_ORIGINS
#   WECHAT_OPEN_APP_SECRET
#   TURNSTILE_SECRET_KEY
#   TURNSTILE_SITE_KEY
#   TURNSTILE_EXPECTED_HOSTNAMES
# 本地 PostgreSQL 连接由 wrangler.toml 的 hyperdrive.localConnectionString 配置
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

卡密商品的运营接口只返回掩码卡号和 `password_configured`，不会回显密码；Supplier 的商品范围由登录关系固定，不能由请求覆盖：

```text
GET  /adminapi/product/virtual/:id
POST /adminapi/product/virtual/:id/import
GET  /adminapi/product/virtual-alerts
GET  /supplierapi/product/product/virtual/:id
POST /supplierapi/product/product/virtual/:id/import
GET  /supplierapi/product/product/virtual-alerts
```

导入正文为 `{ "attr_unique": "SKUKEY01", "cards": [...] }`，行格式可用 `{card_no, card_pwd}` 或兼容 PHP 的 `{key, value}`；允许仅密码行，单次最多 1,000 行且总正文不超过 512 KiB。固定 `disk_info` SKU 与一次性卡密库存互斥。成功时只按数据库真正新增的行数递增商品/SKU 库存并写库存审计，不把可售库存重置为未分配卡数。

告警接口接受 `threshold=0..1000`、`level=all|shortage|low_buffer`、`cursor` 与 `limit`。未分配卡少于可售库存为 `shortage`，覆盖库存后的余量不超过阈值为 `low_buffer`；固定虚拟内容不参与统计，响应不投影任何卡号或密码。

### 6. 运行测试
```bash
npm run test:unit       # Node 单元测试
npm run test:runtime    # 本地 workerd：Cron / Queue / KV / Durable Object
npm test
npm run typecheck       # 普通源码与 runtime 测试分别检查
```

`test:runtime` 使用 `wrangler.test.toml` 的本地 Miniflare 绑定，不连接生产
Hyperdrive、KV 或 Queue。Windows 运行 workerd 前需安装最新版 Microsoft Visual C++
2015-2022 x64 Redistributable；旧版 `msvcp140.dll` / `vcruntime140.dll` 会在
runtime 启动时产生原生访问冲突。

2026-08-29 本批最终本地证据：Worker 单元测试 135 文件/787 项、双 TypeScript 配置、
PC/Kefu/Supplier 构建、Kefu 7/7、UniApp 类型检查/H5 构建和 Supplier Pages Function
独立类型检查均通过；Wrangler 4.122.0 `deploy --dry-run --minify` 为
2,575.75 KiB/gzip 638.51 KiB。Windows runtime 仍在 0 条断言前以 `0xc0000005`
退出，不能记为通过。

### 7. 旧 MySQL 数据迁移

先执行不连接数据库的仓库 schema 对照：

```bash
npm run data:schema-audit
```

实时计划只读 MySQL 与 PostgreSQL 的 `information_schema` 和行数。连接串必须通过
进程环境变量提供，禁止作为命令行参数；MySQL 账号应为只读账号：

`0072` 保留 `qrcode`、`wechat_qrcode`、`wechat_qrcode_cate` 与 `wechat_qrcode_record`，恢复渠道码分类/目录/状态、推广员与标签约束、扫码用户和有界统计，并把永久二维码生成移入至少一次投递 Queue；外部微信响应流限定 64 KiB，凭据只读取 Worker 配置，重试以源唯一键归一到同一票据记录。回复二维码入口也已恢复。公众号扫码回调、卡券/用户事件链与群发仍明确不可用。

`0073` 保留 `queue_list`、`queue_auxiliary` 与 `system_timer` 的全部源列和主键语义，并恢复只读的定时目录、旧批处理列表及发货逐项结果接口/管理页。旧表不会触发 Cloudflare：`queue_*` 仍只是 Redis/ThinkPHP Job 的历史快照，`system_timer` 的 `is_open/cycle` 也不配置 Worker scheduled。当前仅 `auto_take` 与 `auto_comment` 有独立 Worker 实现，其余任务继续标为未迁移；本页不提供重试、停止或启停操作。

`0074` 保留 `live_anchor`、`live_goods`、`live_room` 与 `live_room_goods` 的全部源列。`live_room` 继续使用源端 `(id,phone)` 混合主键，关系表继续不设主键/唯一约束，历史重复关系不会被静默折叠；`live_anchor`/`live_goods` 按 `id` 计划复制，`live_room` 按精确的 `(id,phone)` 主键做数值 + 二进制 UTF-8 字典序续页，两个分量都写入检查点，不需要假设 `id` 单列唯一。`live_room_goods` 使用全行二进制规范值 + multiplicity 的多重集复制，完全相同的重复关系按次数插入；初次复制必须面对空目标表，每批短事务都会锁表并核对本 run 对目标行数的独占所有权。运行时恢复公开直播列表/回放、Admin 只读目录及微信状态读取；创建、删除、商品提审和导入等微信写操作没有幂等键，继续禁用。

`0075` 保留 `out_account` 与 `out_interface` 的全部源列和非唯一历史语义，并以各表 `id` 进入确定性迁移。Worker 新增隔离的 `/outapi` token/ACL 域，明确注册 14 条有界 GET，以及事务化的订单备注、退款备注、确认收货、人工快递发货、人工快递拆单发货、既有配送信息更正、发票资料/状态、同意退货、拒绝售后和真实资金退款 11 条 PUT；Admin 可管理 API 账户、查看运行时读写矩阵和脱敏访问审计。每条路由都要求账户规则与启用接口行按方法/模板精确匹配。备注使用行锁和脱敏状态证据；确认收货复用完整结算状态机；两条发货路由复用 Supplier 履约状态机，并以 `store_id=0`、共享订单结算锁和只含摘要的同事务重放证据固定平台范围、并发单写及拆单金额/数量守恒。配送更正只修改现有发货类型的元数据，`send` 姓名/电话必须匹配已分配有效配送员，且旧请求延迟重放不会覆盖新值。两条发票路由保留 PHP 手机号/抬头/税号/卡号/发票号合同，只修改平台订单唯一有效申请；两条售后决策路由按退款锁→订单锁维护退款单/订单镜像状态，渠道退款已发起时拒绝改判。资金退款把平台店铺、外部退款单号、订单/退款主键、UID、Supplier 与整数分金额绑定到统一退款核心：请求金额必须等于该售后记录权威金额；Hyperdrive 查询缓存已启用，因此完成态重放、余额提交和渠道意图写入都以锁内新鲜快照为准；微信/支付宝只在短事务再次核对请求/渠道/交易号/金额并写稳定意图后于事务外调用和查询。PHP 同一售后单首次部分退款即标完成、后续又被拒绝的矛盾合同不恢复，真正部分退款使用独立售后记录。其他高影响写入仍返回 501；PHP 发货/拒绝事件的站内信已进入 Queue/outbox，短信、公众号/小程序通知、小程序发货信息上报和任意外部推送仍未迁移。订单/退款/用户响应禁止缓存，用户只走安全字段白名单。新密钥由 Web Crypto 生成、只显示一次并仅保存 bcrypt cost 12 哈希，旧明文与任意外部推送不进入运行时。`0083` / 内嵌 `0090` 新增只保存 HMAC 摘要/查询字段名/静态路由的 `out_api_audit`；IP 与账号分别由 Durable Object 固定窗口限流。2026-08-14 已通过生产 Hyperdrive 创建并核验空审计表，五类随机隔离场景完整验证 11 条写路由的 ACL、重放/并发、平台范围、履约/退款门禁、拆单守恒、配送员权威值、发票唯一关联、渠道互斥、金额绑定、资金 exactly-once、失败回滚与证据脱敏；公共相关表/序列快照不变、审计表 0 行、临时 schema 为 0，临时 Worker 均已删除。主 Worker 未发布，真实账户/目录复制、真实 DO RPC、真实微信/支付宝退款与客户验收仍未开始。

`0076` 保留全部 24 张 `work_*` 企业微信表及源端唯一性语义。`work_member.userid` 与 `work_member_other.member_id` 保留唯一约束；6 张无稳定唯一键的关联表不补主键，改用重复行保真的全行多重集复制，初次复制要求目标为空且每批校验目标行数归本 run 独占。Admin `/operations/work` 只读查看导入的成员、客户、客户群、渠道码、群发、朋友圈和欢迎语历史，人员标识与联系方式默认脱敏。成员/客户同步、客户标签、渠道码、入群方式、欢迎语、群发与朋友圈外部写入统一返回 501；在 Cloudflare Queue、幂等 outbox、重试边界和企业微信 secret 就绪前不得启用，也不恢复公开 `/api/work` 数据接口。

`0077` 保留最后 3 张旧库源表：已由 `system_user_apply` 取代的 `user_enter`、公众号会员卡配置 `wechat_card` 与领取/激活历史 `user_card`。目标只保留源端 `user_enter.uid` 唯一约束，不为远端卡标识、code 或 openid 新增唯一性。Admin `/content/wechat-card` 只读展示导入目录，card_id、会员卡 code 与 openid 默认脱敏；同步上传素材、创建/更新卡券、激活和 `/wechat/serve` 回调写入统一关闭并返回 501，直到具备幂等 outbox、回调验签和事件去重边界。

```powershell
$env:SOURCE_MYSQL_URL = 'mysql://readonly:<password>@127.0.0.1:3306/crmeb'
$env:TARGET_POSTGRES_URL = 'postgresql://migration:<password>@127.0.0.1:5432/cinashop_staging'
npm.cmd run data:plan -- --tables=user,store_product,store_product_attr_value
```

计划支持 manifest 中显式声明源列 → 目标列映射，并会阻断映射源/目标缺失、多个源列写入同一目标列、源字段丢失、目标必填字段缺省、源 NULL/空 JSON/零时间哨兵无法写入目标必填列、缺失/不受支持的迁移策略、整数/小数缩窄、
无损容纳不了的字符串长度、时间精度丢失和不兼容类型；文本写入 JSON 前会逐值解析，
遇到非法 JSON 立即中止。单列或复合冲突键必须由目标主键/唯一索引证明；源约束不足时，
计划会只读统计唯一键策略的重复键组数和多余行数，存在重复即阻断，不会自动删除或选取其中一行。12 张确实没有唯一键的源表显式使用 `append_multiset`：按全部映射源列生成区分 NULL、空串、大小写与分隔符的长度前缀十六进制游标，按全行 multiplicity 原次数插入，不做去重；初次复制要求目标表为空，恢复时要求目标行数与本 run 已提交插入数精确相等。
`member_right.id` 与 `store_product_description(product_id,type)` 使用该实时门禁；没有稳定源键的
`store_order_status` 与 `store_integral_order_status` 使用上述多重集策略。旧 `store_integral_order` 及状态表
只保存统一订单改造前的历史，当前兼容读取和新兑换写入均使用 `store_order(type=4)`。
`category` 继续保存标签分类、参数模板等多态语义，不与 `store_product_category` 合并；
`store_product_rule` 不与每商品 SKU 快照合并，`system_group`/`system_group_data` 也不压入
`system_config`。虚拟卡密按独立敏感履约库存迁移：支付 outbox 在单一 PostgreSQL 事务内以
`FOR UPDATE SKIP LOCKED` 认领可用卡，库存不足整单回滚并可在补库存后重试；运营列表只返回掩码卡号、
密码配置标志和分配状态，只有已登录订单所有者的详情会返回交付内容。Admin/Supplier 批量导入已完成；
发布前仍必须先完成旧卡库存复制和真实运营账号、付款、通知与客户验收；最小库存告警和受控敏感导出已经完成，但主 Worker 尚未发布。
`store_coupon_user` 显式把旧 `cid` / `add_time` / 字符串 `type`
映射为 `issue_coupon_id` / `receive_time` / `receive_source`，并保留 `is_fail`；Worker 的数值 `type`
继续作为券类型快照，不与旧领取来源混用。旧 `system_message.uid`、`user_label.label_name`、
评价回复 `create_time` 也都有显式目标；运费模板把旧主体 `type` 保存为 `owner_type`，只把旧
计费方式 `group` 映射为 Worker `type`。跨表名迁移还覆盖 `express → express_company`、
`article → system_article`、`diy → system_dise` 与 `template_message → notification_template`；
旧通知模板的数字渠道写入 `legacy_type`，不覆盖 Worker 文本 `type`。`user_notice_see` 引用旧
`user_notice`，与引用 `system_message` 的 `user_message` 不是同一模型，迁移时保留为独立表。
真正写入前必须先把目标迁移执行到 `0082_payment_checkout_integrity.sql`（其中 `0020`
创建迁移控制表，`0021` 修复两条 schema 路径差异，`0022` 增加复合游标，`0023`～`0027`
补齐第一批旧列、社区、优惠券、系统元数据、评价回复和运费模板主体；`0028`～`0034` 继续补齐运费区域、提现、订单商品/拼团、发券、活动商品、订单快照、指定包邮和禁配区域；`0035` 支持快递公司与文章的无损改名迁移，`0036` 迁移 `system_city`/`city_area` 并恢复运费祖先区域匹配，`0037` 保留文章分类与独立正文并接入后台回退读取，`0038` 补齐 DIY、协议、通知模板、系统通知和用户通知/已读关系，`0039` 保留社区话题、多态关联和作者统计并恢复关系化发帖与幂等点赞，`0040` 保留订单优惠拆分、发票快照、促销分摊与逐次核销证据并恢复发票列表/详情/补开及支付退款联动，`0041` 保留促销规则及商品/券/品牌/标签范围，`0042` 保留秒杀父活动日期、限购配置与商品关系，`0043` 保留固定/任选优惠套餐并恢复公开读取，`0044` 保留同城配送第三方快照与用户状态轨迹，`0045` 把平台现金收支、用户内部账、供应商账和休眠门店账保持为独立会计语义，同时对旧 varchar 数值/Unix 秒执行显式预检与转换，`0046` 保留独立积分订单历史并恢复统一 `type=4` 兼容读取和事务化直兑，`0047` 保留多态分类、单位、规则、参数模板、虚拟卡密与系统组合配置并恢复租户隔离的兼容接口，`0048` 保留用户分组与标签关系并恢复事务化 Admin 兼容管理，`0049` 保留配置目录、动态表单定义和订单采集历史，并在采集链路完成前阻断表单商品下单；`0050` 保留签到奖励，`0051` 保留代理等级任务和完成记录，`0052` 保留商品支付后赠券关系，`0053` 保留砍价帮助明细，`0054` 保留商品保障、商品行为日志与访问聚合并恢复保障管理、详情读取和用户浏览历史，`0055` 保留用户反馈与平台/客服作用域快捷话术并恢复用户提交、Admin 处理和平台话术管理，`0056` 保留推广员申请、推广关系历史与旧冻结证据，并恢复短信验证码门禁、Admin 审核以及事务化防环绑定/计数/审计；旧冻结表只迁移、不参与现行可提现金额计算，`0057` 保留推广好友关系，并把去重新写入纳入同一关系事务、恢复社区双向好友列表，`0058` 保留搜索历史/结果缓存和页面访问证据，恢复搜索历史、清理、停留上报、完整商品 ID 缓存复用及微信登录访问记录，`0059` 保留新人专享目录，恢复活动价/基础库存、资格消费、四条前台路由、Admin 16 项配置/协议/目录写入及注册赠礼原子链路，`0060` 保留旧数据库缓存并为迁移器加入单列文本键），再同时提供写入开关、明确
表白名单和目标数据库名确认。远程目标额外要求 `MIGRATION_ALLOW_REMOTE_TARGET=1`：

`0061` 另外保留会员卡批次、复合主键卡片、会员套餐、会员订单与无主键状态历史；卡片的自增 `id` 会在复合迁移键复制后同步序列。`0062` 保留优惠券商品范围和领取证据，不增加源端不存在的主键/唯一约束。`0063` 原样保留 `system_store`、`system_store_staff`、`delivery_service` 与 `store_user` 的列、空值和普通索引语义，并以各表 `id` 作为确定性迁移键；源端没有唯一约束或外键的身份关系不会被目标凭空收紧。`0064` 保留 `store_config`、历史 `store_branch_product` / `store_branch_product_attr_value` 与休眠 `store_extract`；仅 `store_config` 恢复运行时，并固定为认证供应商的 `type=2 + relation_id` 作用域、配置键白名单和不回显密钥。`0065` 保留被取代的 `supplier_ticket_print` 历史配置与现行 `print_document`；运行时只恢复平台/供应商严格隔离、密钥遮蔽、启用完整性门禁及打印内容白名单管理，真实第三方打印调用留待 Queue/outbox。`0066` 保留 `system_user_apply` 与 `sms_record`，恢复供应商申请、审核与短信激活；验证码由 Web Crypto 生成，只进入 5 分钟 Redis 缓存和可重试 Queue 消息，不写 PostgreSQL/日志，阿里云访问密钥只允许 Worker secret。`0067` 保留 `system_attachment`、`system_attachment_category`、`system_file` 和 `system_storage`；新图片只进入私有 `ASSETS_BUCKET` R2 binding，并使用短期 HMAC 签名 Worker URL 读取。Admin、Supplier 和用户附件都由认证身份固定作用域，旧对象存储访问密钥仅迁移历史、不会成为运行时配置或进入响应。首次启用前必须显式创建 `cinashop-assets` R2 bucket；仓库配置不会替操作者创建或写入远端资源。`0068` 原样保留已被取代的 `store_product_category_brand`、`store_product_cate` 与 `store_product_label_auxiliary` 历史行；PHP 当前写入只使用 `store_product_relation`，因此 Worker 不恢复旧表双写。分类关系的 `relation_pid` 继续保存所选分类的即时 `pid`，分类移动会逐分类同步该语义，不再误写根祖先或把同一个值写给全部后代。`0069` 原样保留 `page_category` 与 `page_link` 的列、默认值和历史重复/孤儿语义，并恢复 `/diy/get_page_category`、`/diy/get_page_link/:cate_id`、新增与删除兼容接口；分类树不误加状态过滤，专题页和平台商品分类继续从现行权威表动态读取。当前 TypeScript Admin 仍只有简化 DIY 页面编辑器，旧版可视化链接选择器尚未迁移。`0070` 保留 `luck_lottery`、`luck_prize` 与 `luck_lottery_record`，并新增来源幂等、可过期且可原子消费的 `luck_lottery_entitlement`，替代 PHP 中会被覆盖的短时 Redis 抽奖次数；支付、评价和永久推广绑定分别发放对应权益，抽奖事务化处理积分/余额、库存、记录和可自动发放奖品。Admin 恢复活动、8 奖位、记录和实物发货，UniApp 恢复抽奖与领奖；新活动不允许微信红包或语义不明的用户等级奖，生产迁移和真实数据库 E2E 仍未执行。`0071` 保留 `wechat_key`、`wechat_media`、`wechat_message`、`wechat_news_category` 与 `wechat_reply`，恢复关注/默认/关键词回复、图文组和脱敏消息历史的 Admin 管理。新关键词写入以短事务和 advisory lock 拒绝歧义，图文编辑只更新当前组拥有的文章，共享文章会克隆后再修改；图片/语音只能选择已迁移素材。公众号回调、回复二维码与群发仍明确不可用，不会在 Worker 请求内同步调用微信。

`0072`～`0077` 继续保留渠道二维码、旧批处理目录、小程序直播、对外 API、企业微信和公众号会员卡；`0078` 增加履约查询索引，`0079` 把实际承载拼团记录 ID 的 `store_pink.is_refund` 拓宽为 `INTEGER`，`0080` 建立 Queue 死信归档/重放审计表，`0081` 建立不含卡号/密码的卡密导出票据审计表，`0082` 为充值订单增加非唯一查询索引，`0083` 建立 Out API 脱敏访问审计，`0084` 为站内发货/拒绝退款通知增加 nullable 精确事件键并扩展既有订单 outbox 白名单，`0085` 建立外部通知投递账本及微信身份/模板查找索引，`0086` 建立不复制目标或 payload 的人工处置审计表。`0082`～`0086` 已于 2026-08-15 在生产以短超时幂等应用并独立复核，既有业务快照不变。每个 Worker 内嵌迁移都在独立事务中先执行 `SET LOCAL search_path TO public`，避免 Hyperdrive 复用会话状态把生产 DDL 落入错误 schema；真实 MySQL 复制仍须先在隔离、空目标表上演练。

```powershell
$env:MIGRATION_CONFIRM_TARGET = 'cinashop_staging'
$env:MIGRATION_RUN_ID = 'staging-20260809-01'
npm.cmd run data:copy -- --apply --tables=user,store_product --batch-size=250
```

所有连接前写入门禁，以及连接后的行数、范围、NULL、转换后为 NULL 的哨兵值、重复键实时检查都必须完成；程序化调用也不能绕过。复制使用 MySQL 一致性只读快照，按由整数和文本分量组成的单列/复合键
做 keyset 分页（整数分量按数值字典序且首次游标为 NULL，不会漏掉合法负键；文本分量按二进制顺序）；单列整数游标保存在 NUMERIC，
复合或含文本的游标以字符串数组保存在 JSONB，避免 JavaScript 精度损失并支持确定性续跑。每批写入与数据库断点在
同一短事务提交，重复主键只记冲突，不覆盖目标数据。失败后使用相同
`MIGRATION_RUN_ID` 续跑。任何历史或本轮冲突/未完成检查点都会把运行标为
`NEEDS_REVIEW`，不能作为迁移通过证据。长时间一致性快照应在只读副本或维护窗口执行；
完成复制后会为本次实际写入的目标 serial/identity 列同步序列，因此复合迁移键中的自增列也不会停留在旧值。不要在未完成行数、金额、关系和抽样校验前将目标指向生产。

复制完成后必须使用同一个 `MIGRATION_RUN_ID` 做只读行级验证；验证同样要求明确表
白名单，并在 MySQL 与 PostgreSQL 两端使用一致性只读快照：

```powershell
$env:MIGRATION_RUN_ID = 'staging-20260809-01'
npm.cmd run data:verify -- --tables=user,store_product --batch-size=250
```

验证会重新应用计划中的时间/JSON 转换：有键表按单列或复合迁移键全量比较所有映射列，无键表按全行值核对目标 multiplicity；同时核对源/目标
行数、目标额外行、迁移检查点、插入/冲突或多重集插入守恒与整个 run 的终态。缺行、字段差异、
目标额外行、非 `COMPLETED` 检查点、任何历史冲突或 run 非完成态都会以非零状态退出。
报告只列主键或不可逆的全行游标 SHA-256 摘要及差异列名，不输出用户字段值；需要机器读取时可附加 `--json`。

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
wrangler secret put WECHAT_OPEN_APP_SECRET
wrangler secret put OPERATIONS_TOKEN
wrangler secret put INITIAL_ADMIN_PASSWORD
wrangler secret put WECHAT_MCH_PRIVATE_KEY
wrangler secret put WECHAT_API_V3_KEY
wrangler secret put WECHAT_PLATFORM_PUBLIC_KEY
wrangler secret put ALIPAY_PRIVATE_KEY
wrangler secret put ALIPAY_PUBLIC_KEY
wrangler secret put ALIYUN_EXPRESS_APP_CODE
wrangler secret put ALIYUN_SMS_ACCESS_KEY_ID
wrangler secret put ALIYUN_SMS_ACCESS_KEY_SECRET
wrangler secret put ALIYUN_SMS_SIGN_NAME
wrangler secret put TURNSTILE_SECRET_KEY
```

PC/Kefu 开放平台登录的 AppID 可来自精确 `wechat_open_app_id` 配置；AppSecret
只允许通过 `WECHAT_OPEN_APP_SECRET` Worker Secret 注入，不得写入
`system_config`、KV、响应或客户端环境。生产还必须设置精确的
`ALLOWED_ORIGINS`、`PC_AUTH_ALLOWED_ORIGINS` 与 `KEFU_AUTH_ALLOWED_ORIGINS`；
两类登录白名单按 audience 隔离，Kefu 正式域名确定前保持其列表为空并失败关闭，
不得用通配 Origin 临时放开。Origin 与 User-Agent 只能减少浏览器跨站请求并供用户
人工核对，非浏览器可伪造，不能充当客户端/设备认证。OAuth callback 必须经同源 Pages
Function（或同站点自定义 API 域名）；不要让 Pages 直接跨站请求 `workers.dev`，否则
`SameSite=Lax` verifier Cookie 不会发送。

Supplier 浏览器端也默认使用同源 `/supplierapi` Pages Function；正式 Pages 项目需设置并
验收 `WORKERS_API`。若任何前端选择绕过同源 proxy 直连 Worker，其正式 Origin 必须精确
加入 `ALLOWED_ORIGINS`，不能使用通配符。

用户短信入口还必须设置非密钥 `TURNSTILE_SITE_KEY` 与
`TURNSTILE_EXPECTED_HOSTNAMES`。后者是逗号分隔的精确 widget hostname，不能填写
scheme、端口或路径；Turnstile widget 所在的 Worker 自定义域/`workers.dev` 域也必须在
Cloudflare Turnstile 站点设置中登记。`POST /api/verify_code` 用有界 JSON 接收手机号和用途，
避免手机号落入 URL/访问日志；缺少任一 Turnstile 配置时，挑战创建会在数据库和短信队列前
失败关闭。服务端验证遵循 Cloudflare 的
[Siteverify 要求](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)，
不接受只在浏览器端成功的 token。UniApp App/小程序通过 WebView 承载 widget；小程序发布前
还要把 challenge hostname 加入平台业务域名白名单，参见
[Cloudflare 移动端要求](https://developers.cloudflare.com/turnstile/get-started/mobile-implementation/)
和 [UniApp web-view 文档](https://uniapp.dcloud.net.cn/component/web-view)。

Sign in with Apple 还需设置非密钥配置 `APPLE_SIGN_IN_CLIENT_IDS`（逗号分隔的
Bundle ID / Services ID audience）。客户端必须先调用
`POST /api/apple_login/challenge`，把返回的 `nonceSha256` 放入 Apple 授权请求，
再把 Apple 返回的 `identityToken` 和挑战 `key` 作为 `nonce_key` 提交到
`POST /api/apple_login`。服务端不接受客户端自报的 `openId` 或 `email`；未配置
audience、Redis、nonce 不匹配、签名/issuer/audience/期限错误均失败关闭。

`INITIAL_ADMIN_PASSWORD` 仅在目标账号尚不存在时用于首次创建，不会在后续迁移中重置管理员密码。支付方式只有在数据库开关与当前 Worker 配置同时完整时才会对收银台开放：余额要求 `balance_func_status=1` 和 `yue_pay_status=1`；微信要求 `pay_weixin_open=1`、HTTPS `site_url`、`wechat_appid`、商户号、商户证书序列号、32 字节 `WECHAT_API_V3_KEY`、商户私钥及微信平台公钥/证书；支付宝要求 `ali_pay_status=1`、`ALIPAY_APP_ID`、私钥、公钥以及 HTTPS 通知/返回地址；线下支付要求 `offline_pay_status=1`。微信退款还需配置 `WECHAT_PLATFORM_PUBLIC_KEY_ID`、`WECHAT_REFUND_NOTIFY_URL`。员工邀请小程序码还要求系统配置存在 `routine_appId` 与 `routine_appsecret`。物流轨迹查询需设置 `logistics_type=2`，并优先通过 `ALIYUN_EXPRESS_APP_CODE` secret 注入 AppCode；运行时仅为兼容旧数据才回退读取 `system_express_app_code`。供应商入驻短信要求 Upstash Redis、`ALIYUN_SMS_ACCESS_KEY_ID`、`ALIYUN_SMS_ACCESS_KEY_SECRET`、`ALIYUN_SMS_SIGN_NAME`，模板优先读取 `ALIYUN_SMS_VERIFICATION_TEMPLATE_CODE`，否则读取启用的 `system_notification(mark=VERIFICATION_CODE_TIME)`；所有短信凭据只从 Worker 环境读取。客服消息由 Durable Object 协调并在发送前直接通过 Hyperdrive 持久化，不再经过公开内部 HTTP 回调；`INTERNAL_API_URL` 仅用于 Worker 对外源站配置，可放 Wrangler vars。第三方退款上线前必须先在隔离数据库执行 `0009_third_party_refund.sql`；任何新支付流量进入新版 Worker 前还必须执行 `0010_payment_outbox.sql` 和 `0082_payment_checkout_integrity.sql`，新版下单/收货流量进入前必须依次执行 `0011_order_brokerage_settlement.sql`、`0012_order_rewards.sql`、`0013_division_brokerage.sql` 与 `0014_division_management.sql`；新版 ACL 上线前必须先执行 `0015_admin_menu_acl.sql`。`0011`～`0014` 不为历史订单回填佣金或收货奖励；`0014` 仅保留每个用户最新一条未删除代理申请，其余重复申请软删除；`0015` 只建兼容表，不伪造旧菜单 ID，旧数字角色规则必须连同对应 `system_menus` 数据迁移并由超级管理员复核或转换为权限 key。随后用测试商户验证回调、主动查询、扫码绑定、物流查询、短信 Queue 重试与 Admin 重放，并对普通/事业部分佣、积分、经验、收货、退款、提现和权限矩阵做对账。

发货/拒绝退款通知流量进入新版 Worker 前，必须依次执行 `0084_order_notification_outbox.sql`、`0085_external_notification_delivery.sql` 和 `0086_notification_delivery_operations.sql`，再从源 MySQL 复制并由运营复核 `order_postage_success`、`order_deliver_success`、`order_fictitious_success` 与 `send_order_refund_no_status` 四类 `system_notification` 及对应 `notification_template`。生产当前四类模板、微信身份、渠道配置和外部 secrets 均未就绪；缺配置会安全抑制或进入可审计终态，不能把 schema 就绪误写成通知已上线。阿里云 `SendSms` 的 `OutId` 不是幂等键，`UNKNOWN` 必须先按提供商记录对账，再由人工确认已发、关闭，或明确承担重复发送风险后重发；每次决定都写入动作审计表。Admin 只显示 secret 是否就绪，旧 `/sms/config` 写接口会拒绝请求，密钥不得保存到 `system_config`。

电子面单流量进入新版 Worker 前，必须先执行 `0091_electronic_waybill_outbox.sql`，再分别以 `wrangler secret put CRMEB_ONEPASS_ACCESS_KEY` 和 `wrangler secret put CRMEB_ONEPASS_SECRET_KEY` 注入一号通凭据。平台需完整配置 `config_export_*`，供应商需在自身 `type=2 + relation_id` 作用域配置 `store_config_export_*`；其中 `*_id` 是默认快递公司 ID，`*_siid` 才是云打印机编号。凭据只允许 Worker Secret，不能回退读取旧 `sms_account/sms_token`。任何 `UNKNOWN` 都表示签发端点可能已受理：必须先在提供商后台按订单/任务引用对账，再选择应用账本中已有单号、人工确认单号、明确承担重复分配风险后重签，或关闭；禁止自动盲重试。

### 5. 部署
```bash
npm run deploy          # 生产
npm run deploy --env staging   # 预发
```

---

## 与 PHP 共存策略（会话隔离的双跑过渡）

本项目放在 `cinashop/workers-ts/`, 不影响 PHP 主项目 (`cinashop/` 根目录)。过渡期:

1. **PHP 后端继续运行**（域名示例 `api.example.com`）。
2. **Workers 后端独立部署**（域名示例 `api-ts.example.com`）；当前两端 token bucket
   键名/编码不兼容，不能把同一个 bearer 在两端任意跳转。
3. **灰度按完整鉴权域切换**，测试账号可分别登录；禁止把同一登录会话的接口随机分流到
   PHP 与 Worker。
4. 正式用户切换前明确二选一：全量切流并强制重新登录，或完成可撤销、保 TTL 的 bucket
   双读/迁移桥。之后再做影子读流量和 5% → 20% → 50% → 100% 业务切量。

---

## 关键约定

| 约定 | 说明 |
|------|------|
| 普通用户密码 | 历史库存为 `md5(password)`；JWT auth claim 为 `md5(user.pwd)`，不要混淆两层用途 |
| 其他身份凭据 | Admin/Supplier/Kefu 使用历史 bcrypt 库存，Out 使用历史 appsecret hash；JWT auth 都是 `md5(库存凭据)` |
| JWT 密钥 | `APP_KEY` 必须与 PHP `.env` 的 `app.app_key` 一致，但 token bucket 仍需单独切换方案 |
| 响应信封 | 业务兼容响应保持 `{status, msg, data}`；来源拒绝、认证基础设施不可用等安全/系统错误使用真实 4xx/5xx，并禁止缓存 |
| token header | 优先 `Authori-zation`, 兜底 `Authorization` (与 PHP 一致) |
| 错误码 | `410000` 未登录 / `410001` 过期 / `410002` 封禁 (与 PHP 一致) |
| 表名 | 无前缀 (PHP 是 `eb_user`, 这里是 `user`); 共库时需调整 |
| 时间戳 | `add_time`/`last_time` 用 int 秒; `delete_time` 用 timestamp |

---

## 已知待办

- [x] 精确注册 PHP `/api/pc` 22 条兼容合同，19 条恢复 PC banner/分类/商品/城市/公司/二维码与 UID 作用域的购物车/资金/订单/收藏/售后；共享商品查询同步修复 `cid/sid/tid/selectId/news/type` 和 SVIP 可见性偏差。生产 Hyperdrive 只读与随机 schema 15/15 通过，`public` 指纹不变，临时 Worker/schema 已删除
- [x] 以精确来源白名单、二维码公钥/私有 poll secret 分离、扫码主体/audience 绑定、按 state 隔离的浏览器 verifier Cookie、OAuth state/code 重放保护、可重试 token 交付、限流和失败关闭重建 PC/Kefu 登录；Origin/UA 只供核对而非身份证明，PC、Kefu 与 UniApp 扫码确认已完成本地接入和桌面/移动浏览器回归
- [ ] 配置生产 `wechat_open_app_id`、`WECHAT_OPEN_APP_SECRET` 和 Kefu 精确 Origin，迁移微信身份/客服账号，并用真实微信、真实账号、浏览器/真机、预发和发布完成正向 E2E；当前主 Worker/前端未发布，PC 分类关系、banner、城市和 14 个候选配置也仍待复制/运营确认
- [x] 恢复 API v2 三条促销只读兼容合同：活动商品、赠品信息和登录态凑单；按 active 平台父规则执行全场/指定/排除/品牌/标签五类范围，保留 PHP 折扣截断、阶梯与券/赠品 SKU 投影，并修复商品 DAO 的显式 `ids` 过去只排序不筛选而导致范围扩散的问题。生产 Hyperdrive 只读确认促销/辅助表均为 0；随机 schema 12/12、`public_state_unchanged=true`、临时 schema `0→0`，一次性审计 Worker 已删除
- [ ] 从源 MySQL 复制并由运营复核促销父子规则、商品/品牌/标签范围、券与赠品 SKU；补齐 API-006 订单促销叠加并完成旧 UniApp/真实账号/预发 E2E 后，才可把 PROMO 域判为完成
- [x] 恢复客服独立 token 域及 22 条核心 PHP 路由，固定账号 ID/聊天 UID 双身份、会话与聊天成员作用域、用户分群、个人话术/分类 owner；登录前以 HMAC 脱敏来源和 Durable Object 实施 10 次/分钟强一致限流。生产 `0092` 四索引已应用，随机 schema 13 项断言和业务行/序列不变验证通过
- [x] 为 `tourist/user|order|chat|upload` 建立安全兼容层：24 小时 HS256 visitor audience、SHA-256 token 摘要与撤销/期限复核、权威客服分配、游客 UID 独立序列、`is_tourist` WebSocket/未读/转接隔离、R2 `module_type=4` owner，以及登录用户订单归属门禁；Kefu 工作台和 UniApp 已接入。生产 `0104` 经随机 schema、两次幂等应用和业务指纹验证，新游客表为 0 行
- [x] 用 PC `/service` 替换旧 Admin 项目中面向顾客的 `appChat`：登录用户沿用 `/api`，匿名用户只使用 `X-Visitor-Token` 与 `cinashop-visitor.<token>` 子协议；URL 不含 token/`tourist_uid`，游客断线不回退到登录用户 REST 写接口。Pages/Vite 双代理保留 WebSocket 101；桌面、390×844 移动端的安全失败态及受控签名游客正向消息单次回显均已通过浏览器验收
- [ ] 从源 MySQL 复制并复核客服账号/bcrypt 密码/用户绑定、会话/消息、话术/分类与游客内容；当前没有 `SOURCE_MYSQL_URL`、旧 `.env`、本机 3306 监听或 MySQL/MariaDB 服务，生产客服账号、会话也均为 0，无法做正向生产游客分配/WebSocket/R2/转接或真实扫码/OAuth E2E。补齐测试客服后，还需完成旧页面退流、生产限流、浏览器/真机、预发、影子流量并取得明确发布批准。不存在控制器目标的旧 `ticket` 不恢复，ERP 写入在回调验签和幂等协议完成前保持关闭
- [x] 将 Out API 扩展为 14 条有界 GET，以及订单/退款备注、确认收货、人工快递发货、人工快递拆单发货、既有配送信息更正、发票资料/状态、同意退货、拒绝售后和真实资金退款 11 条 PUT；逐路由 ACL、`store_id=0` 平台范围、PII 禁缓存、IP+账号强一致限流、HMAC 脱敏审计、共享订单/退款锁、请求摘要重放、拆单金额/数量守恒、配送员权威值、发票唯一关联、渠道状态互斥、权威金额绑定、余额 exactly-once、并发单写与失败回滚已通过单元及生产 Hyperdrive 随机隔离 schema 验证
- [ ] 从源 MySQL 复制 `out_account/out_interface` 并由真实客户确认最小权限与 PII 字段；生产当前两表有效行均为 0。主 Worker 发布后验证真实 Durable Object RPC/429、真实审计写入与客户端退避，再用测试商户完成微信/支付宝退款、回调与对账，并为配送员重新分配及 PHP 发货通知/小程序上报建立幂等 Queue/outbox；任意外部推送继续禁用
- [x] 在生产 PostgreSQL/Hyperdrive 随机隔离 schema 上验证下单并发、取消补偿和支付/取消竞态；公共业务数据/序列前后不变
- [x] 恢复固定/任选优惠套餐的完整选品、服务端权威计价、统一 `type=5` 下单、原子限额、免邮和退款门禁；生产 Hyperdrive 隔离场景覆盖固定/任选规则、并发单赢家、故障回滚、取消及部分/全额退款补偿
- [x] 恢复优惠套餐 Admin 五条 PHP 兼容路由、商品/标签选择、逐 SKU 定价、稳定关系/SKU 更新、启停/软删、ACL 和响应式页面；生产 Hyperdrive 隔离场景覆盖固定保存、转任选、移除清理、强制失败回滚、未来定时启用和缺货拦截
- [ ] 从源 MySQL 复制并由运营确认真实优惠套餐、关系及 `type=5` 属性/SKU；核对 PHP `postage/system_form_id` 与真实源表后，再用受限 Admin 账号、真实客户地址/支付/通知完成端到端验收和发布
- [x] 将积分加现金、运费、地址和自定义表单接入统一购物车/订单/支付/取消/退款；直兑只保留无需配送的零现金、零运费兼容类型并写支付 outbox，生产 Hyperdrive 隔离场景已覆盖积分并发扣减、三层库存和纯积分退款
- [x] 恢复会员套餐购买/订单创建/余额及外部支付编排、回调分流和 `member_scan` 激活二维码；Admin 运营与用户购买支付均已通过生产 Hyperdrive 隔离 E2E
- [x] 恢复订单/会员/充值统一收银台与有效支付能力矩阵，关闭充值余额伪入账路径；生产 Hyperdrive 隔离场景已验证充值并发单次入账、重放幂等、金额/交易号冲突和重复订单拒绝，PC 收银台桌面/移动禁用态及微信 QR 未回调状态已通过浏览器验收
- [x] 删除硬编码充值赠送档位，以 `system_group_data(user_recharge_quota)` 为服务端价格/赠送权威并恢复 PHP 充值首页响应；生产只读确认启用档位 0、畸形档位 0，不再展示虚构赠送
- [x] 迁移 PHP `type=1` 佣金转余额：`brokerage_price → now_money`、paid balance recharge、余额流水、已通过提现记录和佣金支出同事务提交；生产 Hyperdrive 隔离场景覆盖冻结额、双连接单赢家、故障全回滚/重试和三用户资金守恒，PC/UniApp 增加不可逆确认
- [ ] 从源 MySQL 复制并由运营确认 `user_extract_balance_status` 与 `recharge_attention`；生产当前两项均缺失，按 PHP 默认开关 1 处理，3 个有效用户的佣金/冻结/可转聚合均为 0.00
- [ ] 对生产 1 条已支付但无 `trade_no` 的历史充值记录做源 MySQL/支付渠道/用户余额三方对账；在测试商户补齐支付开关和 secrets 后完成微信/支付宝真实验签、客户端跳转/扫码、回调重放和退款验收
- [ ] 复制旧会员/订单/无主键 `other_order_status` 多重集数据，在测试商户和真实客户端完成微信/支付宝验签支付、退款及用户验收后再发布
- [x] 引入本地 Workers runtime 测试池，覆盖 Cron 根任务、Queue ack/retry、KV 隔离绑定和 SequenceDO 回收恢复
- [ ] 在 Linux CI 或另一台 Windows x64 主机执行 runtime 套件并继续覆盖 WebSocket hibernation；本机 Windows build 26200 已安装 VC++ x64 Runtime 14.51，但最小无绑定 workerd 仍以 `0xc0000005` 退出
- [x] 为支付后置任务建立事务 outbox / 可重放消费者（本地实现）
- [x] 将 Admin、Supplier、拆单、虚拟卡密和 Out API 的发货，以及 Admin/Supplier/Out API 的拒绝退款决策接入同事务通知 outbox；PHP 站内信模板渲染、事件键去重、禁用抑制、消费失败/并发租约重试已通过生产 Hyperdrive 隔离场景
- [x] 增加短信、公众号模板、小程序订阅和微信发货上报适配及独立投递账本；随机 schema 验证 17 条渠道矩阵、`16 SENT + 1 UNKNOWN`、引用型 Queue 消息和终态重放不重复调用
- [x] 完成 Admin `mark/tempid`、渠道矩阵、凭据只读就绪状态、脱敏投递台账及 `UNKNOWN` 确认已发/承担重复风险重发/关闭流程；动作以请求键幂等并写入不含目标/payload 的不可变审计表，生产 Hyperdrive 随机 schema 已验证三种状态迁移
- [ ] 从源 MySQL 复制并由运营复核四类订单通知开关/模板，补齐 openid 与阿里云/微信 secrets，并以受限运营账号和真实测试客户完成短信、公众号、小程序和发货上报验收后才能称通知副作用等价
- [x] 用 Turnstile 替换用户短信发送前的 AJCaptcha：一次性挑战绑定手机号/用途/IP，Siteverify 强制校验 hostname/action/cdata/时效，PC iframe 与 UniApp WebView 均在回传后复核服务端状态；生产 Hyperdrive 只读指纹与 Cloudflare Worker 官方测试端点验证通过
- [ ] 创建正式 Turnstile widget，配置 `TURNSTILE_SECRET_KEY`、`TURNSTILE_SITE_KEY`、`TURNSTILE_EXPECTED_HOSTNAMES` 和小程序业务域名白名单；补齐 Aliyun SMS secrets/模板后，用真实 PC、H5、App、小程序完成发送、过期、重复、用途错配与失败恢复 E2E，再申请发布主 Worker/前端
- [x] 在生产 Hyperdrive 随机隔离 schema 与真实 Cloudflare Queue/DLQ 上验证 outbox 提交、重复消息、消费者中断、过期租约、故障恢复、持久归档和受控重放
- [x] 为虚拟卡密/共享密钥接入支付 outbox 原子交付，并在生产 Hyperdrive 隔离 schema 验证库存竞争、部分认领回滚、补库存重试与幂等重放
- [x] 补 Admin/Supplier 卡密脱敏查看与批量导入，并在生产 Hyperdrive 隔离 schema 验证并发幂等、租户隔离、精确库存增量和密码不回显
- [x] 补库存风险告警与只显示一次的受控敏感导出；生产 Hyperdrive 隔离场景已覆盖票据摘要、租户/商品/SKU 绑定、并发单次消费、重放/过期拒绝和精确审计
- [ ] 取得可访问的源 MySQL，复制旧 `store_product_virtual` 库存，并完成真实运营账号、付款/通知/用户验收后再发布
- [x] 补齐 Admin 新人目录、16 项注册配置与协议写入，以及密码/微信注册赠积分、整元余额和优惠券的原子链路；生产 Hyperdrive 隔离场景已验证保存/替换/回滚、并发 exactly-once 和赠礼故障回滚
- [ ] 从源 MySQL 复制并由运营确认 16 项注册/新人配置和活动目录，以真实用户完成 PC/UniApp 下单、微信注册与赠礼账本验收后再启用
- [ ] 在隔离 PostgreSQL 上验证收货/多次退款并发、历史普通/事业部分佣与积分/经验对账
- [x] 迁移事业部、代理商、员工的后台维护、事业部数据作用域、申请/员工关系和经营报表（本地实现）
- [x] 补齐旧版小程序员工二维码生成和全后台菜单级 ACL 执行（本地实现）
- [ ] 用真实小程序 AppID/AppSecret、测试 PostgreSQL 和受限管理员账号验证取码、扫码绑定及 ACL 允许/拒绝矩阵
- [ ] 用真实小程序直播测试账号验证直播列表、回放、直播间/商品状态同步和 Queue 重复投递；在设计幂等 outbox 前保持所有微信直播写接口关闭
- [ ] 用真实阿里云物流 AppCode 验证在途、派送、签收、异常、空轨迹、超时与缓存命中
- [x] 为 `print_document` 建立带幂等、租约、结果未知隔离和人工处置审计的 Queue/outbox；已恢复易联云/飞鹅云收据打印协议、下单/付款/手工触发、Admin/Supplier 台账与权限边界，并通过生产 Hyperdrive 随机 schema 的 mock-provider E2E，尚未发布主 Worker或真实出纸
- [ ] 单独恢复电子面单第三方签发；当前只保留供应商作用域配置，不得把收据打印完成误记为电子面单完成
- [ ] 补齐供应商、后台、UniApp、客服长尾与 ERP 的旧新契约映射
- [ ] 建立旧 MySQL → PostgreSQL 数据迁移与影子流量比对
- [ ] 分拆 Admin/PC 超过 1 MiB 的主包
