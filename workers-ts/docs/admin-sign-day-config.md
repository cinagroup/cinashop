# 签到天数组管理合同

2026-09-30。独立 `/marketing/sign-day-config` 承接旧 `/admin/marketing/integral/signIn` 的管理操作。本批状态和验证数字以新日期验收记录为准；这是未发布的本地候选，不是线上角色、历史数据或真实商城签到验收。

## 来源与三个配置域

旧页面真实管理 `system_group.config_name=sign_day_num`，安装组 ID55 不是运行时身份。字段 `day` 是自由文字标签，`sign_num` 是正整数文本；旧校验实际拒绝0，尽管错误文案曾写“≥0”。种子有七条，部分条目还保留 `pp/ll` 图片字段。原页包含列表、动态添加/编辑、显示/隐藏和删除，全部状态按 `sort DESC,id DESC` 排序，七条上限包括隐藏。完整旧源、SQL解析及SHA见[来源记录](admin-marketing-config-legacy-source-20260930.md)。

这组数据没有被当前旧PHP或Worker的实际签到算法读取。实际奖励继续使用 `sign_mode`、基础积分/经验、`system_sign_reward`；本页不写这些表或配置键。现有 `/marketing/sign-rewards` 属于真实连续/累积奖励合同，不能与本页互相冒充完成。旧六色手机图是静态素材，不随本组字段修改；新页以CSS和已存条目提供明确标注的管理预览。主题读取 `system_dise` 的 `color_change/type3` 首ID，颜色顺序蓝、绿、红、粉、橙、金；管理页的本地颜色切换不写商城主题。

另一旧“优惠券配置”路由是无菜单或源码链接的错名通用配置别名，默认读取站点tab26；本轮只定向退役该孤儿别名。真正的注册赠券和普通等级激活赠券分别由现有新人运营、等级激活页面及真实消费者承接。站点tab26的验证码有效期、微信登录昵称头像策略、全场包邮及五个系统安全键仍保留为真实设置差异，不因别名退役关闭。generic配置保存API存在，也不等于专用页面或有效消费者已完成。

## REST与权限

双 `/adminapi`、`/api/admin` 各注册七项，共14条新路由。静态回执路由先于条目详情，全部响应 `private, no-store`。没有注册旧通用group动态表单接口，也不开放任意gid/config_name。

| 方法与路径（省略Admin前缀） | 输入和行为 | 权限 |
| --- | --- | --- |
| GET `/marketing/sign-day-config` | 固定组全量列表、collection revision、主题诊断；GET不初始化 | `sign_day_config.view` |
| GET `/marketing/sign-day-config/:id` | 仅本组详情 `{info:row}` | `sign_day_config.view` |
| POST `/marketing/sign-day-config` | collection revision、固定字段、UUID；明确首次添加可建固定组及首条数据 | `sign_day_config.manage` |
| PUT `/marketing/sign-day-config/:id` | row revision、固定字段、UUID；保留可解析历史附加字段 | `sign_day_config.manage` |
| PATCH `/marketing/sign-day-config/:id/status` | row revision、0/1状态、UUID | `sign_day_config.manage` |
| DELETE `/marketing/sign-day-config/:id` | row revision、UUID；只删除本组条目 | `sign_day_config.manage` |
| GET `/marketing/sign-day-config/receipts/:requestId` | 仅当前actor原子审计回执，不返回原body | `sign_day_config.view` |

管理权限包含查看。旧菜单154只在精确 `unique_auth=marketing-integral-sign` 和 `/admin/marketing/integral/signIn` 配对时映射查看；不能据相同auth、错误路径、订单/优惠券权限或通用组合写权限泛授新域管理。管理由显式新权限授予。两个权限解析入口使用同样规则，实际HTTP从 `adminInfo` 取actor，body的身份字段拒绝。

所有查询参数拒绝。写body最多4096 UTF-8字节，递归重复JSON键拒绝，字段白名单严格。`day` 保留原文及空格，仅以trim检查空白，最多64个Unicode code points，无控制字符；`sign_num` 必须数值类型正整数且不超过2147483647，`sort` 为0到2147483647，`status` 为整数0/1。这些是明确的输入收紧，不把旧任意长度文字或错误宽容度称为同义。

缺组首次明确添加只建立固定元数据和一条用户输入，不自动种入旧七条业务值；没有HTTP DDL、自动迁移或运行时GRANT。组按config_name读取，不依赖首行gid，修复旧空组无法添加的交互缺陷。历史超过七条仍可编辑、隐藏或删除，不能新增；全量读取另有100条维护上限，超过时拒绝无界读取并要求维护核查。

历史异常字段以null及issues展示，不拿默认值冒充原值。编辑可解析JSON对象时保留未知顶层键、两个已知字段节点的额外属性。原值不是JSON对象时无法恢复附加键，页面明确给诊断，显式编辑将按所确认字段重建；隐藏和删除不需要把异常JSON改写成默认值。无效条目不能直接显示，需先编辑修复。

## 版本、原子性与未知结果

读事务使用有界 REPEATABLE READ READ ONLY；写事务显式 READ COMMITTED，局部statement/lock/idle期限5/2/5秒并保持更严格的调用方期限。固定advisory gate之后，已有 `sign_day_num` 组用 FOR SHARE 行锁，再取 `system_group_data` 的 SHARE ROW EXCLUSIVE 表锁并重新读取版本和数量。缺组明确添加依靠 config_name 唯一索引及 INSERT ON CONFLICT DO NOTHING；竞争创建不沿用旧空组版本写入。该顺序保护已有组元数据、七条数量和不配合的其他SQL写入；等待冲突超过期限则整笔回滚。行/collection摘要包括完整组元数据、完整原value及MVCC身份；正常主题切换不使数据版本失效。data表锁会暂时串行其他组合条目写入，不宣称只锁本组。

业务写、固定组初始化和 `system_log` 回执在同一事务提交；任何审计/权限/SQL失败整笔回滚。全域UUID由首个成功actor和原意图绑定；相同actor、操作、目标、版本和内容重放返回原回执，即使条目后来删除；跨actor或不同内容拒绝。回执不存在才给实际HTTP404；损坏或重复日志不能伪装未提交。

回执为 `{operation,id,request_id,payload_hash}`。规范摘要是UTF-8 SHA256(JSON.stringify(canonical))，UUID不入摘要；键顺序固定：

```text
create/update: {operation,id,revision,day,sign_num,sort,status}
status:        {operation,id,revision,status}
delete:        {operation,id,revision}
```

前端确认后，先以当前actor把固定操作、UUID、全部body和摘要写入sessionStorage，再提交。网络断开、响应不合规或无法证明回执时暂停新写，刷新后恢复；读取回执不自动POST。只有实际HTTP404才提供显式原请求重试，复用全部body/UUID。HTTP200业务信封404不够证明不存在；权限失败、回执异常或摘要不符都继续待核对。损坏本地记录保持锁定，不能以新的UUID覆盖未知请求。

请求、确认框、编辑器和恢复逻辑检查token、actor、角色及本地storage会话代际；换号和权限变化使旧响应失效。sessionStorage是同浏览器标签内恢复机制，不能保证关闭标签、清理浏览器存储后的恢复；取消客户端请求也不能撤回已到达服务器的写入。

## 验证边界

专项业务/并发、真实双前缀HTTP与受限LOGIN、显式权限升级、前端、类型/构建及浏览器证据统一记录在[本批验收](../audit/admin-marketing-config-acceptance-20260930.json)。新 current 权限增加 Admin 的两张组合表能力：group SELECT/INSERT 与仅 UPDATE(id) 的行锁权限；data SELECT/INSERT/DELETE 与 UPDATE(value,sort,status)；两个已有 serial 序列仅 USAGE。不允许 Admin 修改组元数据、删除组或重置序列。app对两表保持只读，其既有 system_log INSERT 能力没有改变；Admin日志不能 UPDATE/DELETE。

`UPDATE(id)` 自身是真实写权限，不能单靠列ACL称为“仅行锁”。独立维护协议先安装精确 SECURITY INVOKER 函数和 group 的 BEFORE UPDATE 触发器，拒绝Admin通过该授权改主键或任何组内容；原值不变的UPDATE及FOR SHARE仍可使用。函数不给runtime EXECUTE权限，不改变既有锁边界函数；新current必须同时满足窄ACL与精确保护目录。七表HTTP夹具也先安装同一保护，不能拿未保护的列权限当最终验收。

旧 current 固定为 pre-sign-day 阶段，旧促销升级仅到其原终态，不顺带开通本功能或安装新保护。新独立维护升级只接受精确 pre-sign-day，验证实际角色、两表及序列目录后，在一个事务内安装固定保护及前推新current；新安装使用v4-sign-day-config current。没有HTTP或启动自动修复；允许的维护DDL只为此固定函数/触发器，不新建业务表、改变列或种入业务值。真实HTTP使用production plan的七表有限切片；独立升级测试使用完整runtime commissioning，均不代替生产Hyperdrive和线上角色验收。

本页仅完成独立旧管理合同；真实奖励算法、其他设置差异、营销部分页面及全局Checklist开放项仍按原归属计账，未发布。

最终原生10文件按四个不重复分组运行，30+23+17+30=100/100通过，均清零并停机；此前十文件整体运行超过固定600秒上限不计通过，失败及保护前的重复尝试另列于验收。七文件审计/维护入口57/57、前端11/11、最终构建桌面1440×1000与手机390×844的15组浏览器交互通过。未知提交后编辑弹窗遮挡回执入口的问题已修复，最终验证直接点击回执而不借取消弹窗绕过。浏览器使用合成API/session，与原生角色证据分别计账；类型和构建结果以冻结验收记录为准。
