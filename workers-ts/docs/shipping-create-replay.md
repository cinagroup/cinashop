# 运费创建持久回执：强制键 HTTP 与正式迁移候选

2026-09-14，对应 A3k13。三个实际创建入口已在候选接入强制键事务，并新增恢复查询；
两端前端现已接入持久意图、原键重试、查询和明确确认。**回执表未安装线上，真实运行角色与
端到端生产验收未完成；本候选不能部署**。已发布源为 9fb7d27，线上页面仍是旧无键合同。
必须完成下述迁移和协同发布门禁，不能单独切换 Worker。
历史阶段“尚未接入 HTTP”的记录保留在后半部分，不代表当前候选状态。

## 浏览器发现并修复供应商归属变更后的重复创建（2026-09-14，未部署）

基线09743b5（业务9cb173e）的实际浏览器复现：Supplier账号27原属20，提交后丢失响应，
已创建10001；维护连接只在本次隔离库把账号改属40并授予对应角色，浏览器缓存身份仍20。
旧页面查询原键返回空，随后“使用原请求重试”却在40创建10002，页面误把新结果认作旧
意图完成。同一键/摘要出现两份不同relation回执。原因是服务端依据新归属，而客户端
持久意图依据旧归属，两者没有前置一致性检查；不是绕过权限读取其他供应商数据。

候选新增必需请求头 `X-Shipping-Creation-Scope: v1:<ownerType>:<relationId>:<actorId>`。
两端从挂载身份捕获并发送；创建和恢复控制器与本次真实认证中间件身份精确比较，缺失、
变更、重复或非规范值均HTTP412/business412，且no-store。声明只是预期状态，不能用于
授权或改写服务端身份。客户端保留原键、冻结内容和恢复入口，不自动重试、换键或清除
意图。Admin编辑/Supplier非零ID编辑合同不变；回执表、载荷摘要与本地意图版本均未改。
此检查防止请求进入时已发生的归属漂移，不宣称锁住整个事务中的账号管理操作。

**发布兼容门禁：新建及回执查询现在还要求此头，旧页面/旧客户端缺头会被拒绝。必须与
两端前端、Worker和既有回执迁移协同发布；不能单独部署Worker。线上仍9fb7d27，回执表
仍未安装，没有本轮生产DB、角色或部署操作。**

实际插件使用5395/5396的真实构建、注册路由、JWT/数据库角色和完整ORM受限LOGIN PG16.15。
登录签发/Redis是合成替身，Node宿主而非workerd/Pages/Hyperdrive；不是生产端到端验收。

| 插件场景 | SQL与页面结果 |
| --- | --- |
| 基线Supplier提交后断响应，单条回执摘要改成64个0 | 查询返回损坏摘要，页面拒绝确认；原键重试HTTP409，未另建；恢复原摘要后五表与原提交完全相同 |
| 基线账号27归属20→40，旧页查询后原键重试 | 复现重复：原10001与新10002分属20/40，共两回执；不是通过项 |
| 修复后10001提交断响应，再改属40 | 查询、原键重试、刷新后查询均HTTP412；五表与原提交逐字相同，序列仍10001，原表单冻结保留 |
| 恢复账号原归属20，再查询并明确确认 | 原键查回10001，五表仍相同；Supplier列表仅该项/count1 |
| Admin实际表单新建3.25首费，再查询并确认 | 携带v1:0:0:7，创建及查询均10002；最终模板3/配送2/包邮0/禁配0/回执2 |

红场景键 `2d3dd817-369b-4f47-bb32-a7e26e954a4f`，摘要
`6acb74feb6ef299043ddee2e59b961647db00aaeabe92ff9050793a909f42041`；
修复后Supplier键 `24fd0b3f-907f-4dca-80eb-f27603732254`，摘要
`4a1a893f4fee29a3e6e454b7573b94c10c7f4d93fbb12292ccb7fac135d6919e`；
Admin键 `f8d3594d-4028-4a67-8bc2-c16211a1ad26`，摘要
`ddc6445f1ee07124cb7c18d7b1463fa4e247dfffc552d5138dff52590e8d329e`。

红测试数据库 `cinashop_kefu_runner_db791fabc19c48e9a06110072aa523e9`，角色
`cinashop_runtime_1f89327a8c084caca79290b20c09d2e2`；绿测试数据库
`cinashop_kefu_runner_6b5a98b8aa4546b5bd7320ddd3ea42d2`，角色
`cinashop_runtime_b80a95f1874746f7aed9b256644978b4`。两组均current_user=session_user、
PG160015、五项高权限false；业务没有使用维护连接。明确确认后服务退出0，独立psql精确
查询两库/两角色均0残留，只清理本次可重建测试资源。原始SQL/HTTP在任务工具输出。
临时控制台源码 `cinashop-shipping-pg-browser-20260914.ts` 的当前SHA256为
`36761ee9938da24d6f8fda66ba2f90bcb13e8566b46c77dce2dd6fa81aba3356`。

插件完成真实表单、刷新、恢复、原请求重试、明确确认、DOM/日志和1280×720截图核验。
Supplier控制台error/warn为空；Admin有4条未开放Dashboard统计请求错误及待办失败，
Supplier服务日志仍有favicon缺失。Supplier412及恢复成功状态有截图；Admin截图因滚动
只显示首费与确认按钮，10002由DOM和HTTP确认，不能说截图展示了成功横幅。
本轮未重做手机、真实账号登录或所有回执损坏矩阵。前端测试技能要求实际插件证据，
PG技能要求真实受限LOGIN/短事务/独立清理核验，Workers技能用于预期身份与授权分离。

回归先在旧实现跑出56项真实PG红测，再完成549项路由、72项持久意图和代理/CORS增量。
中间三文件633项、CORS/域名33项均零失败/跳过，但重叠测试不相加。最终联合8文件
702/702、零失败/跳过，包含549路由、72持久意图、20代理/CORS以及域名、企业微信
CORS、Admin API审计/合同、Supplier会话。显式使用本机TEST_FINANCE_POSTGRES_URL，
没有以PGlite替代真实PG路由验证。临时最终报告 `cinashop-shipping-scope-final-20260914.json`
SHA256 `a4f6ce2cab54db84e944c242edc52bb018075a7d84acd9cb440243a88715e852`；
红测报告 `cinashop-shipping-scope-red-20260914.json` SHA256
`9451e71660c02fd4677710561102847b90a775c1da2599494d2021d4823a1bbb`，
56失败/493被名称过滤，不把过滤项算运行时跳过或全套失败。
Worker单元/运行时双类型及Admin、Supplier完整构建通过。首次类型检查发现412未加入
HttpApiException联合类型，显式补齐后通过；未放宽类型、超时或权限。A3k13及清单
240完成/164开放/404总项不变，仍需当前候选自身Linux CI及正式发布门禁。

## 真实PG浏览器回滚与权限失效增量（2026-09-14）

在文档提交d622d05之后继续验证，业务代码仍为9cb173e；没有修改业务源码、部署、生产
数据库或线上角色。复用下节临时Node服务、实际注册路由和受限PG16 LOGIN；扩充临时
控制台的断响应、回执INSERT/SELECT撤销及合成Supplier角色停用开关。所有控制只作用于
本次随机数据库，仍保留真实JWT校验/数据库授权，登录签发与Redis仍明确是替身。
本次数据库 `cinashop_kefu_runner_c7b6e44d4b434a2d848867eed0f3a7d0`，角色
`cinashop_runtime_be245220af7b4bb2a042e6d4abc289b6`，current_user=session_user且五项
高权限标志全部false，版本160015。没有借维护连接发送业务请求。

| 浏览器操作及故障 | 权威结果 |
| --- | --- |
| Admin填写全国7.25、甲市计量3/金额88包邮、乙市禁配；撤销回执INSERT后提交，返回体送达前断响应 | 实际末端回执INSERT权限错误，业务status500；模板/三类规则/回执均未留存，仅默认模板1；序列前进10001不等于事务提交 |
| 刷新→新增恢复原冻结表单→恢复查询→恢复INSERT→正常响应→使用原请求重试 | 第一次查询status200/data=null且五表不变，页面提示仅能原键原内容重试；第二次save使用同一键，10002/replayed=false；仅成功一组父模板/三类规则/回执 |
| Supplier首费9.50提交后断响应，随后停用实际system_role 2 | 原创建10003已提交；同键恢复查询和原请求重试均status400011“暂时没有权限访问”，五表逐字相同，页面继续冻结原输入 |
| 恢复角色，再撤销回执SELECT；分别点击恢复查询和原请求重试 | 两次真实SELECT权限错误，均status500/data=null，不是成功空回执；五表逐字相同、序列仍10003，页面没有创建成功或允许新请求的状态 |
| 恢复SELECT→恢复查询→明确确认完成 | 原键/原摘要查回10003，五表仍与最初提交后相同；Supplier列表只显示10003/count1，Admin显示1/10002/10003/count3 |

上述错误的HTTP状态均为200，业务信封status分别500/400011，不能写成HTTP403/500。
Admin键 `bc7a76e1-c56c-4d74-8851-4787de16fd3b`，成功摘要
`ce6230ceb74a180ba2127a3b960dbc632d230804d662cfb0282a3e39cbeecb56`；
Supplier键 `e2ed0c2c-48aa-4358-91a9-5a0996c1ccbe`，摘要
`d598cfd50b76a09d380cc3ea9ebaefe476408bbcd24ad38c16804d480af53ae7`。
本机PG日志 `shipping-replay-pg-20260914.log` 的2026-09-14 12:54:52.345 ACST/PID3068
明确记录回执INSERT权限拒绝；12:57:54.595与12:58:01.940 ACST同PID记录回执SELECT拒绝。
独立psql复核最终模板3/配送2/包邮1/禁配1/回执2，回执SELECT/INSERT=true，UPDATE/DELETE=false。
两端显式确认完成后，临时服务退出0；独立目录查询上述精确数据库和角色均0残留。
只清理本次创建的可重建测试资源，未清除原有库或其他任务资源；原始SQL/HTTP证据在任务工具输出。
本轮扩充后的Temp源码仍为 `cinashop-shipping-pg-browser-20260914.ts`，SHA256为
`c8134f5d5da10b0af53cd4aef10de8e6d10ccf883bdc4e178305db56400852c0`；未加入业务依赖。

浏览器插件使用5395/shipping与5396/shipping-templates，1280×720，未采用外部Playwright。
已执行goto/reload、真实表单交互、DOM与SQL快照、dev.logs和截图：页面身份正确、非空、
无框架遮罩，成功与拒绝状态以及可见操作按钮均有截图。Admin仍有2项未开放Dashboard
统计请求错误和待办失败；Supplier控制台error/warn为空，但服务日志有favicon.ico缺失。
旧夹具JWT在新随机APP_KEY下被拒绝；Supplier本机退出时因夹具未开放logout提示服务器
撤销未确认，重新登录后再开展主场景，不能据此宣称真实登录/登出链路验收通过。
本轮没有修改页面布局或重做手机矩阵；正式账号/真实Redis、Cloudflare及损坏回执、账号
和租户变化完整浏览器矩阵仍待验证，不把两类权限故障推广为全部权限路径通过。
前端测试技能驱动插件操作/截图/日志核验，PG技能驱动真实LOGIN及短事务、独立ACL和清理核验。
A3k13仍开放，240完成/164开放/404总项不变；下节“回滚尚待”等为此前阶段。

## 浏览器插件 → 实际注册路由 → 受限 LOGIN PostgreSQL（2026-09-14）

本轮业务代码为 `9cb173ea0aed441677d32ea803ab97dc71142821`，未修改或部署运行代码。
对应 Linux CI [34800821161](https://github.com/cinagroup/cinashop/actions/runs/34800821161)
已 completed/success，11/11作业成功，包括两单元分片、目录执行、workerd与五前端构建。

浏览器仍使用用户指定的Codex插件，不采用外部Playwright代替。临时服务监听
`http://127.0.0.1:5395/shipping`（Admin）与 `http://127.0.0.1:5396/shipping-templates`
（Supplier），加载实际构建；经真实 `adminapiRoutes` / `supplierapiRoutes`、JWT校验、
数据库账号/角色授权、创建/恢复控制器和正式回执事务访问完整ORM PostgreSQL16.15。
完整ORM后安装正式运费生命周期协议。登录桥只签发本次合成账号，Redis缓存为显式替身；
宿主是Node，不是workerd/Hyperdrive/Pages。本服务拒绝外部fetch，业务HTTP只开放运费路由。
**本轮证据强于先前内存回执夹具，但仍不能声称生产端到端或真实登录/Redis验收。**

本次随机数据库 `cinashop_kefu_runner_12656ec0c3c44c4fb905183773788faf`，运行角色
`cinashop_runtime_ace8840f48df4f208c106e16d21f3def`；运行连接current_user=session_user，
PG版本160015，superuser/createdb/createrole/replication/bypassrls全false。
独立psql只读目录核验回执SELECT/INSERT=true，UPDATE/DELETE=false；订单SELECT、账号
UPDATE、public schema CREATE均false。请求没有使用维护连接或SET ROLE冒充受限LOGIN。
这是运费模板管理授权，不等于整个Worker的生产最小权限。

| 实际浏览器交互 | 数据库及HTTP结果 |
| --- | --- |
| Admin填写全国首费6.25、甲市包邮计量2/金额99、乙市禁配，提交后断开响应；刷新→新增→恢复查询 | 模板10001，owner0/relation0/actor7；模板与三类非空规则及回执各1条；1次create、1次lookup，同键同摘要，无第二次创建 |
| Supplier创建首费8.50，数据库提交后只发送JSON前12字符并保持正文未结束；浏览器总期限触发超时→切回正常传输→使用原请求重试 | 同一10002，owner2/relation20/actor27；第二次create返回replayed=true；浏览器读取控制台SQL快照比较，重放前后五表逐字相同 |
| 两端显式确认完成→列表刷新 | Admin显示默认1与新10001/10002；Supplier仅显示所属10002，共1条，未显示平台模板 |

Admin原键 `f4ca25bc-ee8c-4d38-814a-f4ae808f375e`，摘要
`168939a6af9eb84cd9fa1610be38c010e05751255140c322681032c369f18206`；
Supplier原键 `37bf7651-ec38-419e-bf32-01b5c0829061`，摘要
`35364499b3197721739fd656b395927d0e915281d6c64e5285edf23b6580c541`。
最终数据库共有3个模板（含初始化默认模板）、2条配送规则、1条包邮、1条禁配及2条回执。
终态结构化HTTP日志与SQL快照由服务退出时输出，原始工具输出保留在本任务；无合成JWT输出。
浏览器1280×720截图证明确认回执及所属列表，页面非空且无框架错误遮罩，Supplier日志为空。
Admin登录桥跳到未开放的Dashboard时留下2项统计请求错误，待办加载失败；夹具还记录
Supplier缺少favicon.ico的静态文件请求。不能报告全应用控制台/所有资产完全正常。
插件content.export不受当前in-app实现支持，未伪造独立导出文件；截图和DOM/SQL证据仍在任务中。

首次夹具因Admin发送pwd而非password未能登录，未触发业务路由；修正临时桥后才执行上述测试。
第一次数据库 `cinashop_kefu_runner_0433d22fcd244c4d816d5e85ec752e32` 及角色
`cinashop_runtime_0744c330a6c14382a8230f5d3fee34bc` 已先清理。
第二次完成后服务正常退出0；对两次精确数据库/角色名的独立目录查询均返回0残留。
没有清除原有本机库、其他测试资源或任何线上数据。临时源码留在Temp：
`cinashop-shipping-pg-browser-20260914.ts`、同前缀 `-cache-20260914.ts` 与 `-build-20260914.mjs`，
可复核路由、登录/Redis替身、随机库/角色和故障注入边界；未加入生产依赖或业务源码。

PG技能用于完整模型、受限登录和独立授权/清理核验；Workers技能用于有界请求、真实路由
与模拟边界审查（核对官方5.20260914.1类型，未升级依赖）；前端测试技能要求插件交互、
截图及目标日志证据。尚待：真实PG回滚后原键重试、权限/损坏回执/身份与租户变更完整浏览器
矩阵，真实Redis/Workers/Pages集成、实际线上角色、容量、获准安装及协同发布。
A3k13保持开放，240完成/164开放/404总项不变。下文“正文未做浏览器验证”等为此前阶段。

## 前端持久意图与浏览器插件验证（2026-09-14，未部署候选）

`view/shared/shippingCreation.ts` 用每个身份范围的 Web Lock 协调标签页，首次发送前将
稳定 owner/relation/actor、UUID、准确输入、服务端合同摘要写入 localStorage 并读回验证。
不保存 token；存储异常、记录损坏、不支持安全锁均阻止发送，不提供内存或新键 fallback。
刷新、重入、重新登录相同账号复用旧范围；不同账号/供应商隔离。恢复为空保留原意图，
只有显式“使用原请求重试”才再次发送相同键和内容。严格匹配版本/键/摘要/ID及 replayed，
确认回执也先落盘；“确认完成”只能清理匹配的已确认意图，旧标签不能清理后来意图。
另一标签已有不同输入时恢复原表单并暂停，不静默发送旧输入。编辑路径保留原 revision 合同。
独立请求捕获调用时认证，响应限制4 KiB、no-store、不跟随跳转、不自动重试。

后续超时修复：共享传输为每次创建/恢复设置30秒总期限，覆盖响应头和正文读取。
独立 AbortController 中止当次 fetch，不取消挂载会话；身份失效仍立即向请求传递取消。
所有出口清除计时器/监听器，并关闭未读响应。超时仅表示未知结果，不生成新键或自动重试。
先新增6项检查在旧实现复现4失败/62通过，再加入2项真实客户端与传输组合检查；
最终本文件68项、与三份既有会话/API合同合计109/109、零失败/跳过。
验证等待响应头/半截正文、会话取消、计时器和监听器清理，以及创建/查询超时后释放锁、
原始存储逐字不变、重入后原键查询成功。两前端完整构建/类型与Worker单元类型通过；
首次单元类型检查发现测试中unknown未收窄，补显式Error判断后通过，未放宽配置。
报告 `C:/Users/cina/AppData/Local/Temp/cinashop-shipping-timeout-final-20260914.json`，
SHA256 `fdf76e64d3c814127d3fcd2ec0f37197869491c29022788ea2b90b2bca5fcd4b`。
另补Linux工作流push/PR的 `view/shared/**` 路径过滤，避免仅共享协议改动不触发检查；
原工作流上2项触发断言红测、修复后5项门禁测试通过，未改变任何作业/测试时限或跳过策略。
报告 `C:/Users/cina/AppData/Local/Temp/cinashop-shipping-shared-ci-final-20260914.json`，
SHA256 `1074f83919cb8f967848d9e498d1752f5e56215248d5a0a58d2eabf4e88ab469`。
超时设计使用浏览器原生取消，同时覆盖fetch及正文消费（参见
[MDN AbortController.abort](https://developer.mozilla.org/en-US/docs/Web/API/AbortController/abort)）；
没有新增依赖或降低HTTPS/身份保护。

Admin 和 Supplier 真实 Vue 页接入上述流程，确认前表单冻结；回执仅证明曾创建，不承诺模板
仍可访问。原生浏览器持久存储不是跨设备备份；用户清除站点数据、隐私窗口结束或浏览器清退
数据仍会丢失本机意图，页面明确提示不要清除数据。不能据此宣称跨设备幂等恢复完成。

新增60项协议测试，含12项与真实服务端规范化及 canonical hash 对比、存储/锁失败、
多标签锁竞争、账号/租户隔离、迟到响应、精确回执和有界传输。与既有 Supplier 会话和
Admin API 合同合计101/101、0失败/跳过；两端构建/类型检查及 Worker 单元类型检查通过。
浏览器模块通过实际 esbuild bundle 在 Worker 测试中运行，不把 DOM 类型注入 Worker。
报告：`C:/Users/cina/AppData/Local/Temp/cinashop-shipping-client-contracts-final-20260914.json`，
SHA256 `3679674df1e9d4906431af10d0e9d121dd89e2bfa7101c9f388656581c4cfc97`。

用户要求后已切换到真实 Codex 浏览器插件（cua_repl，in-app browser）。第一次初始化因
本机 sandbox ACL 错误退出，工具 reset 后连接成功；没有继续以外部 Playwright 冒充插件。
插件访问仅监听127.0.0.1的5375/Admin及5381/Supplier真实构建；API为明确的本机夹具，
调用真实服务端规范化和摘要函数，但回执存在夹具内存，不是真实数据库/Redis/Pages链路。
两端实际登录→创建→提交后断响应→刷新→重入→恢复均返回原701；Admin另验证查询为空后
原键/摘要重试得到702，夹具显示总3次创建请求仅2条提交；旧标签确认被拒绝，未清理新意图。
插件验证Admin默认桌面和390×844、Supplier390×844，截图证明恢复提示及页脚按钮可见。

后续Admin插件竞争/换号验证：首标签提交后挂起响应，第二标签打开创建被锁拒绝，
夹具创建计数仅增加1。从第二标签退出后，首标签清表单并禁止写入；登录qa-other并释放
旧响应，新账号新建为空表单，旧标签仍失效。重新登录qa、刷新重入找回原意图，
原键 `a623fdb4-87b3-4d59-8647-758d58932fb8` 查询得到703，没有第二次创建。
这是本机Admin账号7/8边界证据，不外推Supplier租户变更或生产认证。

超时修复后的Admin插件验证：重建并刷新实际前端，创建“插件-30秒超时原键恢复”，
夹具提交后持续挂起；页面自行显示超时、原表单冻结但恢复按钮可用。未刷新/重登即查询
原键 `fc5c86b5-5f2a-4099-81dd-18f068814b37` 得到704，新增恰好1次create/1次lookup。
1081×792截图显示超时提示/操作区，无框架遮罩，目标页面日志为空。API仍为内存夹具；
正文停滞由上述传输测试覆盖，尚未作为浏览器真实流式HTTP场景验证。
Supplier亦以新构建真实页面创建“供应商插件-超时恢复”，挂起到超时后同会话点击恢复，
原键 `3bcaeb32-44f9-4ed3-b8d6-6baf6d3e0b09` 返回702；本场景1次create/1次lookup，
输入仍冻结且没有重登或重发，桌面1280×720截图和空目标页面日志留在插件会话。

插件发现Admin冻结表单仍可点击“添加配送规则”（显式disabled=false覆盖表单继承），
实际点出第二组后修复三个添加按钮，重新构建/刷新确认disabled；同时限制Admin对话框高度
并保留可滚动正文与固定操作区。目标运费页面无框架错误覆盖；Supplier/新Admin标签日志为空。
首次Admin登录短暂经过Dashboard，夹具未提供其完整统计数据，留下5项Dashboard字段缺失
日志及待办加载提示；不能报告全应用控制台无错，也未修改非本次范围的Dashboard。

之前常规Playwright四个桌面/手机场景也通过，原截图/结果在Temp；它们与插件证据分开，
不作为用户指定插件的替代。临时脚本、夹具和截图未加入仓库。

后端候选9a79573的CI34797832927已失败：分片1为3137通过/1失败/0跳过，唯一失败是
shipping-lifecycle-rules的store_seckill规则用例5秒超时。原artifact已下载保留，未改时限或重跑CI。
本机完整56项规则测试按原时限重验通过，但不证明Linux超时根因已解决；新候选仍需CI验证。
本机报告 `C:/Users/cina/AppData/Local/Temp/cinashop-shipping-ci-rules-recheck-20260914.json`，
SHA256 `0aebf145b2762ad73885971d2004893f9a5eabc734b2dd316b9ac461fd6f0b2e`。
线上9fb7d27的main CI34797549907现已success，不与候选CI混淆。
前端候选9e20c42的CI34799544041随后已completed/success、11/11作业成功；没有重跑或
取消该run。它证明该精确提交的门禁通过，不证明旧9a超时根因已修复，也不覆盖本轮超时增量。

尚未完成：Supplier在途竞争/身份及租户切换、存储故障注入等插件交互全矩阵，
真实Worker+PG+Redis+Pages端到端，实际运行角色/容量门禁、获准线上安装及协同发布。
A3k13不勾选，240完成/164开放/404总项不变。以下前端尚未接入的表述是此前阶段记录。

## 实际 HTTP 接入（2026-09-14，本地候选、未部署）

| 表面 | 创建/编辑 POST | 恢复 POST |
| --- | --- | --- |
| Admin | `/adminapi/shipping_template/save` | `/adminapi/shipping_template/creation-receipt` |
| Admin 别名 | `/api/admin/shipping_template/save` | `/api/admin/shipping_template/creation-receipt` |
| Supplier | `/supplierapi/setting/shipping_templates/save/:id` | `/supplierapi/setting/shipping_templates/creation-receipt` |

`ShippingTemplateCreationController` 替换原路由处理器，复用实际认证/权限中间件。
创建和查询只接受原始 `Idempotency-Key` 请求头的 UUID v4，合并后的重复值拒绝；
账号及供应商来自数据库新鲜认证上下文，不能从正文、请求头或轮换 JWT 字符串推导归属。
两种 Admin URL 共享同一平台账号作用域；Supplier 同账号变更供应商关系后也不能恢复旧租户回执。
恢复使用 POST 管理权限，不降为仅查看权限，不把键放在 URL；正文只能为空或空对象（1 KiB上限）。
创建载荷继续限制 Admin 256 KiB / Supplier 64 KiB。认证和权限拒绝先于正文/键校验。

创建成功 data 精确为 `{version,requestKey,requestHash,id,replayed}`，版本 `shipping-create-v1`；
恢复 data 精确为 `{version,requestKey,requestHash,id}` 或 null。同键不同内容 HTTP409/data=null。
缺表、缺失权限和 RLS 隐藏返回失败，而不是 null；所有相关响应包括认证/权限失败均 private/no-store。
null 仍只表示当时未见已提交回执，不能生成新键重建。回执 ID 不赋予当前模板访问权限。

平台扁平、平台分组直接/分派、Supplier save/create 五个服务入口均拒绝无独立创建上下文；
旧无键插入分支已删除，没有开关或可选键旁路。上下文参数可省略仅为保持已有编辑调用：
编辑仍要求父锁之后校验 expectedRevision，返回 `{id}`，不读写创建回执。
Admin 分组数值/字符串状态规范化保留，Supplier 状态继续固定1。未修改模板表、绑定、密钥或域名。

先在旧实际路由复现18项失败（按名称选择新用例，250项旧用例未选择），随后首轮330项、
扩展542项、最终14文件763项零失败/零跳过。493项注册路由测试包含原250项及新增243项，
使用维护账号和真实受限LOGIN、完整ORM、JWT验签、新鲜账号/角色；只替换令牌桶，禁止外部请求。
覆盖无/坏/撤销/过期token、停用角色、仅查看权限、跨账号/租户、重登、伪造字段、重复键、
缺表/SELECT/INSERT/RLS、冲突、转移/软删后的回执及原编辑/引用/历史保护。
独立holder/writer/reader连接与 pg_blocking_pids 实际证明HTTP查询等待创建提交/回滚；
未提交时第三连接看不到模板或回执。11项直接服务测试证实无键入口关闭。

另有22项合同验证通过：真实Pages代理（不带正文的transport-only探针）保留请求键、认证、
路径映射、200/409/500及no-store且只发送一次；Admin API精确快照与原合同保持。
快照更新仅反映路由行号、处理器和新增恢复路由，不证明尚未接入的前端持久意图已完成。
当前345调用/365变体均登记可执行；PHP1904/TS1659/匹配881/可执行863，PHP缺口没有缩小。
测试原始报告和SHA-256见 `audit/shipping-create-http-20260914.json`。

Workers技能驱动最新5.20260914.1 Headers定义、有界正文、请求级身份及响应前提交检查；
PostgreSQL技能驱动最小SELECT/INSERT、短事务、实际锁等待和RLS失败关闭验证。
两份TypeScript配置通过；本机隔离库、运行角色、schema全部0残留。
上一候选9fb7d27/CI34795252721已11/11成功，但不作为本HTTP候选的CI证据。
9fb7d27 随后获得用户精确授权，六端全量发布及 main 推送完成，两轮只读冒烟均17/17；
见 `../../docs/releases/full-test-redeployment-9fb7d27-20260914.json`。本HTTP候选仍未发布。

## 已实现的事务合同

`services/product/ShippingTemplateCreateReplay.ts` 的创建方法要求 UUID v4，
身份由调用方的认证中间件提供，作用域为 owner_type/relation_id/actor_id/request_key。
平台只允许 owner_type=0/relation_id=0，供应商只允许 owner_type=2/正数 relation_id，
actor_id 必须为正整数；身份及标准化输入在首次 await 前复制，忽略请求体伪造的归属字段。
actor_id 是稳定数据库账号 ID，不使用会轮换的 token。

完整分组表单沿用既有校验和地区权威读取，SHA-256 仅覆盖版本、标准化持久字段和服务端状态。
已提交的同键同内容返回原 ID 与 replayed=true，不重新写规则；不同内容为 HTTP/业务409，
不能作为新的成功或“从未创建”的证明。状态0只允许平台选择，供应商由服务端固定为1。

事务锁顺序为回执键 advisory → 供应商既有 advisory → 新插入父模板 → 三类规则 → 回执。
键锁使用作用域和 UUID 的摘要；32位锁哈希碰撞只会额外串行化，完整复合主键才是去重权威。
READ COMMITTED、statement/lock/idle 的5/2/5秒局部上限沿用公共边界，已有更短限制不放宽。
不自动重试、不使用 KV/Redis/进程内缓存，不做响应后的回执补写。

父模板、费率、包邮、禁配和回执在同一事务中提交；任一后期写入失败全部回滚。
回执先于当前城市和模板状态读取，因此模板后续修改、软删、物理删除、转移所属方或城市变化
不会使旧键变成新创建。回执仅证明原创建发生过，不授予查看当前模板的权限。
读取回执只返回版本、键、摘要和 ID，不暴露表单、账号或模板当前私有资料。

查询也取得同键锁，等待已经运行的创建提交/回滚；空结果只表示当时未见已提交回执，
不能据此换新键。新的发送方可能在查询之后进入；所有重试必须使用原键及原内容。
受限角色开启 RLS 导致历史回执不可见时，以 row_security=off 拒绝执行，不把隐藏记录当成未创建。

候选 DDL `migrations/shippingTemplateCreateReplay.ts` 建立复合主键、模板ID唯一约束和
身份/作用域/摘要/UUID约束。无父模板级联外键、无TTL，不让删除模板或时间流逝抹掉去重事实。
没有 CREATE IF NOT EXISTS 或自动建表回退；表未安装会失败。回执表现已注册 ORM，
外部0154与内嵌0160共用相同安装SQL；既有编号不变，内嵌链总计161步。
测试中的运行角色只得到回执 SELECT/INSERT，不能 UPDATE/DELETE/TRUNCATE/ALTER。
高权限维护仍能修改目录或数据；下述门禁不替代运行角色审查与维护窗口协调。

## 正式迁移（代码已发布，尚未线上安装）

新库使用正式外部/内嵌链或 ORM 生成；现有库只调用根连接的
`runShippingTemplateCreateReplay(db)`，禁止为此重跑全部历史迁移。
独立安装器在 READ COMMITTED、读写事务中固定 public/pg_temp 与 row_security=off，
使用安装 advisory 锁和现有表 ACCESS EXCLUSIVE NOWAIT 锁；局部时限30/1/5秒，
已有更短限制保留。失败整体回滚，不替换、重命名、回填或修复已有对象。

复用同名表需精确匹配7列、6约束、2索引以及校验状态、所有权、持久化、RLS、
继承、规则、触发器和表/列 ACL；拒绝 PUBLIC、授权转授及非所有者可变权限，
允许既有运行角色 SELECT/INSERT。启用的 DDL event trigger、replica 模式及并发安装拒绝。
创建后再次检查，默认 ACL 导致暴露时回滚新表，既有授权不被修改。
临时和其他 schema 的同名表不参与安装；没有模板 FK 或TTL，保留历史创建证据。

这里检查的是回执表直接 ACL 和明确列出的目录字段，不是全库有效权限、角色继承、
恶意高权限并发维护或所有扩展行为的完整证明。安装不自动给运行角色授权；实际发布前
仍需审查角色身份、维护排他安排，并单独批准线上升级。

真实 PG16.15 九路径审计已通过：264表、3708列、577约束、1022索引、227序列完全一致。
各路径在任何重复安装前即确认回执表已正确注册，随后两次安装保持表与索引 OID/文件不变。
37项独立安装测试覆盖新建/ORM/外部SQL、带记录重复安装、20种漂移拒绝、受限LOGIN、
event trigger、默认ACL、锁冲突、局部时限恢复、同名表隔离及索引名冲突回滚。
PG16目录语义依据[pg_constraint 文档](https://www.postgresql.org/docs/16/catalog-pg-constraint.html)，
局部配置恢复依据[SET 文档](https://www.postgresql.org/docs/16/sql-set.html)并经实际事务验证。

最终13文件337项零失败/跳过、双类型通过，隔离库/运行角色/schema为0残留。
报告及SHA-256记录于 `audit/shipping-create-replay-migration-20260914.json`。
首次目录样本4项旧计数失败已修正；服务停止造成的连接拒绝报告保留。
随后宽并发回归有2项afterEach失败，JSON仅给出STACK_TRACE_ERROR，不能断言其具体根因；
最终限制文件并发为2、保持所有断言与超时不变后完整通过。
539a828 的候选 CI34793000186 后以 failure 结束：旧序列测试仍期望1090条初始SQL，实际为1091；
该计数在 bef1601 修正，11项本机PG16验证通过。其 main CI34794350398 记录时仍运行。
原 main CI34793782371 因后续 main 推送及工作流并发规则已 cancelled，不作为通过证据。
PostgreSQL技能驱动本轮短事务、局部超时及最小权限门禁；没有因技能而运行线上DDL或自动修复ACL。

## 证据

先用既有真实 Supplier 保存服务复现2项红测：丢失成功响应后的顺序重试和同键并发，
均得到2个模板，而要求是1个。原报告保留：
`C:/Users/cina/AppData/Local/Temp/cinashop-shipping-create-replay-red-20260913.json`，
SHA256 `6ab48c911e64455f2cc9fcb7c0a49cc261dc3433f280198fc8b79856eeedf428`。

新增36项引擎与14项受限 LOGIN/数据库约束测试；最终与既有 Supplier 保存/快照、
Admin 分组和250项注册路由授权回归合计6文件343项，零失败、零跳过。
报告 `C:/Users/cina/AppData/Local/Temp/cinashop-shipping-create-replay-final-20260913.json`，
SHA256 `1aba76c8630ca6f36953c439421e6e34d7b8d5e243bf15ebafa17845fa1ea835`。
第一轮32项及第二轮46项报告亦保留在同一临时目录（first/second）。

独立连接由专用夹具校验数据库、角色、版本和不同 backend PID。
并发测试通过 pg_blocking_pids 证明实际阻塞，不以睡眠或 Promise 同时开始充当并发证据；
第三连接同时确认业务行及回执未提交时均不可见。
覆盖创建/查询遇到首事务提交或回滚、锁超时后原键恢复、回执/子表写入失败整组回滚、
字段规范化、输入对象中途变动、跨账号/供应商/平台隔离、缺表、RLS隐藏和数据库约束。
真实受限 LOGIN 只针对五表创建引擎，不是该新协议的 HTTP 鉴权验收；既有250项路由回归
仍测试旧入口，不能据此宣称新引擎已接入路由。Worker 双类型检查通过。
隔离测试数据库、角色、schema 均已检查为0残留。

Workers 技能驱动最新 Web Crypto 定义核对、请求级状态和同步提交要求；PostgreSQL 技能驱动
固定锁顺序、局部时限、复合唯一索引及实际并发/受限角色验证。不升级依赖、改兼容日期或部署。

## 后续必须完成的接入门禁（不是可选兼容模式）

1. ORM、正式编号文件/内嵌迁移、现有库独立升级及九目录路径已在本机验证；
   仍需精确候选 Linux CI、实际运行角色审查和获准后的线上升级。旧迁移编号不可改写。
2. 两个后台创建入口已统一调用引擎，认证/权限之后强制键、旧服务无键路径关闭已本地验证；
   仍需与前端持久意图共同验证，不保留可选键绕行模式。
3. 真实注册恢复路由、精确安全回执、no-store、跨角色拒绝及实际事务等待已本地验证；
   真实Redis/线上角色及浏览器集成仍未完成。
4. 两个前端必须在请求发出前持久保存身份范围、UUID和准确输入；刷新/重入/未知响应只能恢复原意图，
   不能自动生成新键。存储失败必须阻止发送，恢复查询为空也不能解除这条规则。
   对比服务端回执，明确处理冲突、账号变化、模板已删除/转移、迟到响应和多标签竞争。
5. 完成桌面/手机的实际刷新及提交后断网恢复、真实角色、最小权限/容量、精确候选 Linux 和明确发布验证。

正式引擎不采用可选键 fallback；当前候选后端已强制，旧页面尚未适配，因此禁止单独上线。
完整清单仍为240完成/164开放/404总项，A3k13不勾选。

## 共享规则与旧扁平回执增量（2026-09-14，本地候选）

`ShippingTemplateRules.ts` 承载分组解析、快照格式、城市权威和规则写入，
不再依赖 Supplier 服务；旧导出保留兼容现有调用方。`FlatShippingTemplateInput.ts`
复用旧平台表单原校验，不把仅名称创建、空区域、默认值和旧零计量合同误改为分组规则。

`createFlatShippingTemplateOnce` 只接受平台身份和必需 UUID v4，拒绝正数编辑ID、
Supplier身份以及混入分组载荷。默认值/小数在首次await前复制并标准化，保留旧区域名称，
不伪造城市路径或读取当前城市。平台归属/状态等持久字段由受控字段映射生成；
请求体伪造的 actor/owner/relation、删除/时间字段不写入或参与摘要。

扁平与分组共用私有 `commitCreation`：同一作用域和请求键锁、同一回执表、同一短事务。
扁平摘要显式区分载荷表示，原分组摘要保持不变。跨格式重用同键返回409，不另建模板。
没有公开的任意事务回调、缓存、自动重试、后台回执补写或无键回退。
旧服务入口当前未切换，因此本增量不是已交付的 HTTP 或浏览器恢复功能。

先由真实旧平台保存服务复现丢响应重试和同键并发各创建两模板的2项红测。
最终新增43项扁平引擎测试及4项真实受限LOGIN测试；与原分组引擎、平台编辑/列表、
Supplier保存/快照及250项原注册路由授权合计10文件428项全部通过、零跳过。
跨格式竞争和创建后的查询使用独立数据库连接，pg_blocking_pids确认实际阻塞，
第三连接确认提交前不可见；分别验证提交、回滚、409及原键后续恢复。
扁平写入不要求城市读取、子表DELETE或包邮/禁配表权限；缺失必要INSERT/SELECT整体回滚。

Worker双类型检查通过，最后两项竞争测试添加后单元类型重验通过。
专用本机PG16.15隔离库/运行角色/schema均零残留。原始红测、首轮95项、最终428项及
各自SHA-256见 `audit/shipping-create-flat-replay-20260914.json`。
Workers技能驱动请求状态复制和同步提交检查，PostgreSQL技能驱动短事务与最小权限验证。
未变更DDL/模型、绑定、域名或密钥，未访问生产业务数据库、未部署。
