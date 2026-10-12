# 旧平台管理员表单、写入及结果恢复合同

本批本地验证已完成，尚未发布。GitHub main 已只读核对为 `5a4e363`，并合入本地 `8033ba07`；本批不借用其 PR CI 或生产验收信用。当前候选在独立现代页面 `/system/legacy-staff` 承接旧 staff 流程，原 PHP/Vue2 源未修改。

## 实际合同

| 路由 | 行为 |
|---|---|
| GET `setting/admin` | 原分页名单，实时平台身份及 `relation_id=0`、下一层级、非删除过滤 |
| GET `setting/admin/create` | 七字段 form-create DTO、数字角色选项、固定相对 POST action |
| GET `setting/admin/:id/edit` | 真实存储回显、空密码、固定相对 PUT action |
| POST `setting/admin` | 确认后创建下一层级平台管理员 |
| PUT `setting/admin/:id` | 确认后修改七字段，允许账号改名，空密码保留 |
| PUT `setting/set_status/:id/:status` | 空请求体，确认后真实启停 |
| DELETE `setting/admin/:id` | 空请求体，确认后 `status=0/is_del=1`，保留原行 |

表中相对路由同时存在 `/adminapi` 和 `/api/admin` 两个 base；仅六个新 canonical URL 可用于旧缺口抵扣，v1 别名与新的确认/恢复 URL 不额外计分。两条表单 GET 返回 `title/rules/action/method`，名单 GET 保留分页 DTO；七字段依次为 `account,pwd,conf_pwd,real_name,phone,roles,status`，返回规则永不含密码 hash。

保存 body 保留七字段，不接收 id。实际写入还必须提供四个确认请求头：`X-Admin-Operation-Id` 为小写 UUIDv4、`X-Admin-Revision` 为64位小写十六进制、`X-Admin-Expires-At` 为整数秒字符串、`X-Admin-Confirmed` 为字面值 `true`。缺确认返回受控冲突，不自动调用现代全层级 save。CORS 固定允许这四个头，未受信 Origin 不获 ACAO。

专用 POST `setting/admin-authority/preview` 接收 `{operation_id,operation,payload}`；save payload 为 `{id,...七字段}`（创建 id=0，编辑为真实 id），status 为 `{id,status}`，delete 为 `{id}`。GET `setting/admin-authority/receipt/:operationId` 要求唯一的 `operation` query；POST `setting/admin-authority/resolve` 只接 `{operation_id,operation}`。专用种类仅 `legacy-admin-save/legacy-admin-status/legacy-admin-delete`。现代 `system/authority/*` 的原三种操作解析保持独立。

## 输入、范围与正常修复

账号采用实际 varchar(32) 容量内的 4–32 位 alphaDash，姓名必填且最多16字符，电话保留真实 ThinkPHP mobile 规则 `^1[3-9]\d{9}$`。数字角色是非空正 int32 数组，去重排序后 CSV 不超过128字符；客户端域、层级与未知字段均拒绝。省略 status 与 null 区分，省略值沿旧 controller 默认0，创建表单默认1。

本批密码明确采用固定至少12字符、UTF-8最多72字节并确认一致的策略，编辑两密码空值保留原密码。72字节上限防止 bcrypt 截断。**它不等价于旧 `system_password_type/system_password_length` 的可配置组成策略；该旧设置合同仍开放，不能据本批宣称迁移完成。** 既有现代密码入口的原合同保持。

实时 actor 必须是有效平台 `admin_type=1/relation_id=0`，密码版本和会话未过期；层级0–9只操作下一层级，支持9→10。目标不得为本人或外域，不能任意派生客户端层级。请求新角色必须启用、同平台、处于下一层级；当前角色全量读取，不丢弃未知/外域/异常菜单。已有停用或退役的真实同域角色保留原ID回显，允许从保存中移除；独立启停、删除不因该角色已停用而无条件拒绝。生效角色和映射数字菜单的每个权限必须在实时委派范围内，合格 opaque 只按 actor 当前数字 membership 保留。受保护菜单身份、路径、unique_auth、方法 tuple 不能伪装 opaque。

列表、表单、写入能力分别为 `system.legacy_admin_view`、`system.legacy_admin_form_view`、`system.legacy_admin_manage`。细 manage 蕴含本流程读取，现代 system.view/manage 可以单向覆盖对应细能力；旧列表授权不会获得本流程写权或现代全层级权限。真实旧菜单 ID20/610 始终只读，PUT/DELETE 不再按 POST 方法折叠。

## 确认、提交与未知结果

旧停用或退役角色以原数字 ID 回显，option 为 `disabled:true`，不能重新选择。页面提供明确的“移除停用角色”按钮，移除后保留其它已选的有效角色；未移除时不能预览保存。这一行为已在实际桌面与手机浏览器中检查，不依赖禁用选项默认隐藏的 tag 删除控件。

写操作取得既有管理员/角色双表屏障及固定菜单锁后再读所有决定，锁保持到真实 COMMIT。账号/电话唯一性采用同平台非删目录，在同一屏障事务内决定；修改排除自身。HMAC request/revision 绑定 operation、actor、密码版本/到期、完整目标、相关角色及菜单目录、唯一性决定和有效期。预览显示账号、姓名、电话、角色、状态、层级、删除及密码是否变化；草稿或权限变化必须重新预览。

真实业务结果的完整 RETURNING 与实际存储回读一致才允许同事务追加不可变回执。save/status 结果为 `{id,created}`，status固定false；delete为 `{id,deleted:true}`。触发器跳过、改写业务列或回执导致整笔回滚。相同UUID/actor/原请求只返回原回执，永久封存后不能执行。

客户端发送前以 actor 隔离存储七项最小 pending 元数据，不持久保存明文密码、草稿、revision或token。Web Locks 保护多窗口 reserve/clear；每层请求按账号、session和权限 generation 隔离迟到响应。5xx、超时、格式不符、响应丢失、reload及换号都不作为成功证明。只原 committed 回执或与相同写屏障串行化的永久 not_applied 封存解除 pending；GET 未查到仅为 unknown。原 actor 以新有效会话可以恢复，新 actor 不能读取旧记录。

## 独立维护升级

`runAdminLegacyAdminOperationUpgrade` 是显式 PG16 维护入口，不由请求或启动调用。它先验证精确已commissioned的完整 app/Admin profile、原 v1 或本批 v2 回执目录及 ACL，在既有 advisory、staff/menu 和 receipt 锁内只扩展两条 CHECK。原表、函数、触发器、索引、所有者、授权和旧回执数据保持，不放宽 app 权限，不修复漂移。v2只增加三个确定种类及严格结果形状；现代 runtimeReady 兼容精确 v1/v2，专用旧管理员操作只接受精确 v2。

本机实际 PG16 的升级五项验收已通过，包括完整283表、旧 committed/not_applied 行、独立 app/Admin LOGIN、重复升级及 third-party/default ACL/owner 漂移拒绝。专用[临时维护工具](../test/integration/admin-authority-maintenance.README.md)固定三个现有 Hyperdrive 与四个目标名称，在同一真实 owner RC 事务内完成 v1 安装和 v2 扩展。预检分别验证三个真实连接的数据库、current/session/backend 身份和精确 profile，指纹绑定源、SQL、目录与受锁数据；正常订单、购物车数据不进入发布门禁。InspectOnly 在数据库工作前拒绝所有 POST；提交结果不明标记 unknown，不自动重试。它未部署，不代表生产前提已经就绪。

## 实际验收与保留范围

本批 **286 个不同测试 / 18 文件通过**：后端业务58、staff原生13、客户端23、CORS/名单23、结构扩展原生5、权限/角色67、现代与main回归81、选定现代原生2、维护HTTP13、维护原生1。其中21项使用真实PG16；维护原生1项为一个完整案例，多个阶段不重复计数。权限67来自43与24两次完整文件结果；现代/main首轮整体失败仅因Supplier依赖缺失、零用例，其余三文件57通过，恢复后只补Supplier24。选定现代原生只计2通过，另15项明确跳过，不称完整文件通过。最终 Worker unit-types04/runtime-types02、Admin类型/构建以及 API/维护Worker dry-run 均实际0。[验证账本](../audit/legacy-admin-workflow-validation-20261009.json)分列实际命令、来源、哈希和失败记录。

桌面1440×1000及移动390×844各12项状态检查、共24截图通过；40个真实递送CSS/JS响应与本地构建 SHA 相同。浏览器使用网络夹具，未执行真实网页登录或数据库；native改密码恢复使用重新签名JWT和真实middleware，未执行login handler。维护原生验证完整profile与独立newcomer共存、两阶段异常完整回滚、精确v2重复以及锁内指纹拒绝；动态census不以本地283表覆盖生产。成功测试集群fixtures0、停止及独立pg_ctl status3已有证据；先前资源耗尽且剩余状态未证明的失败现场保留。

实际CLI退出0：PHP1904/Worker2375、旧902可执行、964可行动缺口（Admin896）；Admin615调用/647变体全注册可执行。六个canonical恢复只抵扣静态URL缺口，旧客户端缺确认头仍不会正常写入；不是完整旧业务兼容证明。清单保持404总项/249完成/155开放，旧可配置密码、旧Vue确认恢复、独立旧role启停/删除、真实生产前提、完整当前提交CI及发布继续开放。依赖恢复、失败现场和原日志保留，不将夹具、PGlite或历史CI计作本轮生产证明。
