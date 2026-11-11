# 购买商品用户标签：真实付款作者与独立任务

基线为 `dd9b2f8e065f7f5bcb1ab472c2ecc194becb5b63`。本次接通真实付款后置事务、独立 Queue 授予、不可变成功回执及受控恢复。默认不启用；本次没有部署、上传旧 PHP 或调用真实支付／通知供应商。

旧 PHP 固定版本 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5` 的 `OrderJob::setUserLabel` 在执行任务时读取商品 `label_id`，并合并 type5 套餐 `link_ids`。DAO 使用按 ID 的查询；隐藏／软删除商品及已关闭套餐仍提供当前配置，物理不存在的行提供空配置。旧 PHP 源文只在本地核对，仓库仅保留文件身份、摘要及行为说明。

用户已确认标签按自身归属授予：平台标签保持 `type=0,relation_id=0`；门店标签必须匹配订单真实财务 `store_id`。履约分配门店不提供财务归属。活动中出现外部门店或其他不受支持的标签归属时，整项任务失败并等待维护。缺失／停用标签写入跳过回执；已有用户关系保留，只追加缺少的准确范围关系。

`OrderOutboxService` 在原付款效果事务中、实际 Supplier 分配完成后，为每个真实履约叶单插入独立 intent 与 PENDING state。支付来源摘要覆盖原 `order.paid` 的全部不可变字段及完整闭合 payload。订单、购物车、用户、实际财务门店、Supplier、赠品行和数量均来自真实数据库作者。此阶段不查询商品标签、不授予关系。游客付款不生成用户标签任务。原有满送活动标签效果保持原子，函数未改动。

任务消费者先在独立 READ COMMITTED 事务中持有有界租约，再在 READ COMMITTED 授予事务中核对并锁定真实付款／商品来源。取得用户行锁后，用同一条 SQL、同一数据库语句快照读取当前商品、套餐、标签目录及既有关系；目录中的实际标签行保持共享锁。这样既保留一致的配置快照，也能看见前一个持有用户锁的作者已提交的关系，用户字段值不改变。关系追加、不可变 result 与 COMPLETED 状态整体提交；提交失败整体回滚。成功回执优先于可变任务状态，重复投递不再读取当前业务配置，不补发人工移除的关系。

Queue 只携带 `{action,taskId,eventKey}`；扫描命令不携带业务数据。付款提交后的派发是加速器，独立定时扫描恢复丢失的加速器、发送未确认及过期处理租约。处理与派发各最多 8 次，退避有界；本地 DEAD 任务通过受控维护重放，最多 20 次。原付款效果不因标签任务失败而重复执行。既有 DLQ 仅接受闭合引用，重放在同一 Admin 事务中核对原 eventKey 并重置原任务，错配时整个重置和审计回滚。

运行声明 `PURCHASED_PRODUCT_LABEL_RUNTIME` 是可信部署组合数据，沿用完整五角色 `RuntimeGiftPeerDeclarations` 并显式增加 `purchasedProductLabels:{purchasedProductLabels:true}`。不能从 HTTP、Queue 或 ACL grantee 推导。先由实际命名的 PG16 maintenance 在受控窗口调用 `installPurchasedProductLabelStorage` 安装严格 owner-only 存储，再调用 `upgradePurchasedProductLabelRuntime` 审计全部既有五角色并只授予固定 App／Admin 新权限。需要保留部署现有 App reader 声明。绑定包含数据库和实际 LOGIN OID；复跑仅验证精确绑定，不学习或补修未知 ACL。

App 只能插入 intent/result、读取任务并更新有限 state 字段；Admin 只能插入 intent、读取任务及 result、更新有限 state 字段及 replay_count。两者均不能改 task_id、更新／删除不可变行、删除任务或委托权限。Financial、Manager、Cashier 无新表权限。每次实际操作检查直接 LOGIN、session identity、事务模式、绑定、完整新存储目录、维护门和物理锁；运行时不执行 DDL、GRANT 或 SET ROLE。

后台通过已注册 `adminAuth`、当前有效平台管理员和现有 `outbox.view`／`outbox.manage` 权限访问：

- `GET /api/admin/order/product-label-tasks`：有界、按 UUID 游标的状态列表，不返回 lease token 或完整业务源文。
- `POST /api/admin/order/product-label-tasks/:id/replay`：确认值 `REPLAY_PURCHASED_LABEL_TASK`，1–100 字符维护原因；活跃租约拒绝重放，完成回执不重新授予。
- 既有 `/api/admin/order/outbox/dead-letter/:id/replay`：确认值仍为 `REPLAY_DEAD_LETTER`，对购买标签引用执行上述原任务核对。

这批提供后台恢复 API 与既有 DLQ 接线，未新增专用前端页面。来源结构被后续维护改变而无法证明原任务时保持失败；不从客户端快照或相似订单重建来源。运行开关、生产五角色 Hyperdrive 验收及整体迁移仍需后续部署阶段处理。

验收摘要、固定 PHP 文件身份和当前源码继承清单见 `../audit/php-ts-purchased-product-label-author-20261110.json`。历史证明使用独立的完整当前图像校验及精确逆向编辑，旧证明 JSON／hash、资源上限、文件库存和业务断言保留；真实 SQL、HTTP 和 Worker Queue 始终导入物理新源码。
