# Admin 供应商申请、目录与推广员协议合同（2026-09-28）

这批本地代码承接旧 Admin 的四条业务页面：`/admin/supplier/apply` → `/supplier/applications`，`/admin/supplier/menu/list` 与建档 `/admin/supplier/supplierAdd/:id?` → `/supplier/directory`，`/admin/agent/agreement` → `/agent/agreement`。旧 `/admin/supplier/supplier/index` 实为供应商菜单规则树，仍缺屏。旧 PHP 1904 条 URL 与 Admin 274 屏是固定审计分母；新原生页面不会自动增加旧 URL 的精确匹配。

供应商申请的 Admin GET 列表接收 `page`、`limit`（默认20）、`status=all|0|1|2`、`keyword` 和成对的 `start_time/end_time`（上海 `YYYY-MM-DD HH:mm:ss`，闭区间到秒）。关键词覆盖申请 ID、用户 UID、供应商名、联系人、电话、拒绝原因和备注，固定 `type=2,is_del=0`，按 ID 倒序；每行包含全部已签名资质图片与 64 位 `version`。审核和备注 POST 必须在 JSON 中传 `expected_version`，删除 DELETE 在查询中传同一值；缺失拒绝，材料、备注或审核状态已变化返回 HTTP 409。申请人重提与审核按申请人键再按行加锁，版本指纹包含数据库 `xmin`，同秒、同内容重提仍会改变版本。审核通过建待短信激活的账号，不发送明文默认密码；按旧 `supplier_verify_success/fail` 配置的 `is_system` 开关，事务内向申请人写安全站内信。已通过且已建供应商身份的申请不能软删。旧短信/微信审核通知渠道尚未重建。

供应商目录用独立 `supplier_directory.view/manage`。双 Admin 前缀注册 GET/POST `/supplier/supplier`、GET/PUT/DELETE `/supplier/supplier/:id`、PUT `/supplier/supplier/set_status/:id/:status` 和只读 GET `/supplier/supplier/cities?pid=`；城市数据复用既有地区服务，不受商城开站中间件影响。列表只查未软删供应商并保留停用行，详情返回建档字段及主账号名，绝不返回密码哈希。建档与主账号同事务绑定，并与入驻审核共用全局账号分配锁；编辑空密码保留现值，改密码需确认。写入要求列表/详情的 `expected_revision`，编辑还要求 `expected_account`；状态和删除同样校验版本。删除拒绝存在待处理订单的供应商，将关联供应商账号与商品停用/软删，历史订单及财务记录保留。旧快捷登录路径不开放：原 PHP 空密码通道可绕过停用状态，未来须设计独立代登录授权、一次性交接和管理员审计，不能由目录查看权自动取得。

供应商自助主账号改名与子账号创建/改名也使用同一账号分配锁，并对全部已有管理员账号做大小写无关查重。自助资料页只提交实际改过的字段，避免把未编辑的地区等旧值回写；新页面 GET 获得供应商及主账号行版本组成的 `revision`，PUT 携带 `expected_revision`，两行锁后比对，冲突返回409并保留输入。旧无版本客户端暂时兼容，因此旧客户端全量提交仍可能覆盖同字段；待客户端迁移后应将版本变为必填。旧后台目录版本校验与新自助版本校验的组合已纳入原生 PostgreSQL 交叉写回归。

推广员协议固定写 `agreement.type=2`，与会员协议 type1 分离。双 Admin 前缀沿用 GET `/agent/get_agent_agreement` 与 POST `/agent/set_agent_agreement/:id`；独立 `agent_agreement.view/manage`。GET 与页面仅展示服务端清洗后的历史 HTML，POST 只接受 `content,status,revision`，清洗后保存并校验 `xmin` 修订值，过期返回 HTTP 409。公开 `/agreement/2`、推广员申请和旧 v2 `agent_info` 均对历史正文做安全投影。旧 Admin 客户端 POST 没有修订值，必须升级新页面；伪造 body 的 `type/id` 被拒绝。

旧申请、目录和推广员协议的页面规则仅在各自 `menu_path` 与 `unique_auth` 精确匹配时授予查看权；管理权需独立配置。三个页面都隔离账号切换后的迟到请求，写入冲突后先刷新记录而不自动重放。PGlite、原生 PostgreSQL 16、双入口 JWT/权限、前端运行时、Worker/Admin 类型检查及管理端构建的结果见同日验收快照。真实申请材料、地区与账号历史、受限角色浏览器、生产规模、通知外部渠道和发布后验收仍需另行核对。

供应商菜单规则树另见[独立缺口合同](admin-supplier-menu-rules-gap.md)：旧规则写入会改变存量子账号权限，运行身份目前不具备菜单内容写权限，新导航也不从该表生成，因此该屏保持 `missing`。
