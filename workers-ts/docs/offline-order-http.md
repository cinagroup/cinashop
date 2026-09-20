# 线下收银鉴权 HTTP 与服务器状态恢复

2026-09-20，未部署的本地接线。建单／支付／详情／支付方式发现／本人消费记录查询已进入实际 `apiRoutes`，PC／UniApp 收银页面已接分步合同、本地持久恢复及无本地记录时找回原单；本地受控安装、正式注册与收银范围权限预检已有独立验收，生产迁移／角色及真实商户验收仍未完成，不据此开放正式生产收款或关闭 FE-003F。

## 最低应付政策（2026-09-20 最新决定，本地未部署）

用户明确选择：**禁止零元结算，折扣后应付至少 0.01 元**。本节覆盖此前阶段记录中的“零元政策待定／允许零元准入”。

- 报价继续按整数分截断，不向上取整、不收最低补差、不取消折扣。`0.01 × 80%` 拒绝；`0.02 × 80% = 0.01` 可继续确认。
- 新建单的确认价为零立即拒绝；客户端伪报 0.01 也不能绕过锁后的权威计价。报价后权益改变使实付不足一分，整笔无订单／准入／状态或财务写入。
- 正金额原订单仍按冻结价幂等恢复。历史零元记录保留，只读详情为 `UNAVAILABLE/paid=false`，方式发现均为 `read_original`；余额、微信及支付宝请求拒绝，不扣款、不赠积分／节省、不预留外部支付路径或请求平台。
- PC／H5 明示最低应付，拒绝新旧服务返回的真实字符串零报价；数字 0 仍是“无会员报价、按原价”的旧展示哨兵。旧零元本地记录不重发建单，不抹掉未知请求，不伪造已付；其安全关闭／释放仍属于后续生命周期工作。
- 无数据库结构更改：保留历史零元准入的读取能力，支付凭据原有正金额约束不放宽。历史测试使用专用 PG16 维护夹具导入旧记录，保留全部触发器和约束，不通过当前建单接口制造零元单。

### 验证与证据边界

本轮不同用例共 **320 项通过**：原生 PG16 报价／准入／余额 142，真实 workerd/JWT/本地 Hyperdrive HTTP＋选择／派发 82，共享客户端 76，Uni 实际运行时 20。HTTP 覆盖四种渠道、三种支付方式拒绝历史零元、无 provider I/O，以及恰好一分钱余额付款／重复请求仅扣一次。Worker 主配置／运行时测试双类型、PC 构建内置测试／类型／产物、Uni 类型／H5 构建通过。首轮 Uni 新用例将旧请求适配器省略的默认 GET 误断言为显式 GET，修正断言后全部复跑通过，不修改请求实现。

浏览器使用已安装工具及最终构建，PC `127.0.0.1:52571` 默认桌面、H5 `127.0.0.1:52572` 390×844；只有本机合成接口和合成登录，不是生产登录或真实支付验收。两端均验证 0.01 原价拒绝且建单禁用 → 改 0.02 得 0.01 报价 → 查询历史 → 明确恢复旧零元 → 整页刷新仍不可付款。页面身份、非空、无框架错误层、交互与截图通过；H5 内容宽375，无横向溢出。最终各 2 次报价 POST、1 次历史 GET、2 次详情 GET，create/pay/方式发现均0；没有新订单。PC 无错误警告，H5 无应用错误，三次加载各保留既有 vue-router 弃用警告。截图通过浏览器展示，临时脚本在系统临时目录。

两个独立 PG16 集群均完成库／角色清理并停止，独立 `pg_ctl status` 为3，无PID／临时口令／原端口监听；可信PG／workerd进程0。临时UI服务器及标签已关闭，端口和脚本进程无残留，诊断目录保留。PostgreSQL／Workers 技能约束整数金额、锁后权威和事务外 I/O；前端测试技能要求实际构建的桌面／移动交互及截图核验。真实 provider／商户／原生设备、完整生产角色、关闭退款及协调发布仍开放，FE-003F 不勾选；无生产访问、暂存、提交、推送或部署。

## 退款范围与后台联合验收（2026-09-20，最新决定）

项目所有者已确认：**保持PHP的type=3线下收银范围，暂不新增退款**。
新增此域退款为本次迁移不适用，不要求增加退款表、接口或按钮；此前“关闭退款仍开放”
等历史文字不再表示必须实现退款。商品订单售后合同不受此决定影响，不确定支付仍须
保存原单和路径、只读查证，不把取消／平台关闭状态推断成退款或释放凭据。

后台现已完成[实际Admin／HTTP／workerd／本地Hyperdrive／PG16联合验收](admin-offline-order-read.md#退款范围决定与真实浏览器联合验收2026-09-20最新本地未部署)：
23条真实SQL合成记录，业务只读LOGIN、分页／详情／实际收银码、真实撤权／503恢复／
过期JWT浏览器验证，资金全行指纹不变。并修正列表／详情／码的HTTP失败中文提示。
这是本地候选证据，不是远端Hyperdrive、Redis、微信／支付宝真实商户、原生设备或生产发布验收。

## HTTP 合同

后台最新本地增量见[线下消费只读记录及收款核验](admin-offline-order-read.md)：
独立平台管理员 `/adminapi/order/scan_list` 和 `scan_detail/:id`，在管理员只读权限下
复用本文件的收款凭据核验；不暴露客户付款 ticket，不代客支付。后台新版页面、严格API
解码、二维码及本机桌面／手机浏览器联合验收已完成；真实手机扫码和生产验收仍待完成。以下表格仍只描述
客户接口，不改变其账号／所有权要求。

后续本地增量：新增[受控安装与协议权限](offline-order-installation.md)。本文件的
原生 PG/workerd HTTP 夹具现通过该安装器及授权入口准备线下收银对象，不再手动
拼接六段候选 DDL；后续[正式注册](offline-order-registration.md)已完成本地验收，生产安装及真实商户验收仍未完成。

上述路由均要求 `authMiddleware({ force: true })` 的顾客令牌；生产继续要求精确 Redis token bucket、JWT 签名／期限、actor=api、账号状态和密码版本。用户只取鉴权注入的 UID，不从 JSON、URL 或支付平台跳转参数取值。全局响应缓存策略使成功及错误响应均为 private/no-store。

| 接口 | 输入 | 输出／作用 |
| --- | --- | --- |
| `POST /api/order/offline/create` | `money`、`expected_pay_price`、`from`、`request_key` | `{order_id,pay_price,replayed}`，只持久建单，不支付 |
| `POST /api/order/offline/pay` | `order_id`、`pay_type`（yue/weixin/alipay）、可选 `return_client`（pc/h5，默认 pc） | 现有原子支付／持久派发，再返回经验证的详情及 replayed；返回客户端不改变原支付路径 |
| `GET /api/order/offline/detail/:orderId` | 只有原订单号，不接受 query 覆盖 | 当前用户的只读、一致性收银快照，不查询支付平台或执行结算 |
| `GET /api/order/offline/pay/type` | 可选唯一 `order_id`、`return_client`（pc/h5，默认 pc）；拒绝身份、渠道、金额等覆盖 | 无单号为旧 H5 展示合同；新页面携带原单号及客户端取得一致的方式预检，非付款授权 |
| `GET /api/order/offline/history` | 无参数／唯一完整 `order_id`／唯一 `cursor`，查询与游标不混用 | 仅本人已准入消费的线索，每页至多 20 条；无收款状态或支付入口 |

写入 JSON 实际流读取最多 1KiB，未知字段拒绝。金额必须是规范十进制字符串；确认价与锁后服务端报价不符返回既有 409 业务信封及权威价格。渠道沿用已有准入规范化：weixin/wechat、weixinh5、routine、h5。只支持独立 type=3，无会员类型、客户折扣、余额数字、UID、OpenID、商户、回调地址、支付成功标志或 quitUrl 输入。

`request_key` 必须为规范小写 UUIDv4，由客户端在首次提交前持久保存。同一用户／请求键／规范化金额和渠道重试返回原单号；同键不同内容 409；服务器以加密 UUID 分配 `xx`＋30位十六进制订单号。新请求键代表新的消费确认，不得在网络超时、刷新或登录恢复时自动生成。建单响应特意不带未经财务凭据校验的 paid 标记，后续付款显示必须读取详情。

旧 PHP `/order/offline/create` 曾把建单和首次支付耦合，并接收 type、pay_type、quitUrl；新路由是**需要配套更新客户端的分步合同**，不声称旧页面可以无修改使用。现代页面与支付方式发现见下节；方式预检仅反映读取时可用性，不宣称平台一定接受付款。

H5 IP 只取 Cloudflare 的 CF-Connecting-IPv6（如存在）或 CF-Connecting-IP；不取 JSON、X-Forwarded-For 或伪造的默认 0.0.0.0。适配器验证地址格式和回环／未指定等情况。Cloudflare 官方说明同域 Worker 子请求可受上游 Worker 的 x-real-ip 影响，跨域也有固定地址；因此该取值不是对任意代理链的真实性证明，发布前仍要核验同域 Pages/Worker 转发及 Pseudo IPv4 配置。见[Cloudflare 请求头合同](https://developers.cloudflare.com/fundamentals/reference/http-request-headers/)。

## 状态不是付款凭据的替代品

详情在一个有界 REPEATABLE READ、READ ONLY 事务中重查有效账号、唯一自有 type=3 订单、不可变准入、原支付选择和财务凭据。不会拿行锁，不会生成入口、发起查单、派队列、写状态或改用户余额。使用与财务重放相同的校验函数，而不是复制一套较弱的“paid 列为 1”判断。

| state | paid | 含义 |
| --- | --- | --- |
| UNSELECTED | false | 尚无支付选择或恢复意图；不表示支付方式开关一定可用 |
| READY | false | 原入口仍在展示期内，摘要／原身份／金额均校验通过；绝非已付款 |
| RECOVERY_REQUIRED | false | 未知结果、过期入口、原恢复记录或未完成派发；不释放支付路径，不换新单 |
| UNAVAILABLE | false | 订单隐藏或历史零元订单禁止付款；不是已向上游确认关闭 |
| PAID | true | 独立资金凭据与来源／账单／原订单一致 |
| REVIEW_REQUIRED | true或false | 存在恢复冲突或关闭标记等需核对情况；paid=true仅保留已验证的本地收款事实 |

余额已付须匹配选择、付款时间、扣款前后差额、现金账单、赠分和会员节省；外部已付还校验回调身份绑定或查询证据及摘要，核对原金额／交易号／到账时间。缺失、双重或损坏凭据一律报错，不补造、不自动修复。原账号当前余额不被用来重新计算历史付款；type=3 不延长会员。隐藏订单仍可读其已核验资金事实，hidden 不冒充 provider 关闭。

返回字段是显式投影：原订单号／原价／实付／渠道／选择的支付方式／创建时间／hidden／paid／state；已付才返回 paid_at，READY 才返回受限 ticket 和 display_until。无数据库主键、UID、选择／attempt／case UUID、明文原付款人、商户密钥或原始平台响应。

## 未就绪与丢响应

缺候选表、列、函数或必要 SQL 权限时返回 HTTP 503 和通用信封，不在请求中运行 DDL、不提供空成功，也不以表存在就证明安装门禁完成。其他完整性错误沿用业务失败信封。正式启用前仍须完成目录／所有者／ACL／约束验证与受控注册，不能直接把候选 SQL 复制上线。

付款可能已经提交，而后续详情读取或 HTTP 响应失败。因此 503／网络异常都不能被页面解释为“肯定未付”：保留原 request_key 和 order_id。当前页面在已知单号时只读取原详情；仅建单响应未知时，由用户明确重试同一持久请求键，不自动支付。服务器余额／派发幂等边界防止同单重扣、重发或切换支付路径；客户端本地恢复已验证，真实商户端到端恢复仍待验收。

## 验证套件与剩余范围

`test/offline-order-http.test.ts` 在实际 workerd 中运行生产 `apiRoutes`、JWT／数据库用户鉴权、控制器和服务；仅运行环境改为测试专属 Hyperdrive/KV、随机非所有者 LOGIN 及本地支付响应。通常设置 NODE_ENV=test 省略外部 Redis；另有 NODE_ENV=production 缺令牌存储仍503的反例，不能冒充实际生产 token bucket 验收。

套件覆盖持久建单／同键冲突、余额支付及重放、账号／actor／所有权／字段拒绝、1KiB边界、缺表503、不自动DDL、H5 IP来源、READY/UNKNOWN重复读取无外发、迟后权限回滚、读账号撤销写权限、损坏付款字段或收款来源拒绝、改密、隐藏／零金额订单。外部已付详情场景用既有 Node 恢复核心生成真实数据库证据，消费者平台响应为本地签名样本；详情仍在 workerd，不将此场景宣称为 provider→回调HTTP→队列端到端。

实际跨设备会话／原生设备找回验收、真实支付平台回跳及商户域名验收、零元政策、安全刷新/确认关闭及退款、跨业务订单号权威、旧凭据版本、受控 DDL／ACL／目录升级、实际 Redis／远端 Hyperdrive／支付平台、当前代码 Linux CI 与协调发布仍开放。Workers/PostgreSQL 技能促成有界请求、显式投影、只读一致性快照、共用财务凭据校验与最小权限验证；没有生产、图片或缓存写入，也未暂存、提交、推送或部署。

## 支付平台回跳原单上下文（2026-09-20 最新本地增量）

此前支付宝使用通用固定返回地址，微信 H5 没有附带原单号；现两种入口均绑定原消费。新 PC `/user/offline-result` 使用独立包装组件，避免 Vue 在收银与结果路由间复用可写模型；H5 仍使用 `/pages/annex/offline_result/index`。两端结果模型必须收到唯一规范的 32 字符原单号；缺失、重复、换行或非法单号不能回落到本机另一笔记录。结果读取完全不访问或修改本地消费日志，即使日志属于另一笔、损坏或存储拒绝访问，也可鉴权核对所指原单；付款、建单、历史查询、SDK 打开及清除记录均不可在结果模型执行。

请求只新增有限枚举 `return_client=pc|h5`；PC 固定 pc，Uni 固定 h5。方式发现与首次派发均预检所选客户端的服务端配置，不取 Origin、Referer、JSON URL 或旧 quitUrl。省略时默认 pc；已有派发重放继续原不可变 ticket，不根据新客户端、配置或刷新重新生成入口。余额支付接收合法枚举但不会产生跳转。

| 服务端配置 | 本地候选值 | Pages GET/HEAD 入口的固定 303 目标 |
| --- | --- | --- |
| OFFLINE_PC_RETURN_ORIGIN | https://shop.cinaseek.ai | `/user/offline-result?orderId=原单号` |
| OFFLINE_H5_RETURN_ORIGIN | https://cinashop-h5.pages.dev | `/#/pages/annex/offline_result/index?orderId=原单号` |

配置仅允许规范 HTTPS DNS origin（无用户信息、端口、路径、片段、查询或尾斜线），生成的 `/offline-payment-return?orderId=…` 不超过 256 字符。支付宝 `return_url` 与业务 `quit_url` 使用同一原单地址并纳入 RSA 签名，覆盖完成与中途退出两条路径；其他会员／商品支付的 ALIPAY_RETURN_URL 不改动。[支付宝 WAP 官方合同](https://opendocs.alipay.com/open/02ivbs.md)给出 return_url 长度及 quit_url 含义。微信验证签名后的原 h5_url 不重新序列化，只追加编码后的 redirect_url；上游已含该字段时拒绝，不覆盖。按[微信官方调起说明](https://pay.weixin.qq.com/doc/v3/merchant/4012791835.md)，商户必须配置对应 H5 支付域名，且取消与完成都会回跳。因此回跳本身永远不是付款证明。

PC／H5 的 Pages 函数使用共用纯导航处理器，无鉴权、数据库、平台查询或结算 I/O。唯一 orderId 必须有效；若平台附 out_trade_no，必须唯一且等于原单号。其余 paid、status、amount、sign、uid、redirect 等参数全部丢弃；只输出站内固定相对 Location。拒绝 POST（405），异常输入 400，所有响应 private/no-store、no-referrer、nosniff 和严格 CSP。平台签名参数不会再传入 SPA，处理器不主动记录这些参数（部署平台的访问日志策略仍须单独核验）；处理器不是支付异步通知接口。结果页必须重新鉴权，通过既有只读详情核验订单和资金证据；刷新不触发 provider 查单或支付。

新签发入口始终带回跳上下文；后端与前端读取器均校验已提供的返回/退出地址属于原订单。历史候选 ticket 若没有导航参数，保留原字节，不改签、不补参数；若带旧通用返回页、重复或错单上下文则拒绝继续入口，保留原支付选择并走原结果核对，不生成替代订单。当前独立收银尚未部署，此规则不能被宣传为所有旧客户端/旧入口无缝兼容；真实存量版本协调仍是发布门禁。

### 本轮验证

- 最终 Node 回跳／适配器／模型／缓存四文件 170 项通过；实际 workerd 三文件 93 项通过。覆盖签名中的完成/退出上下文、配置冻结、H5 原字节保留、唯一/规范输入、前后端错单拒绝、固定 303 及未登录/存储冲突下的只读模型。
- 隔离 PG16.15、非所有者业务 LOGIN、本地 Hyperdrive 与真实 workerd：HTTP 19＋派发 27＋运行时链路 7，共三文件 53 项通过（211.89 秒）。测试证明客户端切换的重放仍返回原 ticket，外部首次发起仅一次；非法 URL/枚举不预留支付，用户/渠道/金额与资金原有门禁不变。
- PC 实际 Axios/会话套件 257 项通过，含新 API 枚举与结果页失效登录原单恢复；Uni 实际页面/Vue/Pinia/native request 收银 17＋通用结果 29，共 46 项通过，验证真实只读页面不回落到别的日志、重登只读原单。
- Wrangler 4.122.0 从配置生成的新绑定类型已 `types --check` 核验，PC/H5 Pages Functions 构建通过；未手改生成类型、升级依赖、修改数据库 DDL 或运行生产发布。首次主类型检查暴露测试子进程精确环境白名单缺少两个新增非敏感变量，补齐后主/运行时类型通过。第一次 workerd 日志写入用户 AppData 被拒，后续命令改用工作区日志目录后重跑通过。使用已安装 workers-types 5.20260828.1；Workers、Wrangler 与前端技能分别指导绑定/请求边界、实际编译和浏览器验证。

### 浏览器证据及未覆盖范围

已安装 Codex 浏览器加载本轮真实构建，专属合成 API 无数据库或外部平台 I/O；本机辅助服务实际调用 PC/H5 Pages 导出的处理器。PC 1280×720 与 H5 390×844 从 `/offline-payment-return` 携伪 SUCCESS、paid=true、0.01 金额进入，303 后只保留原单号；登录后仍读 `xx…000003`，展示原价 12.50／应付 10.00／未付。两端点击重新读取并整页刷新；PC 另往返收银/只读结果路由，结果页不残留消费输入或付款控件。页面身份、非空、无覆盖层、交互与截图通过；H5 宽度390/scrollWidth390，无横向溢出。PC 控制台无错误警告；H5 无应用错误，整页加载各有既有 vue-router 弃用警告。

首轮两个来源各详情 GET 4、业务 POST/方式发现/历史 GET 均 0，预置24条记录不变；PC 回跳303一次，H5 回跳303一次和缺单号400一次。H5 负面导航被浏览器报 ERR_BLOCKED_BY_CLIENT，未取得该错误页截图；本地服务器记录确认收到400且无Location，实际workerd边界测试另独立覆盖，不能把它写成浏览器负面视觉验收通过。首次辅助脚本因 Windows ESM 绝对路径格式失败，改用 file URL 导入本地 esbuild 后启动成功；不是产品故障。

本地导航/合成登录不等于真实微信/支付宝页面、JWT生产令牌存储、远端 Hyperdrive 或原生真机验收。上线仍须受控安装候选 DDL/ACL/目录、先发布两端回跳 Functions 与页面、核验实际商户 H5 域名及支付宝配置、真机取消/完成/丢回调/延迟到账与当前代码 Linux CI，再协调 Worker 启用。零元政策、安全关闭/退款和旧版本处理也继续开放，FE-003F 不勾选；没有生产/图片/缓存修改，原九暂存不变。

### 最终复跑与清理

补齐支付宝 quit_url 和单号末尾换行拒绝后，最终 HTTP 19 项再次在全新专属 PG16.15 集群通过（126.21 秒），Node 170／workerd 93、PC 会话 257（3072.849 毫秒）／Uni 46（2220.278 毫秒）均通过，批次不累加为独立覆盖量。最终主/运行时 Worker 类型、PC/Uni 类型、PC/H5/微信小程序/App 构建和3项产物检查通过。保留既有 PC 依赖注释移除和 Uni articleRichText 空 chunk 提示，不以构建成功代替原生真机验收。

最终新来源 PC 57520、H5 57521 再次从实际回跳函数进入已重新构建的只读页面，完成登录、明确重新读取及整页刷新；PC 1280×720/H5 390×844 的页面身份、非空、无覆盖层、截图和交互均通过，原价12.50/应付10.00/原单未付不变。最终 PC 详情GET3、H5详情GET4，各回跳303一次；业务POST/历史/方式发现均0，预置24条记录不变。两端应用错误0，H5两次加载仍为同一既有路由弃用警告。截图通过浏览器工具展示，无仓库内新建截图/报告。

两个 PG 目录 `finance-postgres-IKJy5e`（57071）和 `finance-postgres-VvPtXj`（59059）均报告测试库/角色 remaining=0 并停止；独立 pg_ctl 确认无服务，PID与bootstrap-password不存在，两端口监听及可信PostgreSQL进程0。两轮 UI 服务均停止，精确辅助脚本进程和57520/57521/58672/58673监听0；视口复位、临时标签关闭，诊断目录保留。九个原暂存条目的路径及numstat逐项不变；checklist仍240完成/164开放/404总计，没有提交、推送或部署。

本轮主要重跑入口（项目各自工作目录、受信Node；workerd使用已验证的本机MINIFLARE_WORKERD_PATH）：

```text
# workers-ts
node node_modules/vitest/vitest.mjs run --config vitest.config.ts test/offline-payment-return.test.ts test/offline-payment-provider.test.ts test/offline-cashier-client.test.ts test/response-cache.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.worker.config.ts test/runtime/offline-payment-provider.test.ts test/runtime/offline-payment-return.test.ts test/runtime/offline-payment-contract.test.ts
node scripts/run-local-finance-postgres.mjs --schema-maintenance <受信PG16-bin绝对路径> test/offline-order-http.test.ts test/offline-order-payment-dispatch.test.ts test/offline-order-payment-workerd.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
# view/pc-ts
node --test test/auth-session.test.mjs
# view/uniapp-ts
node --test scripts/offline-cashier-runtime.test.cjs scripts/order-pay-result.test.cjs
node --test scripts/build-artifacts.test.cjs
```

## 本人消费找回与恢复指针（2026-09-20 前轮增量）

此前只支持已有本地请求记录或已知单号的深链；现新增已鉴权的本人记录查找。服务使用有界 REPEATABLE READ／READ ONLY 事务重验有效账号，以现有 `ooa_user_history(uid,created_at,order_id)` 索引对应的倒序键集查询读取最多 21 行并输出最多 20 条，不使用 OFFSET、总数扫描、行锁、配置缓存或 provider I/O。每页是独立快照，不宣称跨页冻结整个历史；后续新提交或时间变化不构成完整历史审计。游标是原公开单号，先在当前 UID 的准入记录中查找排序边界；他人或不存在的游标失败，不回退第一页，也不凭游标授权。

完整单号搜索只精确匹配；未知／重复／混合参数及超过 160 字符的查询拒绝。仅查询本域已持久准入的 type=3 消费，不把没有新版准入凭据的旧订单拼装成可付款记录。隐藏原消费仍可发现，因为 hidden 不是平台关闭凭据。每项只返回 order_id／money／pay_price／channel／created_at／hidden，核对不可变准入与原单身份，不输出 paid、状态、request_key、数据库主键、付款人、密钥、ticket 或财务原文。列表明确标为“收款状态需核对”；选中后仍须调用既有详情服务核验资金凭据。缺表或 SELECT 权限返回 503，不运行时安装。

PC／UniApp 增加最近记录、精确单号搜索、下一页／返回最近记录和原页失败重试；下一页失败保留原游标，清空旧结果，重试同页。换号、隐藏、卸载立即清空查询和结果，迟到响应不能回填。用户明确选择“恢复并核对这笔消费”后，在浏览器同源锁内读取原详情并保存只含 version=2／UID／原单号的恢复指针，不伪造新的 UUID 或重建报价。沿用既有 `cinashop_offline_pending_v1_<uid>` 存储键，内容按 version 区分旧建单日志与新恢复指针；仅在用户选择付款方式时增加 method，不保存金额、余额、ticket 或令牌。旧版本客户端不理解 version=2 时拒绝恢复，不自动丢弃另建单；协调发布／回滚仍需注意此兼容边界。

恢复指针可在刷新／重开／重新登录后读取同一原单，不能调用 create，也不能覆盖另一笔待确认消费或丢响应但尚无单号的原建单日志。后者必须沿用原键重试。已知单号深链以前没有本地日志时，现也在 pay／继续原 SDK 入口前持久保存并读回恢复指针；保存失败、另一标签页已写入记录或身份变化均阻止付款／打开入口。找回、列表读取和页面恢复本身不支付，只有明确付款操作才使用已有服务器支付路径；原渠道限制不变，不能借找回切换已选择的渠道。只读结果模型不查询历史、不写指针、不调用付款／SDK。

### 本轮验证与边界

| 验证层 | 结果 |
| --- | --- |
| 实际 workerd／JWT／本地 Hyperdrive／独立非所有者 LOGIN／PG16.15 HTTP | 18 项通过，118.69 秒；新增 3 个多断言场景覆盖 23 笔本人单、他人单、新插入后分页、隐藏、严格参数、只读角色／缺 SELECT／缺表，以及伪造 paid 不成为收款凭据 |
| 共用客户端模型＋响应缓存／HTTP 缓存策略 | 3 文件 95 项通过，12.94 秒；模型由 45 增至 63 项，覆盖恢复持久化、丢响应、跨标签覆盖阻止、账户切换、迟到响应、只读结果、分页重试与异常 DTO |
| Uni 实际 Vue／Pinia／native request 运行时 | 收银 15＋既有结果 29，共 44 项通过，最终 2383.645 毫秒 |
| PC 既有 Axios／存储／Pinia 相关回归 | 255 项通过，4300.789 毫秒 |
| 类型／构建／产物 | Worker 主与运行时类型、PC／Uni 类型、PC／H5／微信小程序／App 构建及 3 项产物检查通过 |

批次重叠，不相加为独立覆盖量。首次 Worker 类型检查未带项目规定的 4GB 上限，约 2GB 时内存耗尽；按既有 4GB 配置复跑后发现测试中的可选 draft 访问和 ES2023 toReversed 不符合当前类型目标，修正测试而非放宽编译配置，最终主／运行时类型通过。PC 构建保留依赖注释移除提示，Uni 保留既有 articleRichText 空 chunk 提示。按 Workers 技能重新通过 Firecrawl 连接器读取[官方当前实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)；CLI 不可用，最新 npm 类型检索受网络限制，核对已安装 workers-types 5.20260828.1，无依赖／绑定／DDL 变更。

浏览器使用实际最终构建、已安装工具和本机专属合成 API；PC 56269 与 Uni H5 56270 是两个独立来源，共享同一份内存服务端历史，各自从无本地待处理记录开始。PC 1280×800 验证 20→3 分页、失败重试、他人完整单号无结果、本人单号精确查找；两端均明确恢复 `xx…000003` 并刷新，仍显示原价 12.50／应付 10.00／待选择方式，未被列表冒充付款成功。Uni 390×844 视口的 DOM 可用内容宽度 375（滚动条占位），无横向溢出；截图核对找回确认、原价和付款控件。首轮截图发现读取失败提示远离查询按钮，按前端技能将 history 错误就地显示并补返回最近记录，重新构建／重载后复验。页面身份、非空、无框架覆盖层、交互与截图检查通过；没有应用错误，Uni 两次整页加载各有一条既有 vue-router 弃用警告。

最终两来源共享的预置记录仍为 24 条：PC 历史 GET 6／详情 GET 2／方式 GET 2，Uni 历史 GET 1／详情 GET 2／方式 GET 2，双方业务 POST 都为 0。此浏览器实验只证明分离存储来源的客户端行为，不是两台物理设备、真实 JWT／数据库／平台端到端验收；真实 SQL／鉴权证据来自上表独立 HTTP 套件。PG 专属集群 `finance-postgres-mCRpkj`（55697）测试库／角色清零并停止，独立核对 pg_ctl=3、无 PID／启动口令、PostgreSQL 进程／端口监听均 0。浏览器视口重置、临时标签关闭；专属 UI 脚本停止后精确进程和 56269／56270 监听均 0，诊断文件保留。本轮未访问生产或修改图片／缓存，原九暂存保留，未提交、推送或部署；FE-003F 及 240／164／404 不变。

## 支付方式发现与即时预检（2026-09-20 前轮增量）

旧 `OtherOrder::pay_type` 读取五个配置和当前余额，计算余额开关后又将 `yue_pay_status` unset，属于源端返回合同缺陷。本次恢复该字段；沿用 `offline_pay_status=true` 仅作独立收银域的旧展示标志，**不是新全局开关、安装就绪或付款许可**。无参数 GET 返回 H5 配置预览；新页面固定带原 `order_id`，不允许 `from`、金额、UID、成功标记或重复参数。响应保留 site_name／now_money／三个数字开关，另提供固定三方式的原因；订单模式附原单号／原应付／原渠道，没有 OpenID、商户、密钥、支付入口或内部凭据。

读取过程先复用原订单财务详情核验，再在有界 REPEATABLE READ／READ ONLY 快照中重验当前有效账户、当前余额、有效全局配置和必要微信身份。配置按 is_store=0、sort DESC／id DESC 取唯一有效项，最多十个固定键、每值最多 2048 字节，不使用或回填 CONFIG_KV；站点名另限 200 字符。无订单的预览不证明候选 DDL 已安装。配置／账户快照与此前订单快照不声称同一数据库快照，更不是配置变更锁；支付入口仍须独立按当前账号和原支付路径核验。

| 方式原因 | 展示行为 |
| --- | --- |
| available | 本次预检通过；点击付款仍重查，服务器仍可能拒绝 |
| disabled／not_configured | 商家未开启／配置未就绪，不暴露底层密钥错误 |
| identity_required | 当前原渠道缺少唯一有效微信身份，不能拿其他渠道身份替代 |
| insufficient_balance／amount_unsupported | 余额不足／超出该方式支持的原金额范围 |
| channel_unsupported／read_original | 小程序不使用支付宝 WAP／原消费已有路径或不可再付，只核对原单 |

外部方式使用与派发相同的商户、地址和真实 RSA 密钥导入预检，但绝不调用 initiate。密码学计算在策略事务结束后运行，没有 provider 网络、派发、结算、余额／账单写入或持久成功记录。首次外部派发也改用同一当前数据库配置读取；预检时获取并冻结一次配置，后续编辑不改写该次已选商户，已有路径继续原恢复，不据新开关重发。原生小程序支付宝 WAP 也在服务端选择事务中拒绝，而非仅隐藏按钮。其他业务的通用配置缓存路径未改动。

两端只在服务器详情为 UNSELECTED 时发现方式；失败即清空旧方式能力但保留原订单，读取重试不建单、不支付。请求付款前再次发现并校验订单号／渠道／金额／开关和原因一致，变更为不可用时不保存新支付方式、不发送 pay。能力与余额只保留在当前页面内存，换号／隐藏同步清除，不写日志；结果页的模型增加只读约束，不发现、不支付、不打开 SDK。SDK 回执仍不得冒充收款。

### 本轮服务端与客户端证据

| 批次 | 实际结果 |
| --- | --- |
| 实际 workerd／JWT／本地 Hyperdrive／独立非所有者 LOGIN HTTP | 15 项通过，90.40 秒；含新增 5 场景的鉴权／旧合同／原因／只读权限／无 KV 回填／无外发／配置撤权反例 |
| 独立 PG 首次派发 | 27 项通过，127.62 秒；测试公开配置从本地 KV 夹具迁入真实测试 DB，缓存仍开但 DB 已关的反例保留 |
| workerd／原生 PG 发起恢复 | 7 项通过，48.40 秒 |
| 独立 PG 支付路径互斥 | 35 项通过，156.84 秒 |
| Node 模型／适配器／缓存／路由 | 5 文件 120 项通过，15.10 秒；其中共用模型 45 项 |
| workerd 适配器／请求合同 | 2 文件 50 项通过，7.80 秒；包括当前配置绕过缓存及非法应用身份预检 |
| Uni 实际 Vue／Pinia／请求运行时 | 收银 12 项＋既有结果页 29 项，共 41 项通过；最终复跑 2333.7989 毫秒 |

批次存在重叠，不相加为独立覆盖量。首轮 Uni 40 过／1 失败是测试从简化 calls 记录读取不存在的 method 字段；改为在实际 native request 拦截点断言 GET，不改生产行为。后续中文提示断言又出现模型 44 过／1 失败，发现无能力时的空付款调用会清掉读取错误；将无效调用提前返回，保留锁内复核，最终模型 45 项通过。初次截图还发现禁用按钮对比度不足，已提高 PC／Uni 禁用状态文字对比度并保留真正 disabled 行为；最终页面复验另记下文。

本轮按 Workers／PostgreSQL 技能使用固定投影、短只读快照、无缓存写入与非所有者角色验证，并检索[Cloudflare 当前实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。最新版 npm 类型检索因网络权限失败，回退核对已安装 workers-types 5.20260828.1，未升级依赖或修改绑定。前端技能促成实际浏览器交互与禁用状态对比度修复；不据本地测试关闭 FE-003F。

四个本轮专属集群 ZAOozC:64563、IgRBCz:65001、i74LcY:51363、Pv8qz4:56690 均由运行器报告测试库／角色清零；独立核验各 pg_ctl status=3，无 postmaster.pid／bootstrap-password，四测试端口监听与 PostgreSQL 进程数均 0。保留诊断目录，没有递归删除。

### 最终构建与浏览器复验

最终源码完成中文读取错误提示、无能力付款空调用保护和禁用文字对比度修复后，Worker 主类型检查、PC 类型与 Vite 构建、Uni 类型及 H5／微信小程序／App 构建均通过；Worker 运行时类型此前同轮已通过。Uni 保留既有 articleRichText 空 chunk 构建警告。构建通过不代表原生设备或真实支付平台验收。

已安装浏览器工具在 Codex 内置浏览器中加载实际最终构建：PC `http://127.0.0.1:57641/user/offline-pay`，Uni `http://127.0.0.1:57642/#/pages/annex/offline_pay/index`。桌面默认视口及 Uni 390×844 复验均有截图；页面身份正确、内容非空、没有框架错误覆盖层。桌面禁用按钮及移动端“余额不足／支付配置尚未就绪／商家未开启”文字清晰，无明显遮挡或横向溢出。只使用本机合成 API／内存状态，登录也是专属合成夹具，不是真实 JWT、数据库或支付平台验证。

PC 按报价 12.50／应付 10.00 建单后，将测试配置从可用改为关闭，再点击原先可用的余额按钮；即时预检阻止 pay。模拟方式读取 HTTP 503 后清空可用方式、保留原单；最终页面显示中文“支付方式暂时无法核验，请重新读取原消费；本页未发送付款请求”。恢复可用后仅一次合成 pay 返回 PAID，刷新只读原单；另一次建单来自用户流程中明确点击“已核对，开始另一笔消费”，不是未知结果自动换键或重复付款。Uni 将余额改成 9.99 后点击原按钮，同样只重查方式、没有 pay；伪造 SUCCESS／paid=true 结果 URL 仍只读原服务器未付状态，不查询方式或付款。最终移动端点击“重新读取原消费”后，原单及不可用原因保持一致。

最终停止服务前，PC 为 2 单／2 次 create／1 次合成 pay／7 次方式 GET／7 次详情 GET；Uni 为 1 单／1 次 create／0 次 pay／6 次方式 GET／6 次详情 GET。两端应用错误均 0；Uni 三次新标签加载各记录同一条既有 vue-router 深路径导入弃用警告，PC 警告 0。计数仅是本地交互证据，不是资金流水。浏览器截图后已重置视口并关闭本轮标签；临时服务已停止，独立核对精确脚本进程和 57641／57642 监听均为 0，诊断脚本保留。本轮没有生产访问、图片或生产缓存修改，也未暂存、提交、推送或部署。

以下页面首批及后端首批记录是同日较早阶段证据，不代表其缺口仍保持未接线状态。

## PC／UniApp 收银与持久恢复（2026-09-20 后续增量）

PC `/user/offline-pay` 与 UniApp `/pages/annex/offline_pay/index` 已加入用户中心入口；UniApp 保留 `/pages/annex/offline_result/index` 深链，结果页只有读取和返回操作。未改变 UniApp 的首页顺序。两端共用 `view/common/offlineCashier.ts`，不用商城商品结算 DTO：明确查询报价 → 确认建单 → 选择请求支付 → 按服务器详情展示。金额使用规范十进制字符串；报价数字 `0` 保留旧合同的无会员优惠含义，真实 `0.00` 不允许继续建单。

请求键由浏览器 Web Crypto／微信小程序安全随机字节产生。首次 POST 前将 UID、原金额／确认价／渠道／UUIDv4 写入日志并读回核对；取得原单号、选择支付方式后仍更新同一记录，不保存令牌、支付 ticket、付款人或平台原文。PC 使用 localStorage，UniApp 使用 uni 同步存储，按 UID 隔离；损坏或无法读回的记录阻断新写入，不自行删除重建。建单丢响应保留同键；409 只有严格的权威价格数据才允许用户重新确认，同键不变。只有服务器核验的 PAID 原消费，且用户明确选择开始另一笔，才清除本地待处理记录；不是删除服务器订单或退款。

浏览器同源写入使用 Web Locks `ifAvailable` 独占锁，锁不可用／被另一标签占用时本页不发送写请求；锁内再次核对身份和原日志。它不提供跨域、跨设备或清除存储后的防重建保证，不能替代服务器幂等。小程序是当前 JS 上下文同步存储，不声称存在跨进程锁。账户变化、离页、隐藏和卸载立即清空私有视图并隔离迟到响应；实际 Pinia 测试发现 sessionVersion 先于 token／UID 发布时可能恢复旧身份，已改为同步清空、nextTick 后按完整身份恢复。

UI 不信任 URL 的 SUCCESS／paid／金额，SDK 成功也只触发原详情回读。未知结果不展示新支付路径；READY 继续入口前先重新读取原订单，校验渠道／金额／受限 HTTPS 地址及展示期限，仍不代表到账。结果页不提供建单或付款操作。APP 构建通过不代表已实现原生 App 收款：当前只允许 H5／微信小程序发起，缺安全随机数或浏览器锁能力会明确阻断。微信安全随机数接口依据[微信官方合同](https://developers.weixin.qq.com/miniprogram/dev/api/device/crypto/wx.getRandomValues.html)及已安装 Uni 类型；同源锁边界依据 [Web Locks 文档](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)。实际微信 SDK／设备和平台跳转仍未验收。

### 前端执行与浏览器证据

前端测试技能要求在实际渲染页面检验交互，而不只看构建。使用已安装的浏览器控制工具与 Codex 内置浏览器，没有新增浏览器依赖。实际 PC／Uni H5 生产构建分别由仅监听本机的临时服务提供，端口 59882／59883；所有业务 API 都是合成内存夹具，未使用生产数据库、真实鉴权、余额或支付平台。浏览器“已提交但响应丢失”场景实际用夹具先保存后返回 HTTP 503，不能当作真实网关丢包实测。

| 检查／批次 | 结果与边界 |
| --- | --- |
| 共用收银模型 | 最终 34 项通过；原键恢复、存储拒绝、身份／路由隔离、显式改价、未知支付、入口校验等。首轮 28 过／6 失败，修复非法链接错误被编辑清空及参数化测试空数组传参后复跑；失败不抹去 |
| Uni 实际 Vue／Pinia／请求适配器 | 新增 11 项与既有结果页 29 项合跑，40 项通过；首次新增批 10 过／1 失败揭示身份发布顺序问题，修复后通过。原生随机数和支付 SDK 的传输仍为替身 |
| 相关回归 | PC 身份／页面生命周期等 255 项通过；Worker 客户端／缓存／路由 4 文件 68 项通过。与 34 项有重叠，不累加为独立覆盖量 |
| 最终源码检查 | PC／Uni／Worker 主 TypeScript 通过；PC Vite、Uni H5／mp-weixin／App 构建通过。小程序保留既有 articleRichText 空 chunk 提示 |
| 页面身份／非空／错误遮罩 | PC URL 与收银标题、Uni 收银／结果页标题正确，均有实际内容，无框架错误遮罩 |
| 桌面与移动端 | 两端均检查桌面及 390×844，截图直接通过浏览器工具展示；订单号换行、按钮及结果可读，无阻断遮罩 |
| 控制台 | PC 无 error／warn；Uni 无 error，重新加载累计出现同一条 vue-router 导入弃用警告 3 次，未宣称零警告 |

PC 实际登录表单 → 12.50 报价 10.00 → 建单提交后 503 → 刷新不自动 POST → 点击原请求重试 → 余额提交后 503 → 刷新仅 GET 后展示 PAID。最终构建重载后，明确“开始另一笔消费”只清除本地已确认记录；再用原单深链仍读取 PAID，没有新建或再付。最终夹具统计：1 单、2 次 create、1 个不同 request_key、1 次 pay、5 次 detail GET。

Uni 实际登录 → 报价／建单 → 微信请求后 RECOVERY_REQUIRED → 刷新仍核对原单；结果 URL 即使附 SUCCESS、paid=true、money=0.01，仍显示核对中及原应付 10.00，无付款按钮。最终构建重载和只读按钮复验后：1 单、1 次 create、1 个 request_key、1 次 pay、5 次 detail GET。上述 browser 验收没有实际多标签并发、原生设备、远端 Hyperdrive、真实 provider 或生产令牌存储覆盖。

关键复跑入口：`workers-ts` 下 `node node_modules/vitest/vitest.mjs run test/offline-cashier-client.test.ts`；`view/uniapp-ts` 下 `node --test scripts/offline-cashier-runtime.test.cjs scripts/order-pay-result.test.cjs`。浏览器使用 reload → DOM 状态 → 实际按钮 → 状态及日志 → 桌面／移动截图闭环；临时服务／截图不作为仓库源码或部署产物。原九暂存路径保持，240／164／404 不变，本增量未提交、推送或部署。

收尾已重置浏览器视口、关闭本轮创建的两个标签并停止临时服务；独立进程／监听查询确认该专属脚本进程数 0、59882／59883 监听数 0。初次受限进程查询被拒绝，随后只读权限核验成功；保留临时脚本诊断文件，没有递归清理或修改其他进程。作用域 diff 与新增源码尾部空白检查通过。

## 本地执行证据（2026-09-20）

原生 PostgreSQL 16.15 由独立随机集群运行器创建，仅监听本机。安装夹具使用维护身份，业务请求使用另一真实非所有者 LOGIN；没有生产连接串回退。Windows workerd 使用[前轮记录的同二进制、独立目录签名运行库](offline-order-workerd-verification.md)，未改系统 DLL、依赖版本或用户环境。

| 批次 | 实际结果 | 边界 |
| --- | --- | --- |
| 首轮 HTTP | 9通过／1失败，80.59秒 | 第10项故障注入误写不存在的 payload_hash 列，应为 evidence_hash；不是业务结算失败 |
| HTTP＋建单＋余额 | 3文件84项通过，317.93秒 | 包括新增建单锁后 delete_time 复核；尚未包含随后强化的列级撤权断言 |
| 最终 HTTP＋workerd＋外部结算＋派发联合批 | 73通过／2失败，共75项，311.53秒 | 最终 HTTP 10项和 workerd 7项通过；另两套各一项 beforeEach 建库准备超30秒，未进入业务断言，不算全绿 |
| 外部结算逐套复验 | 1文件31项全部通过，166.18秒 | 原代码／原断言／原30秒准备期限，独立批次无其他测试文件并行 |
| 首次派发逐套复验 | 1文件27项全部通过，145.78秒 | 同上，未降低所有权或证据完整性要求 |
| Node 相关回归 | 8文件226项通过，32.89秒 | provider、查询身份、运行器、缓存、路由、回调与恢复；不代替远端验收 |
| 静态检查 | 主 TypeScript、运行时 TypeScript、运行器语法通过 | 主类型在最终只读权限断言后再次通过 |

最终 HTTP 权限反例不只执行表级 REVOKE：另撤销 user／other_order／wechat_user／派发表原列级 UPDATE 与锁函数 EXECUTE，设置角色默认只读事务，并实际查询关键列及资金表的有效写权限为 false；之后新 workerd 连接仍能读取核验后的 PAID 详情。保持全部业务断言及原30秒准备期限，联合批中的两套超时另逐套重跑，不以调高超时掩盖结果。

首轮错误注入原用手写 BEGIN，SQL失败后使维护连接留在失败事务，清理又报25P02并留下一个临时角色。现改用夹具 transaction 保证失败回滚；原测试库已删除，遗留角色在已停止、路径核验过的专属集群中用单用户模式定点删除，复核额外库／角色均0，未开启端口或修改认证。失败与修复记录保留，不把首次运行改记为成功。

本批五个专属诊断目录位于仓库忽略的 `.cache`，均保留，未递归删除。最终独立只读核验如下；四次后续运行均报告 `FINANCE_LOCAL_FIXTURES remaining=0`，首轮遗留角色按上一段单独处理。五端口监听、PostgreSQL进程、workerd进程及路径不明的对应进程均为0。

| 专属集群 | 端口 | pg_ctl status | postmaster.pid／bootstrap-password |
| --- | --- | --- | --- |
| finance-postgres-UqdoGN | 50533 | 3（停止） | 均无 |
| finance-postgres-D2ZTcU | 50878 | 3（停止） | 均无 |
| finance-postgres-JD8V3H | 50820 | 3（停止） | 均无 |
| finance-postgres-BWfyhk | 59543 | 3（停止） | 均无 |
| finance-postgres-aOO9Eb | 60721 | 3（停止） | 均无 |

可复跑（在 workers-ts 目录；node、PG16_BIN 和 WORKERD_EXE 均指向本机已验证的绝对路径）：

```powershell
$env:MINIFLARE_WORKERD_PATH = $WORKERD_EXE
$env:WRANGLER_SEND_METRICS = 'false'
node scripts/run-local-finance-postgres.mjs --schema-maintenance $PG16_BIN test/offline-order-http.test.ts
node scripts/run-local-finance-postgres.mjs --schema-maintenance $PG16_BIN test/offline-order-admission.test.ts test/offline-order-balance.test.ts
node scripts/run-local-finance-postgres.mjs --schema-maintenance $PG16_BIN test/offline-order-payment-workerd.test.ts
node scripts/run-local-finance-postgres.mjs --schema-maintenance $PG16_BIN test/offline-order-external-payment.test.ts
node scripts/run-local-finance-postgres.mjs --schema-maintenance $PG16_BIN test/offline-order-payment-dispatch.test.ts
node node_modules/vitest/vitest.mjs run test/offline-payment-provider.test.ts test/payment-query-identity.test.ts test/local-finance-postgres-runner.test.ts test/http-cache-policy.test.ts test/response-cache.test.ts test/route-parity-audit.test.ts test/payment-callback-route.test.ts test/payment-reconciliation.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
node --check scripts/run-local-finance-postgres.mjs
```

多批包含重复用例，不能把通过次数相加当作独立覆盖量。Checklist仍为240完成／164开放／404总项，本批不关闭FE-003F或SUP-001。
