# 商品评价与回复线程 PHP → TypeScript 增量（2026-10-14）

本批新增 7 条真实旧 Admin 评价管理接口，并替换 6 条已存在现代路径的 handler。商品评价页面接入筛选、计数分页、平台一级回复、用户评论线程、二级回复与删除，保留已有 TS 隐藏／显示功能。本地候选完成验证：393 项不同测试定义通过，86 项条件测试全部在原生 PostgreSQL 补验；Worker 两套完整类型及 Admin／Supplier 类型、构建退出 0。整体迁移目标与父 checkbox 继续开放，本批未发布。

## 路径与来源

| 方法 | `/adminapi` 下新增旧路径 | 行为 |
| --- | --- | --- |
| GET | `/product/reply` | `{list,count}`、评价筛选与分页 |
| PUT | `/product/reply/set_reply/:id` | 创建／更新平台一级回复 |
| DELETE | `/product/reply/:id` | 评价软删除 |
| GET | `/product/reply/comment/:id` | 用户根评论及单个直属回复 |
| GET | `/product/reply/get_reply/:id` | 平台根回复或 `{content:""}` |
| POST | `/product/reply/save_comment/:replyId/:id` | 真实用户根评论下的平台回复 |
| DELETE | `/product/reply/delete_comment/:id` | 删除确定 ID 及全部直属孩子 |

现代 `/adminapi/reply/{list,status/:id,del/:id}` 与 `/api/admin/reply/{list,status/:id,del/:id}` 六条路径保留 URL，替换此前通用 AdminCrud handler；未计为新增旧合同。虚拟评价的表单和创建两条旧接口仍开放，不混入本批完成数量。

PHP 权威来自 `route/admin.php`、`StoreProductReply` controller、主服务／评论服务、连接商品的 DAO 与 model、安装权限种子和旧 SPA 实际 API／页面／删除弹窗。时间与配置另核对 `ModelTrait`、ThinkORM 时间构造、`config/app.php`、`SystemConfigServices`、`UserServices` 及可读 `time_tran`；来源摘要见 [PHP 输入](../audit/reply-20261014/php-sources.json)。

## 中央管理、原始证据与 DTO

PHP controller 写入的筛选 `type=0/relation_id=0` 在连接 DAO 中因真值判断不产生 owner 条件，实际 Admin 列表跨平台、门店与供应商。本批保留中央 Admin 的全有效 owner 评价管理，不把当前商品 owner 或上下架状态改为其授权边界；LEFT JOIN 的历史孤儿评价仍可读取、回复或软删。Supplier 接口继续按供应商隔离，中央权限不能借其端点取得其他供应商身份。

平台一级与二级回复单独写 `type=0,relation_id=0,uid=0` 评论行，不覆盖客户评价正文、商家响应字段、商品、订单或 SKU 快照。平台回复平台评价才把 `is_reply` 置 1；回复 Supplier／门店评价保持它们原来的回复状态，真实 Supplier 回复与平台回复可以并存。新评论 `create_time` 映射到 TS `add_time`，新增 `update_time=0`，编辑才更新。评价仅修改 `is_del`；评论物理删除目标及全部直属孩子，保留更深后代和点赞记录。深层、先前非递归删除留下的孤儿、重复平台根或已软删评价下的确定评论 ID 可清理；删除并不自动生成新父链。

旧列表使用商品名／关键词／评价 ID／商品 ID、用户昵称、回复状态、时间和分页筛选，保留 PHP 原评价字段与图片 JSON 解码结果，包括合法非数组 JSON。图片按源模型 `json_decode(..., true)` 与响应默认 JSON 编码的关联数组规则回显：空对象成为空数组，原始顺序为连续整数键的对象成为数组，逆序、稀疏或非数字键保留对象；嵌套、转义键与重复键覆盖后的原始插入顺序保留。非法 JSON、孤立代理字符或超出 PHP 默认深度的值回显 null；仍保留的非有限数或超过 JS 精确整数范围的整数明确返回 503，避免历史值被无声改写。此边界依据可读 PHP／ThinkORM 源码与 [PHP JSON 源码](https://github.com/php/php-src/blob/PHP-8.2/ext/json/json_parser.y) 核对，本机未运行 PHP 解释器。

评分 `score` 为三项评分均值向下取整的字符串。现代列表继续返回 camelCase 数组和数组图片，该分支未因旧图片回显修正而改变；旧列表新增已有 TS `status` 审核扩展供现代页面隐藏／显示，该列不是 PHP 原评价列。隐藏／显示只接受数值 0／1，并拒绝不存在或已软删目标。现代列表的有效目标筛选比此前通用全表读取严格，不声称原通用 handler 的全部行为完全相同。

评论与根回复精确投影 PHP 十列：`id/type/relation_id/uid/praise/content/pid/reply_id/create_time/update_time`；读取线程再带用户、单个直属孩子、`productRelation` 和 `is_praise`。真实用户评论在 Supplier 评价下也可能使用默认 0／0 tuple，不能要求它继承 Supplier owner；保存二级回复严格校验评价与真实用户根评论对应。重复或污染根／多个直属回复在读取或新增回复时明确拒绝，不任取一行冒充确定的 PHP hasOne 结果；按确定 ID 删除仍支持清理全部直属孩子。

根用户昵称采用现有合理匿名规则，等级使用 PHP 的数字 grade，付费会员状态按配置和到期时间计算；管理员子回复用解码后的站点名和头像。PHP `anonymity` 实现未取得可执行证明，不能声称完整匿名算法运行时等同。

回复最多 1000 个 Unicode 码点，允许正常换行，拒绝非法控制字符与孤立代理字符；正文上限 64 KiB。旧 `set_reply` 接受字符串 `"0"`，`save_comment` 保留 PHP 对该字符串的拒绝。未知或重复查询、非法路径 ID、未知正文／归属字段拒绝。分页最大 100 条；写入核验与完整根回复读取的线程上限为 2000，超限明确拒绝，不宣称无容量边界。

旧保存消息分别为 `回复成功!`、`保存成功`，删除为 `删除成功!`／`删除成功`，省略 `data`。原保存 caller 只传消息，可读 Json 默认省略 null；编码的 BaseController 转发未运行。实际旧 page `del → modalSure → tableDelApi` 的 Axios 正文为零字节，另兼容唯一 `{ids:""}`；现代删除仅接受空正文。

## 时间、锁与完整回执

日期投影、显式日期解析及命名范围采用 IANA `Asia/Shanghai`，包括 1988 年夏令时。PHP 的解析后 epoch 0 真值边界保留：零起端为开放上界、零止端为开放下界、双零不筛选。开放止端为 `< end+86400`；完整范围保留包含端点与源代码的秒偏移。命名范围按本地日历计算且惰性求值，相对天数进入历史跳时时按 [PHP timelib 源码](https://raw.githubusercontent.com/php/php-src/PHP-8.2/ext/date/lib/tm2unixtime.c) 推导的前跳规范化处理；显式不存在墙钟时间拒绝。本机未运行 PHP 解释器或完整旧应用。

`reply.view/manage` 在旧路径与现代路径统一。页面 6 仅以安装种子的完整页面 tuple 授予读取；188／189／190 仅匹配各自原始 API、方法、菜单路径和空 auth。单条与批量权限 SQL 白名单一致；复制、改写种子、通配 580 或仅有 `product.manage` 不能获得评价管理能力。

读取在 REPEATABLE READ／READ ONLY 事务中复核平台 Admin、密码版本、角色历史和读取能力。写入先持管理员权限 barrier，再复核 `reply.manage`，随后父评价 `FOR UPDATE`、评论 ID 升序，末尾复核完整管理员与当前权限并以数据库时钟检查会话到期。语句 5 秒、锁等待 2 秒，事务内无外部请求。

公开评论点赞原 JOIN 锁可能按执行计划先锁孩子；本批改为定位父评价、先锁父、再锁且复核评论。新服务与真实公开评论、点赞和 Supplier 回复围绕同一父评价行协调，未发明与其他消费者无关的 advisory fence；订单评价创建的 46301 namespace 继续只用于 order ID。

业务 DML 使用完整 RETURNING、业务回读，并在写审计后重新核对目标评价及整个已捕获线程。删除还检查全部目标 ID 与直属 pid 在任何评价下均不存在，以阻止跨父线程重建绕过核验。日志核验当前 schema 全部 11 个非 ID 字段及正数 ID；店铺／商户 ID 明确为 0，Admin 名称／IP 明确为空，保持现有默认值，不冒充真实身份信息。审计不保存评价或回复正文。该证明针对捕获的目标业务状态，不声称检测任意触发器对全库其他数据的改写。

## 前端与验证状态

实际旧 API／Axios、实际现代 API／request、完整 App JWT 与 SQL 由本地 HTTP 适配器核验。新页面实际 SFC render 挂载测试执行输入、按钮、分页、回复、删除、会话切换及失效响应；写结果未知时先读取确认，避免重复提交。页面支持商品 ID 查询和筛选，旧商品列表跳转入口及旧浏览器路由别名尚未补齐，不据此宣称完整旧导航等价。

真实 Chrome 发现并修复 Element Plus 的分页钳制问题：加载开始清零 total 会让第二页退回第一页；根列表与评论列表均保留已有计数直到读取完成，回归测试模拟真实钳制与延迟响应。Browser 插件未提供，使用已安装 Playwright 和 Chrome；1360×900、390×844 的真实浏览器布局／交互使用明确的假 API fixture，不能代替 SQL／JWT 证明。截图、完整 QA 与进程清理回执在 [/tmp/cinashop-reply-qa/qa.md](/tmp/cinashop-reply-qa/qa.md)。

最终结果见 [验证账本](../audit/php-ts-reply-migration-20261014.json) 与可逐定义复算的 [计数回执](../audit/reply-20261014/verification-summary.json)。所有重验证均使用上级 AGENTS 要求的共享串行入口，Vitest 单 worker，Worker 类型检查使用 8192 MiB。八项最终验证事实全部终态退出 0，来源如下；没有把它们描述成最后一次单一完整矩阵。

| 验证 | 最终证据与输入范围 |
| --- | --- |
| 普通测试 | 完整 35 文件基线，按完整文件替换 JSON 修正后重跑的 4 文件；307 通过、86 条件跳过，0 失败 |
| 原生 PG16.14 | 完整 19 文件基线，按完整文件替换重跑的 3 文件；231 通过，0 跳过／失败 |
| 去重及补验 | 普通与原生重合 145 定义只计一次，共 393；86 条件定义全部在原生通过。循环探针不另计测试定义 |
| Worker 完整类型 | JSON 修正后重新执行标准及 runtime 两套，均退出 0 |
| Admin 类型与构建 | 完整 vue-tsc 与 Vite build 均退出 0；284 个声明前端输入在后续修正中未变 |
| Supplier 类型与构建 | 完整 vue-tsc 与 Vite build 均退出 0；63 个声明前端输入在后续修正中未变 |

最终冻结 3348 个声明输入，前后 SHA256 为 `9972ef116089f2f1969e4530273281024a8c90c06707b63ba55da957559b6097`。范围包括 Worker src／test／scripts／migrations 与显式配置、双前端 src／public／入口／配置／包与锁文件、四份实际消费评价的 uniapp 文件，以及旧路由权威和退役决定；八个目录完整枚举并复算，未发现漂移。这不是全部构建输入图，环境值与已安装依赖字节不在冻结证明内。JSON 修正仅改变三个既有输入并新增一个工具，3344 个既有输入未变；双前端 347 个声明输入未变，是复用其完整类型、构建和浏览器回执的范围依据。

三个本批自有 PostgreSQL 集群的运行器终态均记录夹具剩余 0，当前独立状态探测均无 postmaster PID、pg_ctl 退出 3；未为了清理证明重启集群。Browser 的自有 Vite／Chrome 进程也已退出，4973 端口关闭。

失败历史完整保留且不计最终通过：首次 SKU 夹具长度不符合真实列宽，随后站点 JSON 解码、测试权限／HTTP 预期与编译夹具目录修正；源码复核发现的 epoch 0、空配置、历史 DST、惰性日期和浏览器分页问题均修复。首次完整原生运行的两项失败来自夹具显式插入用户点赞 ID 后没有推进序列，仅修正自有夹具并完整重跑至 231 通过。最后旧图片 PHP 关联数组回显修正后，保留原完整矩阵，重新运行全部受影响完整文件及两套 Worker 类型检查，未覆盖历史回执。

独立 [源码复核](../audit/reply-20261014/source-independent-review.json) 保留原始输入摘要；最后的 JSON 输出与新增测试变更另经 [交付复核](../audit/reply-20261014/delivery-independent-review.json) 补审。复核不替代实际 SQL、原生并发或浏览器测试。Checklist 仍 404／249 完成／155 开放，Audit 仍 88／50 完成／38 开放，全部复选行保持不变。

全局 `/api/get_script` 注册与退役决定的既有冲突独立开放，本批不放宽全局审计或宣称新的全局覆盖率。未提交、推送、操作生产数据、发布或下线 PHP；迁移父项、虚拟评价两接口、全库 CI、真实账号／设备／生产验收继续开放。
