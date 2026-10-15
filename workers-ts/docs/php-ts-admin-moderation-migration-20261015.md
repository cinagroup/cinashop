# Admin 商品审核与自动上下架迁移（2026-10-15）

本批以 `b05fefe90e74055344cedf2135de47d77b539769` 为基线，补齐四条旧 Admin 审核接口、现代审核页面和自动上下架分钟任务。此前库存批次的报告、账本、回执和 freeze 保留为历史证据；本批不能替它们重新背书，也不表示整个 PHP→TS 迁移完成。未部署、未执行生产 DDL、未停用 PHP。

## 源合同与当前行为

| 真实旧路由 | 行为 |
| --- | --- |
| GET `/adminapi/product/product/verify/:id` | 返回审核 FormCreate JSON；源构造表单不要求父商品存在 |
| GET `/adminapi/product/product/remove/:id` | 返回强制下架表单，隐藏 `is_verify=-2` 和必填原因 |
| GET `/adminapi/product/product/get_verify/:id` | 仅返回 `{verify:0|1}` 的普通 SKU 售价/结算价提醒；不要求父商品存在 |
| POST `/adminapi/product/product/set_verify/:id` | 源字段默认 `is_verify=1/refusal=''/is_show=0/auto_on_time=0`；body 的冗余 id 被忽略，路径决定商品 |

静态源依据为相邻 PHP checkout 的 `app/controller/admin/v1/product/StoreProduct.php`、`app/services/product/product/StoreProductServices.php`、`app/dao/product/product/StoreProductDao.php`、`route/admin.php` 和旧 Admin `productList` 页面。此环境没有 PHP 解释器，未声称运行了 PHP 对照服务。调查记录见 `audit/review-20261015/next-scope-source-scout.json`。

审核只更新当前父商品的 `is_verify/refusal/is_show/auto_on_time`，且无论通过、拒绝还是强制下架，都将该商品**全部 `status=1` 购物车改为 0**。其他 cart 状态保留。它不传播到子商品，不改 SKU、分类关系、订单或 outbox，也不擅自增加源中没有的 cache/status 事件。源服务没有当前审核状态、归属、回收站、卡密或价格准入门槛，后端保留这些行为。拒绝本身不会强制改写传入的 is_show；有效非零上架时间才会强制 is_show=0。没有时间的 is_show=2 也按源保留。

目标明确收紧：只接受 -2/-1/1 审核值和 0/1/2 上架值；原因最长255个 Unicode 码点，拒绝 NUL/孤立 surrogate，拒绝或下架时不能全空白；输入流上限8KiB，拒绝未知字段和 query。非零时间只接受严格 UTC ISO 或明确的北京时间字符串，校验真实日历和 int32 秒范围，替代任意 PHP strtotime 文本。预检使用整分金额比较，对比较时遇到的负数或非规范历史金额返回失败，不静默修复。

PHP `getSkuArray` 默认按 suk 索引，无序重复 suk 会覆盖。目标比较每条 type=0 的物理 SKU（包括退役行），是**保守提醒扩展**，不能说重复 suk 时完全等价。预检仅为提示，未把 GET 和稍后的 POST 变成同一价格快照或硬性价格门槛。

## 权限、事务与恢复

四路由没有可证明的 PHP installer 数字权限种子。目标读用 canonical `product.view`，写用 `product.manage`，拒绝复制的未证明数字菜单 claim。真实 JWT、当前中央 Admin 状态/密码版本/level 0..9、角色引用历史和当前权限共同判定。敏感响应在认证之前即设置 private/no-store 与 no-cache。

审核写入在一个有期限事务中取得 authority、bargain 生命周期、商品写边界，再锁父商品和关联行。SKU/cart/relation 的真实 `SHARE ROW EXCLUSIVE NOWAIT` 表屏障覆盖空集合插入和直接 SQL 写；它会短暂阻止无关商品在这些表上的写入，且运行角色必须具有这些表的 UPDATE 权限，即使审核只读 SKU/relation。不能将其描述为 SKU/relation SELECT-only writer。完整 RETURNING 和回读检查父商品、全部当前 cart/SKU/relation，完整审计行及同路径既有+新增审计集合，最终复查 authority 与数据库墙钟。失败整笔回滚，不自动修复 drift。审计多次回读不代表禁止任意外部 SQL 同路径并发插入；未对 system_log 建全表写屏障。

现代列表在待审核状态提供审核入口，已通过且未删除的商品提供强制下架入口，不受库存 ERP 开关限制。审核通过可选立即上架、定时上架、放入仓库；定时输入明确标为北京时间。页面拒绝空定时时间；拒绝/强制下架的新 UI 明确提交隐藏状态和空上架时间，这是页面决策，后端仍保留旧合同的其他合法组合。

提交前重新取得价格提示并显式确认。组件在路由、商品、账号、权限或上下文变化后丢弃旧读取/确认；Axios 发出请求前再次核对账号和 bearer。结果未知时只持久保存 owner/product/run 标识，阻止重发；需要之后的真实商品列表读取与人工核对才能开始新的决定，因为重复审核可能使新加入的购物车失效。使用 Web Locks 的跨标签写边界和短 marker mutex；读取开始前探测同一写锁，进行中或写入前开始的读取不能事后用作恢复证据。没有 Web Locks 的旧浏览器仅有单标签 pending 与持久标记保障，未声称等同跨标签并发保证。恢复不是证明上一笔已提交，更不是后台自动重试。

## 自动上下架

PHP auto_show 每60秒执行：is_del=0，先 is_show=0 且 auto_on_time 非零且 `<= now` 上架，再 is_show=1 且 auto_off_time 非零且 `< now` 下架，保留定时时间，不检查 is_verify/type/pid，不改 cart/relation/cache。

目标新增 `* * * * *` cron，只投递 `product_auto_shelf` 根任务。原 `*/5` 分钟 cron 的其余维护任务保持独立，不重复投递商品根任务。Cron 不读库，根捕获最大商品 ID，两个阶段按 `(time,id)` keyset 扫描，每页80行加 continuation，Queue 只传有界引用。执行时在 bargain/商品/行锁后按**当前 PostgreSQL 墙钟**重新判断先上后下，避免新下架任务完成后迟到的旧上架消息重开商品。扫描截止时间保持本轮 scheduledAt；后来新到期、新增或改期商品可由下一根扫描发现，不承诺 Queue 无延迟或严格60秒内完成。

目标边界为合法归属 tuple、正数 int32 定时秒与当前数据库时间；PHP 非零负数时间等异常导入值不自动执行。该任务只更新 is_show，对整个父商品核对写回结果。重复/乱序任务可再次经历相同的 on/off 判定，但最终状态稳定，无重复审计或外部效果。它没有公开 HTTP 写入口，也不在运行路径补 DDL。

新增两个部分索引：`sp_auto_on_due_idx(auto_on_time,id)`、`sp_auto_off_due_idx(auto_off_time,id)`。独立 SQL 为 `migrations/0176_product_auto_shelf.sql`，字节相同 embedded 源在 `src/migrations/productAutoShelf.ts`，追加 registration0181，已有0180未改。独立事务核对普通持久表，并拒绝 RLS/继承/启用的事件触发器和既有索引漂移；保留更低调用者超时。生产启用前仍须独立升级索引及核对运行角色权限，不能由这份本地报告推断生产就绪。

## 验证证据与边界

本批账本 `audit/php-ts-admin-moderation-migration-20261015.json` 引用最终回执、源码 freeze、独立审查和浏览器事实。所有重型检查通过共享串行锁，Vitest 单 worker，Worker tsc8192MiB。失败的初轮记录保留，不计入最终通过。

普通7文件63项通过；原生4文件30项通过，其中19项与普通执行重叠，因此合计74个不同的 SQL/页面/协议测试定义。workerd另外2文件19项通过，包含4项新调度分发与15项既有运行时回归。最终标注清理后的窄回归与类型/构建回执在账本逐条记录，重复执行不增加覆盖数。

| 最终门禁 | 结果 |
| --- | --- |
| Worker 普通完整 tsc / runtime 完整 tsc | 各 exit0，8192MiB |
| Admin vue-tsc / Vite build | 各 exit0 |
| 最终前端窄回归 | 2文件9项通过，覆盖与普通执行重叠 |
| 最终原生标注清理复核 | 2文件11项通过，集群已停止、剩余测试数据库0 |
| 源码与目录重新核对 | 3495输入无差异；freeze范围不包含依赖安装字节、环境值或完整构建图 |

Vite 有2条既有 @vueuse PURE 注释位置提示，构建成功；workerd 的模拟 SQL 失败日志是重试用例的预期结果。首轮测试 scaffold 的 ref 访问、认证前 no-cache header，以及新测试的泛型/事务类型标注失败均保留在历史回执中；仅最终成功回执用于本批验收。暂存检查另发现新 API 文件末尾多一空行，已只删除该换行；EOF 字节等价证明及前后 SHA 记录在 eof-normalization.json，未为此重复重型测试。


普通回归包括真实 App/JWT/旧 Axios/SQL、完整审核业务、普通和新跨标签页面、调度、既有库存业务与页面。原生 PG16 在新建并清理的本地集群上使用真实 LOGIN/PID/权限/锁、数据库墙钟及触发器回滚；调度索引同时检查实际 ORM predicate、幂等 OID、漂移整笔回滚和更低超时。原生审核包含 cart/relation/child；scheduler 的 stockFixture 没有 cart/relation 表，未声称原生验证这两表不变。未运行真实 Checkout 并发，也未验证生产 Hyperdrive。

workerd 覆盖分钟 cron 分流及根/scan/work 的真实 Queue 分发、失败 retry 和成功 ack；其中 SQL service 是 mock，SQL 语义证据来自普通/原生数据库套件，不能称它为 workerd→真实PG端到端。

浏览器使用已安装 Browser 插件的 cua_repl、真实 Admin/Vue/ElementPlus/Axios 与仅回环合成 HTTP/WS。桌面1280×720和窄屏390×844，走通定时输入、价格确认、模拟保存后500、禁止重复提交、后续读取人工确认、新强制下架原因和列表/计数刷新。窄屏完整核验恢复后的新下架输入与提交，未声称重复走完整移动审核链。初始登录跳到 Dashboard 时合成 home/header 缺 sales 导致控制台错误，记录保留；独立直接商品标签无 warn/error。不是生产 API 或真实数据库浏览器验收。临时服务/标签已清理，截图和原始浏览器脚本留 `/tmp/cinashop-moderation-qa`，账本只记录引用与散列，不提交个人浏览器数据。

全局 `MIGRATION_CHECKLIST.md` 保持404项/249已勾选/155待办，`MIGRATION_AUDIT.md` 保持88项/50已勾选/38待办。未顺便解决 `/api/get_script` 的注册/退役冲突，也未将本批局部迁移升级为全局完成。
