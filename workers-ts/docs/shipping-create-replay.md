# 运费创建持久回执：强制键 HTTP 与正式迁移候选

2026-09-14，对应 A3k13。三个实际创建入口已在候选接入强制键事务，并新增恢复查询；
两端前端现已接入持久意图、原键重试、查询和明确确认。**回执表未安装线上，真实运行角色与
端到端生产验收未完成；本候选不能部署**。已发布源为 9fb7d27，线上页面仍是旧无键合同。
必须完成下述迁移和协同发布门禁，不能单独切换 Worker。
历史阶段“尚未接入 HTTP”的记录保留在后半部分，不代表当前候选状态。

## 前端持久意图与浏览器插件验证（2026-09-14，未部署候选）

`view/shared/shippingCreation.ts` 用每个身份范围的 Web Lock 协调标签页，首次发送前将
稳定 owner/relation/actor、UUID、准确输入、服务端合同摘要写入 localStorage 并读回验证。
不保存 token；存储异常、记录损坏、不支持安全锁均阻止发送，不提供内存或新键 fallback。
刷新、重入、重新登录相同账号复用旧范围；不同账号/供应商隔离。恢复为空保留原意图，
只有显式“使用原请求重试”才再次发送相同键和内容。严格匹配版本/键/摘要/ID及 replayed，
确认回执也先落盘；“确认完成”只能清理匹配的已确认意图，旧标签不能清理后来意图。
另一标签已有不同输入时恢复原表单并暂停，不静默发送旧输入。编辑路径保留原 revision 合同。
独立请求捕获调用时认证，响应限制4 KiB、no-store、不跟随跳转、不自动重试。

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

尚未完成：真实浏览器同时在途竞争、身份切换/迟到响应、存储故障注入的插件交互全矩阵，
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
