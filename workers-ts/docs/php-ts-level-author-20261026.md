# 普通会员等级 PHP → TypeScript 迁移增量（2026-10-26）

本批实现普通 `system_user_level` 定义作者：九个有效表单值、独立图标/背景图库、名称及显隐筛选、分页、显隐、新增、编辑和受保护删除。入口 `/level` 与固定 PHP 原入口 `/admin/vipuser/level/list`，旧 API 和现代作者接口均在 `/adminapi`、`/api/admin` 双前缀注册。本批是本地切片；整体迁移继续。

## 固定原件和行为选择

PHP 固定提交 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`，16 份完整 PHP 原件与前一批 6070 文件前像共同作为依据。九字段为 `name, grade, discount, exp_num, icon, image, color, is_show, explain`；两项图片建议尺寸分别 656×300 和 750×990。原表单的 grade/exp 默认 0 保留，新增与改变数值遵从 PHP Controller 拒绝 0 的规则。

未删除行全域检查名称、级别、经验重复，以及相邻级别经验严格递增，包含非平台历史行；非平台历史行可见只读。只改展示数据时保留既有结构缺陷；历史 0、无效图片地址、可空说明和相同十进制折扣可原样保留。隐藏有效期/收费字段编辑时全数保留；新建明确 `validDate=0,isForever=1,isPay=0,money=0.00,merId=0`，逐字段核对 INSERT RETURNING，触发器改写也整笔回滚。

原任务入口/有效期控件已注释，缺失的 PHP task/read 目标和任意 `set_value` 不恢复。本批不修改分销等级、九键会员激活设置或收费会员。

## 图片与价格

两个图片槽分别保存稳定地址，预览地址单独返回；平台规范附件须当前为公开平台图片、规范 R2 路径、栅格 MIME/扩展名匹配，改变时按 ID 排序 `FOR SHARE NOWAIT` 重验。未改变的历史 HTTP 原文保留，预览升级 HTTPS；不安全原值留档但不渲染。等级专用图库只授予 `level.manage` 范围的 GET 分类/选项，不扩展附件管理授权。

`UserLevelService.gradeList` 仅改变 icon/image 公开预览投影。既有 `getLevel`、会员激活、购物车、报价和订单折扣规则保持。后台允许原始 0/95.50/100；0 沿用既有原价回退，不改成免费。

## 写入、恢复和并发

实时校验平台管理员、权限、凭据版本和期限；先 staff/role barrier，再 `system_user_level ACCESS EXCLUSIVE NOWAIT`。删除还持有 `user,user_level SHARE ROW EXCLUSIVE NOWAIT`；任意用户引用（含停用/已删用户）都阻止删除。未引用等级及关联历史同事务软删，全字段回读核验，失败无定义或回执残留。

独立九列 `admin_level_operation` addon，不以 App 可追加的共享日志作为作者回执。Admin 仅 SELECT/INSERT，App 无权限，UPDATE/DELETE/TRUNCATE 不可变；显式维护升级具备精确权限审计、回滚和运行就绪检测，不扩大既有业务表授权。

客户端先持久化完整非秘密 UUID 操作及规范摘要，再提交；同 UUID 先查已提交回执再校验旧目录版本。回执缺失仍为未知，显式原样重试或 owner resolve 封存未应用结果，阻断迟到提交。原 owner 在权限撤销后仍可查/封存旧请求；刷新及多个待确认 UUID 逐条恢复。矛盾终态 DTO 不能清除本地记录。请求和恢复均接受 512KiB 预算，覆盖完整历史说明的 UTF-8 与 JSON 转义。

前端真实 SFC/cacheHandlers/native 事件测试覆盖快速输入、编辑 ABA、旧确认/图库监听失效、账号/路由/卸载、陈旧分类响应、查询快照、重复提交、存储失败、部分持久化、未知回执、权限撤销和多 UUID 恢复。

## 旧证据保留

新增 Level 最外层可逆来源适配，完整剥离当前切片后复用冻结 Express、平台菜单、本人资料、错误页、本地日志和配置分类证据。22 份旧来源/API套件只改读取端口，原断言/负例保留。旧缓存套件单独记录完整前/后像：启用真实受限 fixture 与实时鉴权；删除无引用等级前明确清除 user.level，保留价格/缓存断言，在新作者套件另验全部引用拒删。不是声称这份测试仅修改 import。

## 验收

3494 项唯一选测通过，新增 358 项：新受限 SQL/Hono 作者 54、图片策略 37、专用图库 24、独立回执 addon 32、完整来源 173、真实 Vue 37、原生 PG16 作者并发 1。完整后端/来源 2549、相邻运行时 200、原生旧激活/价格 116、原生作者 1、旧前端 591、新 Vue 37；重跑不重复计数，最终选测无失败/跳过。

Admin vue-tsc、Worker strict tsc、Vite 生产构建均通过。实际 AST API 清单 734 calls / 772 variants，全部 registered/executable，0 unresolved/unregistered/controlledUnavailable。所有重检查使用共享串行锁及单 worker；早先在 PGlite 扩展执行原生定价锁测试失败，保留原断言并切换 native PG16 后 116 项全通过，未绕过定价安全能力。

Browser plugin not available，使用现有 Playwright/Chrome。实际生产构建入口 `http://127.0.0.1:5213/admin/vipuser/level/list`，1365×960、375×900、320×900：页面身份、非空、无框架遮罩、无未解释控制台错误、截图及真实交互六项通过。编辑九值与独立选图、0 状态筛选、引用拒删后的显式封存、刻意丢失响应后的原回执恢复均实测。9 张最终截图逐张读取，桌面选图焦点导致外层滚动的问题已修复；长表单只在内部滚动，标题与确认操作可见。0 pageerror/0 warning；仅受控 HTTP400 与刻意丢包 ERR_FAILED。

原生 PG16.14 独立 LOGIN 实测维护失败回滚、精确 ACL、重放、两个原有消费者的真实 SELECT→写入竞争、引用/历史/附件失败和终态恢复。最后本地集群 `.cache/finance-postgres-JVVtOP` 已停止，fixture=0，浏览器端口5213已关闭。

来源证据 `workers-ts/audit/level-author-source-binding-20261026.json`，SHA256 `b7bb59cd7162f559537ab69d05aa6475217c1cf7117201078357db692ad7a974`：37 份修改完整前/后像、20 份完整新增、16 份完整 PHP、1700 份冻结旧证据、16 份原业务边界精确原值。22 份旧来源读取端口断言正文保持；缓存 fixture 的语义修正独立完整记录。验收汇总 `/tmp/cinashop-level-author/accepted-validation-result.json`。

本批未执行生产 addon 安装、真实生产账号/R2 联调、commit/push/PR/merge/deploy。下一普通用户标签/分类仅作只读差距勘察，不计实现验收；整体 PHP→TS 迁移继续。
