# 分销等级与等级任务管理合同

2026-10-01。本批承接旧 `/admin/setting/membership_level/index` 的等级目录及其任务管理，不与普通会员等级 `system_user_level` 混用。新 Admin 页面为 `/setting/distributor-levels`、`/setting/distributor-levels/tasks/:levelId?`，任务页等级参数可选，未选择时先使用独立父选择器；数据源为 `agent_level`、`agent_level_task`、`agent_level_task_record`。这是未发布的本地实现；生产角色升级、历史数据复核、部署和真实用户验收尚未完成。本文件说明实际合同，不代替最终冻结验收记录，也不把已编写的测试称为已通过。

## 完整管理字段与读取

等级编辑完整提交七个字段：

| 字段 | 写入边界 |
| --- | --- |
| `name` | 非空文字，原文最多50个 Unicode code points，校验后 trim |
| `grade` | 数值类型整数1至32767；未软删除等级中唯一 |
| `image` | 非空稳定图片引用，原文最多255个 code points，校验后 trim |
| `color` | 原文最多32个 code points；HEX 3/4/6/8位，或安全 `rgb` / `rgba` |
| `one_brokerage` | 数值类型整数0至1000，表示一级佣金比例上浮百分比 |
| `two_brokerage` | 数值类型整数0至1000，且不大于一级上浮值 |
| `status` | 数值类型整数0或1 |

`color` 保留大小写和内部合法空格，不转换成另一种颜色表达。RGB 三个通道为0至255的整数；alpha 为0至1，最多三位小数，允许 `0.5`，不允许 `.5`。文字先拒绝控制字符和孤立代理码点，再 trim；长度按 trim 前的原文计算。等级没有单独的排序字段，列表保持旧 `grade ASC,id DESC`。

任务编辑完整提交 `level_id,name,type,number,desc,sort,status`。已有任务不能改所属等级；名称最多50个 code points，说明最多255个，可为空并允许 LF、CR、tab，其余 C0/DEL 控制字符拒绝。`number` 为数值类型正整数，最大2147483647；金额任务的单位为元，不接受小数目标。`sort` 为0至32767整数，列表按 `sort DESC,id DESC`。任务类型完整保留旧五项：

| `type` | 条件 | 单位 |
| --- | --- | --- |
| 1 | 邀请好友成为下级 | 人 |
| 2 | 自身消费金额 | 元 |
| 3 | 自身消费单数 | 单 |
| 4 | 下级消费金额 | 元 |
| 5 | 下级消费单数 | 单 |

任务 DTO 返回历史 `is_must`，它只读，新建写0。所有开启任务均须达到要求；没有新增“任一任务完成即可”的 OR 算法。任何持久任务记录都使该任务 `completed=true`，包括旧 `status=0` 和重复记录；已完成任务不能修改 `type` 或 `number`，仍可改名称、说明、排序、状态。隐藏不删除完成证据。

启用等级、修改级别、创建任务、启用任务及修改任务条件时，按完整目录验证未删除级别/同父任务类型唯一，以及开启父等级、开启任务的同类要求随级别严格递增。隐藏父等级不参与有效任务的递增比较。历史重复级别、重复类型、无效字段、孤儿任务和配置异常通过 `issues` 明示，不自动种数据、修阈值或重写旧记录。部分导入异常会阻止新建或启用，不承诺所有漂移都能经当前编辑器修复。

查询仅接受 `page,limit,keyword,status`，任务列表另要求正整数 `level_id`。页默认1，条数默认20、最多100，偏移最多100000；关键词最多50个 code points，匹配名称的不区分大小写字面包含，百分号和下划线没有 SQL 通配语义。未知、重复参数拒绝。等级和任务列表只返回未删除条目，可筛显示/隐藏状态；GET 不写数据库、不自动初始化目录。

等级列表为 `{list,count,page,limit,revision,config,issues}`；每条包括七个字段及 `id,is_del,add_time,task_count,one_brokerage_ratio,two_brokerage_ratio,revision,image_preview,issues`。`config={one_ratio,two_ratio,enabled}`，比例为两位小数字符串或明确的 `null`，开关为 boolean 或 `null`。三个配置键分别是 `store_brokerage_ratio,store_brokerage_two,brokerage_func_status`，仅取全局 `is_store=0` 的 `sort DESC,id DESC` 第一条；全部重复配置行仍参与版本计算。管理页不修改这些基础配置。

任务列表为 `{parent,list,count,page,limit,revision,task_types,issues}`。父等级只投影 `{id,name,grade,status,revision}`；条目另外返回 `is_must,type_name,completed,issues`。任务专用父选择器分页返回同样的最小父投影，不通过任务权限读取完整等级编辑资料。详情分别为 `{info,config,issues}`、`{info,parent,task_types,issues}`。

图片新值可用规范 `/api/assets/:id`、安全 HTTPS 绝对地址或站内路径。规范素材须通过现有平台商品图片策略验证平台归属、文件类型、目录及 MIME 可用性；写事务对真实附件行取共享锁并重新验证。拒绝供应商私图、非图片、附带查询或fragment的规范素材地址、带六个已知签名参数的外部HTTPS图片，以及编码/路径归一化后绕入素材命名空间的别名。六参数为 `sig,signature,token,expires,x-amz-signature,x-goog-signature`，不声称识别所有第三方签名机制。历史安全外部图片不发 provider 请求。保存值保持稳定引用，`image_preview` 由既有签名媒体读取链生成，不能把预览签名存回等级。

## 路由与独立权限

下表路径均同时注册在 `/adminapi`、`/api/admin`，回执和 `parents` 静态路径先于 `:id`。管理响应均为 `private, no-store`。

| 方法 | 等级 | 任务 | 权限 |
| --- | --- | --- | --- |
| GET | `/agent/levels` | `/agent/level-tasks?level_id=:id` | 各自 `.view` |
| GET | `/agent/levels/:id` | `/agent/level-tasks/:id` | 各自 `.view` |
| POST | `/agent/levels` | `/agent/level-tasks` | 各自 `.manage` |
| PUT | `/agent/levels/:id` | `/agent/level-tasks/:id` | 各自 `.manage` |
| PATCH | `/agent/levels/:id/status` | `/agent/level-tasks/:id/status` | 各自 `.manage` |
| DELETE | `/agent/levels/:id` | `/agent/level-tasks/:id` | 各自 `.manage` |
| GET | `/agent/levels/request/:requestId` | `/agent/level-tasks/request/:requestId` | 各自 `.view` |
| GET | — | `/agent/level-tasks/parents` | `agent_level_task.view` |

权限分别为 `agent_level.view/manage`、`agent_level_task.view/manage`，管理包含本域查看。旧972菜单只有 `unique_auth` 与 `menu_path` 同时精确为 `/admin/setting/membership_level/index` 才提供两个查看权限；错误配对或仅泛分销、会员、配置权限不能提供新域管理。旧动作菜单仍按精确方法/路径映射本域管理，不借父菜单授权写入。

旧 `/agent/level` 与 `/agent/level_task` 的 list/create/form/update/delete/set_status 别名分别委托到同一版本化控制器。旧任务列表的 `id` 仅改名为 `level_id`；同时提交两种父参数或重复参数拒绝。旧状态路径的0/1值必须与 JSON body 的 `status` 一致。旧未携带 UUID/revision 的保存不能绕过新合同；旧管理 service 的公开非版本化写入口已移除。

## 版本、请求回执与删除历史

每次写入使用当前完整目录 `revision`，而非仅本页、本条或当前父等级版本。摘要包含所有等级和任务的完整字段及 `xmin`，也包括隐藏、已删除、离页条目，以及上述三个全局基础配置的全部行及 `xmin`。任务完成记录不进入目录摘要，写事务在同一目录锁下重新查完成证据。因此新增完成记录仍会阻止改已完成阈值，不能把“版本没有变化”解释为允许覆盖证据。等级与任务的所有 row/parent revision 使用同一目录摘要。

读事务为有界 `REPEATABLE READ READ ONLY`。写事务在第一条读取前明确 `READ COMMITTED`，局部 statement/lock/idle 期限为5/2/5秒并保持更严格的调用方期限；随后取得目录排他 advisory `(731624,0)`，先查成功 journal，再重新读取完整目录验证 CAS，取相关父/条目行锁及附件共享锁，最后执行业务 DML 和回执。运行时服务不取目录表级 SRE 锁，也不在管理事务中锁用户。

写 body 最多16KiB，须为 `application/json`，递归重复 JSON 键及未知字段拒绝。完整新增/编辑 body 为 `{request_id,revision,values}`，状态为 `{request_id,revision,status}`，删除为 `{request_id,revision}`。`request_id` 为小写 UUID，revision 为小写64位 SHA256。actor 从真实登录身份取，不接受 body 身份字段。

回执 `{operation,id,request_id,payload_hash}` 与业务写同事务插入 `system_log`，固定 type 为 `distributor_catalog`。UUID 在两个资源间共用，以首个成功 actor 及完整意图绑定；重放先于 CAS，相同成功请求在后来编辑或删除后仍返回原回执。不同 actor、资源、操作、目标、版本或内容的 UUID 冲突拒绝；损坏/重复 journal 不伪装成未提交。GET 回执仅给本 actor、本资源，实际不存在返回 actual HTTP404。

`payload_hash=SHA256(UTF8(JSON.stringify(canonical)))`；UUID 不参与摘要，固定键顺序为：

```text
level:create/update: {operation,id,revision,values:{name,grade,image,color,one_brokerage,two_brokerage,status}}
task:create/update:  {operation,id,revision,values:{level_id,name,type,number,desc,sort,status}}
status:              {operation,id,revision,status}
delete:              {operation,id,revision}
```

`operation` 是 `level:create|update|status|delete` 或 `task:create|update|status|delete`，新增规范 id 为0，成功回执为实际新 id；删除回执保留原 id。大小写、内部颜色空格、Unicode组合序列不会额外规范化；前后端使用同样的 trim 和字段校验后摘要。

仅在无成功 journal、所有业务 DML 之前 CAS 不匹配时，`DistributorLevelStaleVersion` 经 `withTx` 成功回滚后给 actual HTTP409、body status409，以及 `{code:'DISTRIBUTOR_LEVEL_STALE_VERSION',operation,request_id,payload_hash}`。前端只有 HTTP、业务状态、固定码及操作/UUID/hash 都匹配原 pending 才可解除这笔确定过期请求。

另一个窄确定失败为 `DistributorLevelRejected`：无成功 journal、CAS已匹配后，仅在任何业务 DML 之前的准备阶段把确切领域校验拒绝转换为此类，完成回滚后返回 actual HTTP400、body status400及 `{code:'DISTRIBUTOR_LEVEL_REJECTED',operation,request_id,payload_hash}`。重复级别/类型、非递增图、已完成阈值变更、不可用平台图片均在此阶段拒绝。前端只在该 HTTP/body/code/操作/UUID/hash 与原pending全部匹配时解除pending，保留完整编辑内容，由用户重新读取版本并再次确认。解析/字段错误、NotFound、SQL异常、UUID冲突、损坏journal及写入/最终回执阶段失败都不产生这个proof；普通400或HTTP200中的业务错误仍不能证明未提交。

前端在提交前把 actor、资源操作、目标、完整原 body、UUID、摘要写入同 actor 跨等级/任务页面共用的 sessionStorage pending。未知结果阻止新写；读取回执不自动重发。回执实际404才允许显式重试同一原请求；换号、token和权限变化会使旧异步结果失效。该恢复范围是同浏览器标签的 sessionStorage，不保证清理存储或关闭标签后的恢复。

等级删除只设置 `is_del=1`，并同事务软删除所属未删除任务。任务删除亦为软删除；用户已授予 `agent_level`、历史任务记录、佣金和订单均保留，不级联删除或自动降级。目录或父选择器 `issues` 的 `orphan_task:<id>` 可提供待退役孤儿ID。只有明确 task delete 在匹配全目录版本且锁定当前任务后，可跳过缺失/已删除父断言，软删除原任务并写同事务回执；孤儿更新、隐藏、启用、改归属仍拒绝，不能借退役例外新建或移动任务。隐藏/删除等级不再参与新等级佣金上浮，但不会抹去已授予级别的历史事实。

## 实际升级与佣金消费

`AgentLevelTaskService` 在独立事务内用 `(731624,0)` 共享目录锁，再按去重 uid 升序取得用户 advisory `(731628,uid)`、用户行 `FOR UPDATE NOWAIT`，重验推广关系并原子写等级和完成记录。新完成记录使用表模型默认 `status=0`，与旧 PHP 历史语义一致。目录读取限等级10000、开启任务50000，超过时明确拒绝；这些是完整读取保护，页面没有10条业务上限。

升级开关/自购/绑定方式/期限直接读取全局 SQL，仍按 `sort DESC,id DESC` 胜出。自购替换一级 recipient，二级仍沿真实关系和有效期；实际请求用户也参与评估。任务仅统计未删除、未系统删除、`paid=1,pid=0,refund_status in(0,3)` 的原单；下级消费沿真实用户关系查询。未完成的开启历史任务若 type/number 无效，明确抛领域错误并回滚整笔多用户评估；已完成的 status0/重复证据及已赠予级别不因此被降级。已完成历史记录保持有效；所有开启要求达到后按级别向上授予，不自动降级，也不因隐藏/软删除历史等级清空用户赋值。

密码、手机号登录、注册及真实推广关系 bind 在原事务提交后调用 `evaluateAgentLevelsAfterRegistration`；`loginByVerifiedUid` 在验证用户、颁发 token 并更新登录信息后调用，同样覆盖经服务端验证 uid 的二维码入口。注册/关系已提交后的升级失败记录不含用户凭据的 operational event，不撤回已完成的注册或绑定；之后登录及认证的等级/任务读取会再次评估。微信社会登录只有合法 spread 进入实际 bind 后才触发此链，不声称所有 provider 登录、无 spread 登录或外部账号流程都直接执行升级。

持久 `order.paid` outbox 在 claim 提交后、财务事务开始前调用真实升级。先从数据库验证原单 id、orderNo、`paid=1,pid=0`，按实际原单 uid 评估；失败走原 event 的 durable FAILED/retry，不能先把 event 标 COMPLETED。已完成 paid event 的重复消息也可以补评估等级，但不重复原财务 DML。等级升级事务与后续财务事务分开，不宣称两者共享一个 commit；等级成功后若财务失败，既有 durable event 继续重试财务，已有任务记录保持幂等。

认证客户端继续消费 `v2/agent/level_list` 和 `v2/agent/level_task_list`，保留旧字段、当前/下一等级、任务单位、完成状态、金额两位小数模板和进度平均截断。等级图片走真实媒体投影，前端不把未知 CSS 或危险图片直接渲染。

真实 checkout 的佣金权威快照读取推广员与已授予等级；仅 `status=1,is_del=0` 的等级使用上浮。Admin返回的示例比例为基础比例乘 `(100+uplift)/100`，按两位比例单位截断；不是每件商品的现金佣金承诺。固定 SKU 佣金、自购、推广员资格、事业部及原有分佣规则继续由实际 checkout 消费，不能把页面显示的比例代替真实订单金额。

## 角色前推与本地证据边界

旧冻结角色阶段为 `pre-agent-levels`，新安装 commissioning 为固定 `isolated-business-runtime-v5-agent-levels`。独立 `runAgentLevelRuntimeUpgrade` 只接受精确旧阶段或已达到 current 的幂等重放，验证实际 PG16 maintenance/app/Admin 身份及三表/索引/约束/序列目录；持固定维护 gate、目录排他锁及仅维护端表锁后，在一个事务内安装固定 invoker 保护并前推 current。它不修历史业务行、添加唯一约束、创建角色/密码、重置序列或由HTTP自动迁移。

新增 Admin `agent_level` 权限仅 SELECT/INSERT、USAGE序列与 `UPDATE(id,name,image,color,one_brokerage,two_brokerage,grade,status,is_del)`；没有等级表级 UPDATE、硬 DELETE、创建时间修改或 DDL。app仍仅 SELECT及真实行锁所需 `UPDATE(id)`，语义 UPDATE 由固定行保护拒绝。任务与任务记录沿现有运行时 ACL，不因测试报错扩大权限。

三表的 runtime BEFORE STATEMENT invoker trigger 让等级/任务 DML 先取目录排他锁，完成记录 DML先取共享锁，保护未配合 service 的 app/Admin原始SQL幻影。等级行 guard保持id/add_time不变、拒硬删除和app语义更新。函数不提升调用者权限。此保护针对精确 app/Admin 身份；不声称任意维护超级用户或绕过触发器的导入同时受同一协议约束。

专项验证入口如下。最终运行日志、类型、构建、浏览器和冻结 SHA由主任务统一收口；修后待运行的用例不计通过，不累计重复执行。

| 入口 | 实际证明范围 |
| --- | --- |
| `test/admin-distributor-level.test.ts` | 规范输入、摘要、完整图校验和精确比例计算 |
| `test/admin-distributor-level-postgres.test.ts` | 真实11表 production ACL intersection + 同一三表guard；完整CRUD/软删保留、全域CAS、UUID竞争、日志回滚、原始runtime DML锁、附件共享锁与局部期限 |
| `test/admin-distributor-level-http.test.ts` | 真实 createApp、Admin JWT、双前缀、精确菜单授权/反例、task-only父投影、旧别名收紧、actual409与原行/日志不变；无provider fetch |
| `test/runtime-agent-level-upgrade.test.ts` | 完整真实迁移及固定生产 commissioning、精确旧阶段前推、角色和保护目录；不能用有限切片替代 |
| `test/agent-level-consumers.test.ts` / `-postgres.test.ts` | 实际升级计划、旧字段/进度语义；原生使用真实10表 ORM和生产profile交集，实际注册/bind及独立LOGIN锁，不是完整282表验收 |
| `test/agent-level-events-postgres.test.ts` | 完整282表真实迁移、生产 app/Admin commissioning及真实checkout/outbox/等级/供应商账/payCount/status；重复消息、目录故障和真实NOWAIT失败后修复重试、paid-root身份漂移、下一checkout上浮 |
| Admin / Uniapp专项前端测试 | 严格DTO、完整表单、跨页actor pending、回执proof及认证账号投影；浏览器合成API不代替上述真实SQL身份 |

付款夹具仅维护端合成支付标记，并同事务调用真实 enqueue helper；没有替换等级或财务函数。它不证明支付 provider HTTP、实际 Queue投递、真实R2或生产 Hyperdrive。有限切片的production ACL交集不能称为全current角色验收；完整commissioning用例与有限切片分别计账。

## 当前验证状态

最终专项原生59/59通过：完整角色升级11项、管理SQL16项、真实双前缀HTTP10项、消费者18项、完整282表付款事件4项。真实授权历史回归23/23及业务回归30/30也已通过。此前执行发现的付款夹具金额期望已据实际来源修正；早期失败和重复运行不累计为新增通过项。

付款夹具真实商品原价合计50.00，积分抵扣1.00后商品净额49.00；固定运费3.00按两件计6.00，含运费订单payPrice为55.00。初始佣金依原有商品基数为5.00，下一checkout已验证真实升级上浮到10.00。供货快照为2.50×2和20.00×1，供货额25.00加运费6.00得到供应商待结算流水31.00；`supplier_transactions` 没有供应商结算number列，它保留买家payPrice55.00、totalPrice50.00和payPostage6.00。付款四项已完整通过这些订单/商品/双账本的精确金额和identity关系，以及支付次数、任务记录、故障回滚与重复幂等断言，未改生产金融算法；升级与后续财务仍为两个独立事务。

历史页面46/46已通过，其中7项纯解码、39项真实SQL/HTTP。最终11组选定日志共316项唯一通过：151真实SQL/HTTP、165纯输入/静态/既有回归，21未选中排除；浏览器不计入该合计。Worker两套类型、Admin与Uniapp类型以及两端构建均通过，Uniapp使用与当前锁一致的既有工具链，临时目录连接已恢复，没有新增安装或修改锁。

最终实际dist桌面1440×1000和手机390×844浏览器39/39通过，六项基础检查包含于第一组；前序33/39、38/39及各自完整执行脚本保留，不累计。锁定UniH5工具链的一条Vue Router弃用警告保留原始记录，未知控制台错误/警告、pageError与路由错误均为0。root已复核桌面表格、手机七字段滚动表单、任务页及普通/已赠等级；pending截图保留关闭动画中间帧，严格禁止二次写入的用例另等待编辑框隐藏后断言。

13个本批自有PG data目录已清理，三轮自有Chrome与静态服务关闭；含前批端口共28个实际监听核对为空。生产角色、Hyperdrive、真实支付/Queue/provider、规模和真机发布仍未验收。最终全部数字以[冻结manifest](../audit/admin-distributor-levels-acceptance-20261001.json)为准，前批PC305项入批baseline及117项原始证据逐项核对，已声明共用文件修改单列。
