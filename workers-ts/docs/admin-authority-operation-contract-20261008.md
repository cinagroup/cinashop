# 现代管理员与角色确认、回执和恢复合同

本批承接现代 `SystemList` 的管理员保存、角色保存和角色软删除，包括 CREATE。旧裸接口仍保留共同事务和已引用角色实际授权变更 409；现代页面改用独立确认协议，不能将这一新流程记为旧 Vue 消费者迁移完成。

## 决策与提交

`POST system/authority/preview` 接收小写 UUIDv4、operation 和严格 payload，读取当前账号、目标、全部引用账号、相关角色和完整 type=1 菜单目录，返回变更前后及完整影响名单。包括禁用和已删除平台账号，最多 1000 个，超限拒绝而不截断；外域引用拒绝且不披露其姓名或账号。非超级管理员必须能委派每个受影响平台账号的当前和投影权限，不能影响超级管理员。本人角色、等级、启停和最后超级管理员保护继续生效。

预览不执行 DML，不消耗业务序列，也不采用先修改再回滚模拟只读。request HMAC 绑定原账号、UUID、操作类型和完整规范请求；revision HMAC 另外绑定当前凭据版本、到期、目标、引用账号、相关角色和目录。预览最长 300 秒，最多到当前 JWT 到期。密码只留在当前内存草稿及签名输入，回执不保存密码、token 或原 payload，HTTP 不暴露内部完整证明。

`POST system/authority/commit` 必须显式 `confirmed:true`。共同 public 管理员/角色双表屏障先于决定读取；经过严格目录检查的固定菜单锁函数取得 `ONLY public.system_menus SHARE NOWAIT`，防止菜单新增造成数字权限幻影。原 Admin 的菜单列级 UPDATE 权限不足以取得该表锁；新固定零参数函数仅取得这一锁，没有业务数据读取或 DML，正文、维护所有者、EXECUTE ACL 和真实 OID 独立审核，未授予菜单表 UPDATE/DELETE。所有锁持有到真实 COMMIT。

提交在同一事务重验 revision、完整权限和影响范围，再执行共同计划的真实 RETURNING 与存储回读，最后追加并回读回执。已有相同账号、UUID、operation 和 request HMAC 的 committed 回执优先返回原结果，包括已过期预览和已删除目标；不同内容、类型、账号或已经封存的 UUID 拒绝复用。业务保存、回执 RETURNING 或回读异常均整笔回滚。

## 未知结果恢复

`GET system/authority/receipt/:operationId?operation=...` 只返回有效原账号的结果。缺少回执是 `unknown`，不能推断未执行。`POST system/authority/resolve` 在相同双表屏障内查原回执；若仍不存在，永久追加 `not_applied` 封存记录，随后迟到的原提交不能再执行。不存在 UPDATE、DELETE、TRUNCATE、FK cascade 或到期清理来释放已用 UUID。

这两个精确恢复路由允许已认证账号进入身份复验，不依赖当前 `system.manage` 或旧角色仍存在；服务重新核对平台域、启用、未删除、当前密码版本和 JWT 到期，最终绑定 owner。改密码后旧 JWT 不能恢复，同一账号重新登录可恢复。禁用或删除的账号不能绕过身份校验，需要其它已有管理流程处置。其它没有登记权限的路由仍拒绝；preview/commit 仍要求当前 `system.manage`。

前端在发送 commit 前持久保存账号隔离的七项恢复元数据。任何不可靠提交响应保持 pending 并阻止全部新写；刷新目录不会解除，重新加载保留 pending 但丢弃密码和原 payload，也不自动重试。GET unknown 继续阻止；只有严格匹配的 committed 回执或服务端永久 not_applied 封存才能释放。内存原请求仍在时，可以明确确认后重试同一 UUID 和原请求，不能提交当前新草稿。即便同一有效账号失去目录查看与管理权限，仍能看到自己的恢复入口；另一账号看不到原账号记录。

## 独立安装与发布边界

两个 URL 前缀 `/adminapi`、`/api/admin` 各新增四个入口，共八条现代注册，不增加 PHP 旧路由匹配分子。`admin_authority_operation` 是独立安装的永久证据表，不纳入历史 `MigrationService.runAll`、外部 SQL 或全量 ORM 固定 cohort；模型是直接导入的类型映射，实际安装使用严格维护入口的 CHECK、PK、两个不可变触发器及锁函数。

维护升级要求既有 app/Admin 完整权限方案准确，新增表和 Admin 的 SELECT/INSERT、固定锁函数 EXECUTE 在同一事务安装并核验。app 无新表和函数权限；其它账号、PUBLIC/default ACL、可变或可委派权限、所有者、外键、函数正文、触发器或物理结构漂移均拒绝，不进行自动修复。请求和启动不会执行 DDL/grant。历史权限方案保持，审计只在独立表存在且严格审核成功后接纳这一固定 addon 及其精确函数 OID。

本批只完成本地候选。旧角色独立启停/删除、旧 staff/account 全链和旧客户端确认恢复仍开放；真实生产账号数据、规模、Hyperdrive、完整新提交 CI、公开推送、合并、生产 DDL 和部署尚未因此完成。Checklist 的 404/249/155 和旧可行动路由缺口 970（Admin 902）不因新增现代注册自动抵扣。

## 实际证据

本批原始证据目录：`C:\Users\cina\.codex\visualizations\2026\09\26\01a0db11-74a0-7cc2-b1f9-ee3b8653056a\checklist-route-contracts-20261008\admin-authority-operation`。最终命令、输入哈希、退出码、唯一用例和明确限制以 [验证清单](../audit/admin-authority-operation-validation-20261008.json) 为准。

业务83、相关回归90、前端57、真实 PG16 最终33，共263个唯一用例/17文件，其中77项为本批新增。原生完整配置验收实际282→283表、两个独立LOGIN审计、21条新增目录记录、原282表全部目录和数据保持、重复升级无变化，第三方回执SELECT、PUBLIC default SELECT和所有者漂移均拒绝且不自修。最终unit-types03/runtime-types03均退出0且无输出，Admin vue-tsc/Vite构建退出0。原生最终独有89Ci0H集群fixtures0、自停，独立pg_ctl status3/no server running；data/log保留。

首次业务安装因PGlite多语句prepared调用失败；首次原生14项新流程因实际菜单表锁42501失败，另一次单项诊断证明该权限不足；首次权限回归发现恢复入口需单独登记及一项本机资源争用超时；两轮unit类型检查发现新夹具的类型错误。修正后相关用例实际重验，上述失败原始记录不覆盖。最终完整类型和原生快照2533项与当前输入核对，提交前仅清理新前端测试文件末尾多余空行，原输入哈希及前后完全相同的编译JS证明另存；没有重计测试或改SQL、断言、生产行为。先前通过的业务/前端快照有后来新增的整库审计与原生夹具变化，依赖图证明它们不在这些用例的消费输入中，不伪称所有较早快照字节均等于最终树。

浏览器验收使用实际 W 源码、本机 Vite 和已安装 Playwright/Chromium，桌面 1440×900、手机 390×844 共 28 个步骤和 16 张截图。接口为拦截的前端网络夹具，与独立真实 PG16 后端证据分列；页面 URL/title、完整名单、未确认不提交、丢失响应、刷新、reload、unknown、同账号撤权恢复、账号隔离、永久封存和新建/删除已验证。无整页横向溢出、pageerror 或外部请求；唯一 console error 是有意中断 commit。环境和选择器失败尝试及成功原始记录均保留。
