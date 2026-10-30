# PHP → TS：Admin 本人资料完整流程（2026-10-25）

本切片实现个人中心的头像、姓名、原密码改密、新手机短信验证四项独立操作。现代入口 `/system/profile`，原 `/admin/system/user` 为精确别名；账号只读，普通平台管理员可维护本人，无需 `system.manage`、配置或全库附件权限。本次是代码与本地验收，未执行生产部署、生产数据库授权或真实短信发送。

## 原件与兼容合同

固定 PHP ref：`8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`。完整来源绑定见 `../audit/admin-profile-source-binding-20261025.json`，SHA-256 `014557a014be467ac07bc9d57b57caa46f1e9544ea3b8b01c01887eee6b111f6`。保留12份固定PHP全文、32个完整可逆修改前像/后像、17个新增实现/测试完整摘要，以及1691个历史证据/文档/helper的原始摘要。19个历史测试只调整读取/导入入口，原断言、反例及旧helper均保持原文。

PHP依据是 `view/admin/src/pages/setting/user/index.vue`、`view/admin/src/api/user.js`、`route/admin.php`、`SystemAdmin.php` 与 `SystemAdminServices.php`。原GET先验证当前JWT、隐藏密码等内部字段；新DTO仅含 `id/account/real_name/head_pic/phone/revision/avatar_id`。原PUT的七字段 `real_name/head_pic/pwd/new_pwd/conf_pwd/phone/code` 和首个非空分支优先级（头像→姓名→密码→手机）保留。目标ID、账号、权限、角色、级别和状态不是本人可写字段。

有意收紧：拒绝空操作、未知字段与错误类型；姓名不带首尾空白且最多16个Unicode字符；新密码至少12个Unicode字符、最多72个UTF-8字节且两次一致，bcrypt cost12。**原密码保持现登录的非空原串、UTF-16长度≤256合同，不修剪、不套新密码策略**，包含201字符及历史换行密码的真实bcrypt回归。头像仅接受本人受控上传引用，手机号验证码为独立用途且一次性消费。旧任意头像URL和通用商城验证码均不再构成保存授权。这些加强不归因于PHP原件。

## Worker 与 Pages 路由

下表同时注册于 `/adminapi` 和 `/api/admin`，均经原 `adminRuntimeAuthMiddleware`，在普通连接完成JWT/权限准入后才打开独立Admin连接。

| 方法 | 相对路径 | 合同 |
| --- | --- | --- |
| GET | `/setting/info` | 仅当前账号安全资料与凭据/期限绑定的revision |
| PUT | `/setting/update_admin` | 原七字段互斥适配；可带 `X-Profile-Operation` UUID |
| POST | `/system/profile/commit` | `operation_id/operation/revision/payload` 四操作显式提交 |
| GET | `/system/profile/receipt/:operationId?operation=…` | 当前活跃同账号的持久回执 |
| POST | `/system/profile/resolve` | 在相同写屏障下封存缺失操作为未应用 |
| PUT / GET | `/system/profile/avatar/:avatarId` | 有界本人上传 / 私有图片字节读取 |
| POST | `/system/profile/challenge` | 新手机号绑定的专属Turnstile挑战 |
| GET | `/system/profile/challenge/status?key=…` | 当前凭据与IP绑定的服务端状态 |
| POST | `/system/profile/sms` | 已验证挑战入队，明确返回queued |

公开的 `/api/admin-profile/challenge`（GET/HEAD）和 `/api/admin-profile/challenge/complete`（POST）只处理不可猜测的挑战key，不接受客户端actor。Admin Pages 新增两个**精确**代理函数；原站点只有 `site_config/assets` 的部分 `/api` 转发，开发代理可用不能代替生产路径。实际Functions构建已确认两个routePath。代理保留固定Worker目标、配置路径前缀、流式POST和原响应；拒绝其它方法并去除无关Bearer/Cookie，不扩大通用 `/api` 代理。

## 身份、并发与未知结果

事务重新检查活跃平台 `adminType=1/relationId=0/status=1/isDel=0`、当前密码摘要和会话期限。所有本人写入、回执查询/封存使用既有staff写屏障；现代revision绑定账号、凭据版本、期限和当前资料，拒绝丢失更新。业务修改与不可变UUID回执在同一PG事务提交，回执不存明文密码、OTP、手机号或浏览器凭据；请求摘要使用APP_KEY HMAC。

改密必须真实比较原密码。新hash会使全部旧JWT在原认证中间件失效；未知结果不能用旧token绕过认证查回执。重新登录同一账号后，可读取原owner回执或在屏障下封存未应用UUID。浏览器sessionStorage仅存 `operation_id/actor_id/operation`，不保存密码、验证码或可离线猜测的裸摘要。

客户端以完整代次保护弹窗、原生回调、iframe消息、计时器和迟到响应：路由同步watch、storage跨标签事件、显式成功重登/退出、关闭/卸载均退役；同token/账号ABA也不复活旧动作。回读后续体再次检查新代次；取消的私有头像错误响应不清理新会话。已确认回执与资料刷新失败分别展示，不能把保存成功说成已成功刷新。

## 专属短信与头像

短信采用 `admin_phone_update` 和独立Queue action，服务端绑定Admin ID、HMAC凭据标签、会话期限、手机号及挑战IP。Turnstile动作/cdata/hostname/期限核验前后均重查活账号；缺Redis、provider或Turnstile配置时拒绝。复用真实安全随机码、Aliyun签名和原全局手机号/IP/分钟预算：300秒码、60秒cooldown、手机号每日10次、IP每日50次、全局每分钟20次。queued只表示队列接收，provider成功后才发布可消费验证码。消费tombstone阻止迟到Queue重试复活已消费码；死信脱敏且不可重放。

Redis消费与PG写入不是跨介质原子事务：消费后PG失败，码不会随回滚恢复。应查询原UUID；确定未应用并封存后重新验证、发码，不自动重放原请求。真实provider有至少一次队列/网络未知结果边界，不宣称短信严格一次送达。

头像使用独立 `admin-profile/<actor>/<UUID>` R2键和不可变owner元数据，不混用用户、客服或平台附件域。仅接收2 MiB内、字节检测与MIME一致的JPEG/PNG/WebP/GIF；保存稳定 `/admin-profile-avatar/<UUID>`，预览走认证字节与BlobURL。旧外域/未知头像保留原值并提示，不自动规范化、签名或写回。R2成功但PG未知可能留下未引用对象，不能在未知提交时删除潜在已提交头像；本次不自动扫描或删除生产对象。

## 独立数据库维护

新两表 `admin_profile_operation/admin_profile_avatar` 无业务序列或外键级联，并以不可变触发器保护。`migrations/adminProfile.ts` 的runtime检查精确列、约束、索引、触发器、函数、owner与ACL；缺失/漂移/越权在操作前503，绝不在请求、登录或启动中创建/修复。

显式入口为 `runAdminProfileUpgrade(db,target)`，要求已commission的当前whole-shop profile、独立PG16超级维护身份、匹配库名和三个不同身份、固定advisory/staff锁，无event trigger。只授Admin两表SELECT/INSERT，App无权限；审核器按完整可选addon识别，固定历史stage不变。SQL/授权在维护事务中一起安装并回验。部署负责人须在所管理的环境显式调用该入口，先核对目标及既有commission；本切片只在新建隔离本机库调用，未对生产执行。

## 最终验收

所有Node/TS/Vue/构建/浏览器验证经过共享serial wrapper。共 **2510项选定测试**通过，包含500项实际SFC/既有前端回归、7项Pages实际源码代理测试、2002项后端/来源证据测试与1项完整独立PG16 LOGIN验收。新覆盖254项；这是选定回归集，不是全仓库单元测试总量。

- Admin vue-tsc、Worker strict tsc、两Pages函数的独立类型检查通过；Vite生产构建、Wrangler Pages Functions构建通过。
- 真SQL测试覆盖安全DTO、普通无角色管理员、双前缀真实Hono/JWT、撤权/过期、CAS/UUID、长历史原密码、真正回滚、本人头像与跨域拒绝；短信含完整挑战→受控provider→真实profile事务与一次性消费。
- 独立PG16.14验收执行真实whole-shop commissioning、实际DDL/GRANT后的故障回滚、独立App/Admin LOGIN的42501拒绝、Admin窄权限、屏障/维护锁冲突、原样重复安装与全表/序列快照。临时集群停止，残留fixture为0。
- 实际AST清单为717调用点/755路径变体，全部已注册且可执行，未注册/未解析/受控不可用均0；原709/747调用逐项保留。认证私有字节fetch不在该AST清单内，由服务归属/字节回读测试与实际GUI请求Header校验覆盖；清单方法学仍限定request调用。
- Browser插件缺席，使用已安装Playwright/Chrome。生产构建实测旧别名→姓名→头像→手机挑战/入队/码保存→网络未知回执恢复→改密退出；1365×960、375×900、320×900。5张最终截图均已查看；无blank/overlay/pageerror/未解释console，仅1条主动注入的网络失败。

真实Turnstile和Aliyun响应仅替换HTTP端口，Redis为受控端口，生产配置、真实短信送达和真实R2服务未验收。没有提交、推送、生产部署或生产维护写入。下一候选“平台type=1权限规则作者”只做了只读来源准备，不计本切片完成。
