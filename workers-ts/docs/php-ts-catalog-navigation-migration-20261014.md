# 主商品目录与旧评价导航 PHP → TypeScript 增量（2026-10-14）

本批补齐主商品列表与八状态计数两条真实旧 GET 接口，将 Admin 商品列表接入服务端总数和状态，并恢复旧商品列表、指定商品评价地址。最终限定回归共有 214 个不同测试定义通过，43 个条件定义全部原生补验；详见 [验证账本](../audit/php-ts-catalog-navigation-migration-20261014.json)。本地候选未发布，整体迁移目标继续开放。

## 真正入口、权限与查询

| 方法／入口 | 目标与合同 |
| --- | --- |
| GET `/adminapi/product/product` | 主目录 `{list,count}`；`product.view`，真实 API 种子 108 |
| GET `/adminapi/product/product/type_header` | `{list}`，八项 `{type,name,count}`；`product.view`，真实种子 192 |
| `/admin/product/product_list` | Vue 跳转 `/product`，保留 query／hash |
| `/admin/product/product_reply/:id?` | Vue 跳转 `/reply`；非空 path ID 优先于 query.product_id，其余 query／hash 保留 |

两个浏览器跳转不计作新增 API。旧行的评价入口把真实商品 ID 传到评价筛选；query 的 `is_reply=0` 保留为有效条件。现代页面明确支持 `is_reply=1`，非法 ID／状态及 type、product_id、is_reply 的重复参数在页面显示错误并停止请求；其他保留 query 不因此成为全局拒绝项。

页面种子 2 的完整 tuple 包括真实 `admin-store-storeProuduct-index`，只授予 product.view。108、192 以及既有选择器 193 均保留真实方法、api_url、菜单路径和 auth；192 的实际路径是 `/adminproduct/product/type_header`。本批另补齐真实安装种子 377／388／399／410／941 的空路径、空 auth 选择器 tuple。复制到任意 ID、改写元数据、把菜单 methods 改为 HEAD、伪造空 tuple 和 579／580 通配均不能获得该 grant；已拥有 product.view 的真实 HTTP HEAD 仍可按 GET 注册返回 200。单条与批量解析有实际测试，opaque fallback 拒绝门禁另有源码复核。评价读取与管理、商品管理仍各自判断。

主目录与上一批 `/product/product/list` 选择器具有不同查询口径。原现代 `/product/list` 仍被运营分组商品选择直接消费，本批保持其 handler，不能据本批证据宣称该独立读取已完全恢复 PHP 主目录合同。

主目录 type 默认 1；源支持空值、-2、-1、0 至 7。八个 header 固定为 1／2／4／5／6／0／-1／-2，名称和顺序分别为销售中、仓库中、已售罄、库存预警、回收站、待审核、审核未通过、强制下架。header 每项自己覆盖传入 type。

未选供应商时主目录使用 pid=0，包括源可读的异常 owner tuple；选 supplier_id 时限制 type=2／relation_id，但不加 pid=0，供应商副本可返回。主目录 store_id 是源读取后删除的无效果参数。header 则优先门店分支并保留 supplier_id，两者同时给出时非分类分支会产生冲突 owner 条件，结果为零。

非空分类数组触发 DAO 独立 count 分支：忽略 pid、关键词、owner、品牌和标签，销售／仓库／全部计数不加 is_verify，已售罄计数使用 is_sold=1 **且**主库存=0；列表已售罄条件是两者 **或**。保留源的列表／计数差异，不能把两者改成一致查询。主目录分类不展开后代；品牌同时要求主 brand_id 和 type=2 relation，商品标签使用 type=3 relation。真实旧完整 artFrom 和 Axios bracket 数组消费已通过实际旧脚本→Axios→App／JWT／SQL 验证。

## DTO、分页与素材边界

状态筛选依据主商品 stock，输出 stock 则汇总该商品所有 type=0 普通 SKU，包括退役行；无 SKU 为 null，branch_stock 为 0，页面显示“—”。收藏、点赞和访客按源统计全部匹配行，不增加用户去重。警戒状态按源 is_show=1／is_del=0／is_verify=1、is_police 和主 stock>0 判断，不另加阈值；-1／-2 不追加源没有的删除条件。

分类名保留本分类，不过滤其 show／del；只拼直接且 is_show=1 的父分类。门店／供应商名称只过滤 is_del，缺失名称仍保留 `门店：`／`供应商：` 前缀。在显式 supplier_id 筛选且返回 type=2 商品的结算价非正数时，源普通 SKU product_id 键覆盖使用无 ORDER 的最后遇到行，不改成 MIN 或 ID 排序；默认主目录中的供应商行不因此回补。无 ORDER 的跨引擎遇行顺序和回补价格未定义，不能宣称 PHP golden 同价。缺少 SKU 时源 PHP 8 的空 min 不成立，TS 显式返回 503；合法供应商副本夹具已补齐普通 SKU。

先按源 count<=limit 且 page!=1 执行第一页回退，再判断有效 page 和 limit 同时为真才分页；否则完整读取，声明 10000 行容量，超过明确 503。page 缺失或 0 也可能先被回退成 1（例如分类计数为 0、列表有匹配行且 limit=1），不能一概视为完整读取。正数 limit 按源上限压到 100。TS 另声明 page 上限 1000000、query 16 KiB／320 keys、数组最多 100 项、canonical 数字及未知／冲突参数拒绝；这些容量和解析边界属于目标实现约束，不冒充 PHP 原有限制。count／SUM 转成精确安全整数，DECIMAL 保持字符串，复杂 JSON getter 的关联对象形状保留。负库存只属于目标 PostgreSQL signed 状态的对账展示；PHP 原 stock 为 unsigned，不能把负数说成合法源数据。未执行完整 PHP PDO／JSON 序列化，因此不宣称线上 PHP 数字传输类型已逐字一致。

非私有图片原值保留；canonical R2 引用按当前商品 owner／发布元数据签名，异常 owner 私有引用置空。本地 HTTP 验证真实资产 HMAC、SQL 元数据和撤销，R2 get 字节由明确 stub 提供；没有真实 R2、外部取图或 provider 证明。

## 读取事务、前端与实际修复

每个 endpoint 请求在各自 REPEATABLE READ READ ONLY 事务中保持该响应的查询快照一致；并行的 list 与 header 请求不共享快照。中央管理员类型、状态、密码版本、真实角色历史与能力按请求事务的起始快照准入；结束前使用数据库墙钟检查 JWT 到期，不承诺捕获此后提交的撤权或密码变更。语句 5 秒、锁 2 秒、事务空闲 5 秒。真实锁冲突 SQLSTATE 有重试错误，运行权限或查询超时明确失败。仅 SELECT 的原生 LOGIN 成功执行读取并被数据库拒绝 DML、审计 INSERT 和序列使用；隔离夹具全部声明业务表／列快照不变。没有新增 DML、审计写入、schema／migration 或库存写接口。

初轮完整合同测试找出 Drizzle 在四个相关子查询投影中去掉外表 id 限定的真实生产错误：SKU／收藏／点赞／访客实际关联到内表 id。现在使用固定 `"store_product"."id"` 标识，列表／count WHERE 原本正确。实际生产表达式生成的前后 SQL 留存，正确 DTO 断言保持；127 项最终原生测试另证明实际执行。

Admin 使用真实总数分页，保留页面切换时已知 count，避免 Element Plus 把第二页误夹回第一页；列表和 header 分开处理错误，状态计数失败不会丢弃已成功的商品行。八状态、type=0、NULL 库存和旧评价导航均由真实 Vue Router／SFC／Axios 验证。商品只读角色可以读取；管理操作仅在独立 product.manage 与相应状态允许时出现。

读取、批量候选和删除确认捕获会话、权限、列表轮次、状态与具体 ID；旧 await 不能重开弹窗或删除新会话的旧商品。批量提交另有独立执行归属，切换会话时失效并重置当前 busy，旧 finally 不能清掉新提交状态，同一 pending 操作不能重复发送。实际模板和真实 Axios 的双会话 gated 测试验证旧结果无 toast／刷新／关闭新 dialog，新操作完成后正常释放并刷新。该修复只补齐既有操作的 UI 生命周期，不把既有写入当成本批新迁移的库存能力。

## 最终限定验证与开放项

| 最终事实 | 结果 |
| --- | --- |
| 16 个完整相关普通文件 | 171 通过，43 条件跳过，0 失败 |
| 9 个完整原生 PostgreSQL 文件 | 127 通过，0 跳过／失败 |
| 逐定义去重 | 重合 84 只计一次，共 214；全部条件定义补验 |
| Worker 两套完整类型 | 标准／runtime，8192 MiB，终态退出 0 |
| Admin／Supplier | 各自完整类型和 Vite build，终态退出 0 |

相关范围是本批目录、共享 Admin 权限、既有评价／自评、商品前端与独立运营分组消费者；这是本轮完整文件的限定矩阵，不是全库 CI。八项通过共享串行 wrapper 执行，Vitest 单 worker；全部 startedAt 位于本轮最终冻结之后。[逐定义回执](../audit/catalog-20261014/verification-summary.json)区分普通、原生、重合和循环，不能把重跑累加。声明八目录完整枚举及显式配置／包锁／消费者输入共 3365 个，摘要 `1dba80872bd77d46df79bb7041e2a8fed11b948d49d86309c2cb69b58dd3c5fd`，最终前后相同；环境值及已安装依赖字节不在该声明图内。

[真实 Chrome QA 报告](/tmp/cinashop-catalog-qa/QA.md)记录实际 Vue／Element Plus 的 20 个交互流程、25 个状态／截图；1360×900 与 390×844 两视口，14 个实际应用源前后摘要相同，console／page error、未 mock API 和外部传输请求均为 0。root 另目检 7 张代表图，并核对 200 件原始 artifact 哈希。真实页面使用标准本地登录状态，所有 API 和身份为明确合成 transport，不能作为后端 SQL、JWT／HMAC、PHP、R2 或生产证据。移动端表格内部横向滚动可到评价动作，文档无横向溢出。Browser 插件不可用，使用已安装 Playwright／Chrome；建议安装 Browser 插件以便后续应用内验证。四次历史 attempt 保留，harness 的 trim、既有英文 OK 按钮定位和 POST 计数修正分别记录；最终完整重跑通过。

初轮四个失败、类型检查失败和所有中间实终状态保留：负库存测试边界修正、供应商合法夹具 SKU 补齐与真实 SQL 关联修复分别记录；类型修正只去掉未用 fixture 参数／systemRole 导入并为原生观察 SQL 行添加准确类型，SQL 与断言不变。独立源码审查发现的 options／confirm 和旧 finally 生命周期问题均有分阶段输入摘要和最终行为证明。原自评报告、账本、冻结和独立交付记录保留其当时历史原貌，本轮授权修改由新的冻结和差异文件承接。

全部自有原生集群 fixtures=0，独立 pg_ctl 确认停止且无 postmaster.pid；浏览器自有 Vite／Chrome 关闭另有回执。未重启旧失败集群或因观察超时重跑。迁移清单仍 404／249 完成／155 开放，审计清单仍 88／50 完成／38 开放，全部复选行和父项保持。

PHP 解释器、编码 BaseController 和完整 PHP 应用未运行；本地 Node 的 App／JWT／SQL 证据不等于新 Workers、Hyperdrive 或生产部署。全局 `/api/get_script` 注册／退役决定与活消费者冲突仍独立开放；全库 CI、真实账号／设备及生产验收继续开放。下一批库存 attrs／saveStocks 只读调查不计完成。未提交、推送、创建 PR、改生产数据、发布或下线 PHP。
