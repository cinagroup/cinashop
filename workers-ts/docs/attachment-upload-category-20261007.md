# 普通图片上传分类提交合同（2026-10-07）

本轮补齐普通图片上传的分类归属与提交互斥，覆盖 Admin、Supplier、User、Kefu 和 Visitor。对象上传期间不占用分类事务锁；R2 写入完成后，在 metadata 事务内使用与分类增删和附件移动相同的范围锁，对非根目录重新核对目标分类的 type、relationId 与图片 fileType，并持有共享行锁直到事务结束。分类删除先提交时上传拒绝；上传先取得范围锁时，删除等待其提交后重新统计，不能删除已非空的分类。根目录、合法子分类以及用户／游客命名空间分别保留原合同。

普通 INSERT 核对单行返回、正安全附件 ID 和请求的完整 metadata，canonical 更新再次核对相同 ID、完整 metadata 与两个 canonical 路径。触发器改写 pid、owner、key、路径或静默跳过 INSERT／UPDATE 均不能假报成功。`char(30)` 的 MIME 和大小只按数据库右侧空格填充语义比较，其他 metadata 严格匹配；数据库不保存 signed preview，R2 对象 key 不因分类操作改名。

metadata 回调内明确失败时整笔回滚，并只清理本次新 key。直接清理失败时沿现有队列协议申请补偿；排队也失败时保留原 metadata 错误。真实 COMMIT 后确认丢失与提交后签名失败保留可能已被引用的对象，不误删或排队。本轮未提供 SQL 与 R2 的跨系统原子性、自动对账或生产 provider 确认。

代客表单 module5 保留 R2 之后、metadata 事务内的最终授权回调、根目录及独立 ao/digest 命名空间；同 type／同 owner 的普通素材操作仍排除 module5。其既有 id-only INSERT／UPDATE 合同保持，本轮普通上传的完整 ACK 检查不扩成 module5 完成信用。

本地真实 PostgreSQL 16.15 验证实际退出0，共 **180 项、零跳过**：

- 新普通上传合同26项、新并发／触发器／确认错误案例43项。
- 既有移动合同20项、移动原生11项、存储迁移12项、module5范围35项。
- 既有 module5 完整消费原生文件33项。

SQL、锁等待、提交、回滚和触发器使用真实引擎；R2、队列为显式内存测试适配器。五个普通 scope 的确认错误先完成真实 COMMIT，再由 wrapper 注入 `undefined`／`40003`／`08006` 错误，不把该故障注入称为真实网络丢包。两个本轮临时 PG 测试库均验证 `FINANCE_LOCAL_FIXTURES remaining=0` 并停止。两套原 Worker 类型检查实际退出0；完整 unit 类型检查第一次缺三端依赖的退出2保留，按已有锁文件安装 Admin／Kefu／UniApp 依赖后以新收据退出0，没有改检查脚本或缩小类型范围。

本轮基线为 `eeb54beb8a3671fb83e575a3e816e45ef116dea4`，包含正常合并的 PR #49 和 #50。完整 CI、合并、API 部署、五个 Pages 状态、线上只读探针、归档和清理仍以对应后续实际收据记载，不预填未来版本或成功。

原始本地证据保存在本轮外部工作目录 `.cache/attachment-upload-category-20261007`：`backend-native01`、`assisted-consumption-native01`、`typecheck-runtime01`、`typecheck-unit02` 的 `execution.json` 保存真实退出状态、完整输入与 stdout／stderr 的 SHA256 和字节数；失败 `typecheck-unit01` 及三个依赖安装回执保留。测试输入前后相同，不沿用上一批测试的通过信用。

Checklist 实数仍为 **404总项／248完成／156开放**，ADM-007、FE-001、TEST-005 均保持开放。本轮不新增 HTTP 接口，也未重新执行路由或 Uni 页面分布审计；旧批次数字保留原日期与源。视频分类提交、历史失效分类修复、完整分类树管理、真实角色／provider／数据规模，以及跨系统原子性和自动对账仍需完成。
