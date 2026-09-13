# 运费模板引用与生命周期：A3k12

## 2026-09-13 安装环境副作用门禁（未注册、未发布）

正式接入前的真实PG16红测复现：`ddl_command_start`/`ddl_command_end` 事件可在候选
创建协议对象时将历史订单运费12.34改成99.99；安装仍提交、精确目录仍是complete。
另一个红测证明旧安装器错误接受replica会话，而安装的origin触发器在该模式下不执行。
这三项均是隔离库反例，不代表线上订单发生了变化。

现有阻写事务在锁表前及锁内存量重验后各执行一次只读环境门禁：只允许origin/local，
拒绝所有未禁用DDL事件触发器，不按事件类型/命令TAG猜测其安全性，不自动禁用/删除
事件或切换复制模式。第二次检查由独立连接在初检后启用事件的测试验证，拒绝时释放七表锁、
不调用安装回调、不撤销另一维护身份的变更。禁用事件保持原OID/定义，正常首次/重复安装通过。
依据[PG16事件行为](https://www.postgresql.org/docs/16/event-trigger-definition.html)及
[pg_event_trigger启用模式](https://www.postgresql.org/docs/16/catalog-pg-event-trigger.html)。

新增19项（13真实PG16场景、6失败关闭单元），最终8文件225项零失败/跳过、双类型通过；
隔离库/schema/角色余量0。首轮220项已通过，但测试观察器的TypeScript签名不合，修正后
保留首轮与红测报告，再执行上述最终回归。证据 `audit/shipping-lifecycle-install-environment-20260913.json`。

边界：这是两次目录快照，不是阻止独立超级用户在最终检查后创建/启用事件的全局锁。
正式维护窗口仍须协调所有高权限身份，非协议行触发器交互和0152/0158正式新建/升级注册
仍待完成；未执行线上SQL、未部署本增量，不以新增门禁代替正式角色或容量验收。

## 2026-09-13 运行身份权限边界（本地候选验收）

新增只读 `auditShippingLifecycleRuntimePermissions`，以真实连接身份及可继承/切换角色
检查七表、ID序列、五函数的必要权限和所有权、DDL、复制绕过、授权传播等危险能力。
34项新增测试覆盖真实LOGIN的必要写入、应用软删除与权限拒绝；七文件206项全部通过、
零跳过，双类型检查通过。证据见 `audit/shipping-lifecycle-runtime-permissions-20260913.json`。
审计不执行GRANT或业务写入，不代表完整服务授权、数据基线或精确协议目录已验收；
禁用触发器时权限检查仍可通过的反例明确要求独立目录检查。未注册正式迁移、未改线上权限。

## 2026-09-13 精确目录与候选幂等（未发布）

固定协议定义移至 `src/migrations/shippingLifecycleProtocol.ts`，未改变触发器SQL语义，
仍只由限定随机PG16库的测试候选安装。`inspectShippingLifecycleProtocol` 在安装阻写事务内
比较5函数/9触发器：未安装才创建、完整一致返回applied=false、部分对象或漂移一律拒绝，
创建后再次核验，禁止OR REPLACE、自动修复或覆盖原对象。正文来自版本控制的固定定义，
不是把线上目录当期望值；对外只返回状态/计数/布尔，不输出正文、角色或业务数据。

函数核对正文、参数类型/名称、返回值、语言、strict/volatile/security/parallel/leakproof、
配置、默认参数/支持函数/成本等属性及当前安装者所有权、完整ACL项；触发器核对public表、
函数绑定、ROW/STATEMENT及事件位、origin启用、约束/延迟/列限制/WHEN/参数/transition表，
并拒绝额外挂载、同名重载和协议保留前缀中的额外对象。依据
[PG16 pg_proc](https://www.postgresql.org/docs/16/catalog-pg-proc.html) 与
[pg_trigger](https://www.postgresql.org/docs/16/catalog-pg-trigger.html) 的字段定义逐项比较。

权限边界须明确：这里精确固定的是当前候选的PostgreSQL默认函数EXECUTE ACL（owner和PUBLIC），
不是批准正式运行权限；不检查或授予运行角色的表写/DDL/复制权限，runtimePrivilegesVerified始终false。
函数/触发器DDL仍需受信任维护身份管理；七表锁不能防止不遵守维护协议的高权限人事后改函数。
最终最小权限策略、非协议触发器交互及注册仍开放，不能把state=complete解释为生产验收通过。

38项新PG16目录测试证明首次applied=true/重复false且OID/定义/ACL/非空历史数据不变，
33种定义/触发器变异拒绝覆盖，另验证部分安装、额外grantee/grant option、函数及表所有者漂移，
以及默认权限注入额外授权时全部新对象回滚。原函数冲突测试现改为安装前拒绝（旧阶段是中途DDL失败）。
最终6文件172项零失败/跳过，双类型及候选开启8应用案例通过，隔离库/schema/角色均0；
证据 `audit/shipping-lifecycle-protocol-catalog-20260913.json`。未注册正式新建/升级、未执行线上SQL。

## 2026-09-13 安装阻写与锁内重验（未发布）

`withShippingLifecycleWriteBarrier` 现在作为测试候选安装器的事务边界：PG16根连接独占
READ COMMITTED/READ WRITE事务，保留更严格的statement/lock/idle期限；先检查目标形状，
按固定顺序对7张public表取得SHARE ROW EXCLUSIVE NOWAIT，再在锁内重验形状和全部引用。
检查与只读CLI共用查询，但读写安装事务不标记readOnly；不接收或复用旧审计报告。
安装回调只能使用传入事务执行受信任DDL。没有网络/线上apply入口，没有自动重试、修数据或授权。

依据 [PG16 LOCK](https://www.postgresql.org/docs/16/sql-lock.html) 的互斥与事务释放规则，
真实测试逐表证明已有写锁使安装立即拒绝、部分锁释放；安装持有全部7把锁时普通读取成功，
第二安装器拒绝。用pg_blocking_pids证明无效活动写入排队，锁内验证及触发器DDL提交后，
排队写入被新触发器23503拒绝。此前read-only报告成功、另一连接随后提交坏引用时也拒绝安装。

22项安装协议测试还覆盖六类不兼容引用零DDL/数据保持、继承/错误结构拒绝、真实SELECT-only
与RLS隐藏行拒绝、嵌套事务拒绝、较严期限保持，以及回调异常/中途同名函数冲突的DDL整体回滚。
最后5文件134项零失败/跳过（22+26+2+36+48），双类型通过，候选开启的8应用案例全部保护成立、
零观察到修改；该8案例不另算单元测试，也不证明完整直接SQL写面。隔离库/schema/角色零残留。
证据 `audit/shipping-lifecycle-write-barrier-20260913.json`。

该阶段只完成安装原子性前置；后续已补候选精确目录及幂等，见上。正式权限边界、
新建/升级注册、剩余写面及容量仍开放。现有异构同名对象会拒绝，不擅自替换；
未注册0152/0158，未运行旧runAll，未修改线上。下文安装“未接入”是此前阶段状态。

## 2026-09-13 负引用拒绝及批量/归属竞争补验（未发布）

真实PG16红测发现六类引用表均可写入负temp_id，候选将其当作免费/固定运费的未绑定值；
这与存量只读审计的拒绝政策不一致。候选现在在最终行检查和未变更快捷路径之前明确拒绝
负temp_id（23503），不更改现有行；测试覆盖六表INSERT/UPDATE、三种运费模式（套餐无此列）。
新增六表两行批量改绑：一行无效时整个语句及历史订单保持，随后合法批量改绑成功；
另验证批量停用包含无引用模板时也整体回滚。

按一致锁顺序/最小权限原则补齐源商品归属竞争：先转移时活动准入NOWAIT拒绝，提交后拒绝
旧属模板但接受新属模板；先准入时归属转移真实等待，引用提交后拒绝转移，原归属保留。
四文件112项零失败/跳过（预检26、CLI2、候选36、应用48）和双类型通过，随机库/schema/角色零残留。
证据 `audit/shipping-lifecycle-candidate-boundaries-20260913.json`。这不证明所有多行交错或容量，
正式安装的阻写重验、目录/ACL漂移、幂等和新建/升级注册仍缺，A3k12不勾选。

发布状态更正：应用协议4810501已于2026-09-12 14:07 UTC发布，版本
`3fc99931-0471-4509-9903-c05b8c513842`，17项线上只读检查通过；发布记录442fbbb的
Actions34698489744也已11/11成功。本节及下节的基线审计/触发器候选仍未发布或安装线上。

## 2026-09-12 存量只读预检与源表 TRUNCATE 缺口

新增 `auditShippingLifecycleBaseline` 和 `npm run audit:shipping-lifecycle-baseline`。
只接受显式 `SHIPPING_BASELINE_DATABASE_URL`；远程连接还需要
`SHIPPING_BASELINE_ALLOW_REMOTE=1`，且验证 TLS。不会回退到 DATABASE_URL、dotenv、
本机默认库或 Hyperdrive 管理凭据；不接受参数及 URL options，不存在 apply/reset 模式。
退出码0仅表示本次存量快照兼容，1表示发现不兼容，2表示输入/执行/清理异常。

审计使用 PostgreSQL16 的 REPEATABLE READ/READ ONLY 有界事务，显式 public 表名，
row_security=off；真实SELECT-only角色遇到RLS隐藏行或缺少SELECT时拒绝执行。
先检查7张普通持久表、无继承分区、关键列类型/非空和单列非延迟主键；不兼容时
不继续读取数据。再按6类引用表汇总所有保留行，区分负模板ID、源商品缺失/所属方异常、
父模板缺失/停用/软删和归属不一致。正temp_id即存储引用，隐式默认1按既有读取语义，
套餐temp_id=0不当作默认引用；多个问题可重叠计数，invalidReferences按行去重。
报告仅包含表名/计数/布尔结果，不输出商品、订单、用户标识或数据库凭据。

`baselineReady=true` 不证明函数/触发器/ACL目录一致、已有安装、未来写入安全或安装授权。
该报告只是一致快照；正式安装器必须在自己的阻写边界重新验证，不能据先前报告跳过。
该阶段尚未把审计挂到候选；后续已接入锁内重验，见上。仍未注册0152/0158或运行旧runAll。
安装幂等、完整函数/触发器定义与ACL漂移、维护窗口/多行协议仍待继续，不提前关闭A3k12。

另一个红色测试确认：旧数据库候选允许 `TRUNCATE store_product CASCADE`，行级DELETE
触发器不会因此执行，保留活动可失去源商品。按
[PostgreSQL16 TRUNCATE触发器语义](https://www.postgresql.org/docs/16/sql-createtrigger.html)，
候选增加源商品表的 BEFORE TRUNCATE 拒绝；整行引用/模板/订单快照验证拒绝后不变。
该修复仍限测试候选，不是线上已安装的保护。结果见
`audit/shipping-lifecycle-baseline-20260912.json`。

## 2026-09-12 应用协议集成（当时未发布，后续发布见上）

当前工作分支把绑定准入与退役检查接入真实应用服务，不依赖测试触发器。
`ShippingTemplateLifecycleService` 对有效引用按模板 ID 排序取得 SHARE NOWAIT，
核对模板状态及精确所属方；删除持有父 NO KEY UPDATE 后，以新的 READ COMMITTED
语句检查六类存储引用，包括已退役/跨所属方异常行及隐式默认模板1。
供应商删除不再反向锁商品，规则删除和父软删除在同一事务；总后台停用也检查引用。
已存在订单不重计价，不自动把商品改绑到模板1。

准入接入 Out 商品、Supplier 商品、MobileAdmin 批量运费及套餐复制。
秒杀/拼团/积分旧编辑器保留省略的商品 ID，并在更换来源时重验保留模板。
砍价保存刷新源所属方时，即使省略配送表单，也重验最终规范化后的模板；
新红测证实修复前仅改名会返回成功并遗留跨所属方引用，修复允许显式合法改绑。
普通未改所属方的旧配置编辑仍保留原值，非物流商品沿用原有规范化。

应用删除验收只接受预期业务拒绝；未知 SQL 错误不能计作保护成功，HTTP 采用实际
全局错误处理器隐藏 SQL 细节。真实受限 LOGIN、RLS 隐藏引用、提交/回滚、
父锁等待后重读和既有订单整行不变均有独立 PG16 用例。具体结果及失败重跑记录
以 `audit/shipping-template-lifecycle-application-20260912.json` 为准。

写入口检索排除了 `ProductMetadataService` 的参数模板 tempId（并非运费引用）；
`ProductAssociationService` 的非实物保存仅显式解除运费模板，所属方沿用锁定原商品。
这仍不是完整写面证明：直接 SQL、维护迁移、BEFORE 触发器改值、源商品所属方
维护入口及所有多行交错需要正式数据库协议共同覆盖。

A3k12 保持开放：正式迁移/幂等与目录及 ACL 漂移检查、存量有效性、保留策略、
容量/索引、完整写面、精确提交 CI 和真实角色线上验收尚未全部满足。
该开发阶段未执行生产 SQL；当时线上为 main@c833ce9，后续4810501发布状态见上。
下文是历史阶段观察，不能当作当前工作分支的实现状态。

## 2026-09-12 数据库协议候选

已实现隔离库限定的候选 `test/helpers/shippingTemplateLifecycleCandidate.ts`，不是生产安装器。
六类引用在 AFTER 行触发器中检查最终值，避免只看 UPDATE 列表而漏掉 BEFORE 触发器改绑。
引用准入读取并持有模板 SHARE NOWAIT，活动同时核对源商品所属方；父删除/软删/停用/
身份与所属方变化通过固定六表查询拒绝现存引用，禁止模板TRUNCATE，并拒绝相关写入使用旧RR快照。
触发器为SECURITY INVOKER，固定schema且row_security=off，避免RLS隐藏子行导致误判无引用。
这是按 [PG16锁兼容规则](https://www.postgresql.org/docs/16/explicit-locking.html) 和
[触发器数据可见性](https://www.postgresql.org/docs/16/trigger-datachanges.html) 实现的候选，
仍须用真实并发证据约束，不能只据理论称完成。

完整ORM/PG16的20项测试零失败零跳过，双类型通过，包含真实独立连接的两个提交方向、
回滚与NOWAIT、最终BEFORE值、真实非所有者LOGIN和RLS隐藏引用拒绝，以及历史订单整行不变。
同一8案例脚本在不安装候选时仍8项失败；设置 `SHIPPING_LIFECYCLE_CANDIDATE=1` 后8项通过，
Admin控制器和Supplier服务的删除均被数据库拒绝且父模板未变。各运行仅使用自己的随机库，零残留。
证据 `audit/shipping-template-lifecycle-candidate-20260912.json`，两组计数不累加为单元测试总数。

当前候选采用“存储引用未清除即保护”，包括已退役记录；这不是批准保留期或自动清理政策。
尚未提供存量有效性/目录漂移/幂等安装守卫，未注册新建与升级迁移、未接入应用错误提示和完整授权。
尤其Supplier删除现有的先锁模板再锁商品流程，仍可能在触发器执行前与商品编辑相撞，须一并对齐。
未验证完整写入口、全部多行/多模板竞争、容量和正式角色；没有生产写入，A3k12仍开放。
下文“未修复”为原始基线；候选本机证明不等于正式应用已修复。

## 2026-09-12 真实红色验收

`scripts/audit-shipping-template-lifecycle.ts` 只接受专用本机 PG16 测试连接，使用完整ORM随机数据库。
它调用实际Admin删除控制器和Supplier删除服务，不是SQL文本检查；认证是明确的本地夹具，
不构成真实角色验收。运行返回 `ready=false` / 退出码1，8例全部确认父模板仍被引用却被删除。
脚本退出前清理自己的随机库；远程连接拒绝，执行或清理异常返回2，只有保护成立才返回0。
这是一份尚未通过的验收复现，不能把“成功复现”计作功能修复或CI通过。
精确证据：`audit/shipping-template-lifecycle-gaps-20260912.json`。

已确认的引用面是商品、秒杀、砍价、拼团、积分商品和套餐明细六张表。
额外两例覆盖源商品已解绑但砍价仍保留模板，以及 `temp_id=0/freight=3` 隐式使用默认模板1。
前六例通过总后台删除；第七例通过Supplier服务删除。显式引用行没有被重写，父模板却成为删除态。
旧PHP `ShippingTemplatesServices.detete` 会删除模板规则并把商品重绑到1；不能直接照搬为自动修复。

## 原始基线已确认的写端差异（由上方应用增量部分覆盖）

| 入口 | 当前观察 | 后续必须验证 |
|---|---|---|
| Admin模板删除 | 单独更新is_del，不检查引用 | 删除/绑定共同协议、幂等与精确失败 |
| Supplier模板删除 | 父FOR UPDATE，只查同供应商未删商品 | 独立活动、套餐、跨所属方异常引用及解绑竞争 |
| Supplier商品保存 | 模板KEY SHARE | 与软删除/停用/所属方变化互斥；不要将KEY SHARE误作SHARE |
| MobileAdmin批量运费 | 先锁商品，再取模板SHARE | 与模板删除反向取商品锁的死锁风险；现有平台模板例外与结算校验差异 |
| Bargain配送编辑 | 活动/源商品后模板SHARE NOWAIT | 缺失、退役、来源变化及重复保存 |
| Out商品、套餐保存 | 写入/复制temp_id | 继续完整追踪校验与锁的调用链，不能据赋值一行判断已受保护 |

这张表是当前已确认入口，不宣称全部绑定/解绑/退役入口已审计。
本轮使用PostgreSQL锁顺序技能识别锁模式及逆序风险，但未用表锁粗暴绕过整个生命周期问题。

## 完整完成条件（仍开放）

1. 完成全部写入口和六张引用表的有效/退役/隐式默认关系清单，包含商品所属方变化。
2. 建立删除、绑定、解绑及恢复共同协议，既阻止旧引用下删除，也阻止删除提交后的新引用；
   单次COUNT或只给删除加锁不够。直接SQL写入也必须有明确保护/权限边界。
3. 保留原订单金额、运费、明细快照；不把模板生命周期操作变成历史订单重计价或隐式批量重绑。
4. 加独立PG16双连接的两个提交方向、回滚、锁超时、死锁反例、跨租户与缺失对象负向验收。
5. 验证模型/新建/升级路径和真实受限身份；CI、需要的迁移与线上验收分别取证，不提前勾选。

当前八个失败只是第一阶段边界证据。共同协议、行为修复和上述其余条件尚未完成。
